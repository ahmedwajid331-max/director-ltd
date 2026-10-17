import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { compileFilterToWhere, hasActiveDirectorRules, type CompileMode } from "@/lib/filters/compile";
import { REAL_COMPANIES_WHERE, visibleCompaniesWhere } from "./scope";
import { nameLetterConditions } from "@/lib/filters/nameLetter";

export const SORTABLE_FIELDS = [
  "name",
  "companyNumber",
  "incorporationDate",
  "status",
  "directorCount",
  "accountsNextDue",
  "registeredPostcode",
  "registeredCity",
  "type",
  "filing",
  "statusDetail",
  "registeredAddress1",
  "registeredAddress2",
  "registeredCounty",
  "sicCodes",
  "accountsLastMadeUp",
  "accountsOverdue",
  "confirmationNextDue",
  "confirmationLastMadeUp",
  "confirmationOverdue",
  "dormant",
  "accountType",
  "hasDS01",
  "ds01FiledAt",
  "officersCoverage",
  "officersFetchedAt",
  "officersUnavailableReason",
  "singleDirector",
  "source",
  "chLastFetchedAt",
  "dissolutionDate",
] as const;

export type SortableField = (typeof SORTABLE_FIELDS)[number];

export interface CompanySearchParams {
  where: Prisma.CompanyWhereInput;
  sortField?: SortableField;
  sortDir?: "asc" | "desc";
  page: number;
  pageSize: number;
  // Offsets at or beyond this are served from the nearer end of the result set
  // (see searchCompanies). Overridable so tests can exercise it on small data.
  reverseFromSkip?: number;
}

export function isSortableField(value: string | null | undefined): value is SortableField {
  return !!value && (SORTABLE_FIELDS as readonly string[]).includes(value);
}

export type CompanyScope = "all" | "followed" | "saved" | "redFlagged" | "trashed" | "none";

// The single place a company query is assembled, shared by search, export,
// reports and the daily refresh so the same filter can never mean two things.
//   filter - untrusted filter tree (validated; throws FilterValidationError)
//   q      - free-text box: name / company number / postcode
//   namePrefix - A-Z directory letter: company names beginning with that letter. The range
//            predicate lets PostgreSQL walk the name index (descending "A" took 12 s with ILIKE alone);
//            the ILIKE keeps the match exact because this database's collation ignores punctuation.
//   scope  - per-user CRM view; "none" applies no per-user trash logic
//   mode   - "confirmed" (default): companies the filter definitely matches;
//            "possible": also companies it could not be evaluated for because
//            officer data is not confirmed (see CompileMode)
export function buildCompanyWhere(opts: {
  filter?: unknown;
  q?: string;
  namePrefix?: string;
  scope?: CompanyScope;
  userId?: string;
  mode?: CompileMode;
}): Prisma.CompanyWhereInput {
  const and: Prisma.CompanyWhereInput[] = [visibleCompaniesWhere(), compileFilterToWhere(opts.filter ?? null, new Date(), opts.mode ?? "confirmed", opts.userId)];

  const term = opts.q?.trim();
  if (term) {
    and.push({
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { companyNumber: { contains: term.toUpperCase() } },
        { registeredPostcode: { contains: term.toUpperCase() } },
      ],
    });
  }

  const letter = opts.namePrefix?.trim().toUpperCase();
  if (letter && /^[A-Z]$/.test(letter)) {
    and.push(...nameLetterConditions(letter));
  }

  const scope = opts.scope ?? "none";
  const stateFilter: Record<string, Prisma.UserCompanyStateWhereInput> = {
    followed: { followed: true },
    trashed: { trashed: true },
    // Saved / red-flagged views hide anything the user has since trashed, matching the dashboard counts.
    saved: { saved: true, trashed: false },
    redFlagged: { redFlagged: true, trashed: false },
  };
  if (opts.userId && stateFilter[scope]) {
    and.push({ userStates: { some: { userId: opts.userId, ...stateFilter[scope] } } });
  } else if (opts.userId && scope === "all") {
    and.push({ NOT: { userStates: { some: { userId: opts.userId, trashed: true } } } });
  }

  return { AND: and };
}

// Exact number of companies matching `where`.
//
// Prisma's count() is emitted as SELECT COUNT(*) FROM (SELECT id ... OFFSET 0),
// a shape PostgreSQL cannot parallelise: at 5.69M rows it took 3-8 s. groupBy
// is emitted as a plain SELECT COUNT(*) ... GROUP BY, which PostgreSQL does
// parallelise (about 1.3 s for the same filter, 0.7 s for an index-only scan).
// Grouping by `status` and summing the groups gives the identical total.
export async function countCompanies(where: Prisma.CompanyWhereInput): Promise<number> {
  const groups = await db.company.groupBy({ by: ["status"], where, _count: { _all: true } });
  return groups.reduce((sum, g) => sum + g._count._all, 0);
}

// The "real companies loaded" figure shown in the app shell on EVERY page
// render, the dashboard and the landing page. It is informational, so it is
// memoised for a minute instead of scanning the register per request.
let realCountCache: { value: number; at: number } | null = null;
export async function countRealCompanies(ttlMs = 60_000): Promise<number> {
  const now = Date.now();
  if (realCountCache && now - realCountCache.at < ttlMs) return realCountCache.value;
  const value = await countCompanies(REAL_COMPANIES_WHERE);
  realCountCache = { value, at: now };
  return value;
}

// Headline register figures for the dashboard and landing page: total, active, dissolved and how many
// companies have confirmed director data. Real rows only, one grouped scan per figure set, memoised for
// five minutes (informational, so it must never scan the register per request).
export interface RegisterBreakdown {
  total: number;
  active: number;
  dissolved: number;
  directorsConfirmed: number;
}
let breakdownCache: { value: RegisterBreakdown; at: number } | null = null;
export async function getRegisterBreakdown(ttlMs = 5 * 60_000): Promise<RegisterBreakdown> {
  const now = Date.now();
  if (breakdownCache && now - breakdownCache.at < ttlMs) return breakdownCache.value;
  const [byStatus, byCoverage] = await Promise.all([
    db.company.groupBy({ by: ["status"], where: REAL_COMPANIES_WHERE, _count: { _all: true } }),
    db.company.groupBy({ by: ["officersCoverage"], where: REAL_COMPANIES_WHERE, _count: { _all: true } }),
  ]);
  const count = (rows: { _count: { _all: number } }[]) => rows.reduce((n, r) => n + r._count._all, 0);
  const value = {
    total: count(byStatus),
    active: count(byStatus.filter((r) => r.status === "active")),
    dissolved: count(byStatus.filter((r) => r.status === "dissolved")),
    directorsConfirmed: count(byCoverage.filter((r) => r.officersCoverage === "full")),
  };
  breakdownCache = { value, at: now };
  return value;
}

type OrderBy = Prisma.CompanyOrderByWithRelationInput[];

// ONE definition per sortable column: the ordered list of database keys it sorts by. "same" follows the clicked
// direction, "asc"/"desc" are fixed, and `nulls` pins where NULLs go. Both the forward and the reversed (read-from-the-end)
// ORDER BY are derived from it, so a column can never sort one way going forward and another going back.
type SortKey = { field: string; dir: "same" | "asc" | "desc"; nulls?: "first" | "last" };
export const SORT_DEFS: Record<SortableField, SortKey[]> = {
  name: [{ field: "name", dir: "same" }],
  companyNumber: [{ field: "companyNumber", dir: "same" }], // text column: UK numbers include letters (SC, NI, OC...), never cast to integer
  status: [{ field: "status", dir: "same" }],
  type: [{ field: "type", dir: "same" }],
  incorporationDate: [{ field: "incorporationDate", dir: "same" }],
  registeredPostcode: [{ field: "registeredPostcode", dir: "same" }],
  // City / town is its own column (Companies House `locality`), stored in registeredCity - never derived from the postcode.
  registeredCity: [{ field: "registeredCity", dir: "same" }],
  // Companies without confirmed officer data ("none" / "partial" / "unavailable") always come AFTER those with a real
  // count, in either direction (coverage "full" sorts first alphabetically); they are never ranked as 0 directors.
  directorCount: [
    { field: "officersCoverage", dir: "asc" },
    { field: "directorCount", dir: "same" },
  ],
  accountsNextDue: [{ field: "accountsNextDue", dir: "same", nulls: "last" }],
  // What the Filing cell shows: DS01 filed, then late accounts, then the accounts due date (no due date last).
  filing: [
    { field: "hasDS01", dir: "same" },
    { field: "accountsOverdue", dir: "same" },
    { field: "accountsNextDue", dir: "same", nulls: "last" },
  ],
  // ---- Remaining stored columns. Text sorts by value (blank / NULL pinned last), dates sort as dates (NULL last in both
  // directions), booleans sort No then Yes ascending. Per-user flags (Followed, Saved, Red flagged, In Trash) and
  // derived display columns are deliberately NOT sortable: they have no single column to order by.
  statusDetail: [{ field: "statusDetail", dir: "same", nulls: "last" }],
  registeredAddress1: [{ field: "registeredAddress1", dir: "same" }],
  registeredAddress2: [{ field: "registeredAddress2", dir: "same", nulls: "last" }],
  registeredCounty: [{ field: "registeredCounty", dir: "same", nulls: "last" }],
  sicCodes: [{ field: "sicCodes", dir: "same" }],
  accountsLastMadeUp: [{ field: "accountsLastMadeUp", dir: "same", nulls: "last" }],
  accountsOverdue: [{ field: "accountsOverdue", dir: "same" }],
  confirmationNextDue: [{ field: "confirmationNextDue", dir: "same", nulls: "last" }],
  confirmationLastMadeUp: [{ field: "confirmationLastMadeUp", dir: "same", nulls: "last" }],
  confirmationOverdue: [{ field: "confirmationOverdue", dir: "same" }],
  dormant: [{ field: "dormant", dir: "same" }],
  accountType: [{ field: "accountType", dir: "same", nulls: "last" }],
  hasDS01: [{ field: "hasDS01", dir: "same" }],
  ds01FiledAt: [{ field: "ds01FiledAt", dir: "same", nulls: "last" }],
  officersCoverage: [{ field: "officersCoverage", dir: "same" }],
  officersFetchedAt: [{ field: "officersFetchedAt", dir: "same", nulls: "last" }],
  officersUnavailableReason: [{ field: "officersUnavailableReason", dir: "same", nulls: "last" }],
  // Like Directors: companies without confirmed officer data always come after those with a real answer.
  singleDirector: [
    { field: "officersCoverage", dir: "asc" },
    { field: "singleDirector", dir: "same" },
  ],
  source: [{ field: "source", dir: "same" }],
  chLastFetchedAt: [{ field: "chLastFetchedAt", dir: "same", nulls: "last" }],
  dissolutionDate: [{ field: "dissolutionDate", dir: "same", nulls: "last" }],
};

// Text columns where a company can have an EMPTY value ("" is not NULL). Empty text sorts before every real value, so
// ascending would open with a page of blanks; these are pinned last in both directions (see searchEmptyLastAsc).
const EMPTY_LAST_FIELDS = ["registeredPostcode", "registeredCity", "registeredAddress1", "registeredAddress2", "registeredCounty", "statusDetail", "accountType", "sicCodes", "officersUnavailableReason"] as const;
type EmptyLastField = (typeof EMPTY_LAST_FIELDS)[number];
function isEmptyLastField(f: SortableField): f is EmptyLastField {
  return (EMPTY_LAST_FIELDS as readonly string[]).includes(f);
}

function orderFor(sortField: SortableField, sortDir: "asc" | "desc", reverse: boolean): OrderBy {
  const flip = (d: "asc" | "desc") => (reverse ? (d === "asc" ? "desc" : "asc") : d);
  const keys = SORT_DEFS[sortField].map((k) => {
    const dir = flip(k.dir === "same" ? sortDir : k.dir);
    if (!k.nulls) return { [k.field]: dir };
    const nulls = reverse ? (k.nulls === "last" ? "first" : "last") : k.nulls;
    return { [k.field]: { sort: dir, nulls } };
  });
  return [...keys, { id: reverse ? "desc" : "asc" }] as OrderBy;
}

function buildOrderBy(sortField: SortableField, sortDir: "asc" | "desc"): OrderBy {
  return orderFor(sortField, sortDir, false);
}

// The exact reverse sequence of buildOrderBy (every key flipped, NULLS LAST becomes NULLS FIRST), so reading it
// forwards and reversing the page yields the same rows in the same order as reading the original forwards.
function reverseOrderBy(sortField: SortableField, sortDir: "asc" | "desc"): OrderBy {
  return orderFor(sortField, sortDir, true);
}

// Offsets from here on are read from the end of the result set instead.
export const REVERSE_FROM_SKIP = 100_000;

// Server-side pagination + filtering + sorting only. Never fetch the full
// result set into memory - the dataset is designed to scale to the full
// ~5.6M Companies House register. `id` is always the final sort key so rows
// never repeat or vanish between pages when the chosen column has ties.
// Nullable columns (accountsNextDue) always sort NULLs last in both directions.
//
// Pages are still numbered (the UI offers previous / next and shows "page N
// of M"), so OFFSET stays, but its cost is proportional to how many rows must
// be skipped. Past the middle of the result set the same page is read from the
// END instead (reverse order, small offset) and flipped back, so the worst
// case is the middle of the register, never the last page. The page query and
// the count run one after the other: run together they fight over disk I/O
// (measured at 5.69M rows) and were slower than back to back.
export async function searchCompanies({ where, sortField = "name", sortDir = "asc", page, pageSize, reverseFromSkip = REVERSE_FROM_SKIP }: CompanySearchParams) {
  const skip = Math.max(0, (page - 1) * pageSize);
  if (isEmptyLastField(sortField) && sortDir === "asc") return searchEmptyLastAsc({ field: sortField, where, page, pageSize, skip, reverseFromSkip });
  const orderBy = buildOrderBy(sortField, sortDir);

  let rows: Awaited<ReturnType<typeof db.company.findMany>>;
  let total: number;
  if (skip < reverseFromSkip) {
    rows = await db.company.findMany({ where, orderBy, skip, take: pageSize });
    total = await countCompanies(where);
  } else {
    total = await countCompanies(where);
    const take = Math.min(pageSize, Math.max(0, total - skip));
    if (take === 0) {
      rows = [];
    } else if (skip > total / 2) {
      const fromEnd = await db.company.findMany({ where, orderBy: reverseOrderBy(sortField, sortDir), skip: total - skip - take, take });
      rows = fromEnd.reverse();
    } else {
      rows = await db.company.findMany({ where, orderBy, skip, take: pageSize });
    }
  }

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// City / town and Postcode are text columns where some companies (overseas entities, charities...) have an EMPTY value
// (~91k blank postcodes, ~94k blank cities). Empty text sorts before every real value, so ASC would open with a whole
// page of blank cells. Empty
// locations are now pinned LAST in BOTH directions, like the nullable columns:
//  - DESC already ends with them (real postcodes descending, then the empties by id), so it needs no special path.
//  - ASC is read from the SAME ordered query as before, shifted past the empties: the old ASC order is
//    [empties by id][real postcodes ascending], so the new page is old positions skip+empty.. (real part) followed by
//    old positions 0.. (empty part). No extra predicate is added to the big query (a `<> ''` filter made PostgreSQL
//    pick a plan ~10x slower on filtered searches); only a cheap count of the empty rows is added.
async function searchEmptyLastAsc({ field, where, page, pageSize, skip, reverseFromSkip }: { field: EmptyLastField; where: Prisma.CompanyWhereInput; page: number; pageSize: number; skip: number; reverseFromSkip: number }) {
  const total = await countCompanies(where);
  const empty = await countCompanies({ AND: [where, { [field]: "" }] });
  const real = total - empty;

  const readAsc = async (from: number, take: number) => {
    if (from >= reverseFromSkip && from > total / 2) {
      const fromEnd = await db.company.findMany({ where, orderBy: reverseOrderBy(field, "asc"), skip: total - from - take, take });
      return fromEnd.reverse();
    }
    return db.company.findMany({ where, orderBy: buildOrderBy(field, "asc"), skip: from, take });
  };

  const rows: Awaited<ReturnType<typeof db.company.findMany>> = [];
  const takeReal = Math.max(0, Math.min(pageSize, real - skip));
  if (takeReal > 0) rows.push(...(await readAsc(skip + empty, takeReal)));
  const takeEmpty = Math.min(pageSize - rows.length, Math.max(0, total - Math.max(skip, real)));
  if (takeEmpty > 0) rows.push(...(await readAsc(Math.max(0, skip - real), takeEmpty)));
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getCompanyById(id: string) {
  return db.company.findUnique({
    where: { id },
    include: {
      directors: { orderBy: [{ resignedOn: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }] },
    },
  });
}

// Streams matching rows in fixed-size batches so exports never hold the full
// result set in memory, however large the underlying query.
//
// The matching ids are selected ONCE with whatever access path PostgreSQL
// finds best for the filter (index / bitmap / parallel scan), then the rows are
// fetched by primary key in batches. The previous cursor + ORDER BY id walk
// re-applied the whole filter along the id index for every batch (random heap
// reads at 5.69M rows: 62,852 rows took 73 s). `maxRows` bounds the id list
// (callers pass their export cap), so memory stays bounded. Rows are emitted in
// ascending id order, as before.
export async function* iterateCompanies(where: Prisma.CompanyWhereInput, batchSize = 500, maxRows?: number) {
  const found = await db.company.findMany({ where, select: { id: true }, ...(maxRows !== undefined ? { take: maxRows } : {}) });
  const ids = found.map((r) => r.id).sort();
  for (let i = 0; i < ids.length; i += batchSize) {
    const slice = ids.slice(i, i + batchSize);
    const batch = await db.company.findMany({ where: { id: { in: slice } } });
    const byId = new Map(batch.map((c) => [c.id, c]));
    const ordered = slice.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
    if (ordered.length) yield ordered;
  }
}

// Every matching company, in EXACTLY the order the table shows for (sortField, sortDir), in batches - for downloads that
// must follow the on-screen order without holding the rows in memory. The ids are read once in the final order (same
// ORDER BY as searchCompanies, including the blanks-last rule for text columns); `total` is the number of ids, i.e. exactly
// what the batches will deliver. The rows are then fetched by primary key in batches and put back in that order. Memory is
// one batch of rows plus the id list. If a row disappears between the id read and its batch, the batches throw instead of
// yielding a short result, so a file is never silently incomplete. `maxRows` bounds the id read (callers pass cap + 1).
export async function openCompaniesSorted(where: Prisma.CompanyWhereInput, sortField: SortableField, sortDir: "asc" | "desc", batchSize = 1000, maxRows?: number) {
  let ids = (await db.company.findMany({ where, select: { id: true }, orderBy: buildOrderBy(sortField, sortDir), ...(maxRows !== undefined ? { take: maxRows } : {}) })).map((r) => r.id);
  if (isEmptyLastField(sortField) && sortDir === "asc") {
    // Plain ascending puts the blank values first; the table pins them last (see searchEmptyLastAsc).
    const blanks = await countCompanies({ AND: [where, { [sortField]: "" }] });
    ids = [...ids.slice(blanks), ...ids.slice(0, blanks)];
  }
  async function* batches() {
    for (let i = 0; i < ids.length; i += batchSize) {
      const slice = ids.slice(i, i + batchSize);
      const found = await db.company.findMany({ where: { id: { in: slice } } });
      const byId = new Map(found.map((c) => [c.id, c]));
      const ordered = slice.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
      if (ordered.length !== slice.length) throw new Error("The results changed while the file was being prepared. Please try again.");
      yield ordered;
    }
  }
  return { total: ids.length, batches: batches() };
}

// Director-filter reporting. `confirmed` is the normal result count; `unknown`
// is how many MORE companies pass every non-director condition but could not
// be evaluated because their officer data is not confirmed (none /
// unavailable). Null when the filter has no active director rule. Unknown is
// never folded into the results and never treated as zero.
export async function countUnknownDirectorMatches(
  opts: { filter?: unknown; q?: string; scope?: CompanyScope; userId?: string },
  confirmedTotal: number
): Promise<number | null> {
  if (!hasActiveDirectorRules(opts.filter ?? null)) return null;
  const possible = await countCompanies(buildCompanyWhere({ ...opts, mode: "possible" }));
  return Math.max(0, possible - confirmedTotal);
}
