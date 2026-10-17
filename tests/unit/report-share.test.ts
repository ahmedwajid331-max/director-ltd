import { test } from "node:test";
import assert from "node:assert/strict";
import { canNativeShare, copyText, mailtoUrl, shareText, whatsappUrl } from "../../src/lib/reports/share";

const input = { title: 'Dormant & "Active" ltd #1', total: 3179, url: "https://app.example/reports/abc123" };

test("WhatsApp link uses the official wa.me endpoint with a fully encoded message", () => {
  const u = whatsappUrl(input);
  assert.ok(u.startsWith("https://wa.me/?text="));
  const text = decodeURIComponent(u.slice("https://wa.me/?text=".length));
  assert.equal(text, shareText(input));
  assert.ok(text.includes('Dormant & "Active" ltd #1') && text.includes("3,179 companies") && text.includes(input.url));
  assert.ok(!u.slice(20).includes("&") && !u.includes("#") && !u.includes(" "), "reserved characters are percent-encoded");
});

test("Email link has an encoded subject and body with the link and the sign-in note", () => {
  const u = mailtoUrl(input);
  const q = new URL(u.replace("mailto:", "http://x/"));
  assert.equal(q.searchParams.get("subject"), 'DIRECTOR.LTD report: Dormant & "Active" ltd #1');
  const body = q.searchParams.get("body")!;
  assert.ok(body.includes(input.url) && /signed in/i.test(body));
});

test("share text carries only the title, count and link (no company data) and says sign-in is required", () => {
  const t = shareText({ title: "R", total: 1, url: "https://x/reports/1" });
  assert.equal(t, 'DIRECTOR.LTD report "R" - 1 company\nhttps://x/reports/1\n(Sign-in required to view.)');
  assert.ok(!shareText({ title: "R", total: null, url: "u" }).includes("null"));
});

test("native share is detected only when navigator.share exists", () => {
  assert.equal(canNativeShare(undefined), false);
  assert.equal(canNativeShare({}), false);
  assert.equal(canNativeShare({ share: async () => {} }), true);
});

test("copyText reports failure instead of throwing when the clipboard is unavailable or denied", async () => {
  assert.equal(await copyText("x", undefined), false);
  assert.equal(await copyText("x", { clipboard: { writeText: async () => { throw new Error("denied"); } } }), false);
  let written = "";
  assert.equal(await copyText("hello", { clipboard: { writeText: async (t) => { written = t; } } }), true);
  assert.equal(written, "hello");
});
