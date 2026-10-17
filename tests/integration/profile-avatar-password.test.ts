import { test } from "node:test";
import assert from "node:assert/strict";
import { api, BASE, db, login, sessionFor, STRONG_PASSWORD, type Session } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const uniq = () => Math.random().toString(36).slice(2, 8);

async function upload(s: Session | null, bytes: Buffer | string, type = "image/png", name = "a.png") {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(typeof bytes === "string" ? Buffer.from(bytes) : bytes)], name, { type }));
  const res = await fetch(`${BASE}/api/profile/avatar`, { method: "POST", headers: s ? { cookie: `director_session=${s.cookie}` } : {}, body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const getAvatar = (s: Session | null, id: string) => fetch(`${BASE}/api/profile/avatar/${id}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {} });

test("Create user: the password minimum is 8 characters, enforced by the server", async () => {
  const sup = await sessionFor("SUPER_ADMIN");
  const mk = (password: string) => api(sup, "/api/users", { body: { name: "Pw Test", email: `pw.${uniq()}@test.example`, password, role: "USER" } });
  const short = await mk("Ab1!xyz"); // 7 characters
  assert.equal(short.status, 400);
  assert.match(JSON.stringify(short.json), /at least 8/);
  const eight = await mk("Xk9#mQ2v"); // exactly 8, passes the complexity rules
  assert.equal(eight.status, 200, eight.text);
  // The existing complexity rules still apply at 8 characters.
  assert.equal((await mk("aaaaaaaa")).status, 400);
  assert.equal((await mk("12345678")).status, 400);
  // The new account can sign in with that 8-character password.
  const created = await db.user.findUniqueOrThrow({ where: { id: eight.json.user.id } });
  assert.equal((await login(created.email, "Xk9#mQ2v")).status, 200);
  void STRONG_PASSWORD;
});

test("Profile picture: save, persist, serve, replace, remove - and nobody can touch another person's", async () => {
  for (const role of ["USER", "SUPER_ADMIN"] as const) {
    const me = await sessionFor(role, "avatar");
    assert.equal((await getAvatar(me, me.userId)).status, 404, "no picture yet: the header shows initials");

    const ok = await upload(me, PNG);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const served = await getAvatar(me, me.userId);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    // Survives sign-out and a fresh sign-in; the header renders the picture URL.
    const again = await login(me.email);
    assert.ok(again.cookie);
    const fresh: Session = { ...me, cookie: again.cookie! };
    assert.equal((await getAvatar(fresh, me.userId)).status, 200);
    const html = await (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${fresh.cookie}` } })).text();
    assert.match(html, new RegExp(`/api/profile/avatar/${me.userId}\\?v=\\d+`));
    assert.match(html, /Profile picture/);

    // Removing returns to initials.
    const del = await fetch(`${BASE}/api/profile/avatar`, { method: "DELETE", headers: { cookie: `director_session=${fresh.cookie}` } });
    assert.equal(del.status, 200);
    assert.equal((await getAvatar(fresh, me.userId)).status, 404);
    assert.doesNotMatch(await (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${fresh.cookie}` } })).text(), new RegExp(`/api/profile/avatar/${me.userId}`));
  }
});

test("Profile picture: only real images, size-limited, authenticated, and private to the owner", async () => {
  const a = await sessionFor("USER", "ava");
  const b = await sessionFor("USER", "avb");
  const sup = await sessionFor("SUPER_ADMIN", "avs");

  assert.equal((await upload(null, PNG)).status, 401, "signed-out upload refused");
  // Declared type is not trusted: an SVG / HTML / script renamed or labelled as an image is refused.
  assert.equal((await upload(a, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/png", "x.png")).status, 415);
  assert.equal((await upload(a, "<html></html>", "image/jpeg", "x.jpg")).status, 415);
  assert.equal((await upload(a, Buffer.from("GIF89a....."), "image/gif", "x.gif")).status, 415);
  assert.equal((await upload(a, Buffer.alloc(0))).status, 400);
  assert.equal((await upload(a, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status, 413, "over 2 MB refused");
  assert.equal((await getAvatar(a, a.userId)).status, 404, "refused uploads leave nothing behind");

  // A target id in the request is ignored: the upload always changes the signed-in user's own picture.
  const form = new FormData();
  form.append("file", new File([new Uint8Array(PNG)], "a.png", { type: "image/png" }));
  form.append("userId", b.userId);
  await fetch(`${BASE}/api/profile/avatar?id=${b.userId}`, { method: "POST", headers: { cookie: `director_session=${a.cookie}` }, body: form });
  assert.equal((await getAvatar(a, a.userId)).status, 200);
  assert.equal((await getAvatar(b, b.userId)).status, 404, "B's picture was not changed by A");

  // Reading: owner and Super Admin may; another user and the signed-out may not. Bad ids cannot reach the filesystem.
  assert.equal((await getAvatar(b, a.userId)).status, 404);
  assert.equal((await getAvatar(null, a.userId)).status, 401);
  assert.equal((await getAvatar(sup, a.userId)).status, 200);
  assert.equal((await getAvatar(a, "..%2F..%2Fpackage.json")).status, 404);
  assert.equal((await getAvatar(a, "a".repeat(80))).status, 404);

  // B deleting only deletes B's own (nothing), never A's.
  await fetch(`${BASE}/api/profile/avatar`, { method: "DELETE", headers: { cookie: `director_session=${b.cookie}` } });
  assert.equal((await getAvatar(a, a.userId)).status, 200);
});

test("Users page: a picture shows in that person's row, initials otherwise; supervisors see only their own team's pictures", async () => {
  const sup = await sessionFor("SUPER_ADMIN", "uvs");
  const boss = await sessionFor("ADMIN", "uvb");
  const withPic = await sessionFor("USER", "uvp");
  const without = await sessionFor("USER", "uvn");
  const outsider = await sessionFor("USER", "uvo");
  await db.user.updateMany({ where: { id: { in: [withPic.userId, without.userId] } }, data: { managerId: boss.userId } });
  assert.equal((await upload(withPic, PNG)).status, 200);
  assert.equal((await upload(outsider, PNG)).status, 200);

  const html = await (await fetch(`${BASE}/users`, { headers: { cookie: `director_session=${sup.cookie}` } })).text();
  assert.match(html, new RegExp(`/api/profile/avatar/${withPic.userId}[?]v=[0-9]+`), "picture URL is in that user's row");
  assert.doesNotMatch(html, new RegExp(`/api/profile/avatar/${without.userId}`), "no picture: initials only");

  // The supervisor's page lists only their team, and the image endpoint agrees with that scope.
  const bossHtml = await (await fetch(`${BASE}/users`, { headers: { cookie: `director_session=${boss.cookie}` } })).text();
  assert.match(bossHtml, new RegExp(`/api/profile/avatar/${withPic.userId}[?]v=[0-9]+`));
  assert.doesNotMatch(bossHtml, new RegExp(outsider.userId));
  assert.equal((await getAvatar(boss, withPic.userId)).status, 200, "supervisor can load a team member's picture");
  assert.equal((await getAvatar(boss, outsider.userId)).status, 404, "...but not someone outside their team");
  assert.equal((await getAvatar(withPic, outsider.userId)).status, 404, "an ordinary user still cannot load anyone else's");
});
