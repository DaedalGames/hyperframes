import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../utils/runFfmpeg.js";
import { extractVideoMetadata } from "../utils/ffprobe.js";
import { svgOutputArgs } from "./svgFrames.js";
import { extractVideoFramesRange, resolveFrameFormat } from "./videoFrameExtractor.js";

describe("svgOutputArgs", () => {
  const args = svgOutputArgs({
    parts: "/tmp/frames/parts",
    shared: ["fps=25", "setparams=colorspace=bt709"],
    colourFilter: "format=yuv444p",
    jpegQuality: "2",
    perOutput: ["-frames:v", "10", "-start_number", "4"],
  });

  it("splits one decode into colour and alpha branches", () => {
    expect(args[1]).toBe(
      "[0:v]fps=25,setparams=colorspace=bt709,format=yuva420p,split[c][a];[c]format=yuv444p[rgb];[a]alphaextract,format=gray[al]",
    );
  });

  it("gives each output its own frame count and first number", () => {
    const outputs = args.join(" ").split(" -map ").slice(1);
    expect(outputs).toHaveLength(2);
    for (const output of outputs) expect(output).toContain("-frames:v 10 -start_number 4");
  });
});

describe("alpha WebM frames", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-svg-frames-"));
  const fixture = join(dir, "half.webm");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeAll(async () => {
    const made = await runFfmpeg([
      ...[
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red@0.5:s=64x48:d=1:r=5,format=yuva420p",
      ],
      ...["-c:v", "libvpx-vp9", "-auto-alt-ref", "0", "-pix_fmt", "yuva420p", fixture],
    ]);
    if (!made.success) throw new Error(`fixture synthesis failed: ${made.stderr.slice(-300)}`);
  }, 30_000);

  it("is read as svg frames unless png is asked for", async () => {
    const metadata = await extractVideoMetadata(fixture);
    expect(resolveFrameFormat(metadata, "jpg")).toBe("svg");
    expect(resolveFrameFormat(metadata, "png")).toBe("png");
  });

  it("extracts one svg per frame holding the colour as jpeg and the alpha as a png matte", async () => {
    const result = await extractVideoFramesRange(fixture, "all", 0, 1, {
      fps: 5,
      outputDir: join(dir, "out"),
      format: "auto",
    });
    expect(result.framePattern).toBe("frame_%05d.svg");
    expect(result.framePaths.size).toBe(5);
    expect(readdirSync(result.outputDir).some((name) => name.startsWith("svg-parts"))).toBe(false);
    const svg = readFileSync(result.framePaths.get(0)!, "utf8");
    expect(svg).toContain('width="64" height="48"');
    expect(svg).toContain("data:image/jpeg;base64,");
    const matte = Buffer.from(/image\/png;base64,([^"]+)"/.exec(svg)![1]!, "base64");
    const ffmpegArgs = ["-v", "error", "-i", "-", "-f", "rawvideo", "-pix_fmt", "gray", "-"];
    const gray = spawnSync("ffmpeg", ffmpegArgs, { input: matte }).stdout;
    const mean = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    expect(mean).toBeGreaterThan(120);
    expect(mean).toBeLessThan(135);
  }, 60_000);

  it("numbers each output's frames from the segment's first frame", async () => {
    const result = await extractVideoFramesRange(fixture, "range", 0, 1, {
      fps: 5,
      outputDir: join(dir, "out"),
      format: "auto",
      frameRanges: [{ firstFrame: 2, frames: 2 }],
    });
    expect([...result.framePaths.keys()]).toEqual([2, 3]);
    expect(readdirSync(result.outputDir).filter((name) => name.startsWith("frame_"))).toEqual([
      "frame_00003.svg",
      "frame_00004.svg",
    ]);
  }, 60_000);

  it.each([
    { width: 64, height: 48 },
    { width: 20, height: 12 },
  ])(
    "keeps the matte when a shown box scales the frames to $width x $height",
    async (shownBox) => {
      const result = await extractVideoFramesRange(fixture, `box-${shownBox.width}`, 0, 1, {
        fps: 5,
        outputDir: join(dir, "out"),
        format: "auto",
        frameRanges: [{ firstFrame: 0, frames: 2 }],
        shownBox,
      });
      expect(result.framePaths.size).toBe(2);
      const svg = readFileSync(result.framePaths.get(0)!, "utf8");
      expect(svg).toContain("data:image/png;base64,");
    },
    60_000,
  );
});
