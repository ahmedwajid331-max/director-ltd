import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A very small Chrome DevTools Protocol driver (no dependency): enough to log in through the real UI, click, type, read
// the DOM and take screenshots against the production build. Skipped by the tests when Chrome is not installed.

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p);

export function findChrome(): string | null {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

export interface BrowserPage {
  goto(url: string): Promise<void>;
  eval<T = unknown>(expression: string): Promise<T>;
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  setViewport(width: number, height: number, mobile?: boolean): Promise<void>;
  screenshot(file: string, fullPage?: boolean): Promise<void>;
  logs: string[]; // console / security messages seen so far (for diagnosing a failed step)
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchPage(port: number): Promise<BrowserPage> {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome not found");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dl-chrome-"));
  const proc: ChildProcess = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = tabs.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
  }
  if (!target) {
    proc.kill();
    throw new Error("Chrome did not start");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP connection failed"));
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const logs: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Log.entryAdded") logs.push(`${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) logs.push(`console.${m.params.type}: ${(m.params.args ?? []).map((a: { value?: unknown; description?: string }) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 400)}`);
    if (m.method === "Runtime.exceptionThrown") logs.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  };
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const i = ++id;
      pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  };
  const waitFor = async (expression: string, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await evaluate<boolean>(`!!(${expression})`)) return;
      } catch {
        /* page navigating */
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  };

  return {
    logs,
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(300);
      await waitFor(`document.readyState === "complete"`);
      await sleep(400); // let client components hydrate
    },
    eval: evaluate,
    waitFor,
    async click(selector) {
      await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async type(selector, text) {
      await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await send("Input.insertText", { text });
    },
    async setViewport(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await sleep(300);
    },
    async screenshot(file, fullPage = false) {
      let params: object = {};
      if (fullPage) {
        const h = await evaluate<number>("Math.max(document.documentElement.scrollHeight, 600)");
        const w = await evaluate<number>("window.innerWidth");
        params = { captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 6000), scale: 1 } };
      }
      const r = await send("Page.captureScreenshot", params);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      proc.kill();
      await sleep(1000);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold the profile on Windows; it is a temp directory */
      }
    },
  };
}
