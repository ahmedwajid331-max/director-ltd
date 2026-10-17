import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, BASE, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";
import { runDailyUpdate } from "../../src/lib/companies-house/dailyUpdate";
import { JobAlreadyRunningError } from "../../src/lib/jobs/runs";
import { formatDate } from "../../src/lib/data/format";

after(async () => {
  await db.$disconnect();
});

const uniq = () => Math.random().toString(36).slice(2, 8);
// Strip React's comment markers so interpolated text reads as it does on screen.
const html = async (s: Session, path: string) => (await (await fetch(`${BASE}${path}`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" })).text()).replace(/<!--[\s\S]*?-->/g, "");
const filterFor = (tag: string) => group("AND", rule("name", "startsWith", `ARF ${tag}`));
const mkReport = async (s: Session, tag: string, dailyRefresh: boolean, name = `rep ${uniq()}`) => {
  const r = await api(s, "/api/reports", { body: { name, filter: filterFor(tag), dailyRefresh } });
  assert.equal(r.status, 200, r.text);
  return r.json.report.id as string;
};
const row = (id: string) => db.report.findUniqueOrThrow({ where: { id } });
// The text of the "Last automatic update" cell for one report on the archive page.
const archiveCell = (page: string, name: string) => {
  const i = page.indexOf(name);
  assert.ok(i >= 0, `${name} is on the archive`);
  const tr = page.slice(page.lastIndexOf("<tr", i), page.indexOf("</tr>", i));
  const tds = tr.split("</td>");
  return tds[5].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); // # | report | created | results | daily refresh | LAST AUTOMATIC UPDATE
};
const detailValue = (page: string) => {
  const i = page.indexOf("Last automatic daily update");
  assert.ok(i >= 0);
  return page.slice(i, i + 400).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace("Last automatic daily update", "").trim().split(" Results last computed")[0].trim();
};

// ---------------------------------------------------------------- 1 + 2: a new report has NOT been automatically refreshed
test("A new report never claims an automatic update: daily refresh ON -> 'Not yet updated', OFF -> 'Not scheduled'", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  const before = Date.now();
  const onId = await mkReport(s, tag, true, `ON ${tag}`);
  const offId = await mkReport(s, tag, false, `OFF ${tag}`);

  for (const id of [onId, offId]) {
    const r = await row(id);
    assert.equal(r.lastAutoRefreshAt, null, "creation does not record an automatic refresh");
    assert.ok(r.lastRunAt && r.lastRunAt.getTime() >= before - 1000, "results ARE computed at creation, and that is recorded separately");
    assert.ok(Math.abs(r.createdAt.getTime() - Date.now()) < 60_000, "Created is the real creation time");
  }
  const archive = await html(s, "/reports");
  assert.equal(archiveCell(archive, `ON ${tag}`).startsWith("Not yet updated"), true, archiveCell(archive, `ON ${tag}`));
  assert.ok(archiveCell(archive, `ON ${tag}`).includes("Results last computed"), "the computed time is still shown, separately");
  assert.ok(archiveCell(archive, `OFF ${tag}`).startsWith("Not scheduled"));
  assert.equal(detailValue(await html(s, `/reports/${onId}`)), "Not yet updated");
  assert.equal(detailValue(await html(s, `/reports/${offId}`)), "Not scheduled");
  assert.match(await html(s, `/reports/${onId}`), /Results last computed/);
});

// ---------------------------------------------------------------- 3: a successful automatic refresh
test("The daily job refreshes only daily-refresh reports, records the time per report, and the list and detail agree", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `ARF ${tag} A` });
  const onId = await mkReport(s, tag, true, `JOB ON ${tag}`);
  const offId = await mkReport(s, tag, false, `JOB OFF ${tag}`);
  const offBefore = await row(offId);
  const onBefore = await row(onId);
  assert.equal(onBefore.resultCount, 1);

  await makeCompany({ name: `ARF ${tag} B` }); // the register changed since the report was saved
  await new Promise((r) => setTimeout(r, 15));
  const started = Date.now();
  const result = await runDailyUpdate({ officerEnqueueCap: 0 });
  assert.ok(result.reportsRefreshed >= 1);

  const on = await row(onId);
  assert.ok(on.lastAutoRefreshAt && on.lastAutoRefreshAt.getTime() >= started - 50, "recorded for this report");
  assert.equal(on.lastRunAt!.getTime(), on.lastAutoRefreshAt.getTime(), "same instant: one successful refresh");
  assert.equal(on.resultCount, 2, "results were recomputed against the changed register");
  assert.equal(on.lastRefreshError, null);
  const off = await row(offId);
  assert.equal(off.lastAutoRefreshAt, null, "daily refresh OFF: the job leaves it alone");
  assert.equal(off.lastRunAt!.getTime(), offBefore.lastRunAt!.getTime());
  assert.equal(off.resultCount, offBefore.resultCount);

  const expected = formatDate(on.lastAutoRefreshAt);
  const archive = await html(s, "/reports");
  assert.ok(archiveCell(archive, `JOB ON ${tag}`).startsWith(expected), archiveCell(archive, `JOB ON ${tag}`));
  assert.equal(detailValue(await html(s, `/reports/${onId}`)), expected, "detail page shows the same value");
  assert.ok(archiveCell(archive, `JOB OFF ${tag}`).startsWith("Not scheduled"));
  // The job-level time is labelled as the job's, and is a different thing from the per-report column.
  assert.match(archive, /Daily update job last ran:/);
  assert.doesNotMatch(archive, /Last automatic daily update:/);

  // Running it again the same day is safe: counts stay right and the stamp simply moves forward.
  await new Promise((r) => setTimeout(r, 15));
  await runDailyUpdate({ officerEnqueueCap: 0 });
  const again = await row(onId);
  assert.ok(again.lastAutoRefreshAt!.getTime() > on.lastAutoRefreshAt.getTime());
  assert.equal(again.resultCount, 2);
});

// ---------------------------------------------------------------- 4: a failed automatic refresh does not advance anything
test("A failed automatic refresh records the error, never advances either timestamp, and the next good run clears it", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `ARF ${tag} A` });
  const goodId = await mkReport(s, tag, true, `GOOD ${tag}`);
  const d0 = new Date("2026-09-01T12:00:00.000Z");
  const bad = await db.report.create({ data: { ownerId: s.userId, name: `BAD ${tag}`, filterJson: "{not json", dailyRefresh: true, resultCount: 5, lastRunAt: d0, lastAutoRefreshAt: d0 } });

  const result = await runDailyUpdate({ officerEnqueueCap: 0 });
  assert.ok(result.reportsFailed >= 1);
  const failed = await row(bad.id);
  assert.ok(failed.lastRefreshError, "the error is recorded");
  assert.equal(failed.lastAutoRefreshAt!.getTime(), d0.getTime(), "automatic timestamp NOT advanced");
  assert.equal(failed.lastRunAt!.getTime(), d0.getTime(), "results timestamp NOT advanced");
  assert.equal(failed.resultCount, 5, "the old count is kept");
  const good = await row(goodId);
  assert.ok(good.lastAutoRefreshAt, "one report failing does not stop the others");
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "daily_update" }, orderBy: { startedAt: "desc" } });
  assert.ok(["partial", "failed"].includes(run.status), `run is not reported as a clean success (${run.status})`);
  assert.ok(run.rowsFailed >= 1);

  const archive = await html(s, "/reports");
  assert.ok(archiveCell(archive, `BAD ${tag}`).startsWith(formatDate(d0)), "still shows its last REAL automatic update");
  assert.match(archive, /ERROR/);

  // Repair the report: the next run succeeds, clears the error, and only now advances the timestamp.
  await db.report.update({ where: { id: bad.id }, data: { filterJson: JSON.stringify(filterFor(tag)) } });
  await new Promise((r) => setTimeout(r, 15));
  await runDailyUpdate({ officerEnqueueCap: 0 });
  const fixed = await row(bad.id);
  assert.equal(fixed.lastRefreshError, null);
  assert.ok(fixed.lastAutoRefreshAt!.getTime() > d0.getTime());
});

// ---------------------------------------------------------------- 5 + 6: manual refresh, recomputation, editing
test("Manual refresh, edits and recomputation update 'Results last computed' but never 'Last automatic update'", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `ARF ${tag} A` });
  const never = await mkReport(s, tag, true, `NEVER ${tag}`);
  const d0 = new Date("2026-09-02T12:00:00.000Z");
  const had = await db.report.create({ data: { ownerId: s.userId, name: `HAD ${tag}`, filterJson: JSON.stringify(filterFor(tag)), dailyRefresh: true, resultCount: 1, lastRunAt: d0, lastAutoRefreshAt: d0 } });

  // Manual refresh button
  for (const [id, expectedAuto] of [[never, null], [had.id, d0.getTime()]] as const) {
    const before = await row(id);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal((await api(s, `/api/reports/${id}/refresh`, { body: {} })).status, 200);
    const after = await row(id);
    assert.ok(after.lastRunAt!.getTime() > before.lastRunAt!.getTime(), "results recomputed");
    assert.equal(after.lastAutoRefreshAt?.getTime() ?? null, expectedAuto, "automatic timestamp untouched by a manual refresh");
  }
  assert.equal(detailValue(await html(s, `/reports/${never}`)), "Not yet updated");
  assert.equal(detailValue(await html(s, `/reports/${had.id}`)), formatDate(d0));

  // Edit the criteria (recomputes the results) and then only the name.
  await makeCompany({ name: `ARF ${tag} B` });
  const edit = await api(s, `/api/reports/${had.id}`, { method: "PATCH", body: { filter: filterFor(tag) } });
  assert.equal(edit.status, 200, edit.text);
  const edited = await row(had.id);
  assert.equal(edited.resultCount, 2, "criteria edit recomputed the count");
  assert.equal(edited.lastAutoRefreshAt!.getTime(), d0.getTime(), "an edit is not an automatic refresh");
  const renamed = await api(s, `/api/reports/${had.id}`, { method: "PATCH", body: { name: `HAD2 ${tag}`, dailyRefresh: false } });
  assert.equal(renamed.status, 200);
  const r2 = await row(had.id);
  assert.equal(r2.lastAutoRefreshAt!.getTime(), d0.getTime());
  assert.equal(r2.lastRunAt!.getTime(), edited.lastRunAt!.getTime(), "a rename does not recompute anything");
  // With daily refresh turned OFF the column says so instead of showing an old date as if current.
  assert.equal(detailValue(await html(s, `/reports/${had.id}`)), "Not scheduled");
  // Turning it back on restores the real last automatic date; nothing was erased.
  await api(s, `/api/reports/${had.id}`, { method: "PATCH", body: { dailyRefresh: true } });
  assert.equal(detailValue(await html(s, `/reports/${had.id}`)), formatDate(d0));
});

// ---------------------------------------------------------------- 7 + 8: the original bug, history, midnight, single-flight
test("The reported bug: a report created after the last job run does not inherit that run's date", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const tag = uniq();
  // The same shape as the real data: a successful daily run on 7 Oct 05:16 UTC, then a report created afterwards.
  const run = await db.ingestionRun.create({
    data: { kind: "daily_update", status: "success", startedAt: new Date("2026-10-07T05:16:26.089Z"), heartbeatAt: new Date("2026-10-07T05:16:57.280Z"), finishedAt: new Date("2026-10-07T05:16:57.280Z"), rowsRead: 1, rowsProcessed: 1 },
  });
  const oldRunText = formatDate(run.finishedAt);
  const id = await mkReport(sup, tag, true, `AFTER ${tag}`);
  const archive = await html(sup, "/reports");
  assert.equal(archiveCell(archive, `AFTER ${tag}`).startsWith("Not yet updated"), true, "no date is invented");
  assert.ok(!archiveCell(archive, `AFTER ${tag}`).includes(oldRunText), "not the old job's date");
  const detail = await html(sup, `/reports/${id}`);
  assert.equal(detailValue(detail), "Not yet updated");
  assert.ok(!detailValue(detail).includes(oldRunText));
  await db.ingestionRun.delete({ where: { id: run.id } });
});

test("Existing records keep their history untouched, and dates near midnight render on the right day", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  // A pre-existing report: results computed long ago, no per-report automatic record.
  const oldComputed = new Date("2026-08-15T10:30:00.000Z");
  const historic = await db.report.create({ data: { ownerId: s.userId, name: `HIST ${tag}`, filterJson: JSON.stringify(filterFor(tag)), dailyRefresh: true, resultCount: 7, lastRunAt: oldComputed, createdAt: new Date("2026-08-10T09:00:00.000Z") } });
  const before = await row(historic.id);
  const archive = await html(s, "/reports");
  assert.ok(archiveCell(archive, `HIST ${tag}`).startsWith("Not yet updated"));
  assert.ok(archiveCell(archive, `HIST ${tag}`).includes(`Results last computed ${formatDate(oldComputed)}`));
  assert.match(await html(s, `/reports/${historic.id}`), new RegExp(`Results last computed[\\s\\S]{0,120}${formatDate(oldComputed)}`));
  const after = await row(historic.id);
  assert.equal(after.lastRunAt!.getTime(), before.lastRunAt!.getTime(), "viewing never rewrites history");
  assert.equal(after.resultCount, 7);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());

  // The last second of one local day and the first second of the next are shown as those two days (same convention as the
  // rest of the app: instants are rendered in the host timezone).
  const lateNight = new Date(2026, 9, 7, 23, 59, 59);
  const earlyMorning = new Date(2026, 9, 8, 0, 0, 0);
  const a = await db.report.create({ data: { ownerId: s.userId, name: `LATE ${tag}`, filterJson: JSON.stringify(filterFor(tag)), dailyRefresh: true, lastRunAt: lateNight, lastAutoRefreshAt: lateNight } });
  const b = await db.report.create({ data: { ownerId: s.userId, name: `EARLY ${tag}`, filterJson: JSON.stringify(filterFor(tag)), dailyRefresh: true, lastRunAt: earlyMorning, lastAutoRefreshAt: earlyMorning } });
  const arch2 = await html(s, "/reports");
  assert.equal(archiveCell(arch2, `LATE ${tag}`).startsWith("07 Oct 2026"), true);
  assert.equal(archiveCell(arch2, `EARLY ${tag}`).startsWith("08 Oct 2026"), true);
  assert.equal(detailValue(await html(s, `/reports/${a.id}`)), "07 Oct 2026");
  assert.equal(detailValue(await html(s, `/reports/${b.id}`)), "08 Oct 2026");
});

test("The job cannot run twice at once, and a refused run changes nothing", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `ARF ${tag} A` });
  const id = await mkReport(s, tag, true, `LOCK ${tag}`);
  const before = await row(id);
  // Another run is in progress (fresh heartbeat).
  const running = await db.ingestionRun.create({ data: { kind: "daily_update", status: "running" } });
  await assert.rejects(() => runDailyUpdate({ officerEnqueueCap: 0 }), (e: unknown) => e instanceof JobAlreadyRunningError);
  const after = await row(id);
  assert.equal(after.lastAutoRefreshAt, null);
  assert.equal(after.lastRunAt!.getTime(), before.lastRunAt!.getTime());
  await db.ingestionRun.delete({ where: { id: running.id } });
  // Once the other run is gone it proceeds normally.
  await runDailyUpdate({ officerEnqueueCap: 0 });
  assert.ok((await row(id)).lastAutoRefreshAt);
});

// ---------------------------------------------------------------- 9: existing report features still work
test("Viewing, editing, sharing, exporting and deleting reports still work with the new field", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `ARF ${tag} A` });
  const id = await mkReport(s, tag, true, `FEAT ${tag}`);
  await runDailyUpdate({ officerEnqueueCap: 0 });

  const view = await api(s, `/api/reports/${id}`);
  assert.equal(view.status, 200);
  assert.equal(view.json.total, 1);
  assert.ok(view.json.report.lastAutoRefreshAt, "the API exposes the per-report automatic update time");
  assert.equal((await api(s, "/api/companies/export", { body: { filter: filterFor(tag) } })).status, 200);
  const pdf = await fetch(`${BASE}/api/reports/${id}/export?format=pdf`, { headers: { cookie: `director_session=${s.cookie}` } });
  assert.equal(pdf.status, 200);
  assert.equal((await api(s, `/api/reports/${id}/share`, { body: { method: "link" } })).status, 200);
  assert.equal((await api(s, `/api/reports/${id}`, { method: "PATCH", body: { name: `FEAT2 ${tag}`, description: "d" } })).status, 200);
  // The edit pages and listings render.
  assert.match(await html(s, "/reports/new?mode=edit"), new RegExp(`FEAT2 ${tag}`));
  assert.match(await html(s, `/reports/${id}/edit`), /Edit|Report/);
  assert.match(await html(s, "/dashboard"), new RegExp(`FEAT2 ${tag}`));
  assert.equal((await api(s, `/api/reports/${id}`, { method: "DELETE" })).status, 200);
  assert.equal(await db.report.count({ where: { id } }), 0);
});
