// Body and camera motion where the pixels differ (a regenerated shot, another person, another room), ported from
// the Studio's motion-energy.mjs. Both clips are sampled on one 12 fps grid (mixed 24/30 fps skews per-frame
// differences), ROI scaled to 270 px wide, luma. Energy(t) = mean |frame_t - frame_t-1|.
import { meanAbsDiff, readClip, round, type Clip, type Roi } from "./media.js";

export const ENERGY_RATE = 12;

export function energyCurve(clip: Clip, roi?: Roi): number[] {
  const { frames } = readClip(clip, { fps: ENERGY_RATE, width: 270, gray: true, roi });
  return frames.slice(1).map((f, i) => meanAbsDiff(f, frames[i]!));
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let [num, da, db] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1e-12);
}

export interface EnergyComparison {
  /** Pearson r of the two curves at the best lag within ±1 s; only meaningful when the action is the same. */
  r: number;
  lag_s: number;
  peak_ratio: number;
  /** Amount of movement, yours over the reference's. */
  mean_ratio: number;
}

export function compareEnergy(ref: number[], yours: number[]): EnergyComparison {
  let best: [number, number] = [-2, 0];
  for (let lag = -ENERGY_RATE; lag <= ENERGY_RATE; lag++) {
    const [aa, bb] =
      lag >= 0
        ? [ref.slice(0, ref.length - lag), yours.slice(lag)]
        : [ref.slice(-lag), yours.slice(0, yours.length + lag)];
    if (Math.min(aa.length, bb.length) > 8) {
      const r = pearson(aa, bb);
      if (r > best[0]) best = [r, lag];
    }
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
  return {
    r: round(best[0] === -2 ? 0 : best[0]),
    lag_s: round(best[1] / ENERGY_RATE, 2),
    peak_ratio: round(Math.max(...yours, 0) / (Math.max(...ref, 0) || 1e-9), 2),
    mean_ratio: round(mean(yours) / (mean(ref) || 1e-9), 2),
  };
}
