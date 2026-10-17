// Officer coverage pipeline, end to end against the SCRATCH database and a local
// MOCK Companies House server (the client honours COMPANIES_HOUSE_*_URL). No
// live API call is ever made and the production database is never touched
// (helpers.ts refuses to run against anything but the scratch database).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { api, BASE, db, group, makeCompany, rule, sessionFor } from "./helpers";

// ---- mock Companies House ------------------------------------------------------------------------
type Mode = "zero" | "one" | "many" | "404" | "gone" | "bad400" | "malformed" | "auth401";
const modes = new Map<string, Mode>();
const hits: Record<string, number> = {};
const officerHits = () => Object.entries(hits).filter(([p]) => p.endsWith("/officers")).reduce((s, [, n]) => s + n, 0);
let server: http.Server;
let tagCounter = 0;
const tag = String(Date.now() % 100000).padStart(5, "0");
const number = (label: string) => `OP${tag}${label}${String(++tagCounter).padStart(2, "0")}`.toUpperCase();

const person = (n: number, role: string, resigned = false) => ({
  name: `PERSON ${n}`,
  officer_role: role,
  appointed_on: "2018-01-01",
  ...(resigned ? { resigned_on: "2020-01-01" } : {}),
  links: { officer: { appointments: `/officers/ID${n}/appointments` } },
});

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "X-Ratelimit-Remain": "500", "X-Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 300) });
      res.end(JSON.stringify(body));
    };
    const m = /^\/company\/([^/]+)(\/officers)?$/.exec(url.pathname);
    if (!m) return send(404, {});
    const [, num, officers] = m;
    const mode = modes.get(num) ?? "zero";
    if (mode === "auth401") return send(401, {});
    if (mode === "bad400") return send(400, { error: "bad request" });
    if (!officers) {
      if (mode === "gone") return send(404, {});
      return send(200, { company_name: `MOCK ${num}`, company_number: num, company_status: "active", type: "ltd", date_of_creation: "2020-01-15" });
    }
    if (mode === "404" || mode === "gone") return send(404, {});
    if (mode === "malformed") return send(200, { total_results: 0 });
    if (mode === "one") return send(200, { items: [person(1, "director"), person(2, "secretary")], total_results: 2 });
    if (mode === "many") {
      return send(200, {
        items: [
          person(1, "director"),
          person(2, "corporate-director"),
          person(3, "nominee-director"),
          person(4, "llp-member"),
          person(5, "secretary"), // not counted
          person(6, "director", true), // resigned: not counted
        ],
        total_results: 6,
      });
    }
    return send(200, { items: [], total_results: 0 }); // zero: a GENUINE empty officer list
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.COMPANIES_HOUSE_API_KEY = "test-rest-key";
  process.env.COMPANIES_HOUSE_REST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OFFICER_ENQUEUE_CAP = "2000";
});

after(async () => {
  await db.officerSyncJob.deleteMany();
  await resetGate();
  server.close();
  await db.$disconnect();
});

async function resetGate() {
  const { resetSharedQuotaState } = await import("../../src/lib/companies-house/quota");
  await resetSharedQuotaState();
  await db.chBreaker.deleteMany();
}

beforeEach(async () => {
  await resetGate();
  await db.officerSyncJob.deleteMany();
});

const sync = async (id: string, num: string) => (await import("../../src/lib/companies-house/sync")).syncCompanyOfficers(id, num, { quotaClass: "user" });

// ---- officer data state model ---------------------------------------------------------------------
test("a genuine HTTP 200 with zero officers is confirmed: full / 0 / not single (and clears dirty)", async () => {
  const num = number("Z");
  modes.set(num, "zero");
  const c = await makeCompany({ companyNumber: num });
  assert.deepEqual(await sync(c.id, num), { kind: "full", activeCount: 0 });
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.officersCoverage, "full");
  assert.equal(after.directorCount, 0);
  assert.equal(after.singleDirector, false);
  assert.ok(after.officersFetchedAt);
  assert.equal(after.officersUnavailableReason, null);
});

test("one director -> full / 1 / single (a secretary is not counted)", async () => {
  const num = number("O");
  modes.set(num, "one");
  const c = await makeCompany({ companyNumber: num });
  assert.deepEqual(await sync(c.id, num), { kind: "full", activeCount: 1 });
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.directorCount, 1);
  assert.equal(after.singleDirector, true);
  assert.equal(await db.director.count({ where: { companyId: c.id } }), 2, "the secretary is stored, just not counted");
});

test("many officers: the LOCKED rule counts active director / corporate / nominee / LLP roles only", async () => {
  const num = number("M");
  modes.set(num, "many");
  const c = await makeCompany({ companyNumber: num });
  assert.deepEqual(await sync(c.id, num), { kind: "full", activeCount: 4 });
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.directorCount, 4);
  assert.equal(after.singleDirector, false);
  assert.equal(await db.director.count({ where: { companyId: c.id } }), 6);
});

test("404 with the company still on the register -> unavailable / no_officer_resource, NEVER full or zero", async () => {
  const num = number("N");
  modes.set(num, "404");
  const c = await makeCompany({ companyNumber: num });
  assert.deepEqual(await sync(c.id, num), { kind: "unavailable", reason: "no_officer_resource" });
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.officersCoverage, "unavailable");
  assert.equal(after.officersUnavailableReason, "no_officer_resource");
  assert.notEqual(after.officersCoverage, "full");
  assert.ok(after.officersFetchedAt);
});

test("404 on the officers AND the company profile -> unavailable / company_gone", async () => {
  const num = number("G");
  modes.set(num, "gone");
  const c = await makeCompany({ companyNumber: num });
  assert.deepEqual(await sync(c.id, num), { kind: "unavailable", reason: "company_gone" });
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: c.id } })).officersUnavailableReason, "company_gone");
});

test("a malformed 200 (no items list) is an error, not a confirmed zero; the company stays 'none'", async () => {
  const num = number("X");
  modes.set(num, "malformed");
  const c = await makeCompany({ companyNumber: num });
  await assert.rejects(sync(c.id, num));
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: c.id } })).officersCoverage, "none");
});

test("404 for a company whose officers were already confirmed keeps the confirmed data untouched", async () => {
  const num = number("K");
  modes.set(num, "many");
  const c = await makeCompany({ companyNumber: num });
  await sync(c.id, num);
  modes.set(num, "404");
  assert.deepEqual(await sync(c.id, num), { kind: "kept_confirmed" });
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.officersCoverage, "full");
  assert.equal(after.directorCount, 4);
});

test("manual CRM contacts never touch Director rows, directorCount, singleDirector or coverage", async () => {
  const num = number("C");
  modes.set(num, "one");
  const u = await sessionFor("USER");
  const c = await makeCompany({ companyNumber: num });
  await db.crmContact.create({ data: { userId: u.userId, companyId: c.id, name: "MY CONTACT", role: "director" } });
  const before = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(before.officersCoverage, "none");
  assert.equal(before.directorCount, 0, "a manual contact does not become a director");
  await sync(c.id, num);
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.directorCount, 1);
  assert.equal(await db.crmContact.count({ where: { companyId: c.id } }), 1, "the contact survives a sync");
  assert.equal(await db.director.count({ where: { companyId: c.id, name: "MY CONTACT" } }), 0);
  await db.crmContact.create({ data: { userId: u.userId, companyId: c.id, name: "ANOTHER", role: "director" } });
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: c.id } })).directorCount, 1);
});

// ---- queue ----------------------------------------------------------------------------------------
test("enqueue is idempotent, keeps the HIGHEST priority, and only queues eligible companies", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const a = await makeCompany({ companyNumber: number("A") });
  const full = await makeCompany({ companyNumber: number("F"), officersCoverage: "full" });
  const unavailable = await makeCompany({ companyNumber: number("U"), officersCoverage: "unavailable" });
  const seed = await makeCompany({ companyNumber: number("S"), source: "seed" });

  const r1 = await enqueueOfficerJobs([a.id, full.id, unavailable.id, seed.id, "no-such-id"], { priority: 5, reason: "crawl" });
  assert.equal(r1.inserted, 1);
  assert.equal(r1.ineligible, 4, "full, unavailable, seed and unknown ids are not queued as fetch work");
  const r2 = await enqueueOfficerJobs([a.id, a.id], { priority: 2, reason: "followed" });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.upgraded, 1);
  await enqueueOfficerJobs([a.id], { priority: 4, reason: "refresh" }); // a lower priority never downgrades
  const job = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: a.id } });
  assert.equal(job.priority, 2);
  assert.equal(job.reason, "followed");
  assert.equal(await db.officerSyncJob.count({ where: { companyId: a.id } }), 1);
  // refresh jobs target confirmed data
  assert.equal((await enqueueOfficerJobs([full.id], { priority: 4, reason: "ttl", coverage: ["full"] })).inserted, 1);
});

test("one request cannot flood the queue: the enqueue cap truncates", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const cs = await Promise.all([1, 2, 3, 4, 5].map(() => makeCompany({ companyNumber: number("T") })));
  const r = await enqueueOfficerJobs(cs.map((c) => c.id), { priority: 3, reason: "filter", cap: 3 });
  assert.equal(r.inserted, 3);
  assert.equal(r.truncated, true);
  assert.equal(await db.officerSyncJob.count(), 3);
});

test("claim: priority order, leased with an expiry, SKIP LOCKED means two workers never share a job", async () => {
  const { enqueueOfficerJobs, claimOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const cs = await Promise.all([5, 3, 1, 4, 2].map(async (p) => ({ p, c: await makeCompany({ companyNumber: number("P") }) })));
  for (const { p, c } of cs) await enqueueOfficerJobs([c.id], { priority: p as 1, reason: `p${p}` });

  const [a, b] = await Promise.all([claimOfficerJobs("wA", { limit: 3 }), claimOfficerJobs("wB", { limit: 3 })]);
  const ids = [...a, ...b].map((j) => j.companyId);
  assert.equal(new Set(ids).size, ids.length, "no job claimed twice");
  assert.equal(ids.length, 5);
  assert.deepEqual(a.map((j) => j.priority), [...a.map((j) => j.priority)].sort((x, y) => x - y), "highest priority first");
  const leased = await db.officerSyncJob.findMany({ where: { companyId: { in: ids } } });
  assert.ok(leased.every((j) => j.status === "leased" && j.leasedBy && j.leaseUntil && j.leaseUntil > new Date() && j.lastAttemptAt));
});

test("claim never picks future retries, and retries fill at most ~10% of a batch", async () => {
  const { enqueueOfficerJobs, claimOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const fresh = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => makeCompany({ companyNumber: number("Q") })));
  const retrying = await Promise.all([1, 2, 3, 4, 5].map(() => makeCompany({ companyNumber: number("R") })));
  await enqueueOfficerJobs(fresh.map((c) => c.id), { priority: 5, reason: "crawl" });
  await enqueueOfficerJobs(retrying.map((c) => c.id), { priority: 1, reason: "report" });
  const past = new Date(Date.now() - 1000);
  await db.officerSyncJob.updateMany({ where: { companyId: { in: retrying.map((c) => c.id) } }, data: { status: "retry", attempts: 2, nextAttemptAt: past } });
  await db.officerSyncJob.update({ where: { companyId: retrying[0].id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } }); // not due yet

  const batch = await claimOfficerJobs("wR", { limit: 10 });
  const claimedRetries = batch.filter((j) => retrying.some((c) => c.id === j.companyId));
  assert.equal(claimedRetries.length, 1, "10% of a batch of 10");
  assert.ok(!batch.some((j) => j.companyId === retrying[0].id), "a retry that is not due is never claimed");
  assert.equal(batch.length, 10, "the rest of the batch is fresh work: retries cannot starve it");
});

test("lease expiry: a dead worker's jobs return to the queue WITHOUT charging an attempt", async () => {
  const { enqueueOfficerJobs, claimOfficerJobs, releaseExpiredLeases } = await import("../../src/lib/companies-house/officerQueue");
  const c = await makeCompany({ companyNumber: number("L") });
  await enqueueOfficerJobs([c.id], { priority: 2, reason: "followed" });
  const [job] = await claimOfficerJobs("dead-worker", { limit: 1 });
  assert.equal(job.companyId, c.id);
  assert.equal(await releaseExpiredLeases(), 0, "a live lease is not released");
  await db.officerSyncJob.update({ where: { companyId: c.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
  assert.equal(await releaseExpiredLeases(), 1);
  const after = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: c.id } });
  assert.equal(after.status, "queued");
  assert.equal(after.attempts, 0);
  assert.equal(after.leasedBy, null);
});

test("retry state: a failing company backs off, never stays at the front, is PARKED at the cap, and a Super Admin can retry it", async () => {
  const { enqueueOfficerJobs, claimOfficerJobs, failOfficerJob, retryParkedJobs, loadOfficerConfig } = await import("../../src/lib/companies-house/officerQueue");
  const cfg = loadOfficerConfig();
  const bad = await makeCompany({ companyNumber: number("B") });
  const good = await makeCompany({ companyNumber: number("W") });
  await enqueueOfficerJobs([bad.id, good.id], { priority: 1, reason: "report" });

  const mid = () => 0.5;
  for (let i = 1; i < cfg.maxAttempts; i++) {
    await db.officerSyncJob.updateMany({ where: { companyId: bad.id }, data: { status: "leased", leasedBy: "w" } });
    const plan = await failOfficerJob(bad.id, { httpStatus: 400, error: "boom" }, { rand: mid });
    assert.equal(plan.status, "retry");
    const row = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: bad.id } });
    assert.equal(row.attempts, i);
    assert.equal(row.lastHttpStatus, 400);
    assert.equal(row.lastError, "boom");
    assert.ok(row.nextAttemptAt > new Date(), "backed off into the future");
    assert.equal(row.leasedBy, null);
  }
  // the bad company is not claimable, the good one is: it cannot monopolise the queue
  const claimed = await claimOfficerJobs("w2", { limit: 5 });
  assert.deepEqual(claimed.map((j) => j.companyId), [good.id]);

  await db.officerSyncJob.updateMany({ where: { companyId: bad.id }, data: { status: "leased", leasedBy: "w" } });
  assert.equal((await failOfficerJob(bad.id, { httpStatus: 400, error: "boom" })).status, "parked");
  const parked = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: bad.id } });
  assert.equal(parked.status, "parked");
  assert.ok(parked.parkedAt);
  assert.equal((await claimOfficerJobs("w3", { limit: 5 })).length, 0, "parked jobs are excluded from automatic retries");
  assert.equal((await enqueueOfficerJobs([bad.id], { priority: 1, reason: "report" })).upgraded, 0, "re-enqueueing does not un-park");

  assert.equal(await retryParkedJobs({ companyIds: [bad.id] }), 1);
  const back = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: bad.id } });
  assert.deepEqual([back.status, back.attempts], ["queued", 0]);
});

// ---- the worker ----------------------------------------------------------------------------------
test("worker: processes the queue in priority order, writes every state correctly, retries failures, deletes finished jobs", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const mk = async (label: string, mode: Mode) => {
    const num = number(label);
    modes.set(num, mode);
    return makeCompany({ companyNumber: num });
  };
  const zero = await mk("Z", "zero");
  const one = await mk("O", "one");
  const many = await mk("M", "many");
  const unavailable = await mk("N", "404");
  const bad = await mk("B", "bad400");
  for (const [c, p] of [[zero, 3], [one, 1], [many, 2], [unavailable, 3], [bad, 1]] as const) await enqueueOfficerJobs([c.id], { priority: p, reason: "t" });

  const before = officerHits();
  const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false, workerId: "w-main", heartbeatMs: 200 });
  assert.equal(stats.stopReason, "idle");
  assert.equal(stats.full, 3);
  assert.equal(stats.unavailable, 1);
  assert.equal(stats.failures, 1);
  assert.equal(stats.parked, 0);
  assert.ok(officerHits() - before >= 5);

  const get = (id: string) => db.company.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([(await get(zero.id)).officersCoverage, (await get(zero.id)).directorCount], ["full", 0]);
  assert.deepEqual([(await get(one.id)).directorCount, (await get(one.id)).singleDirector], [1, true]);
  assert.equal((await get(many.id)).directorCount, 4);
  assert.equal((await get(unavailable.id)).officersCoverage, "unavailable");
  assert.equal((await get(bad.id)).officersCoverage, "none", "a failed company never gets a state it did not earn");

  assert.equal(await db.officerSyncJob.count({ where: { companyId: { in: [zero.id, one.id, many.id, unavailable.id] } } }), 0, "finished jobs are deleted");
  const failed = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: bad.id } });
  assert.equal(failed.status, "retry");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastHttpStatus, 400);
  assert.ok(failed.nextAttemptAt > new Date());
  assert.equal(failed.leasedBy, null);

  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "officer_backfill" }, orderBy: { startedAt: "desc" } });
  assert.ok(["success", "partial", "failed"].includes(run.status));
  assert.ok(run.finishedAt);
  assert.equal(run.rowsRead, 5);
});

test("worker restart / resume: leases left by a killed worker are recovered and nothing is fetched twice or duplicated", async () => {
  const { enqueueOfficerJobs, claimOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const nums = [number("D"), number("D"), number("D")];
  for (const n of nums) modes.set(n, "many");
  const cs = await Promise.all(nums.map((n) => makeCompany({ companyNumber: n })));
  await enqueueOfficerJobs(cs.map((c) => c.id), { priority: 2, reason: "followed" });
  // worker 1 claims everything, finishes company 0 (committed), then is killed
  await claimOfficerJobs("killed", { limit: 3 });
  await sync(cs[0].id, nums[0]);
  await db.officerSyncJob.updateMany({ where: { leasedBy: "killed" }, data: { leaseUntil: new Date(Date.now() - 1000) } });

  const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  assert.equal(stats.expiredLeasesReleased, 2, "the 2 unfinished jobs were recovered; the finished one was already removed");
  assert.equal(stats.full, 2);
  for (const c of cs) {
    assert.equal(await db.director.count({ where: { companyId: c.id } }), 6, "exactly one set of director rows each");
    assert.equal((await db.company.findUniqueOrThrow({ where: { id: c.id } })).directorCount, 4);
  }
  assert.equal(await db.officerSyncJob.count(), 0);
  assert.equal(hits[`/company/${nums[0]}/officers`], 1, "the company that finished before the crash was not fetched again");
});

test("worker crawl (P5): keyset cursor, active companies first, resumes after a restart, never refetches", async () => {
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const { loadCrawlCursor, saveCrawlCursor } = await import("../../src/lib/companies-house/officerQueue");
  // Isolate: every other real company is temporarily treated as seed data.
  const others = await db.company.findMany({ where: { source: { not: "seed" } }, select: { id: true, source: true } });
  await db.company.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { source: "seed" } });
  try {
    await saveCrawlCursor("active", "", 0);
    const mkc = async (label: string, status: string) => {
      const num = number(label);
      modes.set(num, "one");
      return makeCompany({ companyNumber: num, status });
    };
    const act = [await mkc("a", "active"), await mkc("b", "active"), await mkc("c", "active")];
    const dis = [await mkc("d", "dissolved"), await mkc("e", "dissolved")];
    const activeSorted = act.map((c) => c.companyNumber);

    const first = await runOfficerWorker({ queue: false, crawl: true, maxCompanies: 2, exitWhenIdle: true, freshness: false, batchSize: 10 });
    assert.equal(first.stopReason, "limit");
    assert.equal(first.crawled, 2);
    const doneFirst = await db.company.findMany({ where: { id: { in: [...act, ...dis].map((c) => c.id) }, officersCoverage: "full" } });
    assert.equal(doneFirst.length, 2);
    assert.ok(doneFirst.every((c) => c.status === "active"), "active companies are crawled first");
    assert.equal((await loadCrawlCursor()).phase, "active");

    const second = await runOfficerWorker({ queue: false, crawl: true, exitWhenIdle: true, freshness: false, batchSize: 10 });
    assert.equal(second.crawled, 3, "the remaining active company + both non-active ones");
    for (const c of [...act, ...dis]) assert.equal((await db.company.findUniqueOrThrow({ where: { id: c.id } })).officersCoverage, "full");
    for (const n of [...activeSorted, ...dis.map((c) => c.companyNumber)]) assert.equal(hits[`/company/${n}/officers`], 1, `${n} fetched exactly once`);
    assert.equal(await db.officerSyncJob.count(), 0, "the crawl never materialises job rows for companies it fetched");

    const third = await runOfficerWorker({ queue: false, crawl: true, exitWhenIdle: true, freshness: false });
    assert.equal(third.crawled, 0);
    assert.equal(third.stopReason, "idle");
  } finally {
    for (const o of others) await db.company.update({ where: { id: o.id }, data: { source: o.source } });
  }
});

test("worker: crawl is opt-in - with the queue empty and no --crawl nothing is fetched", async () => {
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  await makeCompany({ companyNumber: number("I") });
  const before = officerHits();
  const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  assert.equal(stats.processed, 0);
  assert.equal(officerHits(), before);
});

// ---- circuit breaker + shared quota, against the real database ---------------------------------------
test("401 breaker stops the worker after the threshold, never charges the companies, and a probe-less restart sends nothing", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const { readBreaker, resetBreaker, loadBreakerPolicy } = await import("../../src/lib/companies-house/breaker");
  const cs = [];
  for (let i = 0; i < 6; i++) {
    const num = number("U");
    modes.set(num, "auth401");
    cs.push(await makeCompany({ companyNumber: num }));
  }
  await enqueueOfficerJobs(cs.map((c) => c.id), { priority: 1, reason: "report" });

  const before = officerHits();
  const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  assert.equal(stats.stopReason, "auth_breaker");
  const sent = officerHits() - before;
  assert.equal(sent, loadBreakerPolicy().authThreshold, "a broken key cannot burn hundreds of requests");
  assert.equal((await readBreaker("auth")).state, "open");
  const jobs = await db.officerSyncJob.findMany({ where: { companyId: { in: cs.map((c) => c.id) } } });
  assert.equal(jobs.length, 6, "the queue is preserved");
  assert.ok(jobs.every((j) => j.attempts === 0 && j.status !== "parked" && j.leasedBy === null), "systemic failures never consume a company's attempts");
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "officer_backfill" }, orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "failed");
  assert.match(run.errorMessage ?? "", /Circuit breaker open/);

  const again = officerHits();
  const restart = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  assert.equal(restart.stopReason, "auth_breaker");
  assert.equal(officerHits(), again, "while the breaker is open nothing is sent to Companies House");

  await resetBreaker("auth");
  for (const c of cs) modes.set(c.companyNumber, "zero");
  const recovered = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  assert.equal(recovered.full, 6, "after the manual reset the queue drains normally");
});

test("the 429 cooldown and quota usage are shared between processes (two independent gate instances, one database row)", async () => {
  const q = await import("../../src/lib/companies-house/quota");
  const policy = q.loadQuotaPolicy();
  const procA = new q.DbQuotaStore(policy);
  const procB = new q.DbQuotaStore(policy);
  const now = new Date();

  q.configureQuotaGate({ store: procA, policy });
  assert.equal((await q.acquireQuota("backfill", now)).granted, true);
  await q.recordQuotaResponse({ status: 429, remaining: 0, resetEpochSeconds: Math.floor(now.getTime() / 1000) + 20 }, now);

  q.configureQuotaGate({ store: procB, policy }); // "another process"
  const denied = await q.acquireQuota("user", new Date(now.getTime() + 1000));
  assert.equal(denied.granted, false);
  if (!denied.granted) assert.equal(denied.reason, "cooldown");
  const used = await procB.read();
  assert.equal(used?.used.backfill, 1, "usage recorded by A is visible to B");

  q.configureQuotaGate({}); // back to the default (database) store for later tests
});

test("outage breaker (5xx) opens through the real client, pausing background work but not interactive requests", async () => {
  const { chRestGetWithRateInfo, CompaniesHouseBreakerOpenError } = await import("../../src/lib/companies-house/client");
  const { readBreaker } = await import("../../src/lib/companies-house/breaker");
  const num = number("5");
  const original = server.listeners("request")[0] as (req: http.IncomingMessage, res: http.ServerResponse) => void;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (req.url?.startsWith(`/company/${num}`)) {
      res.writeHead(503, { "X-Ratelimit-Remain": "500" });
      res.end("{}");
      return;
    }
    original(req, res);
  });
  try {
    for (let i = 0; i < 11; i++) await assert.rejects(chRestGetWithRateInfo(`/company/${num}`, { maxAttempts: 1, quotaClass: "user" }));
    assert.equal((await readBreaker("outage")).state, "open");
    await assert.rejects(chRestGetWithRateInfo(`/company/${num}`, { maxAttempts: 1, quotaClass: "backfill" }), CompaniesHouseBreakerOpenError);
    // interactive requests still try (and still fail on this bad company)
    await assert.rejects(chRestGetWithRateInfo(`/company/${num}`, { maxAttempts: 1, quotaClass: "user" }), (e: unknown) => !(e instanceof CompaniesHouseBreakerOpenError));
  } finally {
    server.removeAllListeners("request");
    server.on("request", original);
  }
});

// ---- heartbeat / stale runs / single flight -----------------------------------------------------------
test("stale-run handling is per kind: the officer worker is dead after ~2 minutes, the daily update is not", async () => {
  const { reconcileStaleRuns, effectiveStatus } = await import("../../src/lib/jobs/runs");
  await db.ingestionRun.updateMany({ where: { status: "running", kind: { in: ["officer_backfill", "daily_update"] } }, data: { status: "failed" } });
  const old = new Date(Date.now() - 3 * 60_000);
  const worker = await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "running", heartbeatAt: old } });
  const daily = await db.ingestionRun.create({ data: { kind: "daily_update", status: "running", heartbeatAt: old } });
  assert.equal(effectiveStatus(worker), "stalled");
  assert.equal(effectiveStatus(daily), "running");
  await reconcileStaleRuns();
  assert.equal((await db.ingestionRun.findUniqueOrThrow({ where: { id: worker.id } })).status, "failed");
  assert.equal((await db.ingestionRun.findUniqueOrThrow({ where: { id: daily.id } })).status, "running");
  await db.ingestionRun.update({ where: { id: daily.id }, data: { status: "success" } });
});

test("single flight: two simultaneous officer workers cannot both start (advisory lock)", async () => {
  const { startRun, finishRun, JobAlreadyRunningError } = await import("../../src/lib/jobs/runs");
  await db.ingestionRun.updateMany({ where: { status: "running", kind: "officer_backfill" }, data: { status: "failed" } });
  const results = await Promise.allSettled([startRun("officer_backfill"), startRun("officer_backfill"), startRun("officer_backfill")]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one start wins");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof JobAlreadyRunningError));
  await finishRun((ok[0] as PromiseFulfilledResult<{ id: string }>).value.id, "success");
});

test("the worker heartbeat updates the run row on a timer while it works", async () => {
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const t0 = new Date();
  await runOfficerWorker({ exitWhenIdle: true, freshness: false, heartbeatMs: 100 });
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "officer_backfill" }, orderBy: { startedAt: "desc" } });
  assert.ok(run.heartbeatAt >= t0);
  assert.equal(run.inputName?.startsWith("officer-worker-"), true);
});

// ---- freshness ------------------------------------------------------------------------------------------
test("an officer filing marks CONFIRMED data dirty (keeping the last count) and queues a P4 refresh; the refresh clears it", async () => {
  const { handleOfficerFiling } = await import("../../src/lib/companies-house/officerFreshness");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const num = number("H");
  modes.set(num, "one");
  const c = await makeCompany({ companyNumber: num });
  const none = await makeCompany({ companyNumber: number("J") });
  assert.equal(await handleOfficerFiling(none.companyNumber, "AP01"), "no_action", "a company with no officer data is simply fetched fresh later");
  assert.equal(await handleOfficerFiling(num, "AP01"), "no_action");
  await sync(c.id, num);

  assert.equal(await handleOfficerFiling(num, "CH01"), "no_action", "details-only filings do not change the count");
  assert.equal(await handleOfficerFiling(num, "TM01"), "marked_dirty");
  const dirty = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.ok(dirty.officersDirtyAt);
  assert.equal(dirty.directorCount, 1, "the last confirmed count is not destroyed");
  assert.equal(dirty.officersCoverage, "full");
  const job = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: c.id } });
  assert.equal(job.priority, 4);
  assert.match(job.reason, /TM01/);

  modes.set(num, "many");
  await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  const refreshed = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(refreshed.directorCount, 4);
  assert.equal(refreshed.officersDirtyAt, null);
  assert.equal(await db.officerSyncJob.count({ where: { companyId: c.id } }), 0);
});

test("a filing that arrives WHILE a fetch is in flight keeps the company dirty", async () => {
  const num = number("W");
  modes.set(num, "one");
  const c = await makeCompany({ companyNumber: num, officersCoverage: "full", officersFetchedAt: new Date(Date.now() - 86_400_000), directorCount: 1, singleDirector: true });
  await db.company.update({ where: { id: c.id }, data: { officersDirtyAt: new Date(Date.now() + 60_000) } }); // newer than this fetch started
  await sync(c.id, num);
  assert.ok((await db.company.findUniqueOrThrow({ where: { id: c.id } })).officersDirtyAt, "the newer filing is not covered by this fetch");
});

test("TTL sweep queues stale confirmed data and due unavailable re-checks (P4); soft refresh has a per-company cooldown", async () => {
  const { enqueueFreshnessRefreshes, loadOfficerConfig } = await import("../../src/lib/companies-house/officerQueue");
  const { maybeSoftRefresh } = await import("../../src/lib/companies-house/officerFreshness");
  const cfg = loadOfficerConfig();
  const old = new Date(Date.now() - (cfg.staleAfterDays + 5) * 86_400_000);
  const stale = await makeCompany({ companyNumber: number("S"), officersCoverage: "full", officersFetchedAt: old });
  const fresh = await makeCompany({ companyNumber: number("F"), officersCoverage: "full", officersFetchedAt: new Date() });
  const unavail = await makeCompany({ companyNumber: number("V"), officersCoverage: "unavailable", officersFetchedAt: new Date(Date.now() - (cfg.unavailableRecheckDays + 5) * 86_400_000) });
  const res = await enqueueFreshnessRefreshes({ cap: 5000 });
  assert.ok(res.stale >= 1 && res.unavailable >= 1);
  const rows = await db.officerSyncJob.findMany({ where: { companyId: { in: [stale.id, fresh.id, unavail.id] } } });
  assert.deepEqual(rows.map((r) => r.companyId).sort(), [stale.id, unavail.id].sort());
  assert.ok(rows.every((r) => r.priority === 4));

  await db.officerSyncJob.deleteMany();
  const view = { id: stale.id, officersCoverage: "full", officersFetchedAt: new Date(Date.now() - 40 * 86_400_000) };
  assert.equal(await maybeSoftRefresh(view), true, "an old company opened by a user is queued");
  assert.equal(await maybeSoftRefresh(view), false, "cooldown: a queued/retrying company is not queued again");
  assert.equal(await maybeSoftRefresh({ ...view, officersFetchedAt: new Date() }), false, "recent data is left alone");
});

// ---- director filters, unknown counts, CSV, pages (HTTP) -----------------------------------------------------
async function seedCoverageSet() {
  const t = `CV${Date.now() % 1000000}`;
  const mk = (label: string, over: Record<string, unknown>) => makeCompany({ name: `${t} ${label}`, ...over });
  const day = 86_400_000;
  const fetched = new Date(Date.now() - 2 * day);
  await mk("none", { officersCoverage: "none" });
  await mk("unavailable", { officersCoverage: "unavailable", officersUnavailableReason: "no_officer_resource", officersFetchedAt: fetched });
  await mk("zero", { officersCoverage: "full", directorCount: 0, singleDirector: false, officersFetchedAt: fetched });
  await mk("one", { officersCoverage: "full", directorCount: 1, singleDirector: true, officersFetchedAt: fetched });
  await mk("three", { officersCoverage: "full", directorCount: 3, singleDirector: false, officersFetchedAt: fetched });
  await mk("stale", { officersCoverage: "full", directorCount: 2, singleDirector: false, officersFetchedAt: new Date(Date.now() - 400 * day) });
  await mk("dirty", { officersCoverage: "full", directorCount: 1, singleDirector: true, officersFetchedAt: new Date(Date.now() - 10 * day), officersDirtyAt: new Date(Date.now() - day) });
  await mk("ds01none", { officersCoverage: "none", hasDS01: true });
  await mk("ds01three", { officersCoverage: "full", directorCount: 3, hasDS01: true, officersFetchedAt: fetched });
  return t;
}

const search = (s: Awaited<ReturnType<typeof sessionFor>>, filter: unknown) => api(s, "/api/companies/search", { body: { filter, page: 1, pageSize: 100 } });
const labels = (rows: { name: string }[], t: string) => rows.map((r) => r.name.slice(t.length + 1)).sort();

test("director filters: confirmed matches only, with an honest unknown count (never zero) - every operator, AND / OR / nested", async () => {
  const s = await sessionFor("USER");
  const t = await seedCoverageSet();
  const base = rule("name", "startsWith", t);
  const q = async (...rules: unknown[]) => {
    const r = await search(s, group("AND", base, ...rules));
    assert.equal(r.status, 200, r.text.slice(0, 200));
    return { names: labels(r.json.rows, t), cov: r.json.officerCoverage as { hasDirectorRules: boolean; confirmed: number; unknown: number } };
  };

  // 9 companies: unknown-by-coverage = none, unavailable, ds01none = 3
  let r = await q(rule("directorCount", "equals", 0));
  assert.deepEqual(r.names, ["zero"], "not fetched / unavailable are NOT zero directors");
  assert.deepEqual(r.cov, { hasDirectorRules: true, confirmed: 1, unknown: 3 });

  r = await q(rule("directorCount", "equals", 1));
  assert.deepEqual(r.names, ["dirty", "one"]);
  assert.equal(r.cov.unknown, 3);

  r = await q(rule("directorCount", "gt", 2));
  assert.deepEqual(r.names, ["ds01three", "three"]);

  r = await q(rule("directorCount", "lt", 2));
  assert.deepEqual(r.names, ["dirty", "one", "zero"]);
  assert.equal(r.cov.unknown, 3);

  r = await q(rule("directorCount", "between", 1, 2));
  assert.deepEqual(r.names, ["dirty", "one", "stale"], "stale / dirty confirmed data still evaluates (last confirmed count)");

  r = await q(rule("singleDirector", "isTrue"));
  assert.deepEqual(r.names, ["dirty", "one"]);
  r = await q(rule("singleDirector", "isFalse"));
  assert.deepEqual(r.names, ["ds01three", "stale", "three", "zero"], "Single = No excludes everything unconfirmed");
  assert.equal(r.cov.unknown, 3);

  // combined with other filters: only the unknowns that pass the OTHER conditions are counted
  r = await q(rule("hasDS01", "isTrue"), rule("directorCount", "equals", 3));
  assert.deepEqual(r.names, ["ds01three"]);
  assert.deepEqual(r.cov, { hasDirectorRules: true, confirmed: 1, unknown: 1 }, "only 'ds01none' passes DS01 but cannot be evaluated");

  // OR group
  const or = await search(s, group("AND", base, group("OR", rule("directorCount", "equals", 0), rule("hasDS01", "isTrue"))));
  assert.deepEqual(labels(or.json.rows, t), ["ds01none", "ds01three", "zero"], "a company matching another OR branch is a confirmed match");
  assert.deepEqual(or.json.officerCoverage, { hasDirectorRules: true, confirmed: 3, unknown: 2 }, "unknown = none + unavailable (ds01none already matches the other branch)");

  // nested AND / OR
  const nested = await search(s, group("AND", base, group("OR", group("AND", rule("hasDS01", "isTrue"), rule("directorCount", "gt", 2)), group("AND", rule("directorCount", "equals", 1), rule("singleDirector", "isTrue")))));
  assert.deepEqual(labels(nested.json.rows, t), ["dirty", "ds01three", "one"]);
  assert.equal(nested.json.officerCoverage.unknown, 3);

  // no director rule -> no unknown count at all
  const plain = await search(s, group("AND", base, rule("hasDS01", "isTrue")));
  assert.deepEqual(plain.json.officerCoverage, { hasDirectorRules: false, confirmed: 2, unknown: 0 });
  // freshness is derived server-side per row
  const all = await search(s, group("AND", base));
  const fr = Object.fromEntries((all.json.rows as { name: string; officerFreshness: string }[]).map((x) => [x.name.slice(t.length + 1), x.officerFreshness]));
  assert.deepEqual([fr.none, fr.unavailable, fr.zero, fr.stale, fr.dirty], ["none", "unavailable", "fresh", "stale", "dirty"]);
});

test("CSV: confirmed values only for full officer data; unfetched / unavailable are labelled, stale / dirty say so; no Companies House call", async () => {
  const s = await sessionFor("USER");
  const t = await seedCoverageSet();
  const before = Object.values(hits).reduce((a, b) => a + b, 0);
  const exp = await api(s, "/api/companies/export", { body: { filter: group("AND", rule("name", "startsWith", t)) } });
  assert.equal(exp.status, 200);
  assert.equal(Object.values(hits).reduce((a, b) => a + b, 0), before, "export never calls Companies House");
  const lines = exp.text.split(/\r?\n/);
  assert.match(lines[0], /Director count,Single director,Officer data as of,Accounts overdue/);
  const line = (label: string) => lines.find((l) => l.includes(`${t} ${label},`)) ?? "";
  assert.match(line("none"), /,Not fetched,Not fetched,Not fetched,/);
  assert.match(line("unavailable"), /,Unavailable,Unavailable,Unavailable,/);
  assert.match(line("zero"), /,0,No,\d{4}-\d{2}-\d{2},/);
  assert.match(line("one"), /,1,Yes,\d{4}-\d{2}-\d{2},/);
  assert.match(line("three"), /,3,No,\d{4}-\d{2}-\d{2},/);
  assert.match(line("stale"), /,2,No,\d{4}-\d{2}-\d{2} \(stale\),/);
  assert.match(line("dirty"), /,1,Yes,\d{4}-\d{2}-\d{2} \(changes pending\),/);
  for (const l of ["none", "unavailable"]) assert.doesNotMatch(line(l), /,0,No,/, `${l} is never exported as 0 / No`);
});

test("company page: shows confirmed / unavailable / stale / dirty officer status", async () => {
  const s = await sessionFor("USER");
  const mk = (over: Record<string, unknown>) => makeCompany({ companyNumber: number("PG"), ...over });
  const day = 86_400_000;
  const un = await mk({ officersCoverage: "unavailable", officersUnavailableReason: "no_officer_resource", officersFetchedAt: new Date() });
  const st = await mk({ officersCoverage: "full", directorCount: 2, officersFetchedAt: new Date(Date.now() - 400 * day) });
  const di = await mk({ officersCoverage: "full", directorCount: 1, singleDirector: true, officersFetchedAt: new Date(Date.now() - 5 * day), officersDirtyAt: new Date() });
  const fr = await mk({ officersCoverage: "full", directorCount: 3, officersFetchedAt: new Date() });
  const page = async (id: string) => (await api(s, `/companies/${id}`)).text;
  assert.match(await page(un.id), /unavailable from Companies House/);
  assert.match(await page(st.id), /2 directors counted/);
  assert.match(await page(st.id), /Not recently verified/);
  assert.match(await page(di.id), /Officer change filed/);
  const f = await page(fr.id);
  assert.match(f, /3 directors counted/);
  assert.doesNotMatch(f, /Not recently verified|update pending/);
});

test("enqueue API: queues the companies a director filter could not evaluate (cap + idempotent), never calls Companies House", async () => {
  const s = await sessionFor("USER");
  const other = await sessionFor("USER");
  const t = await seedCoverageSet();
  const filter = group("AND", rule("name", "startsWith", t), rule("directorCount", "equals", 1));
  const before = Object.values(hits).reduce((a, b) => a + b, 0);

  const r1 = await api(s, "/api/officers/enqueue", { body: { filter } });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.queued, 2, "only 'none' companies are queued: 'none' and 'ds01none' (unavailable has nothing to fetch)");
  assert.equal(r1.json.truncated, false);
  const jobs = await db.officerSyncJob.findMany({ include: { company: { select: { name: true } } } });
  assert.deepEqual(jobs.map((j) => j.company.name.slice(t.length + 1)).sort(), ["ds01none", "none"]);
  assert.ok(jobs.every((j) => j.priority === 3 && j.reason === "filter"));

  const r2 = await api(s, "/api/officers/enqueue", { body: { filter } });
  assert.equal(r2.json.queued, 0);
  assert.equal(r2.json.alreadyQueued, 2, "idempotent");
  assert.equal(Object.values(hits).reduce((a, b) => a + b, 0), before, "queueing makes no Companies House calls");

  // saved report -> P1, owner only
  const rep = await api(s, "/api/reports", { body: { name: `rep ${t}`, filter } });
  assert.equal(rep.status, 200, rep.text);
  const reportId = rep.json.report?.id ?? rep.json.id;
  const r3 = await api(s, "/api/officers/enqueue", { body: { reportId } });
  assert.equal(r3.status, 200);
  assert.ok((await db.officerSyncJob.findMany()).every((j) => j.priority === 1), "a saved report raises the same companies to P1");
  assert.equal((await api(other, "/api/officers/enqueue", { body: { reportId } })).status, 404, "another user's report is not queueable");
  assert.equal((await api(null, "/api/officers/enqueue", { body: { filter } })).status, 401);
  assert.equal((await api(s, "/api/officers/enqueue", { body: { filter: { foo: 1 } } })).status, 400);
});

test("daily update only ENQUEUES officer work (P1 reports, P2 followed) - zero Companies House officer calls", async () => {
  const { runDailyUpdate } = await import("../../src/lib/companies-house/dailyUpdate");
  const u = await sessionFor("USER");
  const t = `DU${Date.now() % 1000000}`;
  const inReport = await makeCompany({ name: `${t} report`, officersCoverage: "none" });
  const followed = await makeCompany({ name: `${t} followed`, officersCoverage: "none" });
  await db.userCompanyState.create({ data: { userId: u.userId, companyId: followed.id, followed: true } });
  await db.report.create({
    data: { ownerId: u.userId, name: t, filterJson: JSON.stringify(group("AND", rule("name", "startsWith", `${t} report`), rule("directorCount", "equals", 1))), dailyRefresh: true },
  });
  await db.ingestionRun.updateMany({ where: { status: "running", kind: "daily_update" }, data: { status: "failed" } });

  const before = officerHits();
  const result = await runDailyUpdate();
  assert.equal(officerHits(), before, "the daily update fetched no officers");
  assert.ok(result.officersQueuedForReports >= 1);
  assert.ok(result.officersQueuedForFollowed >= 1);
  assert.equal((await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: inReport.id } })).priority, 1);
  assert.equal((await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: followed.id } })).priority, 2);
  const again = await runDailyUpdate();
  assert.equal(again.officersQueuedForFollowed, 0, "idempotent");
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: inReport.id } })).officersCoverage, "none");
});

test("super admin observability: pipeline status, recovery actions, role enforcement, no secrets", async () => {
  const sa = await sessionFor("SUPER_ADMIN");
  const user = await sessionFor("USER");
  assert.equal((await api(user, "/api/admin/officers")).status, 403);
  assert.equal((await api(null, "/api/admin/officers")).status, 403);

  const c = await makeCompany({ companyNumber: number("AD") });
  await db.officerSyncJob.create({ data: { companyId: c.id, priority: 3, reason: "t", status: "parked", attempts: 6, lastHttpStatus: 500, lastError: "gave up", parkedAt: new Date() } });
  await db.chBreaker.upsert({ where: { name: "auth" }, create: { name: "auth", state: "open", reason: "HTTP 401", openUntil: new Date(Date.now() + 3_600_000), openedAt: new Date(), trips: 1 }, update: { state: "open", reason: "HTTP 401" } });

  const st = await api(sa, "/api/admin/officers");
  assert.equal(st.status, 200);
  for (const k of ["coverage", "queue", "worker", "quota", "breakers", "requests24h", "recentErrors", "healthy"]) assert.ok(k in st.json, k);
  assert.equal(st.json.queue.parked, 1);
  assert.equal(st.json.breakers.auth.state, "open");
  assert.equal(st.json.healthy, false);
  assert.ok(st.json.recentErrors.some((e: { companyNumber: string }) => e.companyNumber === c.companyNumber));
  assert.doesNotMatch(st.text, /api[_-]?key|COMPANIES_HOUSE_API_KEY|test-rest-key/i);
  for (const k of ["runningNow", "idleWithBacklog", "enabledByConfig", "crawlEnabledByConfig"]) assert.equal(typeof st.json.worker[k], "boolean", `worker.${k}`);
  const adminHtml = await (await fetch(`${BASE}/admin`, { headers: { cookie: `director_session=${sa.cookie}` } })).text();
  assert.match(adminHtml, /Running now/);
  assert.match(adminHtml, /Enabled in configuration/);

  assert.equal((await api(user, "/api/admin/officers", { body: { action: "retry_parked" } })).status, 403);
  assert.equal((await api(sa, "/api/admin/officers", { body: { action: "nonsense" } })).status, 400);
  assert.equal((await api(sa, "/api/admin/officers", { body: { action: "retry_parked" } })).json.requeued, 1);
  assert.equal((await api(sa, "/api/admin/officers", { body: { action: "reset_breaker", breaker: "auth" } })).status, 200);
  assert.equal((await api(sa, "/api/admin/officers")).json.breakers.auth.state, "closed");
  assert.equal((await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: c.id } })).status, "queued");
});

// ---- quota phase 1: demand-aware gate, internal denial vs real 429, CRM isolation ----------------------
test("internal quota denial is recorded and reported as an internal deferral - NOT an HTTP 429 - and the work still completes", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const { loadOfficerPipelineStatus } = await import("../../src/lib/companies-house/officerStatus");
  await db.chQuotaEvent.deleteMany();
  await db.chRequestStat.deleteMany();
  const num = number("QD");
  modes.set(num, "one");
  const c = await makeCompany({ companyNumber: num });
  await enqueueOfficerJobs([c.id], { priority: 3, reason: "t" });
  // The gate is in a short cooldown (as after an earlier 429 seen by another process).
  const now = new Date();
  await db.chQuotaState.create({
    data: { id: "rest", windowStartedAt: now, windowEndsAt: new Date(now.getTime() + 300_000), cooldownUntil: new Date(now.getTime() + 2000), last429At: now },
  });
  const logs: string[] = [];
  const sentBefore = officerHits();
  const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false, log: (m) => logs.push(m) });

  assert.equal(stats.full, 1, "the company is processed once the gate allows it");
  assert.ok(stats.quotaDeferrals >= 1, "the worker saw an internal deferral");
  assert.equal(stats.http429s, 0, "Companies House never answered 429");
  assert.equal(stats.systemicHandBacks, stats.quotaDeferrals + stats.http429s, "systemicHandBacks still counts every hand-back");
  assert.equal(officerHits() - sentBefore, 1, "nothing was sent while the gate said wait");
  assert.ok(logs.some((l) => /internal, not an HTTP 429/.test(l)));
  assert.ok(!logs.some((l) => /rate limit hit/i.test(l)), "the misleading wording is gone");

  await new Promise((r) => setTimeout(r, 150)); // the event is written asynchronously
  const events = await db.chQuotaEvent.findMany();
  assert.ok(events.length >= 1);
  const e = events[0];
  assert.equal(e.kind, "quota_denied");
  assert.equal(e.internal, true);
  assert.equal(e.httpStatus, null, "no HTTP status: no HTTP response was involved");
  assert.equal(e.reason, "cooldown");
  assert.equal(e.quotaClass, "backfill");
  assert.ok(e.waitMs && e.waitMs >= 250);
  assert.ok(e.windowStartedAt && e.windowEndsAt && e.usedTotal !== null && e.usedClass !== null);
  assert.equal((await db.chRequestStat.aggregate({ _sum: { status429: true } }))._sum.status429 ?? 0, 0, "no 429 in the request stats");

  const status = await loadOfficerPipelineStatus();
  assert.ok(status.quotaEvents24h.internalDenials >= 1);
  assert.equal(status.quotaEvents24h.http429, 0);
});

test("a REAL HTTP 429 is a distinct event: recorded with status 429, opens the global cooldown, never retried by background work", async () => {
  const { chRestGetWithRateInfo, CompaniesHouseRateLimitError, CompaniesHouseQuotaDeferredError } = await import("../../src/lib/companies-house/client");
  await db.chQuotaEvent.deleteMany();
  await db.chRequestStat.deleteMany();
  const num = number("R4");
  const original = server.listeners("request")[0] as (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let calls = 0;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (req.url?.startsWith(`/company/${num}`)) {
      calls++;
      res.writeHead(429, { "X-Ratelimit-Remain": "0", "X-Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 5) });
      res.end("{}");
      return;
    }
    original(req, res);
  });
  try {
    // background class: the 429 surfaces as the REAL error, and is not retried in place
    let real: unknown;
    try {
      await chRestGetWithRateInfo(`/company/${num}`, { quotaClass: "backfill", maxAttempts: 4 });
    } catch (err) {
      real = err;
    }
    assert.ok(real instanceof CompaniesHouseRateLimitError);
    assert.ok(!(real instanceof CompaniesHouseQuotaDeferredError), "a genuine 429 is not the internal deferral");
    assert.equal((real as { http429: boolean }).http429, true);
    assert.match((real as Error).message, /HTTP 429/);
    assert.equal(calls, 1, "no retry storm: one request, then stop");

    // the very next background request is held back by the global cooldown WITHOUT being sent
    let internal: unknown;
    try {
      await chRestGetWithRateInfo(`/company/${num}`, { quotaClass: "backfill" });
    } catch (err) {
      internal = err;
    }
    assert.ok(internal instanceof CompaniesHouseQuotaDeferredError);
    assert.equal((internal as { http429: boolean }).http429, false);
    assert.equal(calls, 1, "nothing was sent during the cooldown");

    const state = await db.chQuotaState.findUniqueOrThrow({ where: { id: "rest" } });
    assert.ok(state.cooldownUntil && state.cooldownUntil > new Date());
    assert.ok(state.backgroundPausedUntil && state.backgroundPausedUntil > state.cooldownUntil);
    assert.ok(state.last429At);

    await new Promise((r) => setTimeout(r, 150)); // the internal-denial event is written asynchronously
    const events = await db.chQuotaEvent.findMany({ orderBy: { at: "asc" } });
    const real429 = events.filter((e) => e.kind === "http_429");
    const internalDenials = events.filter((e) => e.kind === "quota_denied");
    assert.equal(real429.length, 1);
    assert.equal(real429[0].httpStatus, 429);
    assert.equal(real429[0].internal, false);
    assert.equal(real429[0].headerRemaining, 0);
    assert.ok(real429[0].waitMs && real429[0].waitMs > 0);
    assert.ok(internalDenials.length >= 1 && internalDenials.every((e) => e.internal && e.httpStatus === null));
    assert.equal((await db.chRequestStat.aggregate({ _sum: { status429: true } }))._sum.status429, 1);
  } finally {
    server.removeAllListeners("request");
    server.on("request", original);
  }
});

test("demand-aware gate against the real database: idle classes leave capacity to the backfill, a user request reclaims it, two processes share one row", async () => {
  const q = await import("../../src/lib/companies-house/quota");
  const policy = { ...q.loadQuotaPolicy(), pacing: false };
  const procA = new q.DbQuotaStore(policy);
  const procB = new q.DbQuotaStore(policy);
  const now = new Date();
  await q.resetSharedQuotaState();

  // Two "processes" hammer the backfill class concurrently: together they get exactly the idle capacity.
  const floors = policy.idleFloor.user + policy.idleFloor.filing + policy.idleFloor.stream + policy.idleFloor.refresh;
  let granted = 0;
  await Promise.all(
    [procA, procB].map(async (store) => {
      for (let i = 0; i < 400; i++) {
        const d = await store.update((s) => {
          const r = q.decideAcquire(s, "backfill", now, policy);
          return { state: r.state, result: r.decision };
        });
        if (d.granted) granted++;
      }
    })
  );
  assert.equal(granted, policy.limit - policy.headroom - floors, "no overspend across processes, and the idle capacity is fully usable");

  // A user request is granted at once and becomes visible demand in the shared row.
  const u = await procB.update((s) => {
    const r = q.decideAcquire(s, "user", now, policy);
    return { state: r.state, result: r.decision };
  });
  assert.equal(u.granted, true);
  const row = await procA.read();
  assert.ok(row?.lastDemandAt.user, "demand is stored in the shared row");
  assert.equal(row?.used.backfill, granted);
  await q.resetSharedQuotaState();
});

test("the officer worker never touches CRM state: UserCompanyState (followed/saved/red flag/trash), notes, follow-ups and manual contacts are unchanged", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const u = await sessionFor("USER");
  const num = number("CR");
  modes.set(num, "many");
  const c = await makeCompany({ companyNumber: num });
  const untouched = await makeCompany({ companyNumber: number("CU") });
  const state = await db.userCompanyState.create({ data: { userId: u.userId, companyId: c.id, followed: true, saved: true, redFlagged: true, trashed: true } });
  await db.note.create({ data: { userCompanyStateId: state.id, body: "private note", authorName: "me" } });
  await db.followUp.create({ data: { userCompanyStateId: state.id, userId: u.userId, dueDate: new Date("2027-01-01"), note: "call", done: false } });
  await db.crmContact.create({ data: { userId: u.userId, companyId: c.id, name: "MANUAL CONTACT", role: "director" } });

  const snap = async () =>
    JSON.stringify({
      s: await db.userCompanyState.findMany({ where: { userId: u.userId }, orderBy: { id: "asc" } }),
      n: await db.note.findMany({ where: { userCompanyStateId: state.id }, orderBy: { id: "asc" } }),
      f: await db.followUp.findMany({ where: { userId: u.userId }, orderBy: { id: "asc" } }),
      c: await db.crmContact.findMany({ where: { userId: u.userId }, orderBy: { id: "asc" } }),
    });
  const before = await snap();
  await enqueueOfficerJobs([c.id], { priority: 2, reason: "followed" });
  const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
  assert.equal(stats.full, 1);
  assert.equal(await snap(), before, "CRM rows are identical after the worker ran");

  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.directorCount, 4, "director counting rules unchanged (director, corporate, nominee, LLP; not secretary / resigned)");
  assert.equal(after.officersCoverage, "full");
  // A company nobody fetched is still 'not fetched' - never a confirmed zero.
  const notFetched = await db.company.findUniqueOrThrow({ where: { id: untouched.id } });
  assert.equal(notFetched.officersCoverage, "none");
});

test("pacing is exercised end to end: a short run with pacing on spends one request per company and never hands work back", async () => {
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  process.env.CH_QUOTA_PACE_BURST = "3";
  try {
    const cs = [];
    for (let i = 0; i < 6; i++) {
      const n = number("PC");
      modes.set(n, "zero");
      cs.push(await makeCompany({ companyNumber: n }));
    }
    await enqueueOfficerJobs(cs.map((c) => c.id), { priority: 3, reason: "t" });
    const t0 = Date.now();
    const sentBefore = officerHits();
    const stats = await runOfficerWorker({ exitWhenIdle: true, freshness: false });
    assert.equal(stats.full, 6);
    assert.equal(officerHits() - sentBefore, 6);
    assert.equal(stats.systemicHandBacks, 0);
    assert.ok(Date.now() - t0 >= 1000, "requests beyond the initial burst are spread out, not fired back to back");
  } finally {
    delete process.env.CH_QUOTA_PACE_BURST;
  }
});
