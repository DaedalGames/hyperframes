// Cuts from the frame-to-frame difference itself, ported from the Studio's videoShots.mjs: ffmpeg's scene score
// missed two of the James Blake source's cuts at 0.25, so a cut is a frame far unlike the one before and several
// times unlike its neighbours' changes. A punch-in at the same angle changes less (dan's 9.743 s: 11 grey levels),
// so a smaller change also counts when nothing else near it changes anywhere near as much: a soft cut.
import { decode, meanAbsDiff, type Frames } from "./media.js";

// Small enough to read a minute quickly, large enough to tell a cut from motion.
export const SIG_W = 64;
export const SIG_H = 36;
const CUT_LEVEL = 12;
const CUT_RATIO = 4;
// A soft cut: at least SOFT_LEVEL, SOFT_RATIO times its neighbours' median and SOFT_ALONE times the largest of them.
const SOFT_LEVEL = 10;
const SOFT_RATIO = 8;
const SOFT_ALONE = 4;
// The other side confirms a soft cut with a change of CONFIRM_LEVEL, CUT_RATIO times its neighbours' median and
// CONFIRM_SHARE of the cut's own change, within a frame of it.
const CONFIRM_LEVEL = 6;
const CONFIRM_SHARE = 0.5;
const NEIGHBOURS = 12;

export interface Cut {
  frame: number;
  /** A whip or a two-frame dissolve changes on consecutive frames: one cut this many frames long. */
  frames: number;
  /** Its largest change, in mean grey levels. */
  change: number;
  /** Found only by the soft rule. */
  soft?: true;
}

/** Every frame of ffmpeg's `input` (after `filters`) as SIG_W x SIG_H grey levels. */
export function signatures(input: string[], filters: string[] = []): Frames {
  return decode(input, [...filters, `scale=${SIG_W}:${SIG_H}:flags=area`], SIG_W, SIG_H, true);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Each frame's mean grey difference from the one before (0 for the first). */
export function frameChanges(frames: Uint8Array[]): number[] {
  return frames.map((f, i) => (i ? meanAbsDiff(frames[i - 1]!, f) : 0));
}

const neighbours = (diffs: number[], i: number) =>
  diffs.slice(Math.max(1, i - NEIGHBOURS), i).concat(diffs.slice(i + 1, i + NEIGHBOURS + 1));

/** The frame indexes where a new shot starts, from each frame's change (`frameChanges`). */
export function cutsIn(diffs: number[]): Cut[] {
  const hits = diffs.flatMap((d, i): { frame: number; change: number; soft?: true }[] => {
    if (i === 0) return [];
    const around = neighbours(diffs, i);
    const typical = Math.max(1, median(around));
    if (d >= CUT_LEVEL && d >= CUT_RATIO * typical) return [{ frame: i, change: d }];
    const alone = d >= SOFT_ALONE * Math.max(0, ...around);
    return d >= SOFT_LEVEL && d >= SOFT_RATIO * typical && alone
      ? [{ frame: i, change: d, soft: true }]
      : [];
  });
  const out: Cut[] = [];
  for (const { soft, ...h } of hits) {
    const last = out.at(-1);
    if (last && h.frame === last.frame + last.frames) {
      last.frames++;
      last.change = Math.max(last.change, h.change);
      if (!soft) delete last.soft;
    } else out.push({ ...h, frames: 1, ...(soft ? { soft } : {}) });
  }
  return out;
}

/** The frame indexes where a new shot starts, each with its change and length. */
export function findCuts(frames: Uint8Array[]): Cut[] {
  return cutsIn(frameChanges(frames));
}

/**
 * Whether these changes show a clear change within a frame of `frame`, though maybe under a cut's thresholds: a
 * soft cut found on the other side counts as matched by it, as a soft cut is a change near the line.
 */
export function confirmsCut(diffs: number[], cut: Cut): boolean {
  return [cut.frame - 1, cut.frame, cut.frame + 1].some((i) => {
    const d = diffs[i];
    if (i < 1 || d === undefined) return false;
    return (
      d >= Math.max(CONFIRM_LEVEL, CONFIRM_SHARE * cut.change) &&
      d >= CUT_RATIO * Math.max(1, median(neighbours(diffs, i)))
    );
  });
}
