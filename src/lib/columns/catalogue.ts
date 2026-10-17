import type { SortableField } from "@/lib/data/companies";

// The ONE list of company-level field options an administrator can offer and a user can display.
// 103 entries. Only entries marked `selectable` have data in the company table row today; everything else is shown in the
// admin catalogue with the truthful reason it cannot be switched on yet. Nothing here fetches data.

export type FieldCategory =
  | "Identity"
  | "Address"
  | "Classification"
  | "Filing & compliance"
  | "Officers"
  | "Ownership (PSC)"
  | "Charges, insolvency & other"
  | "Data provenance"
  | "My CRM";

export const FIELD_CATEGORIES: FieldCategory[] = [
  "Identity",
  "Address",
  "Classification",
  "Filing & compliance",
  "Officers",
  "Ownership (PSC)",
  "Charges, insolvency & other",
  "Data provenance",
  "My CRM",
];

// stored      - held for every company
// partial     - held, but blank for some companies
// enrichment  - held only for companies we have enriched (officers, profile fetch, stream)
// derived     - computed from stored data
// import      - present in the monthly bulk file we hold, but not imported yet
// rest        - needs the Companies House company profile (one request per company)
// endpoint    - needs another Companies House endpoint (per company or per officer)
// stream      - needs the filing stream or the PSC snapshot
// internal    - technical timestamp or flag, not for end users
export type Availability = "stored" | "partial" | "enrichment" | "derived" | "import" | "rest" | "endpoint" | "stream" | "internal";

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  stored: "Stored",
  partial: "Partially populated",
  enrichment: "Enrichment-dependent",
  derived: "Derived",
  import: "Not imported yet",
  rest: "Needs profile fetch",
  endpoint: "Needs extra data collection",
  stream: "Needs stream / snapshot",
  internal: "Internal only",
};

export interface FieldDef {
  key: string;
  label: string;
  category: FieldCategory;
  description: string;
  // Exact source name(s): our column, Companies House API field, bulk-file heading.
  source: string;
  availability: Availability;
  // True when the value can be shown in the company table today without any new query or Companies House request.
  selectable: boolean;
  // Personal data: never selectable until the product owner has decided who may see it.
  restricted?: boolean;
  // Header sort that exists today (server-side, tested). Absent = the column is not sortable.
  sortKey?: SortableField;
  // Filter that exists today (key in the filter registry), usable from the filter panel.
  filterKey?: string;
  // Matched by the search box today.
  searchable?: boolean;
  // Why it cannot be shown yet / what is required.
  needs?: string;
  // The administrator's switch starts ON for selectable fields unless this is false.
  defaultEnabled?: boolean;
}

type Opts = Partial<Pick<FieldDef, "restricted" | "sortKey" | "filterKey" | "searchable" | "needs" | "defaultEnabled">>;

function f(key: string, label: string, category: FieldCategory, source: string, availability: Availability, description: string, selectable: boolean, o: Opts = {}): FieldDef {
  return { key, label, category, source, availability, description, selectable, ...o };
}

const I: FieldCategory = "Identity";
const A: FieldCategory = "Address";
const C: FieldCategory = "Classification";
const F: FieldCategory = "Filing & compliance";
const O: FieldCategory = "Officers";
const P: FieldCategory = "Ownership (PSC)";
const X: FieldCategory = "Charges, insolvency & other";
const V: FieldCategory = "Data provenance";
const M: FieldCategory = "My CRM";

const PROFILE = "Requires fetching each company's Companies House profile (one request per company); not done for the register.";
const ENDPOINT = "Requires an additional Companies House request per company or officer; not collected.";
const PSC_NEEDS = "Requires the Companies House PSC snapshot or stream; not collected.";
const IMPORT = "Present in the monthly bulk file but not imported yet (separate approved import).";

export const FIELD_CATALOGUE: FieldDef[] = [
  // ---- Identity (18) ----
  f("name", "Company name", I, "Company.name · company_name · CompanyName", "stored", "Registered company name.", true, { sortKey: "name", filterKey: "name", searchable: true }),
  f("companyNumber", "Company number", I, "Company.companyNumber · company_number · CompanyNumber", "stored", "Companies House registration number.", true, { sortKey: "companyNumber", filterKey: "companyNumber", searchable: true }),
  f("status", "Status", I, "Company.status · company_status · CompanyStatus", "stored", "Register status such as Active or Dissolved.", true, { sortKey: "status", filterKey: "status" }),
  f("statusDetail", "Status detail", I, "Company.statusDetail · company_status_detail", "partial", "Extra status detail (for example proposal to strike off). Filled from the profile fetch; the bulk file only identifies strike-off. Shows Not fetched until the profile has been fetched, and None recorded when it was fetched and has no detail.", true, { sortKey: "statusDetail" }),
  f("type", "Company type", I, "Company.type · type · CompanyCategory", "stored", "Legal type of the company.", true, { sortKey: "type", filterKey: "type" }),
  f("subtype", "Subtype (CIC / PFLP)", I, "subtype · company_subtype", "rest", "Community interest company or private fund limited partnership subtype.", false, { needs: PROFILE }),
  f("jurisdiction", "Jurisdiction", I, "jurisdiction", "rest", "Political body responsible for the company.", false, { needs: PROFILE }),
  f("countryOfOrigin", "Country of origin", I, "CountryOfOrigin", "import", "Country of origin, mostly the United Kingdom.", false, { needs: IMPORT }),
  f("incorporationDate", "Incorporated", I, "Company.incorporationDate · date_of_creation · IncorporationDate", "stored", "Date the company was incorporated.", true, { sortKey: "incorporationDate", filterKey: "incorporationDate" }),
  f("companyAgeYears", "Company age", I, "derived from Company.incorporationDate", "derived", "Whole years since incorporation. Sorts by incorporation date (youngest first / oldest first).", true, { sortKey: "incorporationDate", filterKey: "companyAgeYears" }),
  f("dissolutionDate", "Dissolved date", I, "Company.dissolutionDate · date_of_cessation · DissolutionDate", "partial", "Date the company was dissolved. The monthly file holds almost no dissolved companies, so this is empty for nearly all rows.", true, { sortKey: "dissolutionDate", defaultEnabled: false }),
  f("previousNames", "Previous names", I, "previous_company_names[] · PreviousName_1..10", "import", "Earlier names of the company, with the date each stopped being used.", false, { needs: IMPORT }),
  f("canFile", "Can file", I, "can_file", "rest", "Whether the company can file online.", false, { needs: PROFILE }),
  f("partialData", "Partial data available", I, "partial_data_available", "rest", "Set when Companies House is not the primary source for this company.", false, { needs: PROFILE }),
  f("externalRegNo", "External registration number", I, "external_registration_number", "rest", "Number given by an external registration body.", false, { needs: PROFILE }),
  f("annotations", "Corporate annotations", I, "corporate_annotation[]", "rest", "Register annotations such as strike-off notices.", false, { needs: PROFILE }),
  f("chLink", "Companies House link", I, "derived from company number · URI", "derived", "Link to the company on Find and update company information.", true, { defaultEnabled: false }),
  f("lastMembersList", "Last members list date", I, "last_full_members_list_date", "rest", "Legacy date of the last full members list.", false, { needs: PROFILE }),

  // ---- Address (14) ----
  f("registeredAddress1", "Address line 1", A, "Company.registeredAddress1 · address_line_1 · RegAddress.AddressLine1", "partial", "First line of the registered office address.", true, { sortKey: "registeredAddress1" }),
  f("registeredAddress2", "Address line 2", A, "Company.registeredAddress2 · address_line_2 · RegAddress.AddressLine2", "partial", "Second line of the registered office address.", true, { sortKey: "registeredAddress2" }),
  f("registeredCity", "City / town", A, "Company.registeredCity · locality · RegAddress.PostTown", "partial", "Registered office town or city.", true, { sortKey: "registeredCity", filterKey: "registeredCity" }),
  f("registeredCounty", "County", A, "Company.registeredCounty · region · RegAddress.County", "partial", "Registered office county. Blank for most companies.", true, { sortKey: "registeredCounty", filterKey: "registeredCounty" }),
  f("registeredPostcode", "Postcode", A, "Company.registeredPostcode · postal_code · RegAddress.PostCode", "partial", "Registered office postcode.", true, { sortKey: "registeredPostcode", filterKey: "registeredPostcode", searchable: true }),
  f("country", "Country", A, "country · RegAddress.Country", "import", "Registered office country.", false, { needs: IMPORT }),
  f("careOf", "Care of", A, "care_of · RegAddress.CareOf", "import", "Care-of name on the registered office address.", false, { needs: IMPORT }),
  f("poBox", "PO box", A, "po_box · RegAddress.POBox", "import", "PO box on the registered office address.", false, { needs: IMPORT }),
  f("premises", "Premises", A, "premises", "rest", "Property name or number.", false, { needs: PROFILE }),
  f("undeliverableRO", "Undeliverable registered office", A, "undeliverable_registered_office_address", "rest", "Whether post can be delivered to the registered office.", false, { needs: PROFILE }),
  f("roInDispute", "Registered office in dispute", A, "registered_office_is_in_dispute", "rest", "Whether the registered office address has been replaced.", false, { needs: PROFILE }),
  f("postcodeArea", "Postcode area", A, "derived from Company.registeredPostcode", "derived", "Outward part of the postcode, for example SW1A.", true, { defaultEnabled: false }),
  f("fullAddress", "Full address", A, "derived from the registered address fields", "derived", "All registered address lines on one line.", true, { defaultEnabled: false }),
  f("serviceAddress", "Service address", A, "service_address.*", "rest", "Correspondence address of a registered overseas entity.", false, { needs: PROFILE }),

  // ---- Classification (4) ----
  f("sicCodes", "SIC codes", C, "Company.sicCodes · sic_codes[] · SICCode.SicText_1..4", "stored", "Standard Industrial Classification codes (codes only).", true, { sortKey: "sicCodes", filterKey: "sicCodes" }),
  f("sicFirst", "Main SIC code", C, "derived from Company.sicCodes", "derived", "First listed SIC code.", true, { defaultEnabled: false }),
  f("sicDescriptions", "SIC description", C, "official sic_descriptions list", "derived", "Plain-English description of the SIC code.", false, { needs: "Needs the official SIC description list loaded as a lookup table; not built." }),
  f("sicCount", "Number of SIC codes", C, "derived from Company.sicCodes", "derived", "How many SIC codes are listed.", true, { defaultEnabled: false }),

  // ---- Filing & compliance (18) ----
  f("accountsNextDue", "Accounts next due", F, "Company.accountsNextDue · accounts.next_accounts.due_on · Accounts.NextDueDate", "partial", "Date the next accounts are due.", true, { sortKey: "accountsNextDue", filterKey: "accountsNextDue" }),
  f("accountsLastMadeUp", "Accounts last made up to", F, "Company.accountsLastMadeUp · accounts.last_accounts.period_end_on · Accounts.LastMadeUpDate", "partial", "End of the last accounting period filed. Blank usually means no accounts filed yet.", true, { sortKey: "accountsLastMadeUp", filterKey: "accountsLastMadeUp" }),
  f("accountsOverdue", "Accounts overdue", F, "Company.accountsOverdue · accounts.next_accounts.overdue", "stored", "Set daily for active companies whose accounts due date has passed.", true, { sortKey: "accountsOverdue", filterKey: "accountsOverdue" }),
  f("lastAccountsPeriod", "Last accounting period", F, "accounts.last_accounts.period_start_on / period_end_on", "rest", "Start and end of the last accounting period.", false, { needs: PROFILE }),
  f("nextAccountsPeriod", "Next accounting period", F, "accounts.next_accounts.period_start_on / period_end_on", "rest", "Start and end of the next accounting period.", false, { needs: PROFILE }),
  f("accountType", "Last accounts type", F, "Company.accountType · accounts.last_accounts.type · Accounts.AccountCategory", "partial", "Type of the last accounts filed, for example micro-entity or dormant.", true, { sortKey: "accountType" }),
  f("dormant", "Dormant", F, "Company.dormant (from the last accounts type)", "stored", "Whether the last accounts filed were dormant accounts.", true, { sortKey: "dormant", filterKey: "dormant" }),
  f("accountRefDate", "Accounting reference date", F, "accounts.accounting_reference_date · Accounts.AccountRefDay / AccountRefMonth", "import", "Day and month the company's financial year ends.", false, { needs: IMPORT }),
  f("confirmationNextDue", "Confirmation statement due", F, "Company.confirmationNextDue · confirmation_statement.next_due · ConfStmtNextDueDate", "partial", "Date the next confirmation statement is due.", true, { sortKey: "confirmationNextDue", filterKey: "confirmationNextDue" }),
  f("confirmationLastMadeUp", "Confirmation last made up", F, "Company.confirmationLastMadeUp · confirmation_statement.last_made_up_to", "partial", "Date the last confirmation statement was made up to.", true, { sortKey: "confirmationLastMadeUp", filterKey: "confirmationLastMadeUp" }),
  f("confirmationOverdue", "Confirmation overdue", F, "Company.confirmationOverdue · confirmation_statement.overdue", "stored", "Set daily for active companies whose confirmation statement is late.", true, { sortKey: "confirmationOverdue", filterKey: "confirmationOverdue" }),
  f("confirmationNextMadeUp", "Confirmation next made up to", F, "confirmation_statement.next_made_up_to", "rest", "Date the next confirmation statement must be made up to.", false, { needs: PROFILE }),
  f("annualReturn", "Annual return dates (legacy)", F, "annual_return.* · Returns.NextDueDate / LastMadeUpDate", "import", "Legacy pre-2016 annual return dates. Mostly stale; not recommended.", false, { needs: IMPORT }),
  f("hasDS01", "DS01 filed", F, "Company.hasDS01", "stored", "Whether an application to strike the company off has been filed.", true, { sortKey: "hasDS01", filterKey: "hasDS01" }),
  f("ds01FiledAt", "DS01 filed date", F, "Company.ds01FiledAt", "enrichment", "Date the DS01 filing was seen on the live filing stream.", true, { sortKey: "ds01FiledAt" }),
  f("filingSummary", "Filing", F, "derived from hasDS01, accountsOverdue, accountsNextDue", "derived", "Combined indicator: DS01 filed, late accounts, or none.", true, { sortKey: "filing" }),
  f("latestFilingEvent", "Latest filing event seen", F, "FilingEvent.type · date", "enrichment", "Most recent filing event recorded from the live stream.", false, { needs: "Needs an extra query per row; not built." }),
  f("filingHistory", "Filing history summary", F, "filing-history items[]", "endpoint", "Latest filing date and counts by category.", false, { needs: ENDPOINT }),

  // ---- Officers (18) ----
  f("directorCount", "Directors", O, "Company.directorCount · officers list", "enrichment", "Confirmed director count. Shown as Not fetched until the officers have been fetched.", true, { sortKey: "directorCount", filterKey: "directorCount" }),
  f("singleDirector", "Single director", O, "Company.singleDirector", "enrichment", "Whether the company has exactly one confirmed director.", true, { sortKey: "singleDirector", filterKey: "singleDirector" }),
  f("officersCoverage", "Officer data status", O, "Company.officersCoverage", "stored", "Fetched, Not fetched or Unavailable.", true, { sortKey: "officersCoverage" }),
  f("officersFetchedAt", "Officers fetched on", O, "Company.officersFetchedAt", "enrichment", "When the officers were last verified.", true, { sortKey: "officersFetchedAt" }),
  f("officersDirtyAt", "Officer change pending", O, "Company.officersDirtyAt", "internal", "Internal flag: an officer change was filed and awaits a re-check.", false),
  f("officersUnavailableReason", "Officer data unavailable reason", O, "Company.officersUnavailableReason", "enrichment", "Why Companies House has no officer data for the company.", true, { sortKey: "officersUnavailableReason", defaultEnabled: false }),
  f("officerCounts", "Active / resigned officers", O, "active_count · resigned_count", "enrichment", "Counts of active and resigned officers.", false, { needs: "Needs a join to the officers table per row; not built." }),
  f("officerNames", "Officer names", O, "Director.name", "enrichment", "Names of the company's officers.", false, { needs: "Needs a join to the officers table per row; not built." }),
  f("officerRoles", "Officer roles", O, "Director.role · officer_role", "enrichment", "Roles such as director or secretary.", false, { needs: "Needs a join to the officers table per row; not built." }),
  f("officerNationalities", "Officer nationalities", O, "Director.nationality · nationality", "enrichment", "Nationalities of the officers.", false, { needs: "Needs a join to the officers table per row; not built." }),
  f("officerOccupations", "Officer occupations", O, "Director.occupation · occupation", "enrichment", "Occupations of the officers.", false, { needs: "Needs a join to the officers table per row; not built." }),
  f("appointmentDates", "Earliest / latest appointment", O, "Director.appointedOn / resignedOn", "enrichment", "Appointment and resignation dates.", false, { needs: "Needs a join to the officers table per row; not built." }),
  f("officerResidence", "Officer country of residence", O, "country_of_residence", "endpoint", "Country where an officer lives.", false, { restricted: true, needs: "Personal data: not stored. " + ENDPOINT }),
  f("officerBirth", "Officer birth month and year", O, "date_of_birth.month / .year", "endpoint", "Officer date of birth (month and year only).", false, { restricted: true, needs: "Personal data: not stored. " + ENDPOINT }),
  f("officerAddress", "Officer correspondence address", O, "address.*", "endpoint", "Officer correspondence address.", false, { restricted: true, needs: "Personal data: not stored. " + ENDPOINT }),
  f("officerVerification", "Officer identity verification", O, "identity_verification_details.*", "endpoint", "Identity verification details.", false, { restricted: true, needs: "Personal data: not stored. " + ENDPOINT }),
  f("officerOtherAppts", "Officer's other appointments", O, "/officers/{id}/appointments", "endpoint", "Other companies an officer is appointed to.", false, { restricted: true, needs: "Personal data. One request per officer." }),
  f("disqualified", "Disqualified officer match", O, "disqualified-officers", "endpoint", "Whether an officer appears on the disqualified officers register.", false, { restricted: true, needs: "Personal data. One request per officer, or the disqualified-officers stream." }),

  // ---- Ownership (PSC) (9) ----
  f("pscCounts", "PSC count (active / ceased)", P, "active_count · ceased_count", "stream", "Number of persons with significant control.", false, { needs: PSC_NEEDS }),
  f("pscNames", "PSC names", P, "items[].name", "stream", "Names of persons with significant control.", false, { restricted: true, needs: "Personal data. " + PSC_NEEDS }),
  f("pscKinds", "PSC kinds", P, "items[].kind", "stream", "Individual, corporate entity, legal person or super-secure.", false, { needs: PSC_NEEDS }),
  f("pscControl", "Natures of control", P, "items[].natures_of_control[]", "stream", "How each PSC controls the company.", false, { needs: PSC_NEEDS }),
  f("pscDates", "PSC notified / ceased dates", P, "notified_on · ceased_on", "stream", "When each PSC was notified or ceased.", false, { needs: PSC_NEEDS }),
  f("pscPersonal", "PSC nationality, residence, birth", P, "nationality · country_of_residence · date_of_birth", "stream", "Personal details of individual PSCs.", false, { restricted: true, needs: "Personal data. " + PSC_NEEDS }),
  f("pscStatements", "PSC statements present", P, "persons-with-significant-control-statements", "stream", "Whether the company has filed PSC statements.", false, { needs: PSC_NEEDS }),
  f("pscSanctioned", "PSC sanctioned (overseas owners)", P, "items[].is_sanctioned", "stream", "Beneficial owner declared as sanctioned.", false, { needs: PSC_NEEDS }),
  f("superSecure", "Super-secure managing officers", P, "super_secure_managing_officer_count", "rest", "Count of super-secure managing officers of an overseas entity.", false, { needs: PROFILE }),

  // ---- Charges, insolvency & other (10) ----
  f("chargeCounts", "Charges (total / outstanding)", X, "Mortgages.NumMortCharges / NumMortOutstanding / NumMortPartSatisfied / NumMortSatisfied", "import", "Number of charges registered against the company.", false, { needs: IMPORT }),
  f("chargeDetails", "Charge details", X, "/charges items", "endpoint", "Dates, status and persons entitled for each charge.", false, { needs: ENDPOINT }),
  f("insolvencyStatus", "Insolvency status", X, "insolvency.status", "endpoint", "Insolvency status of the company.", false, { needs: ENDPOINT }),
  f("insolvencyCases", "Insolvency cases", X, "insolvency.cases[]", "endpoint", "Case types, dates and practitioners.", false, { needs: ENDPOINT }),
  f("exemptions", "Exemptions", X, "/exemptions", "endpoint", "Disclosure exemptions held by the company.", false, { needs: ENDPOINT }),
  f("registersHeld", "Registers held", X, "/registers", "endpoint", "Statutory registers held at Companies House.", false, { needs: ENDPOINT }),
  f("ukEstablishments", "UK establishments", X, "/uk-establishments", "endpoint", "UK establishments of an overseas company.", false, { needs: ENDPOINT }),
  f("foreignDetails", "Foreign company details", X, "foreign_company_details.*", "rest", "Home registry and legal form of an overseas company.", false, { needs: PROFILE }),
  f("branchParent", "UK branch parent company", X, "branch_company_details.*", "rest", "Parent company of a UK branch.", false, { needs: PROFILE }),
  f("partnerCounts", "Partner counts", X, "LimitedPartnerships.NumGenPartners / NumLimPartners", "import", "General and limited partner counts (limited partnerships).", false, { needs: IMPORT }),

  // ---- Data provenance (4) ----
  f("source", "Data source", V, "Company.source", "stored", "Where the record came from, for example bulk import or stream.", true, { sortKey: "source" }),
  f("chLastFetchedAt", "Profile last fetched", V, "Company.chLastFetchedAt", "enrichment", "When the company profile was last fetched from Companies House.", true, { sortKey: "chLastFetchedAt" }),
  f("createdAt", "First imported", V, "Company.createdAt", "internal", "When the record was first created in DIRECTOR.LTD.", false),
  f("updatedAt", "Last updated", V, "Company.updatedAt", "internal", "When the record was last changed in DIRECTOR.LTD.", false),

  // ---- My CRM (8) ----
  f("followed", "Followed", M, "UserCompanyState.followed", "stored", "Whether you follow the company.", true, { filterKey: "followed" }),
  f("saved", "Saved", M, "UserCompanyState.saved", "stored", "Whether you have saved the company.", true, { filterKey: "saved" }),
  f("redFlagged", "Red flagged", M, "UserCompanyState.redFlagged", "stored", "Whether you have red-flagged the company. Your own marker, not an official status.", true, { filterKey: "redFlagged" }),
  f("trashed", "In Trash", M, "UserCompanyState.trashed", "stored", "Whether you have moved the company to Trash.", true, { defaultEnabled: false }),
  f("notesCount", "Notes", M, "Note (count)", "derived", "Number of notes you wrote.", false, { needs: "Needs a per-user count query per row; not built." }),
  f("contactsCount", "Contacts", M, "CrmContact (count)", "derived", "Number of contacts you added.", false, { needs: "Needs a per-user count query per row; not built." }),
  f("followUps", "Open follow-ups", M, "FollowUp", "derived", "Open follow-ups and the next due date.", false, { needs: "Needs a per-user query per row; not built." }),
  f("lastViewedAt", "Last viewed", M, "RecentlyViewed.viewedAt", "derived", "When you last opened the company.", false, { needs: "Needs a per-user lookup per row; not built." }),
];

// Information only: data users may expect but Companies House does not publish. Not part of the 103 options.
export const UNAVAILABLE_FIELDS: { label: string; reason: string }[] = [
  { label: "Turnover, profit, net assets", reason: "Not in the Companies House API. Only inside the Accounts Data Product (XBRL files), which is not collected." },
  { label: "Website, email, phone", reason: "Not published by Companies House. Could only be manual CRM fields or third-party data." },
  { label: "Employee count, revenue band", reason: "Not published by Companies House." },
];

const BY_KEY = new Map(FIELD_CATALOGUE.map((d) => [d.key, d]));
export function getField(key: string): FieldDef | undefined {
  return BY_KEY.get(key);
}

export function isSelectable(key: string): boolean {
  const d = BY_KEY.get(key);
  return !!d && d.selectable && !d.restricted;
}

// What the switch is when the administrator has not touched it. Only the 33 approved Phase 1 columns start on; the other
// eight displayable fields start off and are not part of the Super Admin panel.
export function defaultEnabled(key: string): boolean {
  const d = BY_KEY.get(key);
  if (!d || !isSelectable(key)) return false;
  return d.defaultEnabled !== false;
}
