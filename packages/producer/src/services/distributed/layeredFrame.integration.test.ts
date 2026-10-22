import { resolve, join } from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createFileServer } from "../fileServer.js";
import { certifyLayeredChunk } from "./layeredPrepass.js";
import { createLayeredFrameReader } from "./layeredFrameReader.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { MEDIA_RENDER_ID_ATTR, renderFrameIdForRenderId } from "@hyperframes/core";
import {
  FrameLookupTable,
  createVideoFrameInjector,
  decodePng,
  encodePng,
  runFfmpeg,
  injectVideoFramesBatch,
  createCaptureSession,
  initializeSession,
  closeCaptureSession,
  captureFrameToBuffer,
  prepareFrameForCapture,
  prepareCaptureSessionForReuse,
  type CaptureSession,
} from "@hyperframes/engine";
import { classifyLayeredFrame, resolveLayeredPaintOrder } from "./layeredFrameState.js";
import { readLayeredFrameState, readLayeredFrame } from "./layeredFrame.js";
import { captureCertifiedLayers } from "./layeredCapture.js";
import { buildLayeredGraph, type LayeredGraphLayer } from "./layeredGraph.js";
import { createLayeredDomCapture } from "./layeredDom.js";
import { captureLayeredVideoAssets } from "./layeredAssets.js";
import { createLayeredChunkObserver } from "./layeredEligibility.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function fixture(css = "", content = "") {
  if (!page.isClosed()) await page.close();
  page = await browser.newPage();
  await page.setContent(`<!doctype html><style>
    body { margin:0; } [data-composition-id] { position:relative; width:320px; height:180px; overflow:hidden; }
    video,img { position:absolute; left:10px; top:20px; width:160px; height:90px; z-index:0; object-fit:fill; }
    video { visibility:hidden; } img { border-radius:8px; opacity:0.75; }
    #caption { position:absolute; z-index:1; left:10px; top:10px; color:white; }
    ${css}</style><div data-composition-id="main"><video id="clip" ${MEDIA_RENDER_ID_ATTR}="render-clip"></video>
    <img id="${renderFrameIdForRenderId("render-clip")}" src="${PNG}"><div id="caption">Caption</div>${content}</div>`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
}

describe("browser layered frame facts", () => {
  it("does not carry page globals into the next observation fixture", async () => {
    await fixture();
    await page.evaluate(() => {
      Reflect.set(window, "__hfFixtureResidue", true);
    });
    await fixture();
    expect(await page.evaluate(() => "__hfFixtureResidue" in window)).toBe(false);
  });

  it("accepts a flat radius/opacity/rect-clip composition without changing its pixels or DOM", async () => {
    await fixture();
    const beforeHtml = await page.content();
    const beforePixels = await page.screenshot();
    expect(await readLayeredFrame(page)).toMatchObject({ kind: "candidate", videoCount: 1 });
    expect(await page.content()).toBe(beforeHtml);
    expect(Buffer.from(await page.screenshot()).equals(Buffer.from(beforePixels))).toBe(true);
  });

  it("accepts facts produced by the real frame injector and reuses the pure rule", async () => {
    await fixture();
    await page.evaluate(() => {
      document.querySelector("img")!.remove();
      document.querySelector("video")!.id = "render-clip";
    });
    expect(await injectVideoFramesBatch(page, [{ videoId: "render-clip", dataUri: PNG }])).toEqual([
      "render-clip",
    ]);
    const facts = await readLayeredFrameState(page);
    expect(classifyLayeredFrame(facts)).toMatchObject({ kind: "candidate", videoCount: 1 });
    expect(classifyLayeredFrame(structuredClone(facts))).toEqual(classifyLayeredFrame(facts));
  });

  it.each([
    ["[data-composition-id] {opacity:0.5}", "unsupported_stacking"],
    ["[data-composition-id] {transform:translateX(1px)}", "unsupported_stacking"],
    ["#caption {position:static}", "unsupported_stacking"],
    ["[data-composition-id] {position:static}", "unsupported_stacking"],
    ["#caption {z-index:-1}", "unsupported_stacking"],
    ["img {transform:rotate(5deg)}", "unsupported_geometry"],
    ["img {scale:2}", "unsupported_geometry"],
    ["img {border-radius:50%}", "unsupported_geometry"],
    ["img {filter:blur(1px)}", "unsupported_geometry"],
    ["img {image-rendering:pixelated}", "unsupported_geometry"],
    ["img {clip:rect(0px,80px,80px,0px)}", "unsupported_geometry"],
    ["img {content-visibility:hidden}", "unsupported_geometry"],
    ["body {zoom:2}", "unsupported_stacking"],
    ["[data-composition-id] {z-index:-1}", "unsupported_stacking"],
    ["img {clip-path:circle(40%)}", "unsupported_geometry"],
    ["img {box-shadow:0 0 5px black}", "video_decoration"],
    ["img {padding:1px}", "video_decoration"],
    ["body { overflow:hidden; border:1px solid red }", "unsupported_stacking"],
    ["img {border:1px solid red}", "video_decoration"],
    ["#caption {mix-blend-mode:multiply}", "unsupported_effect"],
    ["#caption {backdrop-filter:blur(1px)}", "unsupported_effect"],
    ["#caption::before {content:'x';mix-blend-mode:multiply}", "unsupported_effect"],
    ["#caption::first-letter {color:red}", "unsupported_effect"],
  ])("refuses unsupported computed CSS: %s", async (css, reason) => {
    await fixture(css);
    expect(await readLayeredFrame(page)).toEqual({ kind: "fallback", reason });
  });

  it("refuses nested videos instead of flattening an implicit stacking context", async () => {
    await fixture();
    await page.evaluate(() => {
      const wrapper = document.createElement("div");
      wrapper.style.opacity = "0.5";
      const video = document.querySelector("video")!;
      video.before(wrapper);
      wrapper.append(video);
    });
    expect(await readLayeredFrame(page)).toEqual({ kind: "fallback", reason: "nested_video" });
  });

  it.each([
    "<canvas></canvas>",
    "<iframe></iframe>",
    "<svg></svg>",
    "<dialog></dialog>",
    "<custom-paint></custom-paint>",
  ])("refuses an unmodeled paint surface %s", async (content) => {
    await fixture("", content);
    expect(await readLayeredFrame(page)).toEqual({
      kind: "fallback",
      reason: "unsupported_effect",
    });
  });

  it("uses render identity rather than the author ID to find the injected frame", async () => {
    await fixture();
    await page.evaluate(() => document.querySelector("img")!.remove());
    expect(await readLayeredFrame(page)).toEqual({
      kind: "fallback",
      reason: "missing_video_frame",
    });
  });

  it("records actual middle-frame CSS through the wrapped injection hook", async () => {
    await fixture();
    const observer = createLayeredChunkObserver({ startFrame: 0, endFrame: 3 }, 25);
    const hook = observer.wrap(async (target, time) => {
      await target.evaluate((t) => {
        document.querySelector("img")!.style.transform = t === 0.04 ? "rotate(5deg)" : "none";
      }, time);
    });
    if (hook === null) throw new Error("Expected video hook");
    for (const time of [0, 0.04, 0.08]) await hook(page, time);
    expect(observer.decision()).toEqual({
      kind: "fallback",
      reason: "unsupported_geometry",
      frameIndex: 1,
    });
  });

  it("observes all captured frames after the injector and forwards held video time", async () => {
    await fixture();
    const calls: number[][] = [];
    const observer = createLayeredChunkObserver({ startFrame: 10, endFrame: 13 }, 25);
    const hook = observer.wrap(async (_page, time, held) => {
      calls.push([time, held ?? -1]);
    });
    if (hook === null) throw new Error("Expected video hook");
    for (const frame of [10, 12, 11]) await hook(page, frame / 25, 0);
    expect(calls).toEqual([
      [0.4, 0],
      [0.48, 0],
      [0.44, 0],
    ]);
    expect(observer.decision()).toEqual({ kind: "eligible", frames: 3, videoCount: 1 });
  });

  it("accepts the runtime viewport clip and preserves zero opacity", async () => {
    await fixture("html,body {overflow:hidden} img {opacity:0}");
    expect(await readLayeredFrame(page)).toMatchObject({ kind: "candidate" });
    const facts = await readLayeredFrameState(page);
    if (facts.kind !== "observed") throw new Error("Expected observed frame");
    expect(facts.videos[0]?.proxy?.opacity).toBe("0");
  });

  it("refuses scenes beyond the bounded observation budget", async () => {
    await fixture();
    await page.evaluate(() => {
      for (let index = 0; index < 513; index++)
        document.querySelector("[data-composition-id]")!.append(document.createElement("div"));
    });
    expect(await readLayeredFrame(page)).toEqual({ kind: "fallback", reason: "scene_complexity" });
  });

  it("does not certify fractional frame samples as complete integer frames", async () => {
    await fixture();
    const observer = createLayeredChunkObserver({ startFrame: 0, endFrame: 1 }, 25);
    const hook = observer.wrap(async () => {});
    if (hook === null) throw new Error("Expected video hook");
    await hook(page, 0.01);
    expect(observer.decision()).toEqual({
      kind: "fallback",
      reason: "unsupported_sampling",
      frameIndex: 0,
    });
  });

  it("falls back on the infinite CSS transform that still screenshots successfully", async () => {
    await fixture(
      "",
      '<div style="position:absolute;z-index:2;--progress:0;transform:scale(calc(1 / var(--progress)))">bad transform</div>',
    );
    const before = Buffer.from(await page.screenshot());
    const observer = createLayeredChunkObserver({ startFrame: 0, endFrame: 1 }, 25);
    const hook = observer.wrap(async () => {});
    if (hook === null) throw new Error("Expected video hook");
    await expect(readLayeredFrame(page)).rejects.toThrow("DOMMatrix");
    await hook(page, 0);
    expect(observer.decision()).toEqual({
      kind: "fallback",
      reason: "observation_error",
      frameIndex: 0,
    });
    expect(Buffer.from(await page.screenshot()).equals(before)).toBe(true);
  });

  it("propagates seek completion failure outside the observation boundary", async () => {
    await fixture();
    await page.evaluate(() => {
      Object.defineProperty(window, "__hfWaitForSeekCompletion", {
        configurable: true,
        value: async () => {
          throw new Error("seek failed");
        },
      });
    });
    try {
      const observer = createLayeredChunkObserver({ startFrame: 0, endFrame: 1 }, 25);
      const hook = observer.wrap(async () => {});
      if (hook === null) throw new Error("Expected video hook");
      await expect(hook(page, 0)).rejects.toThrow("seek failed");
      expect(observer.decision()).toEqual({
        kind: "fallback",
        reason: "incomplete_frames",
        frameIndex: null,
      });
    } finally {
      await page.evaluate(() => Reflect.deleteProperty(window, "__hfWaitForSeekCompletion"));
    }
  });

  it("propagates injector failure without claiming eligibility", async () => {
    await fixture();
    const observer = createLayeredChunkObserver({ startFrame: 0, endFrame: 1 }, 25);
    const hook = observer.wrap(async () => {
      throw new Error("inject failed");
    });
    if (hook === null) throw new Error("Expected video hook");
    await expect(hook(page, 0)).rejects.toThrow("inject failed");
    expect(observer.decision()).toEqual({
      kind: "fallback",
      reason: "incomplete_frames",
      frameIndex: null,
    });
  });
});

describe("compact layered frame reader", () => {
  async function gsapFixture(css = "") {
    await fixture(css);
    await page.addScriptTag({
      path: resolve(import.meta.dirname, "../../../../core/node_modules/gsap/dist/gsap.min.js"),
    });
    await page.evaluate(() => {
      const gsap = (window as unknown as { gsap: { ticker: { sleep(): void } } }).gsap;
      gsap.ticker.sleep();
    });
  }
  async function animate(selector: string, progress: number) {
    await page.evaluate(
      ({ selector, progress }) => {
        const gsap = (
          window as unknown as {
            gsap: {
              set(target: string, vars: Record<string, number>): void;
              ticker: { sleep(): void };
            };
          }
        ).gsap;
        gsap.set(selector, { x: progress * 8, opacity: 1 - progress / 2 });
        gsap.ticker.sleep();
      },
      { selector, progress },
    );
  }

  it.each(["", "video,img,#caption{z-index:auto}"])(
    "keeps one full read across GSAP animation above the video: %s",
    async (css) => {
      await gsapFixture(css);
      const reader = await createLayeredFrameReader(page);
      try {
        for (let frame = 0; frame < 20; frame++) {
          await animate("#caption", frame / 20);
          expect(await reader.read()).toEqual(await readLayeredFrame(page));
        }
        expect(reader.fullReads()).toBe(1);
      } finally {
        await reader.dispose();
      }
    },
  );

  it("invalidates when GSAP animates the video's ancestor", async () => {
    await gsapFixture();
    const reader = await createLayeredFrameReader(page);
    try {
      expect((await reader.read()).kind).toBe("candidate");
      await animate("[data-composition-id]", 0.5);
      expect(await reader.read()).toEqual({ kind: "fallback", reason: "unsupported_stacking" });
      expect(reader.fullReads()).toBe(2);
    } finally {
      await reader.dispose();
    }
  });

  it("refuses a non-finite overlay transform instead of hiding an observation error", async () => {
    await fixture("#caption { --progress:0; }");
    const reader = await createLayeredFrameReader(page);
    try {
      expect((await reader.read()).kind).toBe("candidate");
      await page.evaluate(() => {
        document.getElementById("caption")!.style.transform = "scale(calc(1 / var(--progress)))";
      });
      expect(await reader.read()).toEqual({ kind: "fallback", reason: "observation_error" });
    } finally {
      await reader.dispose();
    }
  });

  it("invalidates a focus-dependent blend without a DOM mutation", async () => {
    await fixture("#caption:focus-within {mix-blend-mode:multiply}");
    await page.evaluate(() => {
      document.getElementById("caption")!.innerHTML = '<button id="focus-me">Focus</button>';
    });
    const reader = await createLayeredFrameReader(page);
    try {
      expect((await reader.read()).kind).toBe("candidate");
      await page.focus("#focus-me");
      expect(await reader.read()).toEqual({ kind: "fallback", reason: "unsupported_effect" });
    } finally {
      await reader.dispose();
    }
  });
  it("invalidates a pseudo blend after text becomes empty", async () => {
    await fixture("#caption span:empty::before {content:'x';mix-blend-mode:multiply}");
    await page.evaluate(() => {
      document.getElementById("caption")!.innerHTML = "<span>x</span>";
    });
    const reader = await createLayeredFrameReader(page);
    try {
      expect((await reader.read()).kind).toBe("candidate");
      await page.evaluate(() => {
        document.querySelector("#caption span")!.firstChild!.nodeValue = "";
      });
      expect(await reader.read()).toEqual({ kind: "fallback", reason: "unsupported_effect" });
    } finally {
      await reader.dispose();
    }
  });
  it("disposes a reader after its page closes", async () => {
    await fixture();
    const reader = await createLayeredFrameReader(page);
    await page.close();
    try {
      expect(await reader.read()).toEqual({ kind: "fallback", reason: "observation_error" });
      await reader.dispose();
    } finally {
      page = await browser.newPage();
    }
  });

  it.each([
    ["cssom", "unsupported_effect"],
    ["order", "unsupported_stacking"],
    ["video", "unsupported_geometry"],
    ["blend", "unsupported_effect"],
  ])("invalidates a middle-frame %s change", async (change, reason) => {
    await fixture();
    const reader = await createLayeredFrameReader(page);
    try {
      expect((await reader.read()).kind).toBe("candidate");
      await page.evaluate((change) => {
        const caption = document.getElementById("caption")!;
        if (change === "cssom")
          document.styleSheets[0]!.insertRule(
            "#caption {mix-blend-mode:multiply}",
            document.styleSheets[0]!.cssRules.length,
          );
        if (change === "order") caption.style.zIndex = "-1";
        if (change === "video") document.querySelector("img")!.style.transform = "rotate(5deg)";
        if (change === "blend") caption.style.mixBlendMode = "multiply";
      }, change);
      expect(await reader.read()).toEqual({ kind: "fallback", reason });
      expect(await reader.read()).toEqual(await readLayeredFrame(page));
      expect(reader.fullReads()).toBeGreaterThanOrEqual(2);
    } finally {
      await reader.dispose();
    }
  });
});

describe("layered DOM cache live state", () => {
  it.each(["input", "scroll", "font"] as const)(
    "captures changed %s pixels with identical DOM attributes",
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "hf-layered-live-state-"));
      const contents = {
        input:
          '<input id="live" value="Before" style="position:absolute;left:20px;top:50px;width:100px;height:30px">',
        scroll:
          '<div id="live" style="position:absolute;left:20px;top:50px;width:100px;height:20px;overflow:hidden;white-space:pre;background:white;color:black">Before\nAfter</div>',
        font: '<div id="live" style="position:absolute;left:20px;top:50px;width:200px;height:50px;font-family:Probe;font-size:28px;background:white;color:black">MMMMMM</div>',
      };
      await fixture("", contents[kind]);
      if (kind === "font") {
        const fonts = resolve(
          import.meta.dirname,
          "../../../../../skills/hyperframes/assets/frame-presets/code-editorial/fonts",
        );
        copyFileSync(join(fonts, "Inter-400.woff2"), join(directory, "first.woff2"));
        copyFileSync(join(fonts, "JetBrainsMono-400.woff2"), join(directory, "second.woff2"));
      }
      writeFileSync(join(directory, "index.html"), await page.content());
      const server = await createFileServer({
        projectDir: directory,
        compiledDir: directory,
        port: 0,
        fps: { num: 25, den: 1 },
      });
      await page.goto(server.url);
      expect(await page.evaluate(() => Boolean(crypto.subtle))).toBe(true);
      if (kind === "font")
        await page.evaluate(async () => {
          const font = new FontFace("Probe", 'url("first.woff2")');
          await font.load();
          document.fonts.add(font);
          Reflect.set(window, "__layeredTestFont", font);
        });
      const html = await page.content();
      const capture = await createLayeredDomCapture(page, directory);
      try {
        const first = await capture.capture({ kind: "dom", childIndices: [3] });
        await page.evaluate(async (kind) => {
          const node = document.getElementById("live")!;
          if (kind === "input") (node as HTMLInputElement).value = "After";
          if (kind === "scroll") node.scrollTop = 20;
          if (kind === "font") {
            const next = new FontFace("Probe", 'url("second.woff2")');
            await next.load();
            document.fonts.delete(Reflect.get(window, "__layeredTestFont"));
            document.fonts.add(next);
          }
        }, kind);
        expect(await page.content()).toBe(html);
        const second = await capture.capture({ kind: "dom", childIndices: [3] });
        expect(second.path).not.toBe(first.path);
        expect(capture.captures()).toBe(2);
      } finally {
        await capture.dispose();
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("layered cover, shadow and paint order", () => {
  it("certifies centered cover with an opaque outer shadow and automatic z order", async () => {
    await fixture(
      "video,img {z-index:auto;object-fit:cover} img {opacity:1;box-shadow:0 12px 48px rgba(0,0,0,.5)} #caption{z-index:auto}",
    );
    expect((await readLayeredFrame(page)).kind).toBe("candidate");
    const state = await readLayeredFrameState(page);
    if (state.kind !== "observed") throw Error("Expected observed state");
    expect(resolveLayeredPaintOrder(state.children)).toEqual({
      kind: "layers",
      layers: [
        { kind: "video", videoId: "render-clip", childIndex: 1 },
        { kind: "dom", childIndices: [2] },
      ],
    });
  });
  it.each([
    ["img {opacity:.5;box-shadow:0 0 8px black}", "video_decoration"],
    ["img {opacity:1;box-shadow:inset 0 0 8px black}", "video_decoration"],
    ["img {object-fit:cover;object-position:left top}", "unsupported_geometry"],
    ["#caption{z-index:auto} #caption span{position:absolute;z-index:2}", "unsupported_stacking"],
    [
      "#caption{z-index:auto} #caption::before{content:'x';position:absolute;z-index:2}",
      "unsupported_stacking",
    ],
  ])("refuses an unproved widening: %s", async (css, reason) => {
    await fixture(css, "");
    await page.evaluate(
      () => (document.getElementById("caption")!.innerHTML = "<span>Caption</span>"),
    );
    expect(await readLayeredFrame(page)).toEqual({ kind: "fallback", reason });
  });
  it("records shadow changes as changing video layout", async () => {
    await fixture("img{opacity:1;box-shadow:0 0 8px black}");
    const observer = createLayeredChunkObserver({ startFrame: 0, endFrame: 2 }, 25);
    const hook = observer.wrap(async (target, time) => {
      await target.evaluate((t) => {
        document.querySelector("img")!.style.boxShadow = `0 0 ${8 + t * 100}px black`;
      }, time);
    });
    if (hook === null) throw Error("Expected video hook");
    await hook(page, 0);
    await hook(page, 0.04);
    expect(observer.decision()).toEqual({
      kind: "fallback",
      reason: "changing_video_layout",
      frameIndex: 1,
    });
  });
});

async function withPreparedSession(run: (session: CaptureSession) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "hf-layered-prepass-"));
  const fps = { num: 25, den: 1 };
  copyFileSync(
    resolve(import.meta.dirname, "../../../../core/node_modules/gsap/dist/gsap.min.js"),
    join(directory, "gsap.js"),
  );
  writeFileSync(
    join(directory, "index.html"),
    `<!doctype html><style>
    body{margin:0}main{position:relative;width:320px;height:180px;overflow:hidden}
    video,img{position:absolute;width:160px;height:90px;object-fit:cover;z-index:auto}
    video{visibility:hidden}#caption{position:absolute;z-index:auto;color:white}
    </style><main data-composition-id="main" data-width="320" data-height="180" data-fps="25" data-duration="1">
    <video id="clip" ${MEDIA_RENDER_ID_ATTR}="clip"></video><img id="${renderFrameIdForRenderId("clip")}" src="${PNG}">
    <div id="caption">Caption</div></main><script src="gsap.js"></script><script>
    const tl=gsap.timeline({paused:true}).to('#caption',{duration:1,x:80,opacity:.5,ease:'none'},0);
    window.__timelines={main:tl};gsap.ticker.sleep();
    </script>`,
  );
  const server = await createFileServer({
    projectDir: directory,
    compiledDir: directory,
    port: 0,
    fps,
  });
  let session: CaptureSession | undefined;
  try {
    session = await createCaptureSession(
      server.url,
      join(directory, "frames"),
      {
        width: 320,
        height: 180,
        fps,
        format: "png",
        skipReadinessVideoIds: ["clip"],
      },
      null,
      { forceScreenshot: true, browserGpuMode: "software", playerReadyTimeout: 3000 },
    );
    await initializeSession(session);
    await run(session);
  } finally {
    if (session) await closeCaptureSession(session);
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("engine-prepared layered pre-pass", () => {
  it("certifies every frame using one full read and leaves capture pixels unchanged", async () => {
    await withPreparedSession(async (session) => {
      const before = await captureFrameToBuffer(session, 0, 0);
      const result = await certifyLayeredChunk(session, { startFrame: 0, endFrame: 20 });
      expect(result).toMatchObject({ kind: "eligible", frames: 20, videoCount: 1, fullReads: 1 });
      expect(result.prepassMs).toBeGreaterThan(0);
      const after = await captureFrameToBuffer(session, 0, 0);
      expect(after.buffer.equals(before.buffer)).toBe(true);
    });
  }, 15000);
  it("captures provisional assets with exactly one engine seek per frame", async () => {
    const counts: number[] = [];
    for (const layered of [false, true]) {
      await withPreparedSession(async (session) => {
        const directory = mkdtempSync(join(tmpdir(), "hf-layered-one-pass-"));
        try {
          const path = join(directory, "source.png");
          const rgba = Buffer.alloc(4 * 4 * 4, 255);
          writeFileSync(path, encodePng(4, 4, rgba));
          await session.page.evaluate(() => {
            document.querySelector("img")!.remove();
            const main = document.querySelector("main")!;
            main.setAttribute("data-updates", "0");
            const timeline = Reflect.get(window, "__timelines").main;
            timeline.eventCallback("onUpdate", () => {
              main.setAttribute(
                "data-updates",
                String(Number(main.getAttribute("data-updates")) + 1),
              );
            });
          });
          const table = loopingLookup([path]);
          prepareCaptureSessionForReuse(
            session,
            session.outputDir,
            createVideoFrameInjector(table),
          );
          if (layered) {
            const captured = await captureCertifiedLayers({
              session,
              table,
              range: { startFrame: 0, endFrame: 5 },
              directory: join(directory, "layers"),
            });
            expect(captured.kind).toBe("captured");
            if (captured.kind === "captured") {
              expect(captured.preparedPassMs).toBeGreaterThanOrEqual(
                captured.certificate.prepassMs,
              );
              expect(captured.domCaptures).toBeGreaterThan(0);
            }
          } else {
            for (let frame = 0; frame < 5; frame++)
              await prepareFrameForCapture(session, frame, frame / 25);
          }
          counts.push(
            await session.page.evaluate(() =>
              Number(document.querySelector("main")!.getAttribute("data-updates")),
            ),
          );
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  }, 30000);

  it("finds an unsupported middle frame through the actual engine seek", async () => {
    await withPreparedSession(async (session) => {
      await session.page.evaluate(() => {
        const tl = (
          window as unknown as {
            __timelines: {
              main: { set(target: Element, vars: Record<string, unknown>, position: number): void };
            };
          }
        ).__timelines.main;
        const image = document.querySelector("img")!;
        tl.set(image, { rotation: 5, immediateRender: false }, 0.08);
        tl.set(image, { rotation: 0, immediateRender: false }, 0.12);
      });
      expect(await certifyLayeredChunk(session, { startFrame: 0, endFrame: 5 })).toMatchObject({
        kind: "fallback",
        reason: "unsupported_geometry",
        frameIndex: 2,
        fullReads: 2,
      });
    });
  }, 15000);
  it("discards provisional assets when a later frame refuses certification", async () => {
    await withPreparedSession(async (session) => {
      const directory = join(session.outputDir, "provisional");
      await session.page.evaluate(() => {
        const timeline = Reflect.get(window, "__timelines").main;
        timeline.set(document.querySelector("img"), { rotation: 5, immediateRender: false }, 0.08);
      });
      const result = await captureCertifiedLayers({
        session,
        table: new FrameLookupTable(25),
        range: { startFrame: 0, endFrame: 5 },
        directory,
      });
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "unsupported_geometry",
        frameIndex: 2,
      });
      expect(existsSync(directory)).toBe(false);
    });
  }, 15000);

  it("propagates injector failure from frame preparation", async () => {
    await withPreparedSession(async (session) => {
      prepareCaptureSessionForReuse(session, session.outputDir, async () => {
        throw Error("injector failed");
      });
      await expect(certifyLayeredChunk(session, { startFrame: 0, endFrame: 2 })).rejects.toThrow(
        "injector failed",
      );
    });
  }, 15000);
});

function coverSource() {
  const rgba = Buffer.alloc(64 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) {
      const offset = (y * 64 + x) * 4;
      rgba.set(x < 20 ? [255, 0, 0, 255] : x > 43 ? [0, 0, 255, 255] : [0, 255, 0, 255], offset);
      if (x < 20) rgba[offset + 3] = 0;
    }
  return encodePng(64, 32, rgba);
}

describe("native layered pixels", () => {
  it("matches Chrome cover, rounded shadow and interleaved DOM without changing author state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-layered-pixels-"));
    const target = await browser.newPage();
    const assets = await browser.newPage();
    let server: Awaited<ReturnType<typeof createFileServer>> | undefined;
    let capture: Awaited<ReturnType<typeof createLayeredDomCapture>> | undefined;
    try {
      await target.setViewport({ width: 128, height: 96 });
      const source = coverSource();
      const sourcePath = join(dir, "source.png");
      writeFileSync(sourcePath, source);
      writeFileSync(
        join(dir, "index.html"),
        `<!doctype html><style>
      body{margin:0}main{position:relative;width:128px;height:96px;overflow:hidden;background:rgb(40,40,40)}
      video{visibility:hidden}img,video{position:absolute;left:36px;top:24px;width:48px;height:48px;object-fit:cover;z-index:auto}
      img{border-radius:12px;box-shadow:0 5px 7px rgba(0,0,0,.8)}
      #back,#front{position:absolute;width:40px;height:12px;left:60px;top:50px;background:yellow;z-index:auto}
      #front{left:72px;top:54px;background:magenta}
      </style><main data-composition-id="main" data-width="128" data-height="96" data-duration="1"><div id="back"></div>
      <video id="clip" ${MEDIA_RENDER_ID_ATTR}="clip"></video>
      <img id="${renderFrameIdForRenderId("clip")}" src="data:image/png;base64,${source.toString("base64")}">
      <div id="front"></div></main>`,
      );
      server = await createFileServer({
        projectDir: dir,
        compiledDir: dir,
        port: 0,
        fps: { num: 25, den: 1 },
      });
      await target.goto(server.url, { waitUntil: "load" });
      await target.waitForFunction(() => [...document.images].every((image) => image.complete));
      const beforeHtml = await target.content();
      const expected = Buffer.from(await target.screenshot({ type: "png" }));
      const frame = await readLayeredFrame(target);
      if (frame.kind !== "candidate") throw Error(`Unexpected refusal: ${frame.reason}`);
      capture = await createLayeredDomCapture(target, join(dir, "dom"));
      const inputArgs: string[] = [];
      let inputIndex = 0;
      const layers: LayeredGraphLayer[] = [];
      const add = (path: string) => {
        inputArgs.push("-loop", "1", "-framerate", "25", "-i", path);
        return inputIndex++;
      };
      const background = await capture.capture("background");
      layers.push({
        kind: "dom",
        inputIndex: add(background.path),
        x: background.x,
        y: background.y,
      });
      for (const layer of frame.layers) {
        if (layer.kind === "dom") {
          const image = await capture.capture(layer);
          layers.push({ kind: "dom", inputIndex: add(image.path), x: image.x, y: image.y });
        } else {
          const geometry = frame.geometry.videos.find((video) => video.videoId === layer.videoId)!;
          const decoration = await captureLayeredVideoAssets({
            page: assets,
            geometry,
            clips: frame.geometry.clips,
            width: 128,
            height: 96,
            directory: join(dir, "video"),
          });
          if (decoration.shadow)
            layers.push({
              kind: "dom",
              inputIndex: add(decoration.shadow.path),
              x: decoration.shadow.x,
              y: decoration.shadow.y,
            });
          layers.push({
            kind: "video",
            inputIndex: add(sourcePath),
            maskInputIndex: add(decoration.maskPath),
            geometry,
          });
        }
      }
      const graph = buildLayeredGraph({
        width: 128,
        height: 96,
        fps: { num: 25, den: 1 },
        frames: 1,
        layers,
      });
      const output = join(dir, "native.png");
      const result = await runFfmpeg(
        [
          "-y",
          "-filter_complex_threads",
          "1",
          ...inputArgs,
          "-filter_complex",
          graph.graph,
          "-map",
          `[${graph.outputLabel}]`,
          "-frames:v",
          "1",
          output,
        ],
        { timeout: 15000 },
      );
      expect(result.success).toBe(true);
      const actual = decodePng(readFileSync(output));
      const reference = decodePng(expected);
      let difference = 0;
      for (let i = 0; i < reference.data.length; i++)
        difference += Math.abs(actual.data[i]! - reference.data[i]!);
      expect(difference / reference.data.length).toBeLessThan(1);
      const pixel = (x: number, y: number) => [
        ...actual.data.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 3),
      ];
      expect(pixel(60, 40)).toEqual([0, 255, 0]);
      expect(pixel(36, 45)).toEqual([40, 40, 40]);
      expect(pixel(76, 58)).toEqual([255, 0, 255]);
      expect(pixel(82, 40)).toEqual([0, 0, 255]);
      for (const channel of pixel(60, 76)) expect(channel).toBeLessThan(35);
      const count = capture.captures();
      const firstDom = frame.layers.find((layer) => layer.kind === "dom");
      if (!firstDom || firstDom.kind !== "dom") throw Error("Expected DOM layer");
      await capture.capture(firstDom);
      expect(capture.captures()).toBe(count);
      await capture.dispose();
      capture = undefined;
      expect(await target.content()).toBe(beforeHtml);
      expect(Buffer.from(await target.screenshot({ type: "png" })).equals(expected)).toBe(true);
    } finally {
      await capture?.dispose();
      await target.close();
      await assets.close();
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

function loopingLookup(paths: string[]) {
  const table = new FrameLookupTable(25);
  table.addVideo(
    {
      videoId: "clip",
      srcPath: paths[0]!,
      outputDir: resolve(paths[0]!, ".."),
      framePattern: "unused",
      fps: 25,
      totalFrames: paths.length,
      framePaths: new Map(paths.map((path, index) => [index, path])),
      ownedByLookup: false,
      metadata: {
        durationSeconds: paths.length / 25,
        videoStreamDurationSeconds: paths.length / 25,
        width: 4,
        height: 4,
        fps: 25,
        videoCodec: "png",
        hasAudio: false,
        isVFR: false,
        hasAlpha: false,
        colorSpace: null,
      },
    },
    0,
    1,
    0,
    true,
  );
  return table;
}

it.each([1, 0.5])(
  "composes the existing lookup and moving DOM on the engine clock, opacity=%s",
  async (opacity) => {
    await withPreparedSession(async (session) => {
      const dir = mkdtempSync(join(tmpdir(), "hf-layered-sequence-"));
      try {
        const paths = ["red", "blue"].map((name, index) => {
          const path = join(dir, `${name}.png`);
          const rgba = Buffer.alloc(4 * 4 * 4);
          for (let pixel = 0; pixel < 16; pixel++)
            rgba.set(index === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255], pixel * 4);
          writeFileSync(path, encodePng(4, 4, rgba));
          return path;
        });
        const table = loopingLookup(paths);
        // This arm uses the real injector, which owns its proxy. Remove the observation-only fixture image.
        await session.page.evaluate((opacity) => {
          document.querySelector("img")!.remove();
          document.querySelector("video")!.style.opacity = String(opacity);
        }, opacity);
        prepareCaptureSessionForReuse(session, session.outputDir, createVideoFrameInjector(table));
        const reference: Buffer[] = [];
        for (let frame = 0; frame < 5; frame++)
          reference.push((await captureFrameToBuffer(session, frame, frame / 25)).buffer);
        const captured = await captureCertifiedLayers({
          session,
          table,
          range: { startFrame: 0, endFrame: 5 },
          directory: join(dir, "layers"),
        });
        if (captured.kind !== "captured") throw Error(`Unexpected fallback: ${captured.reason}`);
        const result = await runFfmpeg(
          [
            "-y",
            "-filter_complex_threads",
            "1",
            ...captured.inputArgs,
            "-filter_complex",
            captured.graph.graph,
            "-map",
            `[${captured.graph.outputLabel}]`,
            "-frames:v",
            "5",
            join(dir, "output-%d.png"),
          ],
          { timeout: 15000 },
        );
        expect(result.success).toBe(true);
        for (let frame = 0; frame < 5; frame++) {
          const actual = decodePng(readFileSync(join(dir, `output-${frame + 1}.png`)));
          const expected = decodePng(reference[frame]!);
          let error = 0;
          for (let pixel = 0; pixel < expected.data.length; pixel++)
            error += Math.abs(actual.data[pixel]! - expected.data[pixel]!);
          expect(error / expected.data.length).toBeLessThan(1);
          expect([...actual.data.slice((45 * 320 + 80) * 4, (45 * 320 + 80) * 4 + 3)]).toEqual(
            frame % 2 === 0 ? [255, 0, 0] : [0, 0, 255],
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
  30000,
);
