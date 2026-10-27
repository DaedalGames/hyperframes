// Two mounts of one composition, each binding its own clip through data-variable-values, each play
// their own clip. Needs Chrome + ffmpeg: integration lane.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "@hyperframes/engine";
import { createRenderJob, executeRenderJob } from "../renderOrchestrator.js";
import { FFMPEG, HAS_FFMPEG, frameLevels } from "./frameLevelsTestFixtures.js";

const WIDTH = 160;
const HEIGHT = 90;
const FPS = 10;

const hostA = (start: number, duration: number, src: string, z = 0) =>
  `<div id="mount-a" data-composition-id="clip" data-composition-src="compositions/clip.html"
      data-start="${start}" data-duration="${duration}" data-width="${WIDTH}" data-height="${HEIGHT}"
      data-variable-values='{"src":"${src}"}' style="z-index:${z}"></div>`;
const hostB = (start: number, duration: number, src: string, z = 0) =>
  hostA(start, duration, src, z).replace("mount-a", "mount-b");

const indexWith = (hosts: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <script src="assets/gsap.min.js"></script>
  <style>* { margin: 0; padding: 0; } body { overflow: hidden; background: #000; }</style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="8"
    data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="${FPS}">
    ${hosts}
  </div>
  <script>window.__timelines["main"] = gsap.timeline({ paused: true });</script>
</body>
</html>
`;

const DECLARED = `data-composition-variables='[{"id":"src","type":"string","label":"Clip","default":"assets/placeholder.mp4"}]'`;
const clipBody = (
  duration: number,
  declared = "",
  muted = "muted",
) => `<div data-composition-id="clip" ${declared} data-width="${WIDTH}" data-height="${HEIGHT}">
    <video id="v" ${muted} src="../assets/placeholder.mp4" data-var-src="src"
      data-start="0" data-duration="${duration}" data-track-index="0"
      style="position:absolute;inset:0;width:100%;height:100%"></video>
  </div>`;
const templated = (duration: number, declared = "", muted = "muted") =>
  `<template id="clip-template">\n  ${clipBody(duration, declared, muted)}\n</template>\n`;
const bare = (duration: number) => `${clipBody(duration)}\n`;

const LAYOUTS: Array<{
  name: string;
  index: string;
  clip: string;
  tones?: boolean;
  placeholderTone?: number;
  single?: boolean;
}> = [
  {
    name: "one after the other, templated",
    index: indexWith(hostA(0, 4, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4")),
    clip: templated(4),
  },
  {
    name: "overlapping in time, templated",
    index: indexWith(hostA(0, 8, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4", 5)),
    clip: templated(8),
  },
  {
    name: "one after the other, declared default",
    index: indexWith(hostA(0, 4, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4")),
    clip: templated(4, DECLARED),
  },
  {
    name: "one after the other, templated, with sound",
    index: indexWith(hostA(0, 4, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4")),
    clip: templated(4, "", ""),
    tones: true,
  },
  {
    name: "a single mount, with sound",
    index: indexWith(hostA(0, 4, "assets/white.mp4")),
    clip: templated(4, "", ""),
    tones: true,
    single: true,
  },
  {
    name: "one after the other, a placeholder with its own sound",
    index: indexWith(hostA(0, 4, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4")),
    clip: templated(4, "", ""),
    tones: true,
    placeholderTone: 200,
  },
  {
    name: "one after the other, bare file",
    index: indexWith(hostA(0, 4, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4")),
    clip: bare(4),
  },
  {
    name: "overlapping in time, bare file",
    index: indexWith(hostA(0, 8, "assets/white.mp4") + hostB(4, 4, "assets/grey.mp4", 5)),
    clip: bare(8),
  },
];

/** Black for `black` seconds is not needed: each clip is one solid colour. */
function makeClip(path: string, color: string, seconds: number, tone?: number): void {
  const input = `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${seconds}`;
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", input];
  if (tone) args.push("-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=16000:d=${seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (tone) args.push("-c:a", "aac", "-shortest");
  args.push("-y", path);
  const made = spawnSync(FFMPEG, args, { encoding: "utf-8" });
  if (made.status !== 0) throw new Error(`fixture failed: ${made.stderr}`);
}

/** Dominant frequency (Hz) of the mono audio between two times, from its zero crossings. */
function pitchAt(videoPath: string, from: number, to: number): number {
  const rate = 16000;
  const raw = spawnSync(
    FFMPEG,
    ["-v", "error", "-ss", String(from), "-t", String(to - from), "-i", videoPath].concat([
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-f",
      "s16le",
      "-",
    ]),
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (raw.status !== 0) return 0;
  const samples = new Int16Array(raw.stdout.buffer, raw.stdout.byteOffset, raw.stdout.length >> 1);
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings++;
  }
  return crossings / 2 / (to - from);
}

describe.skipIf(!HAS_FFMPEG).each(LAYOUTS)("two mounts of one composition: $name", (layout) => {
  let root: string;
  let levels: number[];
  let pitches: number[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "hf-variable-copies-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    mkdirSync(join(root, "compositions"), { recursive: true });
    copyFileSync(
      resolve(import.meta.dirname, "../../../../core/node_modules/gsap/dist/gsap.min.js"),
      join(root, "assets/gsap.min.js"),
    );
    makeClip(join(root, "assets/placeholder.mp4"), "black", 8, layout.placeholderTone);
    makeClip(join(root, "assets/white.mp4"), "white", 8, layout.tones ? 400 : undefined);
    makeClip(join(root, "assets/grey.mp4"), "gray", 8, layout.tones ? 1200 : undefined);
    writeFileSync(join(root, "compositions/clip.html"), layout.clip);
    writeFileSync(join(root, "index.html"), layout.index);
    const job = createRenderJob({
      fps: FPS,
      quality: "draft",
      format: "mp4",
      hdrMode: "force-sdr",
      workers: 1,
      producerConfig: resolveConfig({ browserGpuMode: "software" }),
    });
    const output = join(root, "out.mp4");
    await executeRenderJob(job, root, output);
    levels = frameLevels(output, WIDTH, HEIGHT);
    if (layout.tones) pitches = [pitchAt(output, 1, 3), pitchAt(output, 5, 7)];
  }, 180_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("plays each mount's own clip", () => {
    expect(levels).toHaveLength(8 * FPS);
    expect(levels[Math.round(2 * FPS)]!).toBeGreaterThan(200);
    if (layout.single) return;
    const second = levels[Math.round(6 * FPS)]!;
    expect(second).toBeGreaterThan(90);
    expect(second).toBeLessThan(170);
  });

  it.skipIf(!LAYOUTS.some((l) => l.tones))("plays each mount's own sound", () => {
    if (!layout.tones) return;
    expect(pitches[0]!).toBeGreaterThan(350);
    expect(pitches[0]!).toBeLessThan(450);
    if (layout.single) return;
    expect(pitches[1]!).toBeGreaterThan(1100);
    expect(pitches[1]!).toBeLessThan(1300);
  });
});
