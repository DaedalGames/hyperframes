// HeyGen's video model watches a video and drafts its timeline as JSON. Its route samples at most 2 fps and reads
// one clip of at most 90 s at that rate, so the video goes in parts of up to 30 s split at cuts, each slowed until
// 2 fps there is about 6 fps of the original, and every time in the answer is mapped back to the film.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { defineCommand } from "../utils/defineCommand.js";
import type { Example } from "./_examples.js";
import { tryResolveCredential } from "../auth/resolver.js";
import { idempotencyKey, runJob } from "../heygen/v3.js";
import {
  DESCRIBE_SCHEMA,
  mergeDrafts,
  REVERSE_PROMPT,
  REVERSE_SCHEMA,
  toFilmTime,
} from "../heygen/reverseDraft.js";
import { jsonArg, num, runMeasure } from "../measure/command.js";
import { findCuts, signatures } from "../measure/cuts.js";
import { Fix, probeVideo, round, runFfmpeg, videoClip, type VideoInfo } from "../measure/media.js";

export const examples: Example[] = [
  [
    "Draft a reverse spec's timeline with HeyGen",
    "hyperframes analyze .reverse/source.mp4 --preset reverse",
  ],
  [
    "Ask one question about a video",
    'hyperframes analyze clip.mp4 --prompt "Does the logo animate in or cut in?"',
  ],
];

const ROUTE = "/v3/video-analyses";
const MODEL = "gemini-4-argon";
const HEYGEN_FPS = 2;
const HEYGEN_MAX_S = 90;
const PART_S = 30;
const INLINE_BYTES = 16 * 1024 * 1024;

/** Parts of at most PART_S seconds, each ending at a cut when one falls in its last two thirds. */
export function partsOf(duration: number, cuts: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let start = 0; start < duration - 0.05; ) {
    if (duration - start <= PART_S) {
      out.push([start, duration]);
      break;
    }
    const cut = cuts.filter((t) => t > start + PART_S / 3 && t <= start + PART_S).at(-1);
    const end = cut ?? start + PART_S;
    out.push([start, end]);
    start = end;
  }
  return out;
}

/** How much slower a part is sent so HeyGen's 2 fps samples it at `fps`, within its 90 s. */
export const slowBy = (fps: number, seconds: number) =>
  Math.max(1, Math.min(fps / HEYGEN_FPS, HEYGEN_MAX_S / seconds));

/** One part as HeyGen reads it: slowed, 720 px on its long side, silent when slowed, under the inline cap. */
function prepare(info: VideoInfo, [a, b]: [number, number], slow: number, dir: string): Buffer {
  const fit = info.width >= info.height ? "scale=720:-2" : "scale=-2:720";
  for (const crf of [23, 30, 36]) {
    const out = join(dir, `part-${a}-${crf}.mp4`);
    runFfmpeg([
      ...["-y", "-ss", String(a), "-i", info.path, "-t", String(b - a)],
      ...["-vf", `${fit},setsar=1,setpts=${slow}*PTS`, "-r", String(HEYGEN_FPS * 2)],
      ...(slow === 1 && info.audio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]),
      ...["-c:v", "libx264", "-crf", String(crf), "-pix_fmt", "yuv420p", out],
    ]);
    if (statSync(out).size <= INLINE_BYTES) return readFileSync(out);
  }
  throw new Fix(
    `a ${round(b - a, 1)} s part stays over HeyGen's 16 MB inline cap`,
    "analyze a shorter window with --start/--end",
  );
}

function defaultOut(video: string): string {
  const stem = basename(video, extname(video));
  return existsSync(".reverse")
    ? resolve(".reverse", `${stem}-analysis.json`)
    : resolve(".hyperframes", "analysis", `${stem}.json`);
}

/** The project a job log belongs to: the nearest folder up from here with index.html. */
function projectHere(): string | undefined {
  for (let dir = resolve("."); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "index.html"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export default defineCommand({
  meta: {
    name: "analyze",
    description:
      "HeyGen watches a video and drafts its timeline as JSON (--preset reverse), or answers a question about it (--prompt); uploads the video",
  },
  args: {
    video: { type: "positional", description: "The video file", required: true },
    preset: { type: "string", description: "reverse: the draft of a reverse spec (default)" },
    prompt: {
      type: "string",
      description: "Ask your own question instead; the answer comes with the moments it cites",
    },
    start: { type: "string", description: "First second (default 0)" },
    end: { type: "string", description: "Last second (default: the end)" },
    fps: {
      type: "string",
      description: "Frames a second the model should see (default 6; long parts get fewer)",
    },
    model: { type: "string", description: `HeyGen's analysis model (default ${MODEL})` },
    out: {
      type: "string",
      description: "Where to write the draft (default .reverse/<video>-analysis.json)",
    },
    json: jsonArg,
  },
  async run({ args }) {
    await runMeasure(async () => {
      if (args.preset !== undefined && args.prompt !== undefined)
        throw new Fix("--preset and --prompt both given", "pass one of them");
      if (args.preset !== undefined && args.preset !== "reverse")
        throw new Fix(
          `unknown preset "${String(args.preset)}"`,
          '--preset reverse, or --prompt "<question>"',
        );
      const credential = await tryResolveCredential();
      if (!credential)
        throw new Fix(
          "analyze needs a HeyGen sign-in; without one, measure the video and look at its frames instead",
          "npx hyperframes auth login, or set HEYGEN_API_KEY",
        );
      const info = probeVideo(String(args.video));
      const a = num(args.start, "--start", 0);
      const b = Math.min(info.duration, num(args.end, "--end", info.duration));
      if (b <= a) throw new Fix("--end is not after --start", "--start 0 --end 30");
      const fps = num(args.fps, "--fps", 6);
      const question = args.prompt === undefined ? REVERSE_PROMPT : String(args.prompt);
      const schema = args.prompt === undefined ? REVERSE_SCHEMA : DESCRIBE_SCHEMA;
      const clip = videoClip(info.path, a, b - a, info);
      const cuts = findCuts(signatures(clip.input, clip.filters).frames).map(
        (c) => a + c.frame / info.fps,
      );
      const parts = partsOf(
        b - a,
        cuts.map((t) => t - a),
      ).map(([x, y]): [number, number] => [a + x, a + y]);
      const work = mkdtempSync(join(tmpdir(), "hf-analyze-"));
      const project = projectHere();
      const answers: unknown[] = [];
      const done: Record<string, unknown>[] = [];
      try {
        for (const [i, part] of parts.entries()) {
          const slow = slowBy(fps, part[1] - part[0]);
          const video = prepare(info, part, slow, work);
          const partCuts = cuts
            .filter((t) => t > part[0] && t < part[1])
            .map((t) => round((t - part[0]) * slow, 2));
          const notes = [
            `This clip is ${round((part[1] - part[0]) * slow, 2)} s long${slow > 1 ? `: it plays at 1/${round(slow, 2)} speed and has no sound; judge motion as if at normal speed` : ""}.`,
            `Hard cuts measured in it (seconds): ${partCuts.length ? partCuts.join(", ") : "none"}.`,
            `Video: ${info.width}x${info.height}.`,
          ];
          const prompt = [question, ...notes].join("\n\n");
          const body = {
            model: String(args.model ?? MODEL),
            video: { type: "base64", media_type: "video/mp4", data: video.toString("base64") },
            prompt,
            response_schema: schema,
            max_output_tokens: 32768,
          };
          console.error(
            `analyze: part ${i + 1}/${parts.length}, ${round(part[0], 2)}–${round(part[1], 2)} s, slowed ${round(slow, 2)}x`,
          );
          const job = await runJob(
            ROUTE,
            body,
            idempotencyKey(ROUTE, [video, prompt, JSON.stringify(schema), body.model]),
            (id) => `${ROUTE}/${encodeURIComponent(id)}`,
            {
              log: {
                projectDir: project,
                what: `analyze ${basename(info.path)} ${round(part[0], 2)}-${round(part[1], 2)}s`,
              },
              onWait: (j) => console.error(`analyze: part ${i + 1} ${j.status}…`),
            },
          ).catch((err: unknown) => {
            if (
              err instanceof Fix &&
              /refused the credential/.test(err.message) &&
              credential.type === "oauth"
            )
              throw new Fix(
                "HeyGen's video analysis takes an API key, not a sign-in",
                "set HEYGEN_API_KEY, or continue without analyze: measure the video and look at its frames",
              );
            throw err;
          });
          const output = job.output;
          const answer =
            typeof output === "object" && output !== null && "json" in output
              ? output.json
              : output;
          answers.push(toFilmTime(answer, slow, part[0]));
          done.push({
            start: round(part[0], 3),
            end: round(part[1], 3),
            slow: round(slow, 2),
            job: job.id,
            usage: job.usage ?? null,
          });
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      const draft: Record<string, unknown> =
        args.prompt === undefined ? mergeDrafts(answers) : { answers };
      const out = args.out ? resolve(String(args.out)) : defaultOut(info.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          { video: info.path, model: String(args.model ?? MODEL), parts: done, ...draft },
          null,
          1,
        ),
      );
      const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      return {
        video: info.path,
        out,
        parts: done,
        ...(args.prompt === undefined
          ? {
              segments: count(draft.segments),
              questions: count(draft.questions),
              next: "check the draft against the frames (measure events --map, measure frames --events) and correct it in REVERSE.md",
            }
          : { answers }),
      };
    });
  },
});
