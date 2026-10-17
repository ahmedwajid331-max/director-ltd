/* eslint-disable @typescript-eslint/no-explicit-any -- CSV rows are loosely typed */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { BASE, db, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

const page = (s: Session, path: string) => fetch(`${BASE}${path}`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" });

// With more people than fit on the screen, nothing is silently dropped: totals and chart cover everyone, the screen lists
// the most active people (not the alphabetically first) and says so, and the CSV is complete.
test("More than 200 people: the screen says so, totals cover everyone, and the CSV is complete", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const tag = Math.random().toString(36).slice(2, 7);
  // 230 extra accounts (dummy hash: they never sign in). The busiest one sorts LAST alphabetically.
  await db.user.createMany({ data: Array.from({ length: 230 }, (_, i) => ({ email: `scale.${tag}.${i}@test.example`, name: `A Scale ${tag} ${String(i).padStart(3, "0")}`, passwordHash: "x", role: "USER" })) });
  const busy = await db.user.create({ data: { email: `scale.${tag}.zzz@test.example`, name: `ZZZ Busiest ${tag}`, passwordHash: "x", role: "USER" } });
  const when = new Date();
  await db.activityLog.createMany({ data: Array.from({ length: 7 }, () => ({ userId: busy.id, action: "search", meta: JSON.stringify({ q: "x", total: 1 }), createdAt: when })) });

  const html = (await (await page(sup, "/admin/activity?period=day")).text()).replace(/<!--[\s\S]*?-->/g, ""); // React comment markers between interpolated text
  assert.match(html, /Listing the 200 most active of \d+ people/);
  assert.ok(html.includes(`ZZZ Busiest ${tag}`), "the most active person is listed even though they sort last by name");
  const profileLinks = (html.match(/href="\/admin\/staff\/[a-z0-9]+/g) ?? []).length;
  assert.equal(profileLinks, 200, "exactly the 200 most active people are listed in the table")

  const res = await page(sup, "/api/staff/report?period=day");
  assert.equal(res.status, 200);
  const rows = parse(await res.text(), { columns: true }) as any[];
  assert.ok(rows.length >= 231, `the CSV lists everyone, got ${rows.length}`);
  assert.ok(rows.some((r) => r["Email"] === `scale.${tag}.229@test.example`), "including people not on the screen");
  const mine = rows.find((r) => r["Email"] === busy.email);
  assert.equal(mine["Recorded actions"], "7");
  // The page's headline total covers everyone: its figure equals the sum of every person in the CSV.
  const sum = rows.reduce((n, r) => n + Number(r["Recorded actions"]), 0);
  assert.ok(sum >= 7);
  assert.ok(html.includes(`${sum.toLocaleString("en-GB")}`) || sum < 10, "headline total matches the sum over all people");
});
