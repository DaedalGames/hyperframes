import { describe, expect, it } from "vitest";
import { RENDER_HEAP_ENV, renderHeapToRelaunch, type RenderHeapFacts } from "./renderHeap.js";

// A 10 GB container on 8 cores: Node's default heap 2,096 MB, three workers' worth needed.
const container: RenderHeapFacts = {
  env: {},
  execArgv: [],
  currentMb: 2096,
  neededMb: 1024 + 3 * 640,
  memoryMb: 10240,
};

describe("renderHeapToRelaunch", () => {
  it("relaunches when only the default heap holds auto sizing to one worker", () => {
    expect(renderHeapToRelaunch(container)).toBe(2944);
  });

  it("stays put when the heap already feeds the workers (a 16 GB host: 4,144 MB)", () => {
    expect(renderHeapToRelaunch({ ...container, currentMb: 4144 })).toBeNull();
  });

  it("never asks for more than half the memory, nor relaunches for less than a worker's share", () => {
    expect(renderHeapToRelaunch({ ...container, memoryMb: 5000 })).toBeNull();
    expect(renderHeapToRelaunch({ ...container, neededMb: 6000, memoryMb: 9000 })).toBe(4500);
  });

  it("leaves a heap set by hand and never relaunches twice", () => {
    expect(
      renderHeapToRelaunch({ ...container, env: { NODE_OPTIONS: "--max-old-space-size=2048" } }),
    ).toBeNull();
    expect(
      renderHeapToRelaunch({ ...container, execArgv: ["--max-old-space-size=2048"] }),
    ).toBeNull();
    expect(renderHeapToRelaunch({ ...container, env: { [RENDER_HEAP_ENV]: "2944" } })).toBeNull();
  });
});
