# DIRECTOR.LTD

Companies House search, filtering, reporting and CRM platform.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · Prisma · SQLite (dev) · custom JWT session auth · real Companies House REST + streaming APIs · Google Calendar OAuth.

## Getting started

```bash
npm install
npm run db:push       # create the local SQLite database from prisma/schema.prisma
npm run db:seed        # seed ~7,000 realistic development companies, directors, users and demo CRM data
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Demo accounts

Seeded by `prisma/seed.ts`, all using the password `DirectorAdmin123!`:

| Email | Role |
|---|---|
| `admin@director.ltd` | Super Admin |
| `ops@director.ltd` | Admin |
| `sales@director.ltd` | User |

## Architecture

- `prisma/schema.prisma` — data model. `Company`/`Director` are real Companies House data (with a `source` field tracking provenance: `seed`/`bulk_import`/`stream`/`rest_enrichment`); `FilingEvent` is the raw filing-stream audit trail; `IngestionRun` records every pipeline run (success/failure/checkpoint); `UserCompanyState`/`Note`/`FollowUp`/`Report`/`ActivityLog` are user CRM data, kept entirely separate from CH source data; `CalendarConnection`/`CalendarEvent` back the calendar integration. Runs on SQLite locally — swap `datasource` to `postgresql` + `DATABASE_URL` for production (every column is plain-typed so this needs no schema changes; see the note in `compile.ts` about restoring case-insensitive string matching on Postgres).
- `src/lib/filters/` — the filter/query-builder engine. `fields.ts` is the single registry of filterable Companies House attributes (using the *real* `company_status`/`company_type`/`account_type` enums — see comments there); `compile.ts` turns a saved AND/OR/nested filter tree into a Prisma `where` clause. Add a new filter by adding one entry to the registry.
- `src/lib/companies-house/` — the real Companies House integration:
  - `client.ts` — REST/streaming HTTP client (Basic Auth, rate-limit aware).
  - `profile.ts` / `officers.ts` — map real API responses to our schema. `dormant` is derived strictly from `accounts.last_accounts.type`, never from `company_status`. `hasDS01` is derived from `company_status_detail === "active-proposal-to-strike-off"` or a streamed `DS01` filing event — the Advanced Search API's `company_status` filter only accepts the 12 real top-level status values (active, dissolved, liquidation, receivership, converted-closed, voluntary-arrangement, insolvency-proceedings, administration, open, closed, registered, removed); `active-proposal-to-strike-off` is a `company_status_detail` value only the full profile endpoint exposes.
  - `sync.ts` — DB-touching sync functions used by lazy-fetch (company detail page), the stream worker, and the backfill queue.
  - `bulkIngest.ts` — two ingestion paths: `bulkIngestFromSearch` (fast, real, uses the Advanced Search API — good for dev/testing a real slice) and `bulkIngestFromCsv` (production-scale: streams the official monthly "Free Company Data Product" CSV, ~5M rows, batched + resumable via `IngestionRun.checkpoint`).
  - `streamWorker.ts` — long-lived consumer of the filing stream. Every event is deduped on `transactionId`; `DS01` events trigger an immediate profile refresh.
  - `dailyUpdate.ts` — the real scheduled job: recomputes overdue flags, advances the rate-limited officer-backfill queue, refreshes every `dailyRefresh` report, and records an `IngestionRun`.
- `src/lib/calendar/` — provider-agnostic calendar integration (`types.ts` defines the `CalendarProvider` interface every provider implements identically). `providers/internal.ts` is the always-on fallback; `providers/google.ts` is a real, working Google Calendar OAuth2 integration (encrypted token storage via `token-crypto.ts`, a dedicated "DIRECTOR.LTD Follow-ups" calendar per user). Adding Microsoft/Outlook means one new file implementing the same interface — no changes to the CRM/follow-up code.
- `src/lib/auth/` — password hashing, signed JWT session cookies, role-based route guards (`USER` < `ADMIN` < `SUPER_ADMIN`), enforced server-side in both `src/proxy.ts` (page routes) and every API route individually.
- `src/app/(app)/` — the authenticated app shell and pages. Settings and Super Admin show **real** pipeline/calendar health (data-source breakdown, last successful/failed run per job kind, officer-data coverage %) — not hardcoded claims.
- `src/app/api/` — REST route handlers backing every mutation, plus `api/calendar/*` for the OAuth connect/callback/disconnect/status flow.

### Director/officer data coverage

Officer data isn't in the monthly bulk file at all — only per-company via REST or the officers stream. Coverage is intentionally partial and tracked explicitly (`Company.officersCoverage`: `none`/`partial`/`full`, visible in Settings): a company gets its directors fetched (and cached) the first time it's viewed or matched, the daily update job advances a rate-limited backfill queue (active companies first), and `dailyRefresh` reports never claim director-count accuracy beyond what's actually been fetched.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | always | SQLite file locally; Postgres connection string in production |
| `AUTH_SECRET` | always | Signs session JWTs |
| `COMPANIES_HOUSE_API_KEY` | for real data | CH REST API (company profile, officers, search) |
| `COMPANIES_HOUSE_STREAM_KEY` | for real-time DS01 | CH filing stream |
| `TOKEN_ENCRYPTION_KEY` | for calendar | Encrypts OAuth tokens at rest — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `GOOGLE_CALENDAR_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` | for Google Calendar | See manual setup below |

## Manual setup

1. **Companies House credentials** — already configured server-side for this environment. If rotating (recommended if any key was ever committed or shared in plaintext): [Companies House Developer Hub](https://developer.company-information.service.gov.uk/) → your application → regenerate → update `COMPANIES_HOUSE_API_KEY`/`COMPANIES_HOUSE_STREAM_KEY` in `.env`. Free.
2. **Google Calendar OAuth** (only needed to test the live "Connect" flow in Settings — the code ships ready regardless):
   - [Google Cloud Console](https://console.cloud.google.com/) → new or existing project → **APIs & Services → Library** → enable "Google Calendar API".
   - **APIs & Services → OAuth consent screen** → External → add your Companies House-linked Google account as a test user (keeps it out of Google's review queue while testing).
   - **APIs & Services → Credentials** → Create Credentials → OAuth client ID → Web application → Authorized redirect URI: `http://localhost:3000/api/calendar/callback/google` (add your production URL later too).
   - Copy the Client ID and Client Secret into `.env` as `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`. Free.
3. **Production Postgres + AWS** — not needed for development; only at actual deployment time.

## Daily update pipeline (production shape)

- `npm run ch:bulk-ingest` / `npm run ch:daily-update` are short-running jobs — an **AWS EventBridge scheduled rule → Lambda or ECS Fargate task** is the right shape.
- `npm run ch:stream` holds a persistent HTTP connection open — it needs an **always-on process (ECS/Fargate task, not Lambda)**, since Lambda's execution-time limit is wrong for a long-lived stream consumer.

## Useful scripts

```bash
npm run db:studio        # browse the local database
npm run db:push          # re-sync schema.prisma to the dev database
npm run db:seed          # reset and reseed development data
npm run ch:bulk-ingest -- --status active --limit 2000 --enrich 200   # real data, Advanced Search API
npm run ch:bulk-ingest -- --csv [--limit N]                            # real data, full monthly bulk CSV
npm run ch:stream         # long-lived filing-stream consumer (Ctrl+C to stop)
npm run ch:daily-update   # run the daily update job once, manually
npm run lint
npx tsc --noEmit
npm run build
```
