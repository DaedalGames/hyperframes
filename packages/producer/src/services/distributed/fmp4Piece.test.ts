import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChunkSliceJson } from "../render/stages/freezePlan.js";
import { assemble } from "./assemble.js";
import { audioCutForChunk, buildFragmentedPiece, placePiece } from "./fmp4Piece.js";

const FPS = { num: 30, den: 1 };
// Uneven chunks and a 1-frame tail: the shapes where decode times drift.
const CHUNKS: ChunkSliceJson[] = [
  { index: 0, startFrame: 0, endFrame: 47 },
  { index: 1, startFrame: 47, endFrame: 90 },
  { index: 2, startFrame: 90, endFrame: 91 },
];
const TOTAL_FRAMES = 91;

let root: string;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function ffmpeg(args: string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", ...args], {
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Closed-GOP chunk shaped like renderChunk's: IDR at frame 0, no B-frames, 90 kHz track. */
function encodeChunk(path: string, slice: ChunkSliceJson, bFrames = 0): void {
  const frames = slice.endFrame - slice.startFrame;
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=160x120:rate=30,trim=start_frame=${slice.startFrame}:end_frame=${slice.endFrame}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-g",
    String(frames),
    "-keyint_min",
    String(frames),
    "-sc_threshold",
    "0",
    "-bf",
    String(bFrames),
    "-x264-params",
    "scenecut=0:open-gop=0:repeat-headers=1",
    "-video_track_timescale",
    "90000",
    "-pix_fmt",
    "yuv420p",
    "-avoid_negative_ts",
    "make_zero",
    "-y",
    path,
  ]);
}

function videoFrames(path: string): string[] {
  return ffmpeg(["-i", path, "-map", "0:v", "-f", "framemd5", "-"])
    .toString()
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) =>
      line
        .split(",")
        .map((field) => field.trim())
        .filter((_, i) => i === 2 || i === 5)
        .join(","),
    );
}

function pcm(path: string): Buffer {
  return ffmpeg(["-i", path, "-map", "0:a", "-f", "s16le", "-"]);
}

/** moof's first child is mfhd (8-byte header + 4 version/flags), so its sequence number sits at +20. */
function topLevelBoxes(bytes: Buffer): { type: string; start: number }[] {
  const boxes: { type: string; start: number }[] = [];
  for (let at = 0; at < bytes.length; at += bytes.readUInt32BE(at)) {
    boxes.push({ type: bytes.toString("latin1", at + 4, at + 8), start: at });
  }
  return boxes;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hf-fmp4-piece-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("audioCutForChunk", () => {
  it("gives each chunk the AAC packets that start in its range, priming to chunk 0", () => {
    const grid = { sampleRate: 48000, firstStart: -1024, packetSamples: 1024, packetCount: 564 };
    const chunks = [0, 120, 240].map((startFrame, index) => ({
      index,
      startFrame,
      endFrame: startFrame + 120,
    }));
    const cuts = chunks.map((_, index) => audioCutForChunk(grid, chunks, index, FPS));
    expect(cuts).toEqual([
      { seekSeconds: null, durationSeconds: 4, firstPacket: 0, packetCount: 189 },
      {
        seekSeconds: 4,
        durationSeconds: (375 * 1024 - 512) / 48000 - 4,
        firstPacket: 189,
        packetCount: 187,
      },
      {
        seekSeconds: (375 * 1024 - 512) / 48000,
        durationSeconds: null,
        firstPacket: 376,
        packetCount: 188,
      },
    ]);
  });
});

describe.skipIf(!hasFfmpeg)("fragmented pieces", () => {
  it("join by concatenation into the same frames and audio samples as today's join", async () => {
    const audioPath = join(root, "audio.m4a");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=0.4*sin(2*PI*(220+40*t)*t)|0.4*sin(2*PI*(330+30*t)*t):s=48000:d=${TOTAL_FRAMES / 30}`,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-y",
      audioPath,
    ]);
    const planDir = join(root, "plan");
    mkdirSync(join(planDir, "meta"), { recursive: true });
    writeFileSync(
      join(planDir, "plan.json"),
      JSON.stringify({
        planHash: "fake",
        totalFrames: TOTAL_FRAMES,
        hasAudio: true,
        dimensions: { fpsNum: 30, fpsDen: 1, width: 160, height: 120, format: "mp4" },
      }),
    );
    writeFileSync(join(planDir, "meta", "chunks.json"), JSON.stringify(CHUNKS));
    writeFileSync(join(planDir, "meta", "encoder.json"), JSON.stringify({ fragmentedMp4: true }));

    const videoPaths = CHUNKS.map((slice) => join(root, `video-${slice.index}.mp4`));
    const piecePaths = CHUNKS.map((slice) => join(root, `piece-${slice.index}.mp4`));
    for (const slice of CHUNKS) {
      encodeChunk(videoPaths[slice.index]!, slice);
      await buildFragmentedPiece({
        videoPath: videoPaths[slice.index]!,
        audioPath,
        outputPath: piecePaths[slice.index]!,
        chunks: CHUNKS,
        chunkIndex: slice.index,
        fps: FPS,
        timeoutMs: 60_000,
      });
    }
    const outputPath = join(root, "out.mp4");
    const result = await assemble(planDir, piecePaths, null, outputPath);
    expect(result.framesEncoded).toBe(TOTAL_FRAMES);

    const probe = spawnSync("ffprobe", ["-v", "error", outputPath], { encoding: "utf-8" });
    expect(probe.status).toBe(0);
    expect(probe.stderr).toBe("");
    const videoDuration = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v",
        "-show_entries",
        "stream=duration",
        "-of",
        "csv=p=0",
        "--",
        outputPath,
      ],
      { encoding: "utf-8" },
    );
    expect(Number(videoDuration.stdout)).toBeCloseTo(TOTAL_FRAMES / 30, 6);

    // Today's join of the same chunks: the same plan without the fragmented layout.
    writeFileSync(join(planDir, "meta", "encoder.json"), "{}");
    const referencePath = join(root, "reference.mp4");
    await assemble(planDir, videoPaths, audioPath, referencePath);
    expect(videoFrames(outputPath)).toEqual(videoFrames(referencePath));
    expect(pcm(outputPath).equals(pcm(referencePath))).toBe(true);

    const bytes = readFileSync(outputPath);
    expect(topLevelBoxes(bytes).map((box) => box.type)).toEqual([
      "ftyp",
      "moov",
      ...CHUNKS.flatMap(() => ["moof", "mdat"]),
    ]);
    const sequenceNumbers = topLevelBoxes(bytes)
      .filter((box) => box.type === "moof")
      .map((moof) => bytes.readUInt32BE(moof.start + 20));
    expect(sequenceNumbers).toEqual([1, 2, 3]);
    for (const piece of piecePaths.slice(1)) {
      expect(readFileSync(piece).subarray(4, 8).toString()).toBe("moof");
    }
  }, 60_000);

  it("refuses a chunk whose video starts late, as B-frames make it", async () => {
    const delayed = join(root, "bframes.mp4");
    encodeChunk(delayed, { index: 0, startFrame: 0, endFrame: 30 }, 3);
    await expect(
      buildFragmentedPiece({
        videoPath: delayed,
        audioPath: null,
        outputPath: join(root, "bframes-piece.mp4"),
        chunks: [{ index: 0, startFrame: 0, endFrame: 30 }],
        chunkIndex: 0,
        fps: FPS,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("expected 0 (no B-frames)");
  });

  it("refuses a file that is not one fragment behind an init segment", async () => {
    const plain = join(root, "plain.mp4");
    encodeChunk(plain, { index: 0, startFrame: 0, endFrame: 5 });
    const placement = {
      keepInit: true,
      sequenceNumber: 1,
      videoStartFrame: 0,
      videoFrames: 5,
      fps: FPS,
      audio: null,
    };
    await expect(placePiece(plain, join(root, "never.mp4"), placement)).rejects.toThrow(
      "expected ftyp,moov,moof,mdat",
    );
  });
});
