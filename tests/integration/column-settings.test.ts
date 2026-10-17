import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, api, db, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

const page = (s: Session | null, path: string) =>
  fetch(`${BASE}${path}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });

const put = (s: Session, columns: unknown, baseLayoutId?: string | null) => api(s, "/api/columns/preference", { method: "PUT", body: { columns, baseLayoutId } });
const config = (s: Session) => api(s, "/api/columns/config");
const fieldSwitch = (s: Session, updates: { key: string; enabled: boolean }[]) => api(s, "/api/admin/columns/fields", { method: "PUT", body: { updates } });

// Tests share one database, so each restores any administrator setting it changes.
async function restoreSwitches(keys: string[]) {
  await db.columnFieldSetting.deleteMany({ where: { key: { in: keys } } });
}

test("access control: anonymous, user and admin are refused; super admin is allowed", async () => {
  const user = await sessionFor("USER", "cs");
  const admin = await sessionFor("ADMIN", "cs");
  const sa = await sessionFor("SUPER_ADMIN", "cs");

  assert.equal((await api(null, "/api/columns/config")).status, 401);
  assert.equal((await api(null, "/api/admin/columns")).status, 401);
  assert.equal((await api(user, "/api/admin/columns")).status, 403);
  assert.equal((await api(admin, "/api/admin/columns")).status, 403);
  assert.equal((await fieldSwitch(user, [{ key: "registeredCounty", enabled: false }])).status, 403);
  assert.equal((await api(admin, "/api/admin/columns/layouts", { body: { name: "x", columns: ["name"] } })).status, 403);

  const ok = await api(sa, "/api/admin/columns");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.fields.length, 103);
  assert.ok(ok.json.layouts.length >= 1 && ok.json.layouts.some((l: { isDefault: boolean }) => l.isDefault));
  assert.equal(ok.json.unavailable.length, 3);
});

test("the Super Admin page keeps its dashboard and gains the new tab; the new page is Super Admin only", async () => {
  const user = await sessionFor("USER", "csp");
  const admin = await sessionFor("ADMIN", "csp");
  const sa = await sessionFor("SUPER_ADMIN", "csp");

  const overview = await (await page(sa, "/admin")).text();
  assert.match(overview, /System-wide oversight/);
  assert.match(overview, /Companies House pipeline health/);
  assert.match(overview, /Column &amp; Default Settings/);

  const cols = await page(sa, "/admin/columns");
  assert.equal(cols.status, 200);
  assert.match(await cols.text(), /Column &amp; Default Settings/);

  for (const s of [user, admin]) {
    const res = await page(s, "/admin/columns");
    assert.ok([302, 303, 307, 308].includes(res.status), `expected a redirect, got ${res.status}`);
    assert.match(res.headers.get("location") ?? "", /dashboard/);
  }
  assert.ok([302, 303, 307, 308].includes((await page(null, "/admin/columns")).status));
});

test("a user with nothing saved gets the recommended layout; the company pages still load", async () => {
  const u = await sessionFor("USER", "csd");
  const c = await config(u);
  assert.equal(c.status, 200);
  assert.equal(c.json.hasSaved, false);
  assert.equal(c.json.recommendedChanged, false);
  assert.equal(c.json.columns[0], "name");
  assert.ok(c.json.fields.every((f: { key: string }) => f.key !== "officerBirth" && f.key !== "previousNames"), "restricted / unavailable fields are never offered");
  for (const path of ["/companies", "/watches", "/saved", "/red-flags", "/trash", "/settings"]) {
    assert.equal((await page(u, path)).status, 200, path);
  }
});

test("saving, reloading and resetting a personal default", async () => {
  const u = await sessionFor("USER", "css");
  const mine = ["name", "registeredCounty", "accountsNextDue", "status"];
  const saved = await put(u, mine);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.columns, mine);

  const c = await config(u);
  assert.equal(c.json.hasSaved, true);
  assert.deepEqual(c.json.columns, mine);
  assert.deepEqual(JSON.parse((await db.userColumnPreference.findUniqueOrThrow({ where: { userId: u.userId } })).columnsJson), mine);

  const reset = await api(u, "/api/columns/preference", { method: "DELETE" });
  assert.equal(reset.status, 200);
  const after = await config(u);
  assert.equal(after.json.hasSaved, false);
  assert.notDeepEqual(after.json.columns, mine);
});

test("bad column lists are rejected and nothing is stored", async () => {
  const u = await sessionFor("USER", "csv");
  const bad = async (cols: unknown, re: RegExp) => {
    const r = await put(u, cols);
    assert.equal(r.status, 400, JSON.stringify(cols));
    assert.match(r.json.error, re);
  };
  await bad([], /at least one/i);
  await bad(["status", "name"], /first/i);
  await bad(["name", "status", "status"], /once/i);
  await bad(["name", "nonsense"], /not an available/);
  await bad(["name", "previousNames"], /not an available/); // data not imported
  await bad(["name", "officerBirth"], /not an available/); // personal data
  await bad(["name", "officersDirtyAt"], /not an available/); // internal
  assert.equal(await db.userColumnPreference.count({ where: { userId: u.userId } }), 0);
});

test("users only ever change their own preference", async () => {
  const a = await sessionFor("USER", "csa");
  const b = await sessionFor("USER", "csb");
  await put(a, ["name", "status"]);
  await put(b, ["name", "type", "registeredCity"]);
  await api(a, "/api/columns/preference", { method: "DELETE" });
  assert.deepEqual((await config(b)).json.columns, ["name", "type", "registeredCity"]);
  assert.equal((await config(a)).json.hasSaved, false);
});

test("switching a field off hides it for users but never erases their saved choice; switching on restores it", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "csw");
  const u = await sessionFor("USER", "csw");
  const mine = ["name", "registeredCounty", "companyNumber"];
  try {
    await put(u, mine);
    assert.equal((await fieldSwitch(sa, [{ key: "registeredCounty", enabled: false }])).status, 200);

    const hidden = await config(u);
    assert.ok(!hidden.json.columns.includes("registeredCounty"));
    assert.ok(hidden.json.fields.every((f: { key: string }) => f.key !== "registeredCounty"));
    // the stored preference is untouched
    assert.deepEqual(JSON.parse((await db.userColumnPreference.findUniqueOrThrow({ where: { userId: u.userId } })).columnsJson), mine);
    // and a user cannot newly save the switched-off field
    assert.equal((await put(u, ["name", "registeredCounty"])).status, 400);

    assert.equal((await fieldSwitch(sa, [{ key: "registeredCounty", enabled: true }])).status, 200);
    assert.deepEqual((await config(u)).json.columns, mine);
  } finally {
    await restoreSwitches(["registeredCounty"]);
  }
});

test("administrator switches: only fields that can be shown can be switched; Company cannot be switched off", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "csx");
  assert.equal((await fieldSwitch(sa, [{ key: "previousNames", enabled: true }])).status, 400);
  assert.equal((await fieldSwitch(sa, [{ key: "officerBirth", enabled: true }])).status, 400);
  assert.equal((await fieldSwitch(sa, [{ key: "createdAt", enabled: true }])).status, 400);
  assert.equal((await fieldSwitch(sa, [{ key: "name", enabled: false }])).status, 400);
  assert.equal((await fieldSwitch(sa, [{ key: "does-not-exist", enabled: true }])).status, 400);
  assert.equal((await db.columnFieldSetting.count({ where: { key: { in: ["previousNames", "officerBirth", "createdAt", "name", "does-not-exist"] } } })), 0);
});

test("layouts: create, rename, edit, duplicate, default and delete, with the safeguards", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "csl");
  const user = await sessionFor("USER", "csl");
  const tag = `L${Date.now() % 1000000}`;
  const created: string[] = [];
  try {
    const l1 = await api(sa, "/api/admin/columns/layouts", { body: { name: `${tag} one`, columns: ["name", "status", "type"] } });
    assert.equal(l1.status, 201);
    created.push(l1.json.id);
    assert.equal(l1.json.isDefault, false);
    assert.equal(l1.json.version, 1);

    // duplicate name
    assert.equal((await api(sa, "/api/admin/columns/layouts", { body: { name: `${tag} one`, columns: ["name"] } })).status, 409);
    // invalid columns
    assert.equal((await api(sa, "/api/admin/columns/layouts", { body: { name: `${tag} bad`, columns: ["status", "name"] } })).status, 400);
    assert.equal((await api(sa, "/api/admin/columns/layouts", { body: { name: `${tag} bad2`, columns: ["name", "officerBirth"] } })).status, 400);

    // rename keeps the version; changing columns increases it
    const renamed = await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "PATCH", body: { name: `${tag} renamed` } });
    assert.equal(renamed.json.name, `${tag} renamed`);
    assert.equal(renamed.json.version, 1);
    const edited = await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "PATCH", body: { columns: ["name", "type", "status", "registeredCity"] } });
    assert.equal(edited.json.version, 2);
    assert.deepEqual(edited.json.columns, ["name", "type", "status", "registeredCity"]);

    // duplicate
    const dup = await api(sa, `/api/admin/columns/layouts/${l1.json.id}/duplicate`, { method: "POST" });
    assert.equal(dup.status, 201);
    created.push(dup.json.id);
    assert.match(dup.json.name, /\(copy\)/);
    assert.deepEqual(dup.json.columns, edited.json.columns);

    // a user cannot touch layouts
    assert.equal((await api(user, `/api/admin/columns/layouts/${l1.json.id}`, { method: "DELETE" })).status, 403);

    // make default, then the old default cannot be deleted while default and the new default cannot be un-defaulted directly
    const before = (await api(sa, "/api/admin/columns")).json.layouts.find((l: { isDefault: boolean }) => l.isDefault);
    const made = await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "PATCH", body: { isDefault: true } });
    assert.equal(made.json.isDefault, true);
    const layouts = (await api(sa, "/api/admin/columns")).json.layouts;
    assert.equal(layouts.filter((l: { isDefault: boolean }) => l.isDefault).length, 1);
    assert.equal((await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "DELETE" })).status, 400);
    assert.equal((await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "PATCH", body: { isDefault: false } })).status, 400);

    // restore the original default, then delete ours
    await api(sa, `/api/admin/columns/layouts/${before.id}`, { method: "PATCH", body: { isDefault: true } });
    assert.equal((await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await api(sa, `/api/admin/columns/layouts/${l1.json.id}`, { method: "DELETE" })).status, 404);
  } finally {
    await db.columnLayout.deleteMany({ where: { id: { in: created } } });
  }
});

test("changing the recommended layout never overwrites a user's own columns, and the user chooses what to do", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "csr");
  const mine = await sessionFor("USER", "csr");
  const follower = await sessionFor("USER", "csr");
  const tag = `R${Date.now() % 1000000}`;
  const original = (await api(sa, "/api/admin/columns")).json.layouts.find((l: { isDefault: boolean }) => l.isDefault);
  let newId: string | null = null;
  try {
    const saved = ["name", "type", "registeredCounty"];
    await put(mine, saved);
    assert.equal((await config(mine)).json.recommendedChanged, false);

    // the administrator publishes a different recommendation
    const l = await api(sa, "/api/admin/columns/layouts", { body: { name: `${tag} new`, columns: ["name", "status", "dormant"], makeDefault: true } });
    assert.equal(l.status, 201);
    newId = l.json.id;

    // a user without saved columns follows it immediately
    assert.deepEqual((await config(follower)).json.columns, ["name", "status", "dormant"]);

    // the user with saved columns keeps them and is told
    const c = await config(mine);
    assert.deepEqual(c.json.columns, saved);
    assert.equal(c.json.hasSaved, true);
    assert.equal(c.json.recommendedChanged, true);
    assert.deepEqual(JSON.parse((await db.userColumnPreference.findUniqueOrThrow({ where: { userId: mine.userId } })).columnsJson), saved);

    // "Keep mine" dismisses the notice and changes nothing else
    assert.equal((await api(mine, "/api/columns/preference", { method: "PATCH" })).status, 200);
    const kept = await config(mine);
    assert.equal(kept.json.recommendedChanged, false);
    assert.deepEqual(kept.json.columns, saved);

    // editing the recommended columns again raises the notice again
    await api(sa, `/api/admin/columns/layouts/${newId}`, { method: "PATCH", body: { columns: ["name", "status", "dormant", "type"] } });
    assert.equal((await config(mine)).json.recommendedChanged, true);

    // "Use the recommendation" = reset: they now follow it
    await api(mine, "/api/columns/preference", { method: "DELETE" });
    assert.deepEqual((await config(mine)).json.columns, ["name", "status", "dormant", "type"]);
  } finally {
    await api(sa, `/api/admin/columns/layouts/${original.id}`, { method: "PATCH", body: { isDefault: true } });
    if (newId) await db.columnLayout.deleteMany({ where: { id: newId } });
  }
});

test("deleting a layout a user started from does not touch their saved columns", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "csq");
  const u = await sessionFor("USER", "csq");
  const tag = `Q${Date.now() % 1000000}`;
  const l = await api(sa, "/api/admin/columns/layouts", { body: { name: `${tag} temp`, columns: ["name", "status"] } });
  try {
    const saved = ["name", "companyNumber", "type"];
    assert.equal((await put(u, saved, l.json.id)).status, 200);
    assert.equal((await api(sa, `/api/admin/columns/layouts/${l.json.id}`, { method: "DELETE" })).status, 200);
    const c = await config(u);
    assert.deepEqual(c.json.columns, saved);
    assert.equal(c.json.recommendedChanged, true, "told that the recommendation they started from is gone");
  } finally {
    await db.columnLayout.deleteMany({ where: { id: l.json.id } });
  }
});

test("column settings changes are written to the activity log", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "csa2");
  try {
    await fieldSwitch(sa, [{ key: "registeredCounty", enabled: false }]);
    const log = await db.activityLog.findFirst({ where: { userId: sa.userId, action: "column_settings_changed" }, orderBy: { createdAt: "desc" } });
    assert.ok(log);
    assert.match(log!.meta ?? "", /field_switches/);
  } finally {
    await restoreSwitches(["registeredCounty"]);
  }
});

test("reading the column configuration is cheap (small tables only, no company-table work)", async () => {
  const u = await sessionFor("USER", "csperf");
  await config(u); // warm
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    const r = await config(u);
    assert.equal(r.status, 200);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`# /api/columns/config median ${median.toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`);
  assert.ok(median < 500, `median ${median} ms is too slow for a three-small-table read`);
});
