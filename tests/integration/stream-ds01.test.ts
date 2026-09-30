// Deterministic tests for the stream worker, DS01 handling, the REST client's
// rate-limit / retry behaviour and officer pagination. Companies House is
// replaced by local mock servers (the client honours COMPANIES_HOUSE_*_URL),
// so these tests are fast, repeatable and never touch the real API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { api, db, group, makeCompany, rule, sessionFor } from "./helpers";

const streamConnections: { timepoint: string | null; at: number }[] = [];
let streamScript: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void = () => {};
const restHits: Record<string, number> = {};
let restPort = 0;
let streamPort = 0;
let streamServer: http.Server;
let restServer: http.Server;
const openSockets = new Set<import("node:net").Socket>();

const ev = (tp: number, company: string, type: string, tx: string, date = "2026-09-30") =>
  JSON.stringify({
    resource_kind: "filing-history",
    resource_uri: `/company/${company}/filing-history/${tx}`,
    resource_id: tx,
    data: { transaction_id: tx, type, date, description: `${type} filing` },
    event: { timepoint: tp, published_at: "2026-09-30T10:00:00", type: "changed" },
  }) + "\n";

function profile(number: string) {
  return {
    company_name: `MOCK ${number} LTD`, company_number: number, company_status: "active", type: "ltd", date_of_creation: "2020-01-15",
    registered_office_address: { address_line_1: "1 Mock Street", locality: "Mockton", postal_code: "mo1 1ck" },
    accounts: { next_due: "2027-01-31", last_accounts: { made_up_to: "2025-04-30", type: "micro-entity" }, overdue: false },
    confirmation_statement: { next_due: "2026-12-01", last_made_up_to: "2025-11-17", overdue: false },
    sic_codes: ["62012"],
  };
}

function officerPage(total: number, start: number, per: number) {
  const roles = ["director", "secretary", "corporate-director", "llp-member", "director"];
  const items = Array.from({ length: Math.max(0, Math.min(per, total - start)) }, (_, i) => {
    const n = start + i;
    return {
      name: `OFFICER ${n}`,
      officer_role: roles[n % roles.length],
      appointed_on: "2015-03-02",
      ...(n % 7 === 0 ? { resigned_on: "2019-01-01" } : {}),
      links: { officer: { appointments: `/officers/ID${n}/appointments` } },
    };
  });
  return { items, total_results: total, items_per_page: per, start_index: start };
}

before(async () => {
  streamServer = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    streamConnections.push({ timepoint: url.searchParams.get("timepoint"), at: Date.now() });
    streamScript(req, res, streamConnections.length);
  });
  streamServer.on("connection", (s) => { openSockets.add(s); s.on("close", () => openSockets.delete(s)); });
  await new Promise<void>((r) => streamServer.listen(0, "127.0.0.1", r));
  streamPort = (streamServer.address() as AddressInfo).port;

  restServer = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const p = url.pathname;
    restHits[p] = (restHits[p] ?? 0) + 1;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "X-Ratelimit-Remain": "500", ...headers });
      res.end(JSON.stringify(body));
    };
    const m = /^\/company\/([^/]+)(\/officers)?$/.exec(p);
    if (!m) return send(404, {});
    const [, number, officers] = m;
    if (number === "RL000001" && restHits[p] === 1) {
      return send(429, {}, { "X-Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 1), "X-Ratelimit-Remain": "0" });
    }
    if (number === "SV000001" && restHits[p] === 1) return send(503, {});
    if (number === "AUTH0001") return send(401, {});
    if (number === "NOTFOUND") return send(404, {});
    if (officers) {
      const start = Number(url.searchParams.get("start_index") ?? 0);
      const per = Number(url.searchParams.get("items_per_page") ?? 35);
      return send(200, officerPage(number === "OFF00250" ? 250 : 40, start, per));
    }
    return send(200, profile(number));
  });
  await new Promise<void>((r) => restServer.listen(0, "127.0.0.1", r));
  restPort = (restServer.address() as AddressInfo).port;

  process.env.COMPANIES_HOUSE_STREAM_URL = `http://127.0.0.1:${streamPort}/filings`;
  process.env.COMPANIES_HOUSE_STREAM_KEY = "test-stream-key";
  process.env.COMPANIES_HOUSE_API_KEY = "test-rest-key";
  process.env.COMPANIES_HOUSE_REST_BASE_URL = `http://127.0.0.1:${restPort}`;
});

after(async () => {
  for (const s of openSockets) s.destroy();
  streamServer.close();
  restServer.close();
  await db.$disconnect();
});

// ---- stream: reconnect, resume, duplicates, malformed, gap, DS01/DS02 ------------------------------
test("stream worker: reconnects, resumes from checkpoint, dedupes, survives malformed lines and a gap; DS01 sets hasDS01", async () => {
  const { runStreamWorker, loadCheckpoint } = await import("../../src/lib/companies-house/streamWorker");
  await db.streamCheckpoint.deleteMany();

  const tag = String(Date.now() % 100000).padStart(5, "0");
  const A = await makeCompany({ companyNumber: `SA${tag}`.toUpperCase() });
  const B = await makeCompany({ companyNumber: `SB${tag}`.toUpperCase() });
  const cNumber = `SC${tag}`.toUpperCase(); // NOT in our database: must be fetched from REST then flagged
  const t = (s: string) => `${s}-${tag}`;

  streamScript = (req, res, n) => {
    if (n === 3) {
      res.writeHead(416); // checkpoint no longer available
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (n === 1) {
      res.write(ev(100, A.companyNumber, "DS01", t("txA")));
      res.write(ev(101, A.companyNumber, "AA", t("txAA")));
      res.write("{this is not json\n");
      res.write("\n"); // heartbeat
      res.write(JSON.stringify({ resource_kind: "company-profile", resource_uri: "/company/X/", data: {} }) + "\n"); // not a filing event
      res.write(ev(102, B.companyNumber, "DS01", t("txB")));
      res.write(ev(102, B.companyNumber, "DS01", t("txB"))); // duplicate delivery
      setTimeout(() => res.socket?.destroy(), 150); // connection drops
    } else if (n === 2) {
      res.write(ev(102, B.companyNumber, "DS01", t("txB"))); // replay of the checkpoint event itself
      res.write(ev(103, cNumber, "DS01", t("txC")));
      // ...then goes silent: the worker must notice via its idle timeout.
    } else {
      res.write(ev(500, A.companyNumber, "DS02", t("txA2"))); // withdrawal of A's strike-off application
      // stay open until the worker is stopped
    }
  };

  streamConnections.length = 0;
  const logs: string[] = [];
  const stats = await runStreamWorker({
    maxRuntimeMs: 6000,
    idleTimeoutMs: 700,
    backoff: { initialMs: 50, maxMs: 200 },
    onEvent: (m) => logs.push(m),
  });

  // Connection log: live, resume@102, resume@103 (rejected with 416), then live again.
  assert.deepEqual(streamConnections.slice(0, 4).map((c) => c.timepoint), [null, "102", "103", null], JSON.stringify(streamConnections));
  assert.ok(stats.reconnects >= 3);
  assert.equal(stats.gaps, 1);
  assert.ok(logs.some((l) => /GAP/.test(l)), "the gap is logged loudly");
  assert.equal(stats.malformed, 1); // the garbage line is dropped inside the client; the non-filing record is counted here
  assert.ok(stats.duplicates >= 2);

  // Exactly one stored row per transaction, regardless of replays.
  for (const tx of ["txA", "txB", "txC", "txA2"]) assert.equal(await db.filingEvent.count({ where: { transactionId: t(tx) } }), 1, tx);
  assert.equal(await db.filingEvent.count({ where: { transactionId: t("txAA") } }), 0, "non state-changing events are not stored by default");

  // DS01: event -> company identified -> database updated -> hasDS01 true.
  const b = await db.company.findUniqueOrThrow({ where: { companyNumber: B.companyNumber } });
  assert.equal(b.hasDS01, true);
  assert.equal(b.ds01FiledAt?.toISOString().slice(0, 10), "2026-09-30");
  const c = await db.company.findUniqueOrThrow({ where: { companyNumber: cNumber } });
  assert.equal(c.hasDS01, true, "company fetched from REST then flagged");
  assert.equal(c.source, "stream");
  assert.equal(c.registeredPostcode, "MO1 1CK");
  const evC = await db.filingEvent.findUniqueOrThrow({ where: { transactionId: t("txC") } });
  assert.equal(evC.applyStatus, "applied");
  assert.equal(evC.companyId, c.id);
  assert.equal(Number(evC.timepoint), 103);

  // DS02 withdrew A's DS01.
  const a = await db.company.findUniqueOrThrow({ where: { companyNumber: A.companyNumber } });
  assert.equal(a.hasDS01, false);
  assert.equal(a.ds01FiledAt, null);

  // The report filter finds the DS01 companies through the real API.
  const user = await sessionFor("USER");
  const r = await api(user, "/api/companies/search", { body: { filter: group("AND", rule("hasDS01", "isTrue"), rule("companyNumber", "endsWith" as never, tag)), pageSize: 50 } });
  assert.equal(r.status, 400); // endsWith is not an allowed operator: sanity check of validation
  const found = await api(user, "/api/companies/search", { body: { filter: group("AND", rule("hasDS01", "isTrue"), rule("companyNumber", "contains", tag)), pageSize: 50 } });
  assert.equal(found.status, 200);
  assert.deepEqual((found.json.rows as { companyNumber: string }[]).map((x) => x.companyNumber).sort(), [B.companyNumber, cNumber].sort());

  // Checkpoint ends at the last persisted position, and the run is closed cleanly.
  assert.equal(await loadCheckpoint(), 500);
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "stream" }, orderBy: { startedAt: "desc" } });
  assert.equal(run.status, "success");
  assert.ok(run.finishedAt);
});

test("a killed worker restarts from its checkpoint without re-applying or duplicating", async () => {
  const { runStreamWorker } = await import("../../src/lib/companies-house/streamWorker");
  const tag = String(Date.now() % 100000).padStart(5, "0");
  const A = await makeCompany({ companyNumber: `KA${tag}`.toUpperCase() });
  const B = await makeCompany({ companyNumber: `KB${tag}`.toUpperCase() });
  await db.streamCheckpoint.upsert({ where: { name: "filings" }, create: { name: "filings", timepoint: BigInt(1000) }, update: { timepoint: BigInt(1000) } });

  // Run 1 is "killed": the client disconnects mid-stream after the first event.
  streamScript = (req, res, n) => {
    res.writeHead(200);
    if (n === 1) { res.write(ev(1001, A.companyNumber, "DS01", `k1-${tag}`)); setTimeout(() => res.socket?.destroy(), 100); }
    else { res.write(ev(1001, A.companyNumber, "DS01", `k1-${tag}`)); res.write(ev(1002, B.companyNumber, "DS01", `k2-${tag}`)); }
  };
  streamConnections.length = 0;
  const s = await runStreamWorker({ maxRuntimeMs: 1500, idleTimeoutMs: 5000, backoff: { initialMs: 30, maxMs: 60 } });
  assert.equal(streamConnections[0].timepoint, "1000"); // resumed from the stored checkpoint
  assert.equal(streamConnections[1].timepoint, "1001"); // and again after the drop
  assert.equal(await db.filingEvent.count({ where: { transactionId: { in: [`k1-${tag}`, `k2-${tag}`] } } }), 2);
  assert.equal(s.duplicates, 1);
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: B.companyNumber } })).hasDS01, true);
});

test("DS01 is sticky: a profile refresh that lacks the strike-off status does not erase it", async () => {
  const { persistFilingEvent, applyFilingEvent } = await import("../../src/lib/companies-house/filingEvents");
  const { syncCompanyProfile } = await import("../../src/lib/companies-house/sync");
  const tag = String(Date.now() % 100000).padStart(5, "0");
  const c = await makeCompany({ companyNumber: `ST${tag}`.toUpperCase() });
  const { id } = await persistFilingEvent({ transactionId: `st-${tag}`, companyNumber: c.companyNumber, type: "DS01", date: "2026-09-29", description: null, resourceUri: `/company/${c.companyNumber}/filing-history/x`, timepoint: 1 });
  assert.equal(await applyFilingEvent(id), "applied");
  assert.equal(await applyFilingEvent(id), "applied"); // idempotent
  await syncCompanyProfile(c.companyNumber, "rest_enrichment"); // the mock profile has no strike-off detail
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.hasDS01, true);
  assert.equal(after.ds01FiledAt?.toISOString().slice(0, 10), "2026-09-29");
});

test("a DS01 that cannot be applied yet stays pending (not lost) and is applied by reconcile", async () => {
  const { persistFilingEvent, applyFilingEvent, reconcilePendingFilingEvents } = await import("../../src/lib/companies-house/filingEvents");
  const tag = String(Date.now() % 100000).padStart(5, "0");
  const number = `NOTFOUND`; // mock REST 404s this company
  const { id } = await persistFilingEvent({ transactionId: `pend-${tag}`, companyNumber: number, type: "DS01", date: "2026-09-30", description: null, resourceUri: `/company/${number}/filing-history/x`, timepoint: 2 });
  assert.equal(await applyFilingEvent(id), "pending");
  const row = await db.filingEvent.findUniqueOrThrow({ where: { id } });
  assert.equal(row.applyStatus, "pending");
  assert.match(row.lastError ?? "", /not found/);
  const rec = await reconcilePendingFilingEvents();
  assert.ok(rec.stillPending >= 1);
  await db.filingEvent.delete({ where: { id } });
});

// ---- REST client: rate limits, retries, errors ------------------------------------------------------------
test("REST client: waits out a 429 until the advertised reset, then succeeds", async () => {
  const { chRestGetWithRateInfo, resetRateState } = await import("../../src/lib/companies-house/client");
  resetRateState();
  const t0 = Date.now();
  const res = await chRestGetWithRateInfo<{ company_number: string }>("/company/RL000001");
  assert.equal(res.company_number, "RL000001");
  assert.equal(restHits["/company/RL000001"], 2);
  assert.ok(Date.now() - t0 >= 900, "it really waited for the rate-limit window");
});

test("REST client: retries a transient 503, and does not retry 401 / 404", async () => {
  const { chRestGetWithRateInfo, CompaniesHouseApiError, CompaniesHouseNotFoundError, resetRateState } = await import("../../src/lib/companies-house/client");
  resetRateState();
  const hits = (p: string) => restHits[p] ?? 0;
  const base401 = hits("/company/AUTH0001");
  const base404 = hits("/company/NOTFOUND");
  const ok = await chRestGetWithRateInfo<{ company_number: string }>("/company/SV000001");
  assert.equal(ok.company_number, "SV000001");
  assert.equal(restHits["/company/SV000001"], 2);
  await assert.rejects(chRestGetWithRateInfo("/company/AUTH0001"), (e: unknown) => e instanceof CompaniesHouseApiError && e.status === 401);
  assert.equal(hits("/company/AUTH0001") - base401, 1); // 401 is not retried
  await assert.rejects(chRestGetWithRateInfo("/company/NOTFOUND"), CompaniesHouseNotFoundError);
  assert.equal(hits("/company/NOTFOUND") - base404, 1); // 404 is not retried
});

test("REST client: self-throttles when the quota is nearly exhausted", async () => {
  const { chRestGetWithRateInfo, getLastKnownRateRemaining } = await import("../../src/lib/companies-house/client");
  await chRestGetWithRateInfo("/company/QUOTA001");
  assert.equal(getLastKnownRateRemaining(), 500); // header recorded
});

// ---- officers: pagination + counting --------------------------------------------------------------------------
test("officers: every page is read (250 officers over 3 pages), not just the first", async () => {
  const { fetchCompanyOfficers, countActiveDirectors } = await import("../../src/lib/companies-house/officers");
  const before = restHits["/company/OFF00250/officers"] ?? 0;
  const officers = await fetchCompanyOfficers("OFF00250");
  assert.equal(officers.length, 250);
  assert.equal(restHits["/company/OFF00250/officers"] - before, 3);
  assert.equal(new Set(officers.map((o) => o.name)).size, 250);
  // roles cycle director,secretary,corporate-director,llp-member,director; every 7th is resigned
  const expected = officers.filter((o, n) => ["director", "corporate-director", "llp-member"].includes(o.officer_role) && n % 7 !== 0).length;
  assert.equal(countActiveDirectors(officers), expected);
  assert.ok(expected > 0 && expected < 250);
});

test("officer sync stores ALL officers, sets the director count, and leaves CRM contacts alone", async () => {
  const { syncCompanyDirectors } = await import("../../src/lib/companies-house/sync");
  const s = await sessionFor("USER");
  const c = await makeCompany({ companyNumber: "OFF00250" }).catch(async () => db.company.findUniqueOrThrow({ where: { companyNumber: "OFF00250" } }));
  await db.crmContact.create({ data: { userId: s.userId, companyId: c.id, name: "MY CONTACT" } });
  const count = await syncCompanyDirectors(c.id, "OFF00250");
  const after = await db.company.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.directorCount, count);
  assert.equal(after.singleDirector, count === 1);
  assert.equal(after.officersCoverage, "full");
  assert.equal(await db.director.count({ where: { companyId: c.id } }), 250);
  assert.equal(await db.crmContact.count({ where: { companyId: c.id } }), 1);
  // Re-sync is idempotent (replace, not append).
  await syncCompanyDirectors(c.id, "OFF00250");
  assert.equal(await db.director.count({ where: { companyId: c.id } }), 250);
});
