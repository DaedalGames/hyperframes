// New media on HeyGen for `media-use generate`: a still (optionally edited from a reference), a shot (optionally from
// a first frame), a person speaking from one photo, a voice reading text, or music. Every call is priced first with
// --plan, keyed for idempotency, downloaded into the project and recorded in the media ledger as generated.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { Fix, runFfmpeg } from "../measure/media.js";
import { idempotencyKey, runJob, type Job } from "./v3.js";

export type GenerateType = "image" | "video" | "avatar" | "voice" | "music";
export const GENERATE_TYPES: readonly GenerateType[] = [
  "image",
  "video",
  "avatar",
  "voice",
  "music",
];

export interface GenerateRequest {
  type: GenerateType;
  out: string;
  prompt?: string;
  /** image: pictures the result is edited from or styled after. video: the person or things to keep in the shot. */
  references?: string[];
  /** video: speech the person in the references says, lips in sync (a stretch of the original's voice). */
  audio?: string;
  /** video: a clip whose camera and body motion the shot follows (the original's same stretch, up to 15 s). */
  motion?: string;
  /** video: the shot starts from this picture. */
  firstFrame?: string;
  /** avatar: the photo of the person who speaks. */
  photo?: string;
  /** avatar and voice: what is said. */
  script?: string;
  voice?: string;
  seconds?: number;
  aspect?: string;
  model?: string;
  instrumental?: boolean;
  bpm?: number;
}

interface Route {
  path: string;
  poll: (id: string) => string;
  body: (r: GenerateRequest, media: Media) => Record<string, unknown>;
  /** Where the finished job keeps the file's URL. */
  urls: string[];
  ledger: "image" | "video" | "voice" | "bgm";
  ext: string[];
}

type Media = (
  path: string,
  kind: "image" | "audio" | "video",
) => { type: "base64"; media_type: string; data: string };

const DEFAULTS = { image: "nano-banana-2", video: "heygen-video-1", music: "lyria-3-pro" } as const;
const MUSIC_LENGTHS = [30, 60, 120, 180];

const need = <T>(value: T | undefined, flag: string, example: string): T => {
  if (value === undefined || value === "")
    throw new Fix(`${flag} is required for this type`, example);
  return value;
};

export const ROUTES: Record<GenerateType, Route> = {
  image: {
    path: "/v3/images",
    poll: (id) => `/v3/images/${id}`,
    body: (r, media) => ({
      model: r.model ?? DEFAULTS.image,
      prompt: need(r.prompt, "--prompt", '--prompt "the same room, empty, no text"'),
      num_images: 1,
      ...(r.aspect ? { aspect_ratio: r.aspect } : {}),
      ...(r.references?.length
        ? { reference_images: r.references.map((p) => media(p, "image")) }
        : {}),
    }),
    urls: ["images.0.url", "image_url", "url"],
    ledger: "image",
    ext: [".png", ".jpg", ".jpeg", ".webp"],
  },
  video: {
    path: "/v3/models/videos",
    poll: (id) => `/v3/models/videos/${id}`,
    body: (r, media) => {
      // A person speaking given audio is a reference shot: the references show who, the audio drives the lips.
      const spoken = !!r.audio || !!r.references?.length || !!r.motion;
      if (spoken && r.firstFrame)
        throw new Fix(
          "--first-frame cannot be used with --reference, --audio or --motion",
          "a speaking shot takes the person as --reference and the voice as --audio",
        );
      return {
        model: r.model ?? DEFAULTS.video,
        mode: spoken ? "reference_to_video" : r.firstFrame ? "image_to_video" : "text_to_video",
        prompt: need(r.prompt, "--prompt", '--prompt "slow push in on the desk"'),
        duration: Math.min(15, Math.max(5, Math.round(r.seconds ?? 5))),
        resolution: "768p",
        ...(r.firstFrame ? { image: media(r.firstFrame, "image") } : {}),
        ...(r.firstFrame ? {} : { aspect_ratio: r.aspect ?? "16:9" }),
        ...(r.references?.length
          ? { reference_images: r.references.map((p) => media(p, "image")) }
          : {}),
        ...(r.audio ? { reference_audio: [media(r.audio, "audio")] } : {}),
        // One guide clip: HeyGen follows its camera and body motion, and takes the face from the references.
        ...(r.motion ? { reference_videos: [media(r.motion, "video")] } : {}),
      };
    },
    urls: ["video_url", "output.video_url", "url"],
    ledger: "video",
    ext: [".mp4", ".mov", ".webm"],
  },
  avatar: {
    path: "/v3/videos",
    poll: (id) => `/v3/videos/${id}`,
    body: (r, media) => ({
      type: "image",
      image: media(need(r.photo, "--photo", "--photo assets/presenter.png"), "image"),
      script: need(r.script, "--script", '--script "What they say"'),
      voice_id: need(
        r.voice,
        "--voice",
        "--voice <voice id> (npx hyperframes media-use resolve --type voice lists voices)",
      ),
      ...(r.aspect ? { aspect_ratio: r.aspect } : {}),
      output_format: "mp4",
    }),
    urls: ["video_url"],
    ledger: "video",
    ext: [".mp4"],
  },
  voice: {
    path: "/v3/voices/speech",
    poll: (id) => `/v3/voices/speech/${id}`,
    body: (r) => ({
      text: need(r.script, "--script", '--script "What the voice says"'),
      voice_id: need(r.voice, "--voice", "--voice <voice id>"),
    }),
    urls: ["audio_url"],
    ledger: "voice",
    ext: [".mp3", ".wav", ".m4a"],
  },
  music: {
    path: "/v3/audio/music",
    poll: (id) => `/v3/audio/music/${id}`,
    body: (r) => ({
      model: r.model ?? DEFAULTS.music,
      prompt: need(r.prompt, "--prompt", '--prompt "warm lo-fi beat, soft keys"'),
      duration_seconds: MUSIC_LENGTHS.find((s) => s >= (r.seconds ?? 30)) ?? 180,
      instrumental: r.instrumental ?? true,
      ...(r.bpm ? { bpm: Math.round(r.bpm) } : {}),
    }),
    urls: ["audio_url"],
    ledger: "bgm",
    ext: [".mp3"],
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The first URL at any of these dotted paths of a job. */
export function urlOf(job: Job, paths: string[]): string | null {
  for (const p of paths) {
    let v: unknown = job;
    for (const key of p.split("."))
      v = Array.isArray(v) ? v[Number(key)] : isRecord(v) ? v[key] : undefined;
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

/** A picture or a sound as the routes take it inline, pictures shrunk to 2048 px so the body stays small. */
function inline(work: string): Media {
  return (path, kind) => {
    if (!existsSync(path))
      throw new Fix(`no file at ${path}`, "pass a picture or sound from the project");
    const out = join(
      work,
      `in-${Math.random().toString(36).slice(2)}.${{ image: "jpg", audio: "mp3", video: "mp4" }[kind]}`,
    );
    if (kind === "image")
      runFfmpeg([
        "-y",
        "-i",
        path,
        "-vf",
        "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease",
        "-q:v",
        "3",
        "-frames:v",
        "1",
        out,
      ]);
    else if (kind === "audio")
      runFfmpeg(["-y", "-i", path, "-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", out]);
    // A guide clip only needs its motion: 720 px on the long side, no sound, at most 15 s.
    else
      runFfmpeg([
        ...["-y", "-i", path, "-t", "15", "-an", "-vf"],
        "scale='if(gt(iw,ih),min(720,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))'",
        ...["-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p", out],
      ]);
    return {
      type: "base64",
      media_type: { image: "image/jpeg", audio: "audio/mpeg", video: "video/mp4" }[kind],
      data: readFileSync(out).toString("base64"),
    };
  };
}

/** The nearest folder at or above `from` holding index.html. */
function projectOf(from: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "index.html"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export interface Generated {
  out: string;
  type: GenerateType;
  job: string;
  route: string;
  ledger?: string;
}

export async function generate(
  r: GenerateRequest,
  onWait?: (status: string) => void,
): Promise<Generated> {
  const route = ROUTES[r.type];
  const out = resolve(r.out);
  if (!route.ext.includes(extname(out).toLowerCase()))
    throw new Fix(`--out ${r.out} does not fit a ${r.type}`, `--out assets/name${route.ext[0]}`);
  mkdirSync(dirname(out), { recursive: true });
  const project = projectOf(dirname(out));
  const work = mkdtempSync(join(tmpdir(), "hf-generate-"));
  try {
    const body = route.body(r, inline(work));
    const key = idempotencyKey(route.path, [JSON.stringify(body)]);
    const job = await runJob(route.path, body, key, (id) => route.poll(encodeURIComponent(id)), {
      log: {
        projectDir: project ?? undefined,
        what: `generate ${r.type} ${relative(project ?? ".", out)}`,
      },
      onWait: (j) => onWait?.(j.status),
      timeoutMs: 30 * 60_000,
    });
    const url = urlOf(job, route.urls);
    if (!url)
      throw new Fix(
        `HeyGen finished job ${job.id} without a file URL`,
        "run the same command again; it re-reads the job",
      );
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok)
      throw new Fix(
        `could not download the result (${res.status})`,
        "run the same command again; it re-reads the job",
      );
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    let ledger: string | undefined;
    if (project) {
      const { recordInPlace } = await import("../media-use/lib/manifest.mjs");
      const { regenerateIndex } = await import("../media-use/lib/index-gen.mjs");
      const describe = (p?: string) =>
        p ? relative(project, resolve(p)).split("\\").join("/") : undefined;
      ledger = recordInPlace(project, {
        type: route.ledger,
        path: relative(project, out).split("\\").join("/"),
        source: "generated",
        description: r.prompt ?? r.script ?? r.type,
        provenance: {
          provider: "heygen",
          route: route.path,
          model: body.model ?? null,
          job: job.id,
          prompt: r.prompt ?? null,
          ...(r.references?.length ? { references: r.references.map(describe) } : {}),
          ...(r.firstFrame ? { first_frame: describe(r.firstFrame) } : {}),
          ...(r.photo ? { photo: describe(r.photo) } : {}),
          ...(r.audio ? { audio: describe(r.audio) } : {}),
          ...(r.motion ? { motion: describe(r.motion) } : {}),
          ...(r.voice ? { voice: r.voice } : {}),
        },
      }).id;
      regenerateIndex(project);
    }
    return { out, type: r.type, job: job.id, route: route.path, ...(ledger ? { ledger } : {}) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
