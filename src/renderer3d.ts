// Server-side agent-frame renderer: one headless Chromium (via puppeteer) running public/render.html, which
// draws a Snapshot with Three.js and returns a PNG. Works under Bun on Windows with puppeteer's own
// downloaded chrome-headless-shell (`headless: "shell"`); WebGL runs on SwiftShader (no GPU needed).
//
// Chromium is the fragile part of the server, so it is treated as disposable: every frame has a deadline,
// a failed or hung frame throws the browser away and is retried once on a fresh one, and the browser is
// also recycled every RECYCLE_AFTER frames so a slow leak in the page can't build up over a long session.
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { Snapshot } from "./snapshot";
import { VIEW_H, VIEW_W } from "./snapshot";

/** Chromium flags that give a working WebGL2 context on machines without a usable GPU. */
export const CHROMIUM_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--disable-gpu-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

const FRAME_TIMEOUT_MS = 30_000;
const RECYCLE_AFTER = 400;

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class Renderer3D {
  private browser: Browser | null = null;
  private page: Promise<Page> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private frames = 0;

  constructor(private readonly baseUrl: string) {}

  /** Render the agent's first-person frame (VIEW_W x VIEW_H PNG). Calls are serialized. */
  render(snap: Snapshot): Promise<Uint8Array<ArrayBuffer>> {
    const job = this.queue.then(() => this.renderWithRetry(snap));
    this.queue = job.catch(() => undefined);
    return job;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (!browser) return;
    // A wedged Chromium may never answer close(): give it a moment, then kill the process.
    await deadline(browser.close(), 5_000, "closing the browser").catch(() => {
      try {
        browser.process()?.kill("SIGKILL");
      } catch {
        // already gone
      }
    });
  }

  private async renderWithRetry(snap: Snapshot): Promise<Uint8Array<ArrayBuffer>> {
    if (this.frames >= RECYCLE_AFTER) {
      this.frames = 0;
      await this.close();
    }
    try {
      return await this.renderNow(snap);
    } catch (err) {
      console.error("[renderer3d] frame failed, restarting the browser and retrying once:", (err as Error).message);
      await this.close();
      return this.renderNow(snap);
    }
  }

  private async renderNow(snap: Snapshot): Promise<Uint8Array<ArrayBuffer>> {
    const page = await deadline(this.ensurePage(), 60_000, "starting the browser");
    try {
      const b64 = await deadline(
        page.evaluate((s) => globalThis.renderSnapshot(s), snap),
        FRAME_TIMEOUT_MS,
        "rendering a frame",
      );
      this.frames++;
      return Uint8Array.fromBase64(b64);
    } catch (err) {
      // a crashed/hung page is replaced on the next call
      await this.close();
      throw err;
    }
  }

  private ensurePage(): Promise<Page> {
    this.page ??= this.launch().catch((err: unknown) => {
      this.page = null;
      throw err;
    });
    return this.page;
  }

  private async launch(): Promise<Page> {
    const browser = await puppeteer.launch({ headless: "shell", args: CHROMIUM_ARGS, defaultViewport: { width: VIEW_W, height: VIEW_H } });
    this.browser = browser;
    this.frames = 0;
    browser.on("disconnected", () => {
      if (this.browser === browser) {
        console.error("[renderer3d] browser disconnected; it restarts on the next frame");
        this.browser = null;
        this.page = null;
      }
    });
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.error("[renderer3d] page error:", err));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error("[renderer3d] console:", msg.text());
    });
    // The tab itself crashed (out of memory, GPU process died): drop it so the next frame starts clean.
    page.on("error", (err) => {
      console.error("[renderer3d] page crashed:", err);
      if (this.browser === browser) void this.close();
    });
    await page.goto(`${this.baseUrl.replace(/\/$/, "")}/render`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.renderReady === true, { timeout: 30_000 });
    return page;
  }
}
