// Cuts from the frame-to-frame difference itself, ported from the Studio's videoShots.mjs: ffmpeg's scene score
// missed two of the James Blake source's cuts at 0.25, so a cut is a frame far unlike the one before and several
// times unlike its neighbours' changes.
import { decode, meanAbsDiff, type Frames } from "./media.js";

// Small enough to read a minute quickly, large enough to tell a cut from motion.
export const SIG_W = 64;
export const SIG_H = 36;
const CUT_LEVEL = 12;
const CUT_RATIO = 4;

/** Every frame of ffmpeg's `input` (after `filters`) as SIG_W x SIG_H grey levels. */
export function signatures(input: string[], filters: string[] = []): Frames {
  return decode(input, [...filters, `scale=${SIG_W}:${SIG_H}:flags=area`], SIG_W, SIG_H, true);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * The frame indexes where a new shot starts, each with its change (mean grey levels) and length: a whip or a
 * two-frame dissolve changes on consecutive frames, which is one cut `frames` long, not a shot of one frame.
 */
export function findCuts(
  frames: Uint8Array[],
): { frame: number; frames: number; change: number }[] {
  const diffs = frames.map((f, i) => (i ? meanAbsDiff(frames[i - 1]!, f) : 0));
  const hits = diffs.flatMap((d, i) => {
    if (i === 0 || d < CUT_LEVEL) return [];
    const around = diffs.slice(Math.max(1, i - 12), i).concat(diffs.slice(i + 1, i + 13));
    return d >= CUT_RATIO * Math.max(1, median(around)) ? [{ frame: i, change: d }] : [];
  });
  const out: { frame: number; frames: number; change: number }[] = [];
  for (const h of hits) {
    const last = out.at(-1);
    if (last && h.frame === last.frame + last.frames) {
      last.frames++;
      last.change = Math.max(last.change, h.change);
    } else out.push({ ...h, frames: 1 });
  }
  return out;
}
