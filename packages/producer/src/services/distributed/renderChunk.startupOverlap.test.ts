import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distributedCaptureSessionDependencies, renderChunk } from "./renderChunk.js";

// Entry: renderChunk on a BeginFrame chunk with 4 workers. The capture stage is a stand-in that records
// when it starts and what its workers' gate does; the probe browser is a fake whose verdict the test holds.
const probe = vi.hoisted(() => ({ liveness: undefined as undefined | (() => Promise<boolean>) }));
const stage = vi.hoisted(() => ({
  calls: [] as { screenshot: boolean; gate: Promise<void> | undefined }[],
  run: undefined as undefined | ((call: number) => Promise<never>),
}));

vi.mock("@hyperframes/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hyperframes/engine")>()),
  probeBeginFrameLiveness: () => probe.liveness?.(),
}));
vi.mock("../render/stages/captureStage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../render/stages/captureStage.js")>()),
  runCaptureStage: (input: {
    plan: { forceScreenshot: boolean };
    beforeFirstFrame?: Promise<void>;
  }) => {
    stage.calls.push({ screenshot: input.plan.forceScreenshot, gate: input.beforeFirstFrame });
    return stage.run?.(stage.calls.length) ?? Promise.reject(new Error("no stage"));
  },
}));
vi.mock("../render/stages/encodeStage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../render/stages/encodeStage.js")>()),
  canEncodeWhileCapturing: () => false,
}));
vi.mock("../fileServer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fileServer.js")>()),
  createFileServer: async () => ({ url: "http://127.0.0.1:1", port: 1, close: () => {} }),
}));
vi.mock("../render/stages/freezePlan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../render/stages/freezePlan.js")>()),
  recomputePlanHashFromPlanDir: () => "plan-hash",
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readFfmpegVersion: async () => "ffmpeg-test",
}));

const STOP = new Error("stop after capture");
const original = { ...distributedCaptureSessionDependencies };
let planDir = "";
let closed = 0;

const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const render = () => renderChunk(planDir, 0, join(planDir, "chunk.mp4"), { maxCaptureWorkers: 4 });

beforeEach(() => {
  stage.calls = [];
  stage.run = undefined;
  closed = 0;
  Object.assign(distributedCaptureSessionDependencies, {
    createCaptureSession: async () => ({
      page: { close: async () => void closed++ },
      launchCaptureMode: "beginframe",
      beginFrameTimeTicks: 0,
      beginFrameIntervalMs: 33,
      browserConsoleBuffer: [],
      options: {},
    }),
    assertSwiftShader: async () => {},
    initializeSession: async () => {},
  });
  planDir = mkdtempSync(join(tmpdir(), "hf-chunk-overlap-"));
  const write = (path: string, value: unknown) =>
    writeFileSync(join(planDir, path), typeof value === "string" ? value : JSON.stringify(value));
  mkdirSync(join(planDir, "meta"));
  mkdirSync(join(planDir, "compiled"));
  write("plan.json", {
    planHash: "plan-hash",
    producerVersion: "test",
    ffmpegVersion: "ffmpeg-test",
    dimensions: { fpsNum: 30, fpsDen: 1, width: 16, height: 16, format: "mp4" },
  });
  write("meta/encoder.json", {
    browserGpuMode: "software",
    forceScreenshot: false,
    deviceScaleFactor: 1,
    encoder: "libx264-software",
    quality: "standard",
    runtimeEnv: {},
  });
  write("meta/chunks.json", [{ index: 0, startFrame: 0, endFrame: 240 }]);
  write("compiled/index.html", "<div></div>");
});
afterEach(() => {
  Object.assign(distributedCaptureSessionDependencies, original);
  rmSync(planDir, { recursive: true, force: true });
});

it("the workers start while the probe is still checking, and capture once it passes", async () => {
  let verdict!: (alive: boolean) => void;
  probe.liveness = () => new Promise<boolean>((resolve) => (verdict = resolve));
  const opened: boolean[] = [];
  stage.run = async () => {
    await stage.calls[0]?.gate;
    opened.push(true);
    throw STOP;
  };
  const rendered = render().catch((error: unknown) => error);
  await flush();
  expect(stage.calls).toHaveLength(1);
  expect(opened).toEqual([]);
  verdict(true);
  expect(await rendered).toBe(STOP);
  expect(opened).toEqual([true]);
  expect(closed).toBe(1);
});

it("a probe that finds BeginFrame stalled sends the whole chunk to screenshot capture", async () => {
  probe.liveness = async () => false;
  stage.run = async (call) => {
    if (call === 1) {
      const gate = stage.calls[0]?.gate;
      await gate?.catch((error: Error) => {
        throw new Error(`[Parallel] Capture failed: worker 0: ${error.message}`);
      });
    }
    throw STOP;
  };
  expect(await render().catch((error: unknown) => error)).toBe(STOP);
  expect(stage.calls.map((call) => call.screenshot)).toEqual([false, true]);
  expect(stage.calls[1]?.gate).toBeUndefined();
  expect(closed).toBe(1);
});

it("a probe browser that fails surfaces its own error and the chunk is not retried", async () => {
  const failure = new Error("HeadlessExperimental.beginFrame: software GL required");
  distributedCaptureSessionDependencies.assertSwiftShader = async () => {
    throw failure;
  };
  stage.run = async () => {
    await stage.calls[0]?.gate?.catch((error: Error) => {
      throw new Error(`[Parallel] Capture failed: worker 0: ${error.message}`);
    });
    throw STOP;
  };
  expect(await render().catch((error: unknown) => error)).toBe(failure);
  expect(stage.calls).toHaveLength(1);
});

it("a worker that fails before the probe settles waits for it before any retry", async () => {
  const failure = new Error("software GL required");
  let failProbe!: () => void;
  distributedCaptureSessionDependencies.assertSwiftShader = () =>
    new Promise<void>((_, reject) => (failProbe = () => reject(failure)));
  stage.run = async (call) => {
    if (call === 1) {
      setImmediate(() => failProbe());
      throw new Error("[Parallel] Capture failed: worker 0: HeadlessExperimental.beginFrame boom");
    }
    throw STOP;
  };
  expect(await render().catch((error: unknown) => error)).toBe(failure);
  expect(stage.calls).toHaveLength(1);
});
