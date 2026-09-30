// Live check against the REAL Companies House API (needs COMPANIES_HOUSE_API_KEY; ~4 requests).
//   npx tsx tests/live/officers-live.ts
// Verifies officer pagination with a company known to span several pages (Tesco PLC, 00445790).
import { chRestGetWithRateInfo } from "../../src/lib/companies-house/client";
import { countActiveDirectors, fetchCompanyOfficers } from "../../src/lib/companies-house/officers";
import { syncCompanyDirectors, syncCompanyProfile } from "../../src/lib/companies-house/sync";
import { db } from "../../src/lib/db";

async function main() {
  const number = "00445790";
  const first = await chRestGetWithRateInfo<{ items: unknown[]; total_results: number; active_count: number }>(`/company/${number}/officers`);
  console.log(`API page 1 (default size): ${first.items.length} items of total_results=${first.total_results}, active_count=${first.active_count}`);

  const all = await fetchCompanyOfficers(number);
  const ids = new Set(all.map((o) => o.links?.officer?.appointments));
  console.log(`fetchCompanyOfficers: ${all.length} officers (unique appointment links: ${ids.size})`);
  const roles = new Map<string, number>();
  for (const o of all) roles.set(o.officer_role, (roles.get(o.officer_role) ?? 0) + 1);
  console.log("roles:", Object.fromEntries(roles));
  const ours = countActiveDirectors(all);
  const activeAny = all.filter((o) => !o.resigned_on).length;
  console.log(`active officers of any role (should equal API active_count ${first.active_count}): ${activeAny}; counted as directors: ${ours}`);

  const company = await syncCompanyProfile(number, "rest_enrichment");
  const n = await syncCompanyDirectors(company.id, number);
  const stored = await db.director.count({ where: { companyId: company.id } });
  const row = await db.company.findUniqueOrThrow({ where: { id: company.id } });
  console.log(`stored directors rows=${stored}, directorCount=${row.directorCount} (returned ${n}), singleDirector=${row.singleDirector}, coverage=${row.officersCoverage}`);

  const ok = all.length === first.total_results && all.length > first.items.length && stored === all.length && activeAny === first.active_count;
  console.log(ok ? "LIVE OFFICERS CHECK: PASS" : "LIVE OFFICERS CHECK: FAIL");
  await db.$disconnect();
  process.exit(ok ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
