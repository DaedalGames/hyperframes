import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openSettledCompositionPage } from "./captureCompositionFrame.js";

// An image, a fetched asset, then a fetch a frame starts once the network is quiet, all well inside the 1.5 s
// settle cap (~0.7 s here): with an asset at 1.1 s a busy Windows runner settled at up to 1.48 s, 18 ms from the cap.
const IMAGE_MS = 300;
const FETCH_MS = 500;
const FRAME_FETCH_MS = 200;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const HTML = `<!doctype html><html><body>
<div data-composition-id="main" data-width="320" data-height="180" data-duration="1"><img id="late" src="/late.png" /></div>
<script>
  window.__renderReady = true;
  fetch("/late.json").then((r) => r.text()).then((t) => {
    document.body.dataset.late = t;
    // Starts only on the frame after the network went quiet.
    requestAnimationFrame(() => {
      fetch("/frame.json").then((r) => r.text()).then((f) => { document.body.dataset.frame = f; });
    });
  });
</script></body></html>`;

let server: Server;
let url: string;

const ROUTES: Record<string, { ms: number; type: string; body: string | Buffer }> = {
  "/": { ms: 0, type: "text/html; charset=utf-8", body: HTML },
  "/late.png": { ms: IMAGE_MS, type: "image/png", body: PNG },
  "/late.json": { ms: FETCH_MS, type: "application/json", body: '"arrived"' },
  "/frame.json": { ms: FRAME_FETCH_MS, type: "application/json", body: '"framed"' },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[req.url ?? "/"] ?? ROUTES["/"]!;
    setTimeout(() => res.writeHead(200, { "Content-Type": route.type }).end(route.body), route.ms);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

it("returns only once images and fetched assets that land after DOMContentLoaded, or a frame after load, are in", async () => {
  const { browser, page } = await openSettledCompositionPage(HTML, url, {
    renderReadyTimeoutMs: 5_000,
    renderReadyWarningSuffix: "test",
    browserGpuMode: "software",
  });
  try {
    expect(
      await page.evaluate(() => {
        const image = document.getElementById("late") as HTMLImageElement;
        return {
          complete: image.complete,
          width: image.naturalWidth,
          late: document.body.dataset.late,
          frame: document.body.dataset.frame,
        };
      }),
    ).toEqual({ complete: true, width: 1, late: '"arrived"', frame: '"framed"' });
  } finally {
    await browser.close();
  }
}, 90_000);
