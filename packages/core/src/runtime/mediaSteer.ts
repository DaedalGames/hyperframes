/** Drift a playing element may carry before sync pulls it back onto the playhead. */
export const MEDIA_SYNC_TOLERANCE_SECONDS = 0.04;

// Playing media is steered back by rate, not seeked: a seek resets a video's decoder and clicks in sounding audio.
// Its rate is written only when steering starts or stops: every write costs a frame.
const MEDIA_STEER = 0.03;
// Media that starts a cut late closes its lag over one clip at 3%; a bigger lag steers harder,
// in steps so the rate is written rarely.
const MEDIA_STEER_STEPS: readonly (readonly [lag: number, steer: number])[] = [
  [0.3, 0.25],
  [0.1, 0.1],
];
const MEDIA_STEER_RELEASE_SECONDS = 0.01;
// Sounding audio is never nudged past 10%, where speech audibly changes tempo. A lag that rate cannot close in about
// a second is seeked instead, which the caller hides under a gain dip when it has one.
const AUDIO_MAX_STEER = 0.1;
const AUDIO_STEER_LIMIT_SECONDS = 0.1;

/** Direction (+1 fast, -1 slow) an element is being steered in; absent when it plays at its authored rate. */
const steering = new WeakMap<HTMLMediaElement, number>();

/**
 * How to bring playing media `offset` seconds behind (+) or ahead (-) of its target back on: a rate, or a seek.
 * `settled` says the offset has stopped growing; a lag that still grows (a stall) is steered, never seeked.
 */
export function steerMedia(
  el: HTMLMediaElement,
  offset: number,
  baseRate: number,
  settled: boolean,
): { rate: number; seek: boolean } {
  const lag = Math.abs(offset);
  if (el.tagName === "AUDIO" && settled && lag > AUDIO_STEER_LIMIT_SECONDS) {
    steering.delete(el);
    return { rate: baseRate, seek: true };
  }
  const direction = Math.sign(offset);
  const current = steering.get(el);
  if (lag > MEDIA_SYNC_TOLERANCE_SECONDS) steering.set(el, direction);
  else if (current !== direction || lag <= MEDIA_STEER_RELEASE_SECONDS) {
    steering.delete(el);
    return { rate: baseRate, seek: false };
  }
  const step = MEDIA_STEER_STEPS.find(([from]) => lag > from)?.[1] ?? MEDIA_STEER;
  const steer = el.tagName === "AUDIO" ? Math.min(step, AUDIO_MAX_STEER) : step;
  return { rate: baseRate * (1 + direction * steer), seek: false };
}

/** Drop `el`'s steering: it was seeked, paused or replaced, so its old offset says nothing. */
export function forgetSteering(el: HTMLMediaElement): void {
  steering.delete(el);
}

export function isSteering(el: HTMLMediaElement): boolean {
  return steering.has(el);
}
