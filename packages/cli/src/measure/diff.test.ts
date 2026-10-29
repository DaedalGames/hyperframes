import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findFFmpeg, findFFprobe } from "../browser/ffmpeg.js";
import {
  cellsOutside,
  diffVideos,
  longRuns,
  pickedFrames,
  regionRoi,
  selectFilter,
  soundOffset,
  wholeFrameCuts,
} from "./diff.js";
import { probeVideo } from "./media.js";
import { carriedFrame, shotFraming, syncPass } from "./person.js";
import { parseSegments } from "./segments.js";

const ffmpeg = findFFmpeg();
const noTools = !ffmpeg || !findFFprobe();
const dir = mkdtempSync(join(tmpdir(), "hf-diff-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A lossless synthetic clip, so SSIM differences come from the picture, not the encoder. */
function clip(name: string, args: string[]): string {
  const out = join(dir, name);
  execFileSync(ffmpeg!, [
    ...["-hide_banner", "-loglevel", "error", "-y", ...args],
    ...["-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "0", out],
  ]);
  return out;
}

describe("parseSegments", () => {
  it("reads headings and where each window's pixels come from", () => {
    const md = [
      "# Film — reverse",
      "## S01 · 0.00–2.40 s · Title card",
      "Pixels: rebuilt",
      "## S02 · 2.40–5.00 s · Talking head",
      "Pixels: reused",
      "## S03 · 5.00–6.5 s · Product shot",
      "Pixels: regenerated",
      "## S04 · 6.5–8 s",
      "## Unknowns",
    ].join("\n");
    expect(parseSegments(md)).toEqual([
      { id: "S01", start: 0, end: 2.4, title: "Title card", pixels: "rebuilt" },
      { id: "S02", start: 2.4, end: 5, title: "Talking head", pixels: "reused" },
      { id: "S03", start: 5, end: 6.5, title: "Product shot", pixels: "regenerated" },
      { id: "S04", start: 6.5, end: 8, title: "", pixels: "rebuilt" },
    ]);
  });

  it("reads a regenerated region inside a rebuilt segment, in pixels or shares", () => {
    const md = [
      "## S01 · 0–2 s · Board under the presenter",
      "Pixels: rebuilt",
      "Regenerated: 0, 95, 720, 600 (the re-shot presenter)",
      "## S02 · 2–4 s",
      "Regenerated: 0 0.5 1 0.5",
      "## S03 · 4–6 s",
      "Pixels: regenerated",
      "Regenerated: 0, 0, 10, 10",
    ].join("\n");
    const [a, b, c] = parseSegments(md);
    expect(a!.regenerated).toEqual([0, 95, 720, 600]);
    expect(b!.regenerated).toEqual([0, 0.5, 1, 0.5]);
    expect(c!.regenerated).toBeUndefined();
  });

  it("reads drawn elements over a regenerated person, and whether a segment quotes copy", () => {
    const md = [
      "## S01 · 0–2 s · Title over the presenter",
      "Pixels: rebuilt",
      "Regenerated: 0, 0, 608, 1080",
      'Copy: "IS NO" / "LONGER"',
      "Drawn: 110, 615, 390, 165 (the title)",
      "Drawn: 40 40 120 120, logo 0.5–1.5 s",
      "## S02 · 2–4 s",
      "Copy: none, footage only",
    ].join("\n");
    const [a, b] = parseSegments(md);
    expect(a!.drawn).toEqual([
      { box: [110, 615, 390, 165] },
      { box: [40, 40, 120, 120], window: [0.5, 1.5] },
    ]);
    expect(a!.copy).toBe(true);
    expect(b!.drawn).toBeUndefined();
    expect(b!.copy).toBeUndefined();
  });
});

describe("whole-frame cuts", () => {
  it("keeps the ledger's cuts and stills from the original that cover the whole frame", () => {
    const ledger = [
      {
        type: "video",
        provenance: { provider: "original", window: [0, 12.267], roi: [0, 0, 720, 1280] },
      },
      { type: "video", provenance: { provider: "original", window: [1, 2] } },
      {
        type: "video",
        provenance: { provider: "original", window: [3, 4], roi: [0, 0, 720, 704] },
      },
      { type: "image", provenance: { provider: "original", at: 3, roi: [0, 0, 720, 1280] } },
      { type: "image", provenance: { provider: "original", at: 5, roi: [60, 260, 480, 560] } },
      { type: "video", provenance: { provider: "heygen", window: [0, 5] } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(wholeFrameCuts(`${ledger}\nnot json`, 720, 1280)).toEqual({
      windows: [
        [0, 12.267],
        [1, 2],
      ],
      stills: [3],
    });
  });

  it("drops runs of frames shorter than the minimum", () => {
    const on = [true, true, false, true, true, true, true, true];
    expect(longRuns(on, [0, 1, 2, 3, 4, 5, 9, 10], 3)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("regenerated regions", () => {
  it("scales shares to pixels, clips to the frame and leaves the covered cells to the region", () => {
    expect(regionRoi([0, 0.5, 1, 0.5], 320, 180)).toEqual([0, 90, 320, 90]);
    expect(regionRoi([600, 1200, 400, 200], 720, 1280)).toEqual([600, 1200, 120, 80]);
    // 80x44 cells: the bottom half covers rows 2 and 3 (row 2 from y 88, all but 2 px of it).
    expect(cellsOutside([0, 90, 320, 90], 320, 180)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("person gates", () => {
  const at = (t: number, ...boxes: number[][]) => ({ t, boxes });
  const face = [0.4, 0.3, 0.2, 0.12];
  const original = [0, 0.4, 0.8, 1.2].map((t) => at(t, face));

  it("fails a shot's framing only when the face sits clearly off the original's", () => {
    const moved = (dy: number, grow = 1) =>
      [0, 0.4, 0.8, 1.2].map((t) => at(t, [0.4, 0.3 + dy, 0.2 * grow, 0.12 * grow]));
    expect(shotFraming([0, 1.5], original, moved(0.01))).toMatchObject({ pass: true });
    // Half a face height lower, or 40% bigger.
    expect(shotFraming([0, 1.5], original, moved(0.06))).toMatchObject({ pass: false });
    expect(shotFraming([0, 1.5], original, moved(0, 1.4))).toMatchObject({ pass: false });
    // One stray moment off (a hand over the face, a photo) is not a framing.
    const stray = original.map((m, i) => (i === 1 ? at(m.t, [0.4, 0.6, 0.2, 0.12]) : m));
    expect(shotFraming([0, 1.5], original, stray)).toMatchObject({ pass: true });
    // Another face in yours (a picture on the wall) does not stand in for the person.
    const crowd = [0, 0.4, 0.8, 1.2].map((t) => at(t, [0.05, 0.05, 0.3, 0.2], face));
    expect(shotFraming([0, 1.5], original, crowd)).toMatchObject({
      shift: 0,
      pass: true,
    });
    // Too few faces to judge.
    expect(shotFraming([0, 0.5], original, original)).toBeUndefined();
  });

  it("judges lips only on a confident reading, inside +45 / −125 ms", () => {
    expect(syncPass({ best_lag_ms: 30, confidence: "high" })).toBe(true);
    expect(syncPass({ best_lag_ms: -120, confidence: "high" })).toBe(true);
    expect(syncPass({ best_lag_ms: 80, confidence: "high" })).toBe(false);
    expect(syncPass({ best_lag_ms: -200, confidence: "high" })).toBe(false);
    expect(syncPass({ best_lag_ms: -300, confidence: "medium" })).toBeNull();
  });

  it("finds the original's letters in a generated clip, not the place they share", () => {
    // A textured place (the same in the original, the clean still and the clip) and white letters over it.
    const [w, h] = [60, 30];
    const place = new Uint8Array(w * h * 3).map((_, i) => 60 + ((i * 37) % 50));
    const lettered = (px: Uint8Array) => {
      const out = new Uint8Array(px);
      for (let y = 8; y < 22; y++)
        for (const x0 of [10, 25, 40])
          for (let x = x0; x < x0 + 4; x++) out.set([255, 255, 255], (y * w + x) * 3);
      return out;
    };
    const original = lettered(place);
    expect(carriedFrame(original, lettered(place), place, w, h, undefined)).toBeGreaterThan(0.9);
    expect(carriedFrame(original, place, place, w, h, undefined)).toBeLessThan(0.1);
  });
});

describe("frame picks", () => {
  it("keeps a range's frames end-exclusive and renumbers them on the original's clock", () => {
    expect(pickedFrames({ kind: "range", k0: 3, k1: 6 }, 90)).toEqual([3, 4, 5]);
    expect(selectFilter({ kind: "range", k0: 3, k1: 6 }, "30000/1001")).toEqual([
      "select=between(n\\,3\\,5)",
      "setpts=N/(30000/1001)/TB",
    ]);
    expect(selectFilter({ kind: "at", ks: [2, 9] }, "30")[0]).toBe("select=eq(n\\,2)+eq(n\\,9)");
    expect(selectFilter({ kind: "all" }, "30")).toEqual([]);
  });
});

describe.skipIf(noTools)("diffVideos", () => {
  const ref = noTools ? "" : clip("ref.mp4", ["-f", "lavfi", "-i", "testsrc2=d=3:r=30:s=320x180"]);

  it("passes a video against itself", async () => {
    const r = await diffVideos({ reference: ref, yours: ref, outDir: join(dir, "same") });
    expect(r.pass).toBe(true);
    expect(r.ssim.frames).toBe(90);
    expect(r.ssim.mean).toBeGreaterThan(0.999);
    expect(r.worst).toEqual([]);
  });

  it("finds a wrong element by its cell when the whole frame still scores high", async () => {
    // An 80x60 box over a 320x180 frame for one second: about 0.94 whole-frame SSIM.
    const yours = clip("box.mp4", [
      ...["-i", ref, "-vf"],
      "drawbox=x=40:y=40:w=80:h=60:color=red:t=fill:enable='between(t,1,2)'",
    ]);
    const r = await diffVideos({ reference: ref, yours, outDir: join(dir, "box") });
    expect(r.ssim.mean).toBeGreaterThan(0.92);
    expect(r.ssim.cell_p05).toBeLessThan(0.8);
    expect(r.pass).toBe(false);
    const [first] = r.worst;
    expect(first!.t).toBeGreaterThanOrEqual(1);
    expect(first!.t).toBeLessThanOrEqual(2);
    const [x, y, w, h] = first!.cell.roi;
    expect(x < 120 && x + w > 40 && y < 100 && y + h > 40).toBe(true);
    expect(existsSync(r.sheet!)).toBe(true);
  });

  it("draws the worst cell of a tall frame scaled for the sheet", async () => {
    // 1080x1920 scales to 960x1706 for the sheet; the bottom row's box rounds a pixel past the edge.
    const tall = clip("tall.mp4", ["-f", "lavfi", "-i", "testsrc2=d=1:r=30:s=1080x1920"]);
    const yours = clip("tall-box.mp4", [
      ...["-i", tall, "-vf"],
      "drawbox=x=0:y=1500:w=1080:h=420:color=red:t=fill",
    ]);
    const r = await diffVideos({ reference: tall, yours, outDir: join(dir, "tall") });
    expect(r.worst.length).toBeGreaterThan(0);
    expect(r.worst[0]!.cell.roi[1]).toBe(1440);
  });

  it("fails a scene left empty on a plain background", async () => {
    // A small dark label on white, gone from yours after 1.5 s: still about 0.97 whole-frame SSIM.
    const label = "drawbox=x=40:y=20:w=36:h=12:color=0x303030:t=fill";
    const page = clip("page.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=320x180:r=30:d=3",
      "-vf",
      label,
    ]);
    const yours = clip("emptied.mp4", [
      ...["-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=3", "-vf"],
      `${label}:enable='lt(t,1.5)'`,
    ]);
    const r = await diffVideos({ reference: page, yours, outDir: join(dir, "emptied") });
    expect(r.missing_content.pass).toBe(false);
    expect(r.missing_content.share).toBeGreaterThan(0.45);
    expect(r.missing_content.spans[0]![0]).toBeCloseTo(1.5, 1);
    expect(r.pass).toBe(false);
    const same = await diffVideos({ reference: page, yours: page, outDir: join(dir, "page") });
    expect(same.missing_content).toMatchObject({ share: 0, pass: true });
    // A regenerated segment's picture is its own: what it leaves out is not missing.
    const regen = await diffVideos({
      reference: page,
      yours,
      segments: parseSegments("## S01 · 0–3 s · AI shot\nPixels: regenerated\n"),
      outDir: join(dir, "emptied-regen"),
    });
    expect(regen.missing_content).toMatchObject({ share: 0, pass: true });
  });

  it("reports missing texture apart from missing shapes, without failing it", async () => {
    // A fine 4 px checker in the bottom-left cell: flat at an eighth of the width, so texture, not structure.
    const checker =
      "if(lt(X\\,80)*gte(Y\\,135)\\,if(mod(floor(X/4)+floor(Y/4)\\,2)\\,60\\,200)\\,235)";
    const grain = clip("grain.mp4", [
      ...["-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=2", "-vf"],
      `format=gray,geq=lum='${checker}',format=yuv420p`,
    ]);
    const plain = clip("plain.mp4", [
      ...["-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=2", "-vf"],
      "format=gray,geq=lum=235,format=yuv420p",
    ]);
    const r = await diffVideos({ reference: grain, yours: plain, outDir: join(dir, "grain") });
    expect(r.missing_content).toMatchObject({ share: 0, pass: true });
    expect(r.missing_content.texture.share).toBeGreaterThan(0.9);
    expect(r.warnings.some((w) => w.includes("reported, not failed"))).toBe(true);
  });

  it("scores only a range, on the original's frame numbers", async () => {
    const yours = clip("late.mp4", [
      ...["-i", ref, "-vf"],
      "drawbox=x=0:y=0:w=320:h=180:color=black:t=fill:enable='gte(t,2)'",
    ]);
    const r = await diffVideos({
      reference: ref,
      yours,
      range: [0.5, 1.5],
      outDir: join(dir, "range"),
    });
    expect(r.ssim.frames).toBe(30);
    expect(r.window).toEqual([0.5, 1.5]);
    expect(r.pass).toBe(true);
  });

  it("reports a cut a few frames late as missing and extra", async () => {
    const two = (name: string, at: number) =>
      clip(name, [
        ...["-f", "lavfi", "-i", `color=c=0x2050c0:s=320x180:r=30:d=${at}`],
        ...["-f", "lavfi", "-i", `color=c=0xe0c040:s=320x180:r=30:d=${3 - at}`],
        ...["-filter_complex", "[0][1]concat=n=2:v=1[v]", "-map", "[v]"],
      ]);
    const r = await diffVideos({
      reference: two("cut-ref.mp4", 1),
      yours: two("cut-late.mp4", 1.1),
      outDir: join(dir, "cuts"),
    });
    expect(r.cuts?.reference).toEqual([1]);
    expect(r.cuts?.missing).toEqual([1]);
    expect(r.cuts?.extra).toEqual([1.1]);
    expect(r.pass).toBe(false);
  });

  it("matches a soft cut in the original with a hard one in yours", async () => {
    // Grey 0x80 to 0x8b changes the signature by 10 levels: a soft cut. Yours jumps further on the same frame.
    const step = (name: string, to: string, at: number) =>
      clip(name, [
        ...["-f", "lavfi", "-i", `color=c=0x808080:s=320x180:r=30:d=${at}`],
        ...["-f", "lavfi", "-i", `color=c=${to}:s=320x180:r=30:d=${3 - at}`],
        ...["-filter_complex", "[0][1]concat=n=2:v=1[v]", "-map", "[v]"],
      ]);
    const soft = step("soft-ref.mp4", "0x8b8b8b", 1);
    const r = await diffVideos({
      reference: soft,
      yours: step("soft-hard.mp4", "0xa0a0a0", 1),
      outDir: join(dir, "soft"),
    });
    expect(r.cuts).toMatchObject({ reference: [1], missing: [], extra: [], pass: true });
    const late = await diffVideos({
      reference: soft,
      yours: step("soft-late.mp4", "0xa0a0a0", 1.2),
      outDir: join(dir, "soft-late"),
    });
    expect(late.cuts).toMatchObject({ missing: [1], extra: [1.2], pass: false });
  });

  it("judges a rebuilt segment's regenerated region by motion and look, the rest by SSIM", async () => {
    // The bottom half mirrored, as a re-shot presenter differs in pixels but moves the same.
    const mixed = clip("mixed.mp4", [
      ...["-i", ref, "-filter_complex"],
      "[0]split[a][b];[b]crop=320:90:0:90,hflip[f];[a][f]overlay=0:90",
    ]);
    const md = "## S01 · 0–3 s · Board over a presenter\nPixels: rebuilt\n";
    const plain = await diffVideos({
      reference: ref,
      yours: mixed,
      segments: parseSegments(md),
      outDir: join(dir, "mixed-plain"),
    });
    expect(plain.segments?.[0]?.pass).toBe(false);
    const r = await diffVideos({
      reference: ref,
      yours: mixed,
      segments: parseSegments(`${md}Regenerated: 0, 0.5, 1, 0.5\n`),
      outDir: join(dir, "mixed"),
    });
    const [s] = r.segments!;
    expect(s!.ssim!.mean).toBeGreaterThan(0.99);
    expect(s!.regenerated?.roi).toEqual([0, 90, 320, 90]);
    expect(s!.person?.energy?.mean_ratio).toBeCloseTo(1, 1);
    expect(s!.pass).toBe(true);
    // A wrong box outside the region still fails the segment.
    const boxed = clip("mixed-box.mp4", [
      ...["-i", mixed, "-vf"],
      "drawbox=x=20:y=10:w=60:h=40:color=red:t=fill",
    ]);
    const bad = await diffVideos({
      reference: ref,
      yours: boxed,
      segments: parseSegments(`${md}Regenerated: 0, 0.5, 1, 0.5\n`),
      outDir: join(dir, "mixed-box"),
    });
    expect(bad.segments?.[0]?.pass).toBe(false);
  });

  it("judges each drawn element inside a regenerated region by itself, not by what is behind it", async () => {
    // A label (three white strokes) over a soft bottom half, a regenerated person (here 5 frames late); yours
    // draws it 24 px off.
    const strokes = (x0: number) =>
      [0, 14, 28].map((x) => `drawbox=x=${x0 + x}:y=110:w=6:h=24:color=white:t=fill`).join(",");
    const label = strokes(120);
    const soft = (delay: number) =>
      `[0]split[a][b];[b]crop=320:90:0:90,gblur=sigma=10,hue=s=0.4,tpad=start=${delay}:start_mode=clone[f];[a][f]overlay=0:90:shortest=1`;
    const base = clip("label-ref.mp4", [...["-i", ref, "-filter_complex"], `${soft(0)},${label}`]);
    const right = clip("label-right.mp4", [
      ...["-i", ref, "-filter_complex"],
      `${soft(5)},${label}`,
    ]);
    const off = clip("label-off.mp4", [
      ...["-i", ref, "-filter_complex"],
      `${soft(5)},${strokes(144)}`,
    ]);
    const md =
      "## S01 · 0–3 s · Label over a presenter\nPixels: rebuilt\nRegenerated: 0, 90, 320, 90\n";
    const judge = (yours: string, text: string, name: string) =>
      diffVideos({
        reference: base,
        yours,
        segments: parseSegments(text),
        outDir: join(dir, name),
      });
    // Without a Drawn line the label hides in the person's box.
    expect((await judge(off, md, "drawn-hidden")).segments?.[0]?.pass).toBe(true);
    const drawn = `${md}Drawn: 118, 108, 42, 28\n`;
    const good = (await judge(right, drawn, "drawn-right")).segments![0]!;
    expect(good.pass).toBe(true);
    expect(good.drawn?.[0]).toMatchObject({ id: "S01.D1", box: [118, 108, 42, 28], pass: true });
    expect(good.scored).toContain("1 drawn elements, each scored by itself");
    const bad = await judge(off, drawn, "drawn-off");
    expect(bad.segments?.[0]?.pass).toBe(false);
    expect(bad.segments?.[0]?.drawn?.[0]?.pass).toBe(false);
    // A box over the whole frame is flagged.
    const whole = await judge(right, md.replace("0, 90, 320, 90", "0, 0, 320, 180"), "drawn-whole");
    expect(whole.warnings.some((w) => w.includes("covers the whole frame"))).toBe(true);
  });

  it("scores a drawn element by itself without segments, and its ink says when yours is thinner", async () => {
    // The same three-stroke label over two different flat backdrops; yours draws it at half the stroke width.
    const strokes = (w: number) =>
      [0, 14, 28].map((x) => `drawbox=x=${120 + x}:y=110:w=${w}:h=24:color=white:t=fill`).join(",");
    const backdrop = (colour: string) => [
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=320x180:d=3:r=30`,
    ];
    const base = clip("solo-ref.mp4", [...backdrop("0x305070"), "-vf", strokes(6)]);
    const right = clip("solo-right.mp4", [...backdrop("0x604030"), "-vf", strokes(6)]);
    const thin = clip("solo-thin.mp4", [...backdrop("0x604030"), "-vf", strokes(3)]);
    const box: [number, number, number, number] = [116, 106, 44, 32];
    const good = await diffVideos({
      reference: base,
      yours: right,
      at: [0.5, 1, 1.5, 2],
      drawn: [{ box }, { box, window: [1, 3] }],
      outDir: join(dir, "solo-right"),
    });
    expect(good.segments).toBeUndefined();
    expect(good.drawn).toHaveLength(2);
    expect(good.drawn?.[0]).toMatchObject({ id: "D1", box, window: [0, 3], frames: 4, pass: true });
    expect(good.drawn?.[1]).toMatchObject({ id: "D2", window: [1, 3], frames: 3, pass: true });
    const bad = await diffVideos({
      reference: base,
      yours: thin,
      at: [0.5, 1, 1.5, 2],
      drawn: [{ box }],
      outDir: join(dir, "solo-thin"),
    });
    expect(good.drawn?.[0]).toMatchObject({ score: 1, offset: [0, 0], ink: 1 });
    // Half-weight letters in the right place: the score barely drops, the ink says it.
    expect(bad.drawn?.[0]?.score).toBeLessThan(0.9);
    expect(bad.drawn?.[0]?.ink).toBe(0.5);
  });

  it("fails the original's whole frame played where copy is meant to be rebuilt", async () => {
    const ledger = join(dir, "manifest.jsonl");
    writeFileSync(
      ledger,
      JSON.stringify({
        type: "video",
        path: "assets/all.mp4",
        provenance: { provider: "original", window: [0, 3], roi: [0, 0, 320, 180] },
      }) + "\n",
    );
    const titled = '## S01 · 0–3 s · Title\nPixels: rebuilt\nCopy: "TITLE"\n';
    const copy = await diffVideos({
      reference: ref,
      yours: ref,
      segments: parseSegments(titled),
      ledger,
      outDir: join(dir, "copy"),
    });
    expect(copy.whole_frame_reuse).toMatchObject({ spans: [[0, 3]], drawn: [[0, 3]], pass: false });
    expect(copy.segments?.[0]?.pass).toBe(false);
    expect(copy.pass).toBe(false);
    // Footage reused with its burned-in title is a copy too (Miao, 2026-10-23: no whole-frame cut with drawn things).
    const burned = await diffVideos({
      reference: ref,
      yours: ref,
      segments: parseSegments(
        '## S01 · 0–3 s · Title over footage\nPixels: reused\nCopy: "TITLE"\n',
      ),
      ledger,
      outDir: join(dir, "burned"),
    });
    expect(burned.whole_frame_reuse).toMatchObject({ share: 1, drawn: [[0, 3]], pass: false });
    // Footage with nothing drawn on it may be cut whole.
    const footage = await diffVideos({
      reference: ref,
      yours: ref,
      segments: parseSegments("## S01 · 0–3 s · Footage\nPixels: reused\n"),
      ledger,
      outDir: join(dir, "footage"),
    });
    expect(footage.whole_frame_reuse).toMatchObject({ share: 1, drawn: [], pass: true });
    expect(footage.pass).toBe(true);
    // A cut that only fed a generation (a motion guide) is not played: yours differs from it.
    const flipped = clip("guided.mp4", [...["-i", ref, "-vf"], "hflip"]);
    const guided = await diffVideos({
      reference: ref,
      yours: flipped,
      segments: parseSegments(titled),
      ledger,
      outDir: join(dir, "guided"),
    });
    expect(guided.whole_frame_reuse).toMatchObject({ spans: [], pass: true });
    // A generated shot that starts from the original's first frame matches it for a few frames only: not reuse.
    const started = clip("started.mp4", [
      ...["-i", ref, "-filter_complex"],
      "[0]split[a][b];[b]hflip[f];[a][f]overlay=enable='gte(t\\,0.2)'",
    ]);
    const start = await diffVideos({
      reference: ref,
      yours: started,
      segments: parseSegments(titled),
      ledger,
      outDir: join(dir, "started"),
    });
    expect(start.whole_frame_reuse).toMatchObject({ spans: [], pass: true });
  });

  it("finds a whole-frame still of the original shown in yours", async () => {
    const ledger = join(dir, "stills.jsonl");
    writeFileSync(
      ledger,
      [
        { type: "image", provenance: { provider: "original", at: 1, roi: [0, 0, 320, 180] } },
        { type: "image", provenance: { provider: "original", at: 2.5 } },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    // Yours holds the original's frame at 1 s for the whole clip.
    const held = clip("held.mp4", [
      ...["-i", ref, "-vf"],
      "select=eq(n\\,30),loop=loop=89:size=1,setpts=N/30/TB",
    ]);
    const r = await diffVideos({
      reference: ref,
      yours: held,
      segments: parseSegments('## S01 · 0–3 s · Collage\nPixels: rebuilt\nCopy: "TITLE"\n'),
      ledger,
      outDir: join(dir, "held"),
    });
    expect(r.whole_frame_reuse).toMatchObject({ stills: [1], spans: [[0, 3]], pass: false });
  });

  it("reads sound that starts late as late, and the picture's length as the duration", async () => {
    // Clicks at uneven times, with the sound running 0.4 s past the picture.
    const clicks = "aevalsrc=sin(2*PI*660*t)*lt(mod(t*t*3\\,1)\\,0.08):s=48000:d=3.4";
    const voiced = (name: string, delay: number) =>
      clip(name, [
        ...["-f", "lavfi", "-i", "testsrc2=d=3:r=30:s=320x180"],
        ...["-itsoffset", String(delay), "-f", "lavfi", "-i", clicks],
        ...["-map", "0:v", "-map", "1:a", "-c:a", "aac"],
      ]);
    const on = voiced("voiced.mp4", 0);
    const same = await diffVideos({ reference: on, yours: on, outDir: join(dir, "voiced") });
    expect(same.duration).toMatchObject({ reference: 3, pass: true });
    expect(same.sound).toMatchObject({ offset_ms: 0, pass: true });
    const late = await diffVideos({
      reference: on,
      yours: voiced("late.mp4", 0.2),
      outDir: join(dir, "late"),
    });
    expect(late.sound).toMatchObject({ offset_ms: 200, pass: false });
  });

  it("places the sound by its decoded timestamps, not the start time the probe reports", () => {
    // ffmpeg 5.1 drops an HE-AAC edit list's skip twice: the first sample it keeps is timestamped 0.1 s in while
    // the probe still says the track starts at 0. Here a sound timestamped 0.25 s in, probed as starting at 0,
    // against the same sound with 0.25 s of silence baked into its samples: in sync.
    const clicks = "aevalsrc=sin(2*PI*660*t)*lt(mod(t*t*3\\,1)\\,0.08):s=48000:d=3";
    const picture = ["-f", "lavfi", "-i", "testsrc2=d=3:r=30:s=320x180"];
    const stamped = clip("stamped.mp4", [
      ...picture,
      ...["-itsoffset", "0.25", "-f", "lavfi", "-i", clicks],
      ...["-map", "0:v", "-map", "1:a", "-c:a", "pcm_s16le", "-f", "mov"],
    ]);
    const baked = clip("baked.mp4", [
      ...picture,
      ...["-f", "lavfi", "-i", clicks, "-af", "adelay=250:all=1"],
      ...["-map", "0:v", "-map", "1:a", "-c:a", "pcm_s16le", "-f", "mov"],
    ]);
    const probedAtZero = { ...probeVideo(stamped), audioStart: 0 };
    expect(soundOffset(stamped, baked, probedAtZero, probeVideo(baked))).toMatchObject({
      offset_ms: 0,
      pass: true,
    });
  });

  it("passes a re-shot person whose motion is off when the components are right", async () => {
    // The bottom half (the person) frozen on its first frame: no motion at all. Pixels above match.
    const frozen = clip("frozen.mp4", [
      ...["-i", ref, "-filter_complex"],
      "[0]split[a][b];[b]crop=320:90:0:90,trim=end_frame=1,tpad=stop=89:stop_mode=clone[f];[a][f]overlay=0:90",
    ]);
    const r = await diffVideos({
      reference: ref,
      yours: frozen,
      segments: parseSegments(
        "## S01 · 0–3 s · Board over a presenter\nPixels: rebuilt\nRegenerated: 0, 0.5, 1, 0.5\n",
      ),
      outDir: join(dir, "frozen"),
    });
    const [s] = r.segments!;
    expect(s!.person?.energy?.mean_ratio).toBeLessThan(0.5);
    expect(s!.person?.gates).toEqual({ framing: null, text: null, sync: null });
    expect(s!.pass).toBe(true);
    expect(r.components).toMatchObject({ passed: 1, total: 1 });
    expect(r.person?.energy).toBeLessThan(0.5);
    expect(r.pass).toBe(true);
  });

  it("fails a re-shot person whose generated clip carries the original's text", async () => {
    // The original: a white label over a soft lower half (the person). Yours draws the label over a re-shot half.
    const strokes = (x0: number) =>
      [0, 14, 28].map((x) => `drawbox=x=${x0 + x}:y=110:w=6:h=24:color=white:t=fill`).join(",");
    const label = strokes(120);
    const soft = (delay: number) =>
      `[0]split[a][b];[b]crop=320:90:0:90,gblur=sigma=10,hue=s=0.4,tpad=start=${delay}:start_mode=clone[f];[a][f]overlay=0:90:shortest=1`;
    const base = clip("carried-ref.mp4", [
      ...["-i", ref, "-filter_complex"],
      `${soft(0)},${label}`,
    ]);
    const project = join(dir, "carried");
    mkdirSync(join(project, "assets"), { recursive: true });
    // The generated clips: one made from a guide with the label on it, one from a masked guide. Yours draws the
    // label over each; over the first, 8 px off, the letters show doubled.
    clip("carried/assets/dirty.mp4", [...["-i", ref, "-filter_complex"], `${soft(5)},${label}`]);
    clip("carried/assets/clean.mp4", [...["-i", ref, "-filter_complex"], soft(5)]);
    execFileSync(ffmpeg!, [
      ...["-hide_banner", "-loglevel", "error", "-y", "-i", ref, "-filter_complex"],
      `${soft(0)},trim=end_frame=1`,
      ...["-frames:v", "1", join(project, "assets", "still.png")],
    ]);
    const ledger = (path: string) => {
      const file = join(project, `${path}.jsonl`);
      writeFileSync(
        file,
        JSON.stringify({
          type: "video",
          path: `assets/${path}.mp4`,
          provenance: { provider: "heygen", references: ["assets/still.png"], window: [0, 3] },
        }) + "\n",
      );
      return file;
    };
    const md =
      "## S01 · 0–3 s · Label over a presenter\nPixels: rebuilt\nRegenerated: 0, 90, 320, 90\nDrawn: 118, 108, 42, 28\n";
    const judge = (path: string, x0: number) =>
      diffVideos({
        reference: base,
        yours: clip(`carried-yours-${path}.mp4`, [
          ...["-i", join(project, "assets", `${path}.mp4`), "-vf"],
          strokes(x0),
        ]),
        segments: parseSegments(md),
        ledger: ledger(path),
        project,
        outDir: join(dir, `carried-${path}`),
      });
    const dirty = await judge("dirty", 128);
    expect(dirty.segments?.[0]?.person?.text?.[0]).toMatchObject({
      drawn: "S01.D1",
      carried: true,
    });
    expect(dirty.segments?.[0]?.pass).toBe(false);
    expect(dirty.person).toMatchObject({ gates: { text: false }, failed: { text: ["S01"] } });
    expect(dirty.pass).toBe(false);
    const clean = await judge("clean", 120);
    expect(clean.segments?.[0]?.drawn?.[0]?.pass).toBe(true);
    expect(clean.segments?.[0]?.person?.gates.text).toBe(true);
    expect(clean.segments?.[0]?.pass).toBe(true);
    expect(clean.person?.shots_at_cuts).toMatchObject({
      at_cuts: 1,
      total: 1,
      cuts_without_shot: [],
    });
  });

  it("judges a regenerated segment by motion and look, not pixels", async () => {
    const shifted = clip("shifted.mp4", [...["-i", ref, "-vf"], "hflip"]);
    const segments = parseSegments("## S01 · 0–3 s · AI shot\nPixels: regenerated\n");
    const r = await diffVideos({
      reference: ref,
      yours: shifted,
      segments,
      outDir: join(dir, "regen"),
    });
    expect(r.ssim.mean).toBeLessThan(0.9);
    expect(r.segments?.[0]?.energy?.mean_ratio).toBeCloseTo(1, 1);
    expect(r.segments?.[0]?.pass).toBe(true);
  });
});
