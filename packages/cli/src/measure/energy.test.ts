import { describe, expect, it } from "vitest";
import { compareEnergy } from "./energy.js";

describe("compareEnergy", () => {
  it("still compares amounts on a window too short to correlate", () => {
    const e = compareEnergy([1, 2, 3, 2, 1, 2], [0.5, 1, 1.5, 1, 0.5, 1]);
    expect(e.r).toBeNull();
    expect(e.mean_ratio).toBe(0.5);
  });
});
