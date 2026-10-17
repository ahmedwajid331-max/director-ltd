# DIRECTOR.LTD

Companies House search, filtering, reporting and CRM platform.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · Prisma · **PostgreSQL** · custom session auth · real Companies House REST + streaming APIs · Google Calendar OAuth.

## Getting started (development)

```bash
npm install
npm run db:dev          # terminal 1: disposable local PostgreSQL on :5433 (no Docker needed), UTF-8
cp .env.example .env    # then fill AUTH_SECRET (see the file for the generator command)
npm run db:migrate      # apply migrations
npm run db:seed         # OPTIONAL: ~7,000 synthetic development companies + three dev users
npm run dev             # terminal 2 (regenerates the Prisma client first, so it always matches prisma/schema.prisma)
```

After pulling a change that touches `prisma/schema.prisma`: stop the dev server, run `npm run db:migrate`, then start it again.
On Windows a running dev server locks the Prisma engine file, so `prisma generate` cannot replace it while the server is up;
running it anyway leaves a half-updated client and the stale-client error `Unknown field ... for select statement`.

`db:seed` never prints or stores a known password: it generates random passwords for the three development
users (Super Admin / Admin / User) and writes them to `./.dev-credentials.local` (gitignored). Set
`SEED_PASSWORD` to choose one, or rotate any account later:

```bash
NEW_PASSWORD='a long unique passphrase' npm run user:set-password -- someone@example.com
npm run user:set-password -- someone@example.com --generate
```

**Production / first start:** do not seed. Create the first Super Admin with `npm run admin:bootstrap` (interactive, hidden password, shows the target database and asks for confirmation; refuses if a Super Admin already exists; creates no companies or demo data). Further users are created from the Users screen.

The seed refuses to run when `NODE_ENV=production`. There are no demo credentials anywhere in the UI or docs.

### Environment

See [.env.example](.env.example) for every variable. Required: `DATABASE_URL`, `AUTH_SECRET`. Real data needs
`COMPANIES_HOUSE_API_KEY` (REST) and `COMPANIES_HOUSE_STREAM_KEY` (filing stream). **Never commit or paste key values**;
keep them in `.env` (gitignored) or AWS Secrets Manager. In production the app refuses to start with a missing/short/placeholder `AUTH_SECRET`.

## Architecture

- `prisma/schema.prisma` + `prisma/migrations` — PostgreSQL schema. `Company`/`Director` hold Companies House data
  (`Company.source`: `seed` | `bulk_import` | `advanced_search` | `stream` | `rest_enrichment`). User/CRM data
  (`UserCompanyState`, `Note`, `FollowUp`, `CrmContact`, `Report`, `ActivityLog`) is separate. Date-only facts are SQL `DATE`.
  Hand-written performance objects (trigram GIN indexes for `ILIKE`, postcode prefix index, partial indexes for the
  DS01/dormant/late-filing filters) live in the initial migration.
- `src/lib/filters` — one registry of filterable fields (`fields.ts`), a **validator** (`validate.ts`: unknown fields,
  disallowed operators, NaN, impossible dates, oversized/deep trees are rejected with HTTP 400) and a compiler to Prisma
  (`compile.ts`). Every query goes through `buildCompanyWhere` (`src/lib/data/companies.ts`) so search, export, reports and
  the daily refresh can never disagree.
- `src/lib/companies-house` — the real integration: `client.ts` (auth, rate-limit awareness, 429/5xx retry), `csv/`
  (ZIP streaming, real dotted headers, DD/MM/YYYY parser, explicit category maps), `bulkIngest.ts`, `filingEvents.ts`
  (DS01/DS02), `streamWorker.ts`, `officers.ts`, `dailyUpdate.ts`.
- `src/lib/jobs` — run bookkeeping: heartbeats, stale-run reconciliation, success/partial/failed classification.
- `src/lib/calendar` — provider-agnostic calendar (internal fallback + Google; follow-ups are all-day events).
- `src/lib/auth` — password policy, login throttling, sessions.

## Security model

- **Sessions** are signed cookies, but every request re-checks the user row: a deactivated/deleted user is rejected at once and
  the role always comes from the database (a demotion applies on the next request).
- **Roles:** `USER` < `ADMIN` < `SUPER_ADMIN`. An Admin can only activate/deactivate plain Users; only a Super Admin changes roles or
  touches Admin/Super Admin accounts; nobody can deactivate/demote themselves. Enforced in the API, not the UI.
- **Login throttling** (DB-backed, shared by all instances): 8 failures / 15 min per account+IP, 40 per IP; generic error text; constant-time comparison for unknown accounts.
- **Passwords:** 12+ characters, no common/guessable passwords, must not contain the email name.
- **Headers:** CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (`next.config.ts`). The CSP keeps `'unsafe-inline'` for scripts (Next.js hydration); move to nonces in `proxy.ts` if a stricter policy is required.
- **Export:** a `USER` must apply a filter or search term (no "export everything"); row caps per role (`EXPORT_MAX_ROWS_*`); every export is written to the activity log; CSV cells starting with `= + - @` are neutralised.
- Secrets live only in environment variables.

## Data semantics (decisions worth knowing)

- **Director count** (`directorCount`, "single director") counts *active* officers (no `resigned_on`) whose role is `director`, `corporate-director`, `nominee-director`, `corporate-nominee-director`, or — for LLPs — `llp-member`, `llp-designated-member`, `corporate-llp-member`, `corporate-llp-designated-member`. Secretaries, judicial factors and any other role are stored and shown but **not** counted. All officer pages are fetched (the API returns 35 per page by default). See `src/lib/companies-house/officers.ts`.
- **Manual CRM contacts** are private to the user who typed them, stored separately (`CrmContact`), and **never** change `directorCount` / `singleDirector` or any Companies House director filter.
- **DS01** = application to strike the company off. `hasDS01` is set when a DS01 filing event arrives on the stream (`ds01FiledAt`) or the register shows "Active – Proposal to Strike off". A DS02 (withdrawal) clears it. A monthly CSV re-import or profile refresh can never erase a DS01 recorded from an event.
- **Company age** uses calendar dates (UTC): a company incorporated on 2016-09-30 is exactly 10 on 2026-09-30, at any time of day.
- **Follow / Trash** are per user and mutually exclusive: trashing a followed company un-follows it; following a trashed company restores it.
- **Dormant** comes from the last accounts type (`DORMANT`), never from company status.
- **Seed vs real data:** every company carries its `source`. `SEED_DATA_VISIBLE` decides whether synthetic rows appear in search/reports/exports (default: visible in development, hidden in production). Dashboard, landing page and Settings state real coverage ("N of roughly 5.6 million").

## Reports: print and share

- **Print** prints the rows currently on screen (one page of results). Use **Export CSV** for the whole report. (The requirements document was not available in the repository; if full-report printing is required it is a separate change.)
- **Share** copies the report URL. The link is not public: it opens only for signed-in users who may see that report (its owner, and Admins/Super Admins). Teammates with the `USER` role cannot open someone else's report.

## Operations

```bash
npm run ch:bulk-ingest -- --input <zip|csv|url> [--limit N]   # monthly bulk file; --resume <runId> to continue an interrupted run
npm run ch:bulk-ingest -- --input <file> --dry-run [--snapshot-date YYYY-MM-DD]   # read-only: validates the whole file, predicts inserts/updates/unchanged/protected/rejected
npm run ch:bulk-ingest -- --retry-failed <runId>   # retry database-failed rows from the failed-row ledger (IngestRowFailure)
npm run ch:bulk-ingest -- --search --status active --limit 2000 --enrich 200   # small real sample via Advanced Search
npm run ch:stream                # always-on DS01 stream worker (reconnects, resumes from checkpoint)
npm run ch:new-registrations     # newly incorporated companies since the last covered day (Advanced Search, 1 request/day; idempotent)
npm run ch:daily-update          # overdue flags, pending DS01 events, queues officer work (no API calls), report refresh
npm run ch:officer-worker -- --status          # officer pipeline health (read-only, no API calls)
npm run ch:officer-worker -- --limit 500       # fetch officers for up to 500 queued companies, then stop
npm run ch:officer-worker -- --limit 500 --crawl   # ...and also walk the background crawl (opt-in)
npm run jobs:scheduler           # in-process scheduler (new registrations every 6h whenever COMPANIES_HOUSE_API_KEY is set; daily 03:00 UTC; monthly ingest only if MONTHLY_INGEST_ENABLED=1)
# Phase 1 live updates: keep ONE process running -  STREAM_WORKER_ENABLED=1 npm run jobs:scheduler
#   (daily update at 03:00 UTC, retried every 30 min up to 5x/day on failure, never run twice per UTC day;
#    filing stream runs inside it - do not also run ch:stream). Proof it ran: an IngestionRun row of kind
#    daily_update (Settings/Super Admin; also shown on each report page). Report.lastRunAt is also set by manual Refresh.
```

## Officer coverage (director filters at scale)

`directorCount` / `singleDirector` are only meaningful for companies whose officers have been fetched, so officer data has an explicit **state** (`Company.officersCoverage`):

| state | meaning |
|---|---|
| `none` | officers never fetched (the count columns are placeholders) |
| `full` | every officer page fetched; the count is confirmed (a genuine empty list is `full` / 0) |
| `unavailable` | Companies House has no officer data (`officersUnavailableReason`: `no_officer_resource` or `company_gone`). **Never** a zero. |

Staleness is derived, not stored: `officersFetchedAt` older than `OFFICER_STALE_AFTER_DAYS`, or `officersDirtyAt` newer than `officersFetchedAt` (an officer filing was seen). Stale/dirty companies keep their last confirmed count but are labelled "Not recently verified" / "Update pending".

**Director filters** (`directorCount`, `singleDirector`) only evaluate `full` companies. Every search/report with a director rule also returns an *unknown* count: companies that pass all the other conditions but could not be evaluated (`none` / `unavailable`). The UI shows "N companies match. M additional companies could not be evaluated because officer data is not available yet" and a **Fetch officer data for these companies** button, which only *queues* work (capped by `OFFICER_ENQUEUE_CAP`). Implementation: the filter is compiled twice (`confirmed` and `possible`, see `src/lib/filters/compile.ts`); unknown = count(possible) - count(confirmed).

**CSV export**: `Director count` / `Single director` / `Officer data as of` carry real values only for `full` rows (stale/dirty rows are suffixed); otherwise `Not fetched` or `Unavailable`. Export never calls Companies House.

**Pipeline** (all officer fetching is in the dedicated worker, `npm run ch:officer-worker`):

- *Queue* (`OfficerSyncJob`): priorities P1 saved reports, P2 followed, P3 ad-hoc director filter, P4 stale/dirty refresh; P0 (a company being viewed) is fetched inline on the `user` quota class. Enqueue is idempotent (highest priority wins); claiming uses `FOR UPDATE SKIP LOCKED` with a lease; a dead worker's leases expire back into the queue without charging attempts.
- *Background crawl* (P5): a keyset cursor over `Company` (active companies first, partial indexes, never `OFFSET`, no per-company queue rows). **Opt-in**: `--crawl` (or `OFFICER_CRAWL_ENABLED=1` for the scheduler).
- *Retries*: per company, exponential backoff with jitter (5 m, 30 m, 2 h, 8 h, 24 h, 72 h), parked after `OFFICER_MAX_ATTEMPTS`; at most ~10% of a batch may be retries. Systemic failures (429, breaker, outage, bad key) never consume attempts. Parked companies are listed on the Super Admin page with a manual retry.
- *404*: officers 404 + profile 200 -> `unavailable/no_officer_resource`; both 404 -> `unavailable/company_gone`; a 404 for an already-confirmed company leaves its data untouched.
- *Shared quota gate* (`quota.ts`): one PostgreSQL row shared by every process; classes `user > filing > stream > refresh > backfill`; reservations are configurable policy (`CH_QUOTA_*`) and demand-aware (a class keeps its full reservation only while it has recent demand, otherwise just a small floor, so the background crawl can use idle capacity), background classes are paced evenly across the window, `X-Ratelimit-*` headers are authoritative, a real 429 opens a global cooldown, and the backfill is always the first to yield. Internal quota denials and real 429s are different events (`ChQuotaEvent`, Super Admin page). Throughput is **measured** (Super Admin page), not promised.
- *Circuit breakers* (`breaker.ts`, persisted): repeated 401/403 stops all REST traffic until a manual reset or a successful half-open probe; a 5xx/network failure wave pauses background work only.
- *Freshness*: officer filings on the filing stream (AP01/AP02/TM01, LLP equivalents, NEWINC) mark confirmed companies dirty and queue a P4 refresh; a TTL sweep and a soft refresh on detail-page views are the safety net.

Starting a controlled backfill later (nothing here is run automatically):

```
npm run ch:officer-worker -- --status                      # check health first (no API calls)
npm run ch:officer-worker -- --limit 500 --crawl           # pilot: 500 companies
npm run ch:officer-worker -- --limit 5000 --crawl          # larger pilot
npm run ch:officer-worker -- --crawl --max-minutes 60      # sustained, bounded run
```


- Loading the full register requires the explicit flag `--i-understand-this-is-the-full-register`; without `--limit` a full-size file is refused.
- The bulk loader reads the `.zip` Companies House publishes (streamed, never fully in memory), validates the header, parses `DD/MM/YYYY`, maps categories explicitly (unknown values are recorded and reported, never dropped), and requires a **UTF-8** database.
- Run outcome: `success` (no errors, or ≤0.1 % rows failed/skipped) · `partial` (≤5 %) · `failed` (>5 %, or nothing read). Row counters, error samples and unknown categories are stored on the run and shown in Settings / Super Admin.
- A run with no heartbeat for 10 minutes (2 minutes for the officer worker, which heartbeats every 30 s) is shown as `stalled` and reconciled to `failed`. Only one bulk/daily/officer job of a kind runs at a time (PostgreSQL advisory lock).
- **Stream delivery is at-least-once with idempotent processing**, not exactly-once: DS01/DS02 events are persisted before the checkpoint moves; after a drop/restart the stream is replayed from the checkpoint and the unique `transactionId` absorbs duplicates. If Companies House no longer holds the checkpoint (long downtime) the gap is logged and counted — those events cannot be recovered from the stream.
- Health: `GET /api/health` (public: ok/degraded/down; Super Admin session adds job detail). Logs are JSON lines in production (`LOG_FORMAT=json|text`).
- AWS shape: stream worker = always-on ECS/Fargate task; daily update/bulk = EventBridge scheduled task (or the built-in scheduler); PostgreSQL = RDS (UTF-8, `sslmode=require`). Not yet validated on AWS.

## Testing

```bash
npm run typecheck && npm run lint
npm test                              # unit tests (dates, mapping, filters, CSV safety, password policy, ZIP input, ...)
npm run build && npm run test:integration   # scratch PostgreSQL + production build: security, sessions, CRM, filters, ingestion, resume, stream (mock Companies House)
DATABASE_URL=<empty scratch db> npx tsx tests/acceptance/ingest-100k.ts tmp-ingest/sample-100k.zip   # 100k-row acceptance test
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests, build and the integration suite on every push.
