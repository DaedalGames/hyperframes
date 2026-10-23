import { describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as unknown[]);
vi.mock("@hyperframes/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hyperframes/engine")>()),
  createVideoFrameInjector: vi.fn((_lookup: unknown, options: unknown) => {
    created.push(options);
    return async () => {};
  }),
}));

import { createFrameLookupTable } from "@hyperframes/engine";
import { createChunkVideoFrameInjectorFactory } from "./chunkFrames.js";

const budget = { frameDataUriCacheLimit: 256, frameDataUriCacheBytesLimitMb: 1500, workers: 4 };

describe("chunk video frame injector budget", () => {
  it("hands the shared cache budget to every injector it builds", async () => {
    created.length = 0;
    const lookup = createFrameLookupTable([], []);
    createChunkVideoFrameInjectorFactory(lookup, budget)();
    await createChunkVideoFrameInjectorFactory(Promise.resolve(lookup), budget)()?.(
      {} as never,
      0,
    );
    expect(created).toEqual([budget, budget]);
  });
});
