import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, db, group, makeCompany, rule, sessionFor } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// ---- Edit Existing Report: PATCH edits in place, never duplicates -------------------
test("PATCH /api/reports/:id edits a saved report in place (same id, no duplicate), owner only", async () => {
  const owner = await sessionFor("USER");
  const other = await sessionFor("USER");
  const tag = `RE${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} A`, status: "active" });
  await makeCompany({ name: `${tag} B`, status: "active" });
  await makeCompany({ name: `${tag} C`, status: "dissolved" });

  const created = await api(owner, "/api/reports", {
    body: { name: `rep ${tag}`, description: "first", filter: group("AND", rule("name", "startsWith", tag)), dailyRefresh: true },
  });
  assert.equal(created.status, 200, created.text);
  const id = created.json.report.id as string;
  assert.equal(created.json.report.resultCount, 3);

  const before = await db.report.count({ where: { ownerId: created.json.report.ownerId } });

  // Rename, turn off daily refresh, narrow the criteria (AND of two rules).
  const patched = await api(owner, `/api/reports/${id}`, {
    method: "PATCH",
    body: {
      name: `renamed ${tag}`,
      description: "second",
      dailyRefresh: false,
      filter: group("AND", rule("name", "startsWith", tag), rule("status", "equals", "active")),
    },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.report.id, id, "same report id");
  assert.equal(patched.json.report.name, `renamed ${tag}`);
  assert.equal(patched.json.report.description, "second");
  assert.equal(patched.json.report.dailyRefresh, false);
  assert.equal(patched.json.report.resultCount, 2, "count recomputed from the new criteria");
  assert.equal(await db.report.count({ where: { ownerId: created.json.report.ownerId } }), before, "no duplicate report created");

  // Metadata-only edit leaves the criteria untouched.
  const rename = await api(owner, `/api/reports/${id}`, { method: "PATCH", body: { name: `again ${tag}` } });
  assert.equal(rename.status, 200);
  assert.equal(rename.json.report.resultCount, 2);
  assert.deepEqual(JSON.parse(rename.json.report.filterJson).children.length, 2);

  // Validation: bad filter -> controlled 400 and nothing changes.
  const bad = await api(owner, `/api/reports/${id}`, { method: "PATCH", body: { filter: { foo: 1 } } });
  assert.equal(bad.status, 400);
  assert.equal((await db.report.findUnique({ where: { id } }))?.name, `again ${tag}`);
  assert.equal((await api(owner, `/api/reports/${id}`, { method: "PATCH", body: { name: "" } })).status, 400);
  assert.equal((await api(owner, `/api/reports/${id}`, { method: "PATCH", body: { ownerId: "x" } })).status, 400, "unknown fields rejected");

  // Another user cannot edit it.
  assert.equal((await api(other, `/api/reports/${id}`, { method: "PATCH", body: { name: "hijack" } })).status, 404);
  assert.equal((await db.report.findUnique({ where: { id } }))?.name, `again ${tag}`);
});

test("report pages: edit page opens for the owner only; Create/Edit workflow entry points render", async () => {
  const owner = await sessionFor("USER");
  const other = await sessionFor("USER");
  const tag = `RP${Date.now() % 1000000}`;
  const created = await api(owner, "/api/reports", { body: { name: `page ${tag}`, filter: group("AND", rule("name", "startsWith", tag)) } });
  const id = created.json.report.id as string;

  const create = await api(owner, "/reports/new");
  assert.equal(create.status, 200);
  assert.match(create.text, /Create report/i);
  assert.match(create.text, /Edit existing/i);

  const list = await api(owner, "/reports/new?mode=edit");
  assert.equal(list.status, 200);
  assert.match(list.text, new RegExp(`page ${tag}`));
  assert.match(list.text, new RegExp(`/reports/${id}/edit`));

  const edit = await api(owner, `/reports/${id}/edit`);
  assert.equal(edit.status, 200);
  assert.match(edit.text, new RegExp(`page ${tag}`));

  assert.equal((await api(other, `/reports/${id}/edit`)).status, 404, "another user cannot open the editor");
});

test("report archive and report page show daily-update status and the saved confirmation", async () => {
  const s = await sessionFor("USER");
  const tag = `RA${Date.now() % 1000000}`;
  const created = await api(s, "/api/reports", { body: { name: `arch ${tag}`, filter: group("AND", rule("name", "startsWith", tag)), dailyRefresh: true } });
  const id = created.json.report.id as string;

  const archive = await api(s, "/reports");
  assert.equal(archive.status, 200);
  assert.match(archive.text, /Report archive/);
  assert.match(archive.text, new RegExp(`arch ${tag}`));
  assert.match(archive.text, /Last automatic update/, "the per-report column");
  assert.match(archive.text, /Daily update job last ran/, "the system-wide job time, labelled as the job's");

  const saved = await api(s, `/reports/${id}?saved=created`);
  assert.equal(saved.status, 200);
  assert.match(saved.text, /Report saved successfully/);
  assert.match(saved.text, /Daily refresh/);
  assert.match(saved.text, /Last automatic daily update/);
  assert.doesNotMatch((await api(s, `/reports/${id}`)).text, /Report saved successfully/);
});

test("Companies sorting: name A-Z / Z-A and company number ascending / descending are independent, server-side orders", async () => {
  const s = await sessionFor("USER");
  const tag = `SO${Date.now() % 100000}`;
  // Names and numbers deliberately disagree so a mix-up between the two sorts would show.
  const specs: [string, string][] = [
    [`${tag} Charlie`, `99${tag}01`],
    [`${tag} Alpha`, `99${tag}03`],
    [`${tag} Bravo`, `99${tag}02`],
  ];
  for (const [name, companyNumber] of specs) await makeCompany({ name, companyNumber });
  const list = async (sortField: string, sortDir: string) =>
    ((await api(s, "/api/companies/search", { body: { filter: group("AND", rule("name", "startsWith", tag)), sortField, sortDir, page: 1, pageSize: 25 } })).json.rows as { name: string; companyNumber: string }[]);
  assert.deepEqual((await list("name", "asc")).map((r) => r.name.slice(tag.length + 1)), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual((await list("name", "desc")).map((r) => r.name.slice(tag.length + 1)), ["Charlie", "Bravo", "Alpha"]);
  assert.deepEqual((await list("companyNumber", "asc")).map((r) => r.name.slice(tag.length + 1)), ["Charlie", "Bravo", "Alpha"]);
  assert.deepEqual((await list("companyNumber", "desc")).map((r) => r.name.slice(tag.length + 1)), ["Alpha", "Bravo", "Charlie"]);
  for (const f of ["status", "incorporationDate", "registeredPostcode", "directorCount", "accountsNextDue"])
    for (const d of ["asc", "desc"]) assert.equal((await list(f, d)).length, 3, `${f} ${d}`);
});

test("A-Z directory: namePrefix filters by first letter, resets with no letter, and combines with search, filters and sort", async () => {
  const s = await sessionFor("USER");
  const tag = `ZQ${Date.now() % 100000}`; // unique marker inside the names so only our rows can match
  const names = [`Apple ${tag} one`, `Apricot ${tag} two`, `Banana ${tag} three`, `Cherry ${tag} four`, `'Quoted ${tag} five`, `1st ${tag} six`];
  for (const name of names) await makeCompany({ name });
  const search = async (body: Record<string, unknown>) =>
    (await api(s, "/api/companies/search", { body: { filter: group("AND", rule("name", "contains", tag)), page: 1, pageSize: 25, ...body } })).json;

  // ALL (no prefix) returns everything.
  assert.equal((await search({})).total, 6);

  // Letter A / B / C return exactly the names beginning with that letter (punctuation and digits never match a letter).
  const a = await search({ namePrefix: "A", sortField: "name", sortDir: "asc" });
  assert.deepEqual(a.rows.map((r: { name: string }) => r.name), [`Apple ${tag} one`, `Apricot ${tag} two`]);
  assert.equal((await search({ namePrefix: "B" })).total, 1);
  assert.equal((await search({ namePrefix: "c" })).total, 1, "lower-case letter is accepted");
  assert.equal((await search({ namePrefix: "Q" })).total, 0, "a name starting with an apostrophe is not a Q name");
  assert.equal((await search({ namePrefix: "Z" })).total, 0);

  // Name Z-A within a letter, and company-number sort within a letter.
  const desc = await search({ namePrefix: "A", sortField: "name", sortDir: "desc" });
  assert.deepEqual(desc.rows.map((r: { name: string }) => r.name), [`Apricot ${tag} two`, `Apple ${tag} one`]);
  const byNumber = await search({ namePrefix: "A", sortField: "companyNumber", sortDir: "desc" });
  assert.equal(byNumber.total, 2);

  // Search box + letter + sort all apply together (AND).
  const combined = await search({ q: "Apri", namePrefix: "A", sortField: "name", sortDir: "asc" });
  assert.deepEqual(combined.rows.map((r: { name: string }) => r.name), [`Apricot ${tag} two`]);
  assert.equal((await search({ q: "Apri", namePrefix: "B" })).total, 0, "search and letter must both match");

  // Pagination keeps working under a letter: page 2 is the rest, and the total is unchanged.
  const p1 = await search({ namePrefix: "A", pageSize: 1, page: 1, sortField: "name", sortDir: "asc" });
  const p2 = await search({ namePrefix: "A", pageSize: 1, page: 2, sortField: "name", sortDir: "asc" });
  assert.equal(p1.total, 2);
  assert.equal(p2.rows[0].name, `Apricot ${tag} two`);

  // Invalid prefixes are rejected, not interpreted.
  for (const bad of ["AB", "1", "%", "", "A%"]) {
    assert.equal((await api(s, "/api/companies/search", { body: { namePrefix: bad } })).status, 400, `namePrefix ${JSON.stringify(bad)}`);
  }

  // Export honours the letter and counts it as narrowing for a plain USER.
  const exp = await api(s, "/api/companies/export", { body: { filter: group("AND", rule("name", "contains", tag)), namePrefix: "A" } });
  assert.equal(exp.status, 200, exp.text.slice(0, 120));
  assert.match(exp.text, new RegExp(`Apple ${tag} one`));
  assert.doesNotMatch(exp.text, /Banana/);
  assert.equal((await api(s, "/api/companies/export", { body: { namePrefix: "A" } })).status, 200, "a letter alone narrows the export");
});
