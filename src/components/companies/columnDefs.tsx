import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { companyAgeYears, formatAddress, formatDateOnly, STATUS_LABELS, STATUS_TONE, typeLabel } from "@/lib/data/format";
import { directorDisplay } from "@/lib/data/director-display";
import { OFFICER_UNAVAILABLE_REASON, dormantState, ds01DateState, overdueState, postcodeArea, prettySlug, profileFetchedAt, sicList, statusDetailState, accountsState, type YesNoState } from "@/lib/columns/cellRules";
import { getField } from "@/lib/columns/catalogue";
import type { SortableField } from "@/lib/data/companies";
import type { CompanyRow } from "./ResultsTable";

// How each displayable catalogue field is drawn in the company table. The Company column (sticky) is drawn by
// ResultsTable itself. Cells that exist today keep their exact markup. A cell never shows a false zero: blank,
// unknown and not-applicable values use the wording agreed with the product owner.

const PUBLIC_COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company";

export interface ColumnRenderer {
  header: string;
  hint: string;
  sortKey?: SortableField;
  // Sorts on sortKey's column but in the opposite direction (Age is the mirror of Incorporated: youngest = newest).
  sortInverted?: boolean;
  tdClass: string;
  render: (row: CompanyRow) => React.ReactNode;
}

function Muted({ label, title }: { label: string; title?: string }) {
  return (
    <span className="text-xs text-slate-400" title={title}>
      {label}
    </span>
  );
}

const Dash = () => <span className="text-slate-300">—</span>;

function text(value: string | null | undefined, title?: string) {
  return value ? <span title={title ?? value}>{value}</span> : <Dash />;
}

function date(value: string | null | undefined, missing: React.ReactNode = <Dash />) {
  return value ? <>{formatDateOnly(value)}</> : <>{missing}</>;
}

function yesNo(state: YesNoState, yesTone: "red" | "amber" | "slate" | "green" = "slate", unknownTitle = "Not enough data to say") {
  if (state === "yes") return <Badge tone={yesTone}>Yes</Badge>;
  if (state === "no") return <span className="text-slate-500">No</span>;
  if (state === "not_applicable") return <Muted label="Not applicable" title="Only active companies have a filing duty" />;
  return <Muted label="Unknown" title={unknownTitle} />;
}

const base = "px-3 py-2";
const nowrap = "whitespace-nowrap px-3 py-2 tabular-nums text-slate-600";

export const COLUMN_RENDERERS: Record<string, ColumnRenderer> = {
  // ---- the nine columns the table has always had (markup unchanged) ----
  companyNumber: {
    header: "Company No.",
    hint: "Sort by company number, ascending / descending",
    sortKey: "companyNumber",
    tdClass: "px-3 py-2 font-mono text-xs",
    render: (row) => (
      <Link href={`/companies/${row.id}`} className="text-slate-600 underline-offset-2 hover:text-indigo-700 hover:underline">
        {row.companyNumber}
      </Link>
    ),
  },
  status: {
    header: "Status",
    hint: "Sort by company status",
    sortKey: "status",
    tdClass: base,
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>,
  },
  type: {
    header: "Type",
    hint: "Sort by legal type (Companies House company type)",
    sortKey: "type",
    tdClass: "max-w-[170px] truncate whitespace-nowrap px-3 py-2 text-slate-600",
    render: (row) => (row.type ? <span title={typeLabel(row.type)}>{typeLabel(row.type)}</span> : "—"),
  },
  incorporationDate: {
    header: "Incorporated",
    hint: "Sort by incorporation date",
    sortKey: "incorporationDate",
    tdClass: nowrap,
    render: (row) => formatDateOnly(row.incorporationDate),
  },
  registeredCity: {
    header: "City / town",
    hint: "Sort by registered city / town, A → Z / Z → A (companies with no city listed last)",
    sortKey: "registeredCity",
    tdClass: "max-w-[140px] truncate whitespace-nowrap px-3 py-2 text-slate-700",
    render: (row) => (row.registeredCity ? <span title={row.registeredCity}>{row.registeredCity}</span> : <Dash />),
  },
  registeredPostcode: {
    header: "Postcode",
    hint: "Sort by registered postcode, A → Z / Z → A (companies with no postcode listed last)",
    sortKey: "registeredPostcode",
    tdClass: "whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700",
    render: (row) => (row.registeredPostcode ? row.registeredPostcode : <Dash />),
  },
  directorCount: {
    header: "Directors",
    hint: "Sort by director count. Companies whose officers are not fetched or unavailable always come last, never as 0.",
    sortKey: "directorCount",
    tdClass: "px-3 py-2 text-slate-600",
    render: (row) => {
      const d = directorDisplay(row);
      if (d.state !== "fetched") {
        return (
          <span className="text-xs text-slate-400" title={d.tooltip}>
            {d.label}
          </span>
        );
      }
      return (
        <span title={d.tooltip ?? undefined}>
          {d.label}
          {d.single && (
            <Badge tone="amber" className="ml-1.5">
              Single
            </Badge>
          )}
          {d.freshness !== "fresh" && (
            <Badge tone="slate" className="ml-1.5">
              {d.freshness === "dirty" ? "Update pending" : "Not recently verified"}
            </Badge>
          )}
        </span>
      );
    },
  },
  filingSummary: {
    header: "Filing",
    hint: "Sort by filing position: DS01 filed, late accounts, then accounts due date (no due date last)",
    sortKey: "filing",
    tdClass: base,
    render: (row) => (
      <div className="flex flex-wrap gap-1">
        {row.accountsOverdue && <Badge tone="red">Late accounts</Badge>}
        {row.hasDS01 && <Badge tone="amber">DS01</Badge>}
        {!row.accountsOverdue && !row.hasDS01 && <span className="text-slate-400">—</span>}
      </div>
    ),
  },

  // ---- identity ----
  statusDetail: {
    sortKey: "statusDetail",
    header: "Status detail",
    hint: "Extra status detail. Known only for companies whose profile has been fetched, plus proposals to strike off. Not fetched = profile not fetched yet; None recorded = fetched, no detail.",
    tdClass: "whitespace-nowrap px-3 py-2 text-slate-600",
    render: (row) => {
      if (row.statusDetail) return prettySlug(row.statusDetail);
      return statusDetailState(row.source) === "none_recorded" ? (
        <Muted label="None recorded" title="The Companies House profile was fetched and carries no status detail" />
      ) : (
        <Muted label="Not fetched" title="The register extract only identifies proposals to strike off. The Companies House profile has not been fetched, so any other status detail is not known yet" />
      );
    },
  },
  companyAgeYears: {
    header: "Age",
    hint: "Whole years since incorporation. Sorts by incorporation date: youngest first, then oldest first.",
    sortKey: "incorporationDate",
    sortInverted: true,
    tdClass: nowrap,
    render: (row) => `${companyAgeYears(row.incorporationDate)} yrs`,
  },
  dissolutionDate: {
    sortKey: "dissolutionDate",
    header: "Dissolved",
    hint: "Date the company was dissolved. Empty for almost every company in the register file.",
    tdClass: nowrap,
    render: (row) => (row.status === "dissolved" ? date(row.dissolutionDate, <Muted label="Not provided" />) : <Muted label="Not applicable" />),
  },
  chLink: {
    header: "Companies House",
    hint: "Open this company on Find and update company information",
    tdClass: base,
    render: (row) => (
      <a
        href={`${PUBLIC_COMPANY_URL}/${encodeURIComponent(row.companyNumber)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline"
      >
        View <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    ),
  },

  // ---- address ----
  registeredAddress1: { sortKey: "registeredAddress1", header: "Address line 1", hint: "First line of the registered office address", tdClass: "max-w-[220px] truncate whitespace-nowrap px-3 py-2 text-slate-700", render: (row) => text(row.registeredAddress1 as string | undefined) },
  registeredAddress2: { sortKey: "registeredAddress2", header: "Address line 2", hint: "Second line of the registered office address", tdClass: "max-w-[200px] truncate whitespace-nowrap px-3 py-2 text-slate-700", render: (row) => text(row.registeredAddress2) },
  registeredCounty: { sortKey: "registeredCounty", header: "County", hint: "Registered office county (blank for most companies)", tdClass: "max-w-[140px] truncate whitespace-nowrap px-3 py-2 text-slate-700", render: (row) => text(row.registeredCounty) },
  postcodeArea: { header: "Postcode area", hint: "Outward part of the postcode", tdClass: "whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700", render: (row) => text(postcodeArea(row.registeredPostcode)) },
  fullAddress: {
    header: "Full address",
    hint: "All registered address lines",
    tdClass: "max-w-[320px] truncate whitespace-nowrap px-3 py-2 text-slate-700",
    render: (row) => {
      const a = formatAddress({
        registeredAddress1: row.registeredAddress1 ?? "",
        registeredAddress2: row.registeredAddress2,
        registeredCity: row.registeredCity ?? "",
        registeredPostcode: row.registeredPostcode ?? "",
        registeredCounty: row.registeredCounty,
      });
      return text(a);
    },
  },

  // ---- classification ----
  sicCodes: { sortKey: "sicCodes", header: "SIC codes", hint: "Standard Industrial Classification codes", tdClass: "max-w-[180px] truncate whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700", render: (row) => text(sicList(row.sicCodes).join(", ")) },
  sicFirst: { header: "Main SIC", hint: "First listed SIC code", tdClass: "whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700", render: (row) => text(sicList(row.sicCodes)[0]) },
  sicCount: { header: "SIC count", hint: "Number of SIC codes", tdClass: nowrap, render: (row) => (sicList(row.sicCodes).length || <Dash />) },

  // ---- filing & compliance ----
  accountsNextDue: {
    sortKey: "accountsNextDue",
    header: "Accounts due",
    hint: "Date the next accounts are due.",
    tdClass: nowrap,
    render: (row) => date(row.accountsNextDue),
  },
  accountsLastMadeUp: {
    sortKey: "accountsLastMadeUp",
    header: "Accounts made up to",
    hint: "End of the last accounting period filed",
    tdClass: nowrap,
    render: (row) => date(row.accountsLastMadeUp, <Muted label="Not provided" title="Companies House shows no accounts made up. This usually means none have been filed yet." />),
  },
  accountsOverdue: {
    sortKey: "accountsOverdue",
    header: "Accounts overdue",
    hint: "Yes when an active company's accounts due date has passed. Updated daily.",
    tdClass: base,
    render: (row) => yesNo(overdueState(row.status, row.accountsOverdue, row.accountsNextDue), "red", "This active company has no accounts due date on record"),
  },
  accountType: {
    sortKey: "accountType",
    header: "Accounts type",
    hint: "Type of the last accounts filed",
    tdClass: "whitespace-nowrap px-3 py-2 text-slate-600",
    render: (row) => {
      const s = accountsState(row.accountType, row.accountsLastMadeUp);
      if (s === "has_type") return prettySlug(row.accountType);
      return s === "no_accounts" ? <Muted label="No accounts filed" title="The register shows no accounts made up to a date for this company yet" /> : <Muted label="Not recorded" title="Accounts have been filed, but the register does not give their type" />;
    },
  },
  dormant: {
    sortKey: "dormant",
    header: "Dormant",
    hint: "Yes when the last accounts filed were dormant accounts",
    tdClass: base,
    render: (row) =>
      accountsState(row.accountType, row.accountsLastMadeUp) === "no_accounts" ? (
        <Muted label="No accounts filed" title="Dormancy is read from the last accounts filed, and none are on the register yet" />
      ) : (
        yesNo(dormantState(row.accountType, !!row.dormant), "slate", "Accounts have been filed, but their type is not recorded, so dormancy cannot be told")
      ),
  },
  confirmationNextDue: { sortKey: "confirmationNextDue", header: "Confirmation due", hint: "Date the next confirmation statement is due", tdClass: nowrap, render: (row) => date(row.confirmationNextDue) },
  confirmationLastMadeUp: { sortKey: "confirmationLastMadeUp", header: "Confirmation made up to", hint: "Date the last confirmation statement was made up to", tdClass: nowrap, render: (row) => date(row.confirmationLastMadeUp) },
  confirmationOverdue: {
    sortKey: "confirmationOverdue",
    header: "Confirmation overdue",
    hint: "Yes when an active company's confirmation statement is late. Updated daily.",
    tdClass: base,
    render: (row) => yesNo(overdueState(row.status, !!row.confirmationOverdue, row.confirmationNextDue), "red", "This active company has no confirmation due date on record"),
  },
  hasDS01: { sortKey: "hasDS01", header: "DS01 filed", hint: "Whether an application to strike the company off has been filed", tdClass: base, render: (row) => yesNo(row.hasDS01 ? "yes" : "no", "amber") },
  ds01FiledAt: {
    sortKey: "ds01FiledAt",
    header: "DS01 date",
    hint: "Date the DS01 filing was seen on the live filing stream",
    tdClass: nowrap,
    render: (row) => {
      const s = ds01DateState(row.hasDS01, row.ds01FiledAt);
      if (s === "date") return formatDateOnly(row.ds01FiledAt);
      if (s === "not_recorded") return <Muted label="Not recorded" title="Strike-off is shown on the register, but the filing date was not seen on the live stream" />;
      return <Muted label="Not applicable" />;
    },
  },

  // ---- officers ----
  singleDirector: {
    sortKey: "singleDirector",
    header: "Single director",
    hint: "Whether the company has exactly one confirmed director",
    tdClass: base,
    render: (row) => {
      const d = directorDisplay(row);
      if (d.state !== "fetched") return <Muted label={d.label} title={d.tooltip} />;
      return yesNo(d.single ? "yes" : "no", "amber");
    },
  },
  officersCoverage: {
    sortKey: "officersCoverage",
    header: "Officer data",
    hint: "Fetched, Not fetched or Unavailable",
    tdClass: "whitespace-nowrap px-3 py-2 text-slate-600",
    render: (row) => {
      const d = directorDisplay(row);
      return d.state === "fetched" ? "Fetched" : <Muted label={d.label} title={d.tooltip} />;
    },
  },
  officersFetchedAt: {
    sortKey: "officersFetchedAt",
    header: "Officers fetched",
    hint: "When the officers were last verified",
    tdClass: nowrap,
    render: (row) => (row.officersCoverage === "full" && row.officersFetchedAt ? formatDateOnly(row.officersFetchedAt) : <Muted label="Not fetched" title="Officer data has not been fetched yet" />),
  },
  officersUnavailableReason: {
    sortKey: "officersUnavailableReason",
    header: "Officer data issue",
    hint: "Why Companies House has no officer data for the company",
    tdClass: "whitespace-nowrap px-3 py-2 text-slate-600",
    render: (row) =>
      row.officersCoverage === "unavailable" ? (
        row.officersUnavailableReason ? OFFICER_UNAVAILABLE_REASON[row.officersUnavailableReason] ?? prettySlug(row.officersUnavailableReason) : <Muted label="Not provided" />
      ) : row.officersCoverage === "full" ? (
        <Muted label="Not applicable" title="Officer data was fetched, so there is no issue to explain" />
      ) : (
        <Muted label="Not fetched" title="Officer data has not been fetched yet, so it is not known whether there is an issue" />
      ),
  },

  // ---- provenance ----
  source: { sortKey: "source", header: "Data source", hint: "Where the record came from", tdClass: "whitespace-nowrap px-3 py-2 text-slate-600", render: (row) => (row.source ? prettySlug(row.source) : <Dash />) },
  chLastFetchedAt: {
    sortKey: "chLastFetchedAt",
    header: "Profile fetched",
    hint: "When the company profile was last fetched from Companies House",
    tdClass: nowrap,
    render: (row) => {
      const at = profileFetchedAt(row.source, row.chLastFetchedAt);
      return at ? formatDateOnly(at) : <Muted label="Not fetched" title="The Companies House profile has not been fetched for this company (the bulk file only supplied its register entry)" />;
    },
  },

  // ---- my CRM (your own markers) ----
  followed: { header: "Followed", hint: "Whether you follow the company", tdClass: base, render: (row) => yesNo(row.followed ? "yes" : "no", "amber") },
  saved: { header: "Saved", hint: "Whether you have saved the company", tdClass: base, render: (row) => yesNo(row.saved ? "yes" : "no", "slate") },
  redFlagged: { header: "Red flagged", hint: "Your own red flag, not an official status", tdClass: base, render: (row) => yesNo(row.redFlagged ? "yes" : "no", "red") },
  trashed: { header: "In Trash", hint: "Whether you moved the company to Trash", tdClass: base, render: (row) => yesNo(row.trashed ? "yes" : "no", "slate") },
};

export function rendererFor(key: string): ColumnRenderer | null {
  if (key === "name") return null; // drawn by ResultsTable (sticky)
  const def = getField(key);
  if (!def || !def.selectable) return null;
  return COLUMN_RENDERERS[key] ?? null;
}
