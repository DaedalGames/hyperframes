/**
 * The time to give a media element so it shows the frame that starts at `sourceSeconds`.
 *
 * Chrome stores `currentTime` in whole microseconds, truncated, while frame start times are rounded
 * to the microsecond, so a seek to an exact frame instant (2/30 s = 66666.67 us, stored as 66666)
 * shows the previous frame. The middle of the first whole microsecond at or after the instant is
 * never truncated below it. Self-contained: generated scripts embed its source.
 */
export function mediaElementTime(sourceSeconds: number): number {
  return (Math.ceil(sourceSeconds * 1e6) + 0.5) / 1e6;
}
