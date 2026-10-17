import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, api, db, makeCompany, sessionFor, STRONG_PASSWORD } from "./helpers";
import { findChrome, launchPage, type BrowserPage } from "../support/browser";

// Real-browser check of the company table's data-state wording: what each state means, in the page the user actually sees.
// Never-fetched, fetched-with-value, fetched-with-no-value and genuinely-not-applicable must not read the same.

after(async () => {
  await db.$disconnect();
});

const chrome = findChrome();
const uniq = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const COLUMNS = ["name", "companyNumber", "statusDetail", "accountType", "dormant", "hasDS01", "ds01FiledAt", "officersCoverage", "officersFetchedAt", "directorCount", "source", "chLastFetchedAt"];

// Header text -> cell text for the row that contains `name`.
const rowCells = (p: BrowserPage, name: string) =>
  p.eval<Record<string, string>>(`(() => {
    const table = document.querySelector("table");
    const heads = [...table.querySelectorAll("thead th")].map((h) => h.innerText.split("\\n")[0].trim().toLowerCase());
    const tr = [...table.querySelectorAll("tbody tr")].find((r) => r.innerText.includes(${JSON.stringify(name)}));
    if (!tr) return {};
    const cells = [...tr.children].map((c) => c.innerText.trim());
    const out = {};
    heads.forEach((h, i) => { out[h] = cells[i]; });
    return out;
  })()`);

test("Company table: each data state reads for what it is, in a real browser; a detail-page fetch shows in the list on return", { skip: chrome ? false : "Chrome is not installed", timeout: 240_000 }, async () => {
  const tag = uniq();
  const me = await sessionFor("SUPER_ADMIN", "colbrowser");
  const pref = await api(me, "/api/columns/preference", { method: "PUT", body: { columns: COLUMNS } });
  assert.equal(pref.status, 200, pref.text);

  // A: only ever seen in the bulk file. B: profile + officers fetched from Companies House, no status detail, has accounts.
  // C: strike-off proposal from the bulk file (no DS01 date). D: accounts filed but their type is not recorded.
  const old = new Date("2025-03-31T00:00:00Z");
  const fetchedAt = new Date("2026-10-08T10:00:00Z");
  const A = await makeCompany({ name: `AAA ${tag} NEVER FETCHED LTD`, source: "bulk_import", chLastFetchedAt: new Date("2026-10-06T17:00:00Z") });
  const B = await makeCompany({
    name: `AAB ${tag} FETCHED LTD`, source: "stream", chLastFetchedAt: fetchedAt, accountType: "micro-entity", accountsLastMadeUp: old,
    officersCoverage: "full", officersFetchedAt: fetchedAt, directorCount: 2, singleDirector: false,
  });
  const C = await makeCompany({ name: `AAC ${tag} STRIKE OFF LTD`, source: "bulk_import", hasDS01: true, statusDetail: "active-proposal-to-strike-off", accountType: "micro-entity", accountsLastMadeUp: old });
  const D = await makeCompany({ name: `AAD ${tag} TYPE MISSING LTD`, source: "bulk_import", accountsLastMadeUp: old });

  const page = await launchPage(9340 + Math.floor(Math.random() * 400));
  try {
    await page.setViewport(1600, 900);
    await page.goto(`${BASE}/login`);
    await page.type('input[type="email"]', me.email);
    await page.type('input[type="password"]', STRONG_PASSWORD);
    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Sign in")).click()`);
    await page.waitFor(`location.pathname !== "/login"`);

    await page.goto(`${BASE}/companies?q=${tag}`);
    await page.waitFor(`document.querySelectorAll("table tbody tr").length >= 4 && document.body.innerText.includes(${JSON.stringify(`AAD ${tag}`)})`, 30_000);

    const a = await rowCells(page, `AAA ${tag}`);
    assert.equal(a["status detail"], "Not fetched", "bulk-only: not confirmed absent");
    assert.equal(a["profile fetched"], "Not fetched", "the bulk import date is not a profile fetch");
    assert.equal(a["accounts type"], "No accounts filed");
    assert.equal(a["dormant"], "No accounts filed");
    assert.equal(a["officer data"], "Not fetched");
    assert.equal(a["directors"], "Not fetched");
    assert.equal(a["ds01 date"], "Not applicable", "no DS01 filed: the date does not apply");

    const b = await rowCells(page, `AAB ${tag}`);
    assert.equal(b["status detail"], "None recorded", "profile fetched, no detail given");
    assert.match(b["profile fetched"], /\d{2} \w{3} \d{4}/, "a real fetch shows its date");
    assert.equal(b["accounts type"], "Micro entity");
    assert.equal(b["officer data"], "Fetched");
    assert.match(b["directors"], /^2\b/);

    const c = await rowCells(page, `AAC ${tag}`);
    assert.equal(c["status detail"], "Active proposal to strike off");
    assert.equal(c["ds01 date"], "Not recorded");

    const d = await rowCells(page, `AAD ${tag}`);
    assert.equal(d["accounts type"], "Not recorded", "accounts filed, type missing");

    // Detail page agrees about the profile fetch, then a fetch that happens there shows up in the list on return.
    await page.goto(`${BASE}/companies/${A.id}`);
    await page.waitFor(`document.body.innerText.toLowerCase().includes("profile last fetched")`);
    assert.match(await page.eval<string>(`document.body.innerText`), /profile last fetched\s*not fetched/i);
    await db.company.update({ where: { id: A.id }, data: { officersCoverage: "full", officersFetchedAt: new Date(), directorCount: 3, singleDirector: false } });
    await page.eval(`history.back()`);
    await page.waitFor(`location.pathname === "/companies"`);
    await page.waitFor(`(() => { const tr = [...document.querySelectorAll("table tbody tr")].find((r) => r.innerText.includes(${JSON.stringify(`AAA ${tag}`)})); return !!tr && /(^|\\s)3(\\s|$)/.test(tr.innerText); })()`, 20_000);
    assert.match((await rowCells(page, `AAA ${tag}`))["directors"], /^3\b/, "the list shows the officers fetched on the detail page");

    // The same states in the CSV export.
    const csv = await api(me, "/api/companies/export", { body: { q: tag, columns: COLUMNS } });
    assert.equal(csv.status, 200, csv.text.slice(0, 200));
    assert.match(csv.text, /Not fetched/);
    assert.match(csv.text, /None recorded/);
    assert.match(csv.text, /No accounts filed/);
  } finally {
    await page.close();
    void [B, C, D];
  }
});
