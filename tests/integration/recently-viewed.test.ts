import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, db, makeCompany, sessionFor, type Session } from "./helpers";
import { listRecentlyViewed, RECENTLY_VIEWED_MAX } from "../../src/lib/data/recently-viewed";

after(async () => {
  await db.$disconnect();
});

const open = (s: Session, companyId: string) => fetch(`${BASE}/companies/${companyId}`, { headers: { cookie: `director_session=${s.cookie}` } });
const dashboard = async (s: Session) => (await fetch(`${BASE}/dashboard`, { headers: { cookie: `director_session=${s.cookie}` } })).text();

test("opening a company records it once per user and moves it to the front when reopened", async () => {
  const u = await sessionFor("USER", "rv");
  const tag = `RV${Date.now() % 10000000}`;
  const [c1, c2, c3] = [await makeCompany({ name: `${tag} ONE` }), await makeCompany({ name: `${tag} TWO` }), await makeCompany({ name: `${tag} THREE` })];
  for (const c of [c1, c2, c3]) assert.equal((await open(u, c.id)).status, 200);
  assert.deepEqual((await listRecentlyViewed(u.userId)).map((c) => c.name), [`${tag} THREE`, `${tag} TWO`, `${tag} ONE`]);

  // Reopening an older company does not add a row; it only moves it to the front.
  await open(u, c1.id);
  assert.equal(await db.recentlyViewed.count({ where: { userId: u.userId } }), 3);
  assert.deepEqual((await listRecentlyViewed(u.userId)).map((c) => c.name), [`${tag} ONE`, `${tag} THREE`, `${tag} TWO`]);

  // The dashboard shows them, newest first.
  const html = await dashboard(u);
  assert.match(html, /Recently viewed/);
  assert.ok(html.indexOf(`${tag} ONE`) > -1 && html.indexOf(`${tag} ONE`) < html.indexOf(`${tag} TWO`));
});

test("recently viewed is per user and never shows another user's history", async () => {
  const a = await sessionFor("USER", "rva");
  const b = await sessionFor("USER", "rvb");
  const tag = `RW${Date.now() % 10000000}`;
  const c = await makeCompany({ name: `${tag} ONLYA` });
  await open(a, c.id);
  assert.match(await dashboard(a), new RegExp(`${tag} ONLYA`));
  assert.doesNotMatch(await dashboard(b), new RegExp(`${tag} ONLYA`));
  assert.equal((await listRecentlyViewed(b.userId)).length, 0);
});

test("the recently viewed list is bounded", async () => {
  const u = await sessionFor("USER", "rvmax");
  const tag = `RX${Date.now() % 10000000}`;
  for (let i = 0; i < RECENTLY_VIEWED_MAX + 3; i++) {
    const c = await makeCompany({ name: `${tag} ${i}` });
    await db.recentlyViewed.create({ data: { userId: u.userId, companyId: c.id, viewedAt: new Date(Date.now() - i * 1000) } });
  }
  assert.equal((await listRecentlyViewed(u.userId, 10_000)).length, RECENTLY_VIEWED_MAX);
  assert.equal((await listRecentlyViewed(u.userId)).length, 10);
  assert.equal((await listRecentlyViewed(u.userId, 5))[0].name, `${tag} 0`);
});

// A database that has not had the recently_viewed migration applied yet must not take the dashboard down: the section
// is empty and everything else renders. The table is renamed away and restored on the scratch database only.
test("the dashboard still loads (empty Recently viewed) while the RecentlyViewed table is missing", async () => {
  const u = await sessionFor("USER", "rvmiss");
  const c = await makeCompany({ name: `RM${Date.now() % 10000000} MISSING` });
  await db.$executeRawUnsafe('ALTER TABLE "RecentlyViewed" RENAME TO "RecentlyViewed_hidden"');
  try {
    const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: `director_session=${u.cookie}` } });
    assert.equal(dash.status, 200);
    const html = await dash.text();
    assert.match(html, /Recently viewed/);
    assert.match(html, /Companies you open appear here/);
    // Opening a company is best effort and still works.
    assert.equal((await open(u, c.id)).status, 200);
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "RecentlyViewed_hidden" RENAME TO "RecentlyViewed"');
  }
});
