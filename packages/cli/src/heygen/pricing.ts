// Prices before a paid call, from the HyperFrames app's creation pricing (hyperframes-internal
// packages/desktop/shared/creationPricing.mjs, 2026-10-22). HeyGen charges in units of $1/60, rounded up; the label
// rounds up to the cent. Routes HeyGen does not price ahead say so instead of guessing.
import type { GenerateRequest } from "./generate.js";

export interface Price {
  usd: number | null;
  basis: string;
}

const UNIT = 1 / 60;
const charged = (usd: number) => Math.ceil(usd / UNIT - 1e-9) * UNIT;
const cents = (usd: number) => Math.ceil(charged(usd) * 100 - 1e-9) / 100;

const GPT_IMAGE: Record<string, number> = {
  "1:1": 0.05268,
  "16:9": 0.0396,
  "9:16": 0.0396,
  "4:3": 0.03612,
  "3:4": 0.03612,
};
const NANO_IMAGE = 0.067;
const VIDEO_768P_PER_S = 0.018;
const MUSIC_PER_TRACK = 0.08;
const AVATAR_IV_PER_MIN = 4.83;
// An avatar's length is estimated from its script, as the app does.
const WORDS_PER_S = 2;

export function priceOf(r: GenerateRequest): Price {
  switch (r.type) {
    case "image": {
      const refs = r.references?.length ?? 0;
      if ((r.model ?? "nano-banana-2") === "nano-banana-2")
        return { usd: cents(NANO_IMAGE), basis: "nano-banana-2, $0.067 an image" };
      const each = GPT_IMAGE[r.aspect ?? "16:9"] ?? GPT_IMAGE["16:9"]!;
      return {
        usd: cents(each + Math.max(0, refs - 1) * 0.0082),
        basis: `gpt-image-2.5 at ${r.aspect ?? "16:9"}, $0.0082 a reference after the first`,
      };
    }
    case "video": {
      const seconds = Math.min(15, Math.max(5, Math.round(r.seconds ?? 5)));
      return {
        usd: cents(seconds * VIDEO_768P_PER_S),
        basis: `heygen-video-1 at 768p, ${seconds} s at $0.018 a second`,
      };
    }
    case "avatar": {
      const words = (r.script ?? "").split(/\s+/).filter(Boolean).length;
      const seconds = Math.max(1, Math.floor(words / WORDS_PER_S));
      return {
        usd: cents(Math.ceil(seconds * AVATAR_IV_PER_MIN) / 60),
        basis: `avatar video, about ${seconds} s from ${words} words at $4.83 a minute`,
      };
    }
    case "music":
      return { usd: cents(MUSIC_PER_TRACK), basis: "lyria-3-pro, $0.08 a track" };
    case "voice":
      return {
        usd: null,
        basis: "HeyGen does not price catalog speech ahead; it is charged per character",
      };
  }
}
