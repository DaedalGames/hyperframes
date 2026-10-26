import { describe, expect, it } from "vitest";
import { mediaElementTime } from "./mediaClock";

// What Chrome does with the value: stores currentTime as whole microseconds, truncated.
const storedMicroseconds = (seconds: number) => Math.trunc(seconds * 1e6);

describe("mediaElementTime", () => {
  it("lands inside the frame that starts at the instant, at every common frame rate", () => {
    const missed: string[] = [];
    for (const fps of [24, 25, 30, 50, 60, 24000 / 1001, 30000 / 1001, 60000 / 1001]) {
      for (let frame = 0; frame < 20_000; frame++) {
        const stored = storedMicroseconds(mediaElementTime(frame / fps));
        // Frame start times are rounded to the microsecond.
        const inside =
          stored >= Math.round((frame / fps) * 1e6) &&
          stored < Math.round(((frame + 1) / fps) * 1e6);
        if (!inside) missed.push(`${fps} fps frame ${frame}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("lands on the frame when the time was written with six decimals", () => {
    // 449/30 written as 14.966667 starts a clip a third of a microsecond late.
    const local = 450 / 30 - 14.966667;
    expect(storedMicroseconds(mediaElementTime(4.3 + local))).toBeGreaterThanOrEqual(
      Math.round((130 / 30) * 1e6),
    );
  });

  it("is what a raw seek to an exact frame instant is not", () => {
    // 2/30 s is stored as 66666 us; the frame starts at 66667 us.
    expect(storedMicroseconds(2 / 30)).toBe(66666);
    expect(storedMicroseconds(mediaElementTime(2 / 30))).toBe(66667);
  });
});
