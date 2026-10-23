import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { ensureBrowser } from "../src/browser/manager.ts";

const { executablePath } = await ensureBrowser({ preferManagedChrome: true });
const server = createServer((_, res) => res.end("<!doctype html><p>probe</p>"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;
const variants = {
  default: [],
  noProxy: ["--no-proxy-server"],
  noCrash: ["--disable-breakpad", "--disable-crash-reporter"],
  both: ["--no-proxy-server", "--disable-breakpad", "--disable-crash-reporter"],
};
const N = Number(process.env.PROBE_N ?? 20);
const ms = (t) => Math.round(performance.now() - t);
for (let i = 0; i < N; i++) {
  for (const [name, extra] of Object.entries(variants)) {
    const dir = mkdtempSync(join(tmpdir(), "hf-probe-"));
    const t0 = performance.now();
    let launch = -1, first = -1, close = -1, note = "";
    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        pipe: true,
        userDataDir: dir,
        args: ["--no-sandbox", ...extra],
      });
      launch = ms(t0);
      const page = await browser.newPage();
      const t1 = performance.now();
      const cdp = await page.createCDPSession();
      await cdp.send("Network.enable");
      const sent = new Promise((r) => cdp.once("Network.requestWillBeSent", r));
      const nav = page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });
      await sent;
      first = ms(t1);
      await nav;
      const t2 = performance.now();
      const child = browser.process();
      const exited = new Promise((r) => child.once("exit", r));
      await browser.close();
      await exited;
      close = ms(t2);
    } catch (e) {
      note = String(e).slice(0, 120);
    }
    console.log(`PROBE ${name} i=${i} launch=${launch} firstRequest=${first} close=${close} ${note}`);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
server.close();
console.log("PROBE done");
