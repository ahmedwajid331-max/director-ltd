import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { BASE, db, group, makeCompany, rule, sessionFor, STRONG_PASSWORD } from "./helpers";
import { findChrome, launchPage, type BrowserPage } from "../support/browser";

// Real-browser check of the Report Builder's Export dropdown: compact, anchored to the button, inside the viewport at
// desktop / short / phone sizes, closes on Escape / outside click / choosing a format, shows the right messages.
// Screenshots go to SCREENSHOT_DIR (default: the OS temp folder).

after(async () => {
  await db.$disconnect();
});

const chrome = findChrome();
const shots = process.env.SCREENSHOT_DIR ?? path.join(os.tmpdir(), "dl-export-shots");

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
const MENU = `document.querySelector('[role="menu"][aria-label="Export results"]')`;
const rectOf = (p: BrowserPage, expr: string) =>
  p.eval<Box | null>(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const exportButton = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Export") && b.getAttribute("aria-haspopup") === "menu")`;
const saveButton = `[...document.querySelectorAll("button")].find((b) => /^(Save report|Save changes)/.test(b.textContent.trim()))`;
const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function openMenu(p: BrowserPage) {
  await p.eval(`(${exportButton}).click()`);
  await p.waitFor(MENU);
  await new Promise((r) => setTimeout(r, 150));
}

test("Export dropdown: compact, anchored, inside the viewport, closes properly, correct messages", { skip: chrome ? false : "Chrome is not installed", timeout: 240_000 }, async () => {
  const me = await sessionFor("USER", "exportui");
  const tag = `EX${Date.now() % 1000000}`;
  await makeCompany({ name: `${tag} UI ONE` });
  const page = await launchPage(9334);
  try {
    await page.setViewport(1440, 900);
    await page.goto(`${BASE}/login`);
    await page.type('input[type="email"]', me.email);
    await page.type('input[type="password"]', STRONG_PASSWORD);
    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Sign in")).click()`);
    await page.waitFor(`location.pathname !== "/login"`);

    // Carry a filter over exactly as the Companies page does, so the builder opens with a real result.
    await page.goto(`${BASE}/reports/new`);
    await page.eval(`sessionStorage.setItem("pendingReportFilter", ${JSON.stringify(JSON.stringify(group("AND", rule("name", "startsWith", tag))))})`);
    await page.goto(`${BASE}/reports/new`);
    await page.waitFor(`document.querySelector('[data-testid="matching-count"]') && document.querySelector('[data-testid="matching-count"]').textContent.trim() === "1"`, 30_000);
    await page.waitFor(`(${exportButton}) && !(${exportButton}).disabled`);

    const exportBox = (await rectOf(page, exportButton))!;
    const saveBox = (await rectOf(page, saveButton))!;
    assert.ok(Math.abs(exportBox.top - saveBox.top) < 6, "Export sits on the same row as Save report");
    assert.ok(exportBox.left > saveBox.left, "Export is beside (after) Save report");

    // ---- desktop: compact, anchored, not covering the buttons --------------------------------------------------------
    await openMenu(page);
    const items = await page.eval<string[]>(`[...${MENU}.querySelectorAll('[role="menuitem"]')].map((i) => i.innerText.replace(/\\s+/g, ""))`);
    assert.deepEqual(items, ["Excel.xlsx", "CSV.csv", "PDF.pdf", "Word.docx"]);
    let menu = (await rectOf(page, MENU))!;
    assert.ok(menu.width <= 200 && menu.height <= 160, `compact (${menu.width}x${menu.height})`);
    assert.ok(menu.left >= 0 && menu.top >= 0 && menu.right <= 1440 && menu.bottom <= 900, "inside the viewport");
    assert.ok(!overlaps(menu, exportBox) && !overlaps(menu, (await rectOf(page, saveButton))!), "does not cover Export or Save report");
    assert.ok(Math.abs(menu.right - exportBox.right) < 4, "right edge anchored to the Export button");
    assert.ok(Math.min(Math.abs(menu.top - exportBox.bottom), Math.abs(menu.bottom - exportBox.top)) <= 8, "attached directly to the button");
    await page.screenshot(path.join(shots, "export-menu-desktop.png"));

    // ---- other sizes: still fully inside the viewport -----------------------------------------------------------------
    for (const [w, h, mobile] of [[1280, 420, false], [390, 700, true], [320, 480, true]] as const) {
      await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
      await page.setViewport(w, h, mobile);
      await page.eval(`(${exportButton}).scrollIntoView({ block: "center" })`);
      await openMenu(page);
      menu = (await rectOf(page, MENU))!;
      const b = (await rectOf(page, exportButton))!;
      assert.ok(menu.left >= 0 && menu.top >= 0 && menu.right <= w && menu.bottom <= h, `${w}x${h}: inside the viewport (${JSON.stringify(menu)})`);
      assert.ok(!overlaps(menu, b), `${w}x${h}: does not cover the Export button`);
      assert.ok(menu.width <= 200, `${w}x${h}: still compact`);
      await page.screenshot(path.join(shots, `export-menu-${w}x${h}.png`));
    }
    await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await page.setViewport(1440, 900);

    // ---- closing: Escape, outside click, choosing a format --------------------------------------------------------------
    await openMenu(page);
    await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await page.waitFor(`!${MENU}`);
    assert.equal(await page.eval<boolean>(`document.activeElement === (${exportButton})`), true, "Escape returns focus to the button");

    await openMenu(page);
    await page.eval(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
    await page.waitFor(`!${MENU}`);

    await openMenu(page);
    await page.eval(`${MENU}.querySelector('[role="menuitem"][aria-label^="Excel"]').click()`);
    await page.waitFor(`!${MENU}`);
    await page.waitFor(`document.querySelector('[data-testid="export-notice"]')`, 30_000);
    assert.equal((await page.eval<string>(`document.querySelector('[data-testid="export-notice"]').textContent.trim()`)), "Report exported successfully.", "success message, not 'report created'");
    assert.equal(await page.eval<boolean>(`!document.body.innerText.toLowerCase().includes("report created")`), true);
    await page.screenshot(path.join(shots, "export-success.png"));

    // Choosing a format that the server refuses shows its message instead (a plain user needs a filter).
    await page.eval(`sessionStorage.removeItem("pendingReportFilter")`);
    await page.goto(`${BASE}/reports/new`);
    await page.waitFor(`document.querySelector('[data-testid="matching-count"]')`, 30_000);
    await page.waitFor(`(${exportButton}) && !(${exportButton}).disabled`);
    await openMenu(page);
    await page.eval(`${MENU}.querySelector('[role="menuitem"][aria-label^="PDF"]').click()`);
    await page.waitFor(`document.querySelector('[data-testid="export-notice"]')`, 30_000);
    assert.match(await page.eval<string>(`document.querySelector('[data-testid="export-notice"]').textContent`), /Add at least one filter/);
    assert.equal(await page.eval<boolean>(`!${MENU}`), true);
  } finally {
    await page.close();
  }
});
