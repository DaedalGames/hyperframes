import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPublishFileMap } from "../utils/publishProject.js";
import {
  OFFLOAD_MIN_BYTES,
  offloadHeavyMedia,
  type Reencoder,
  type UploadableFile,
} from "./offload.js";

const HEAVY = Buffer.alloc(OFFLOAD_MIN_BYTES, 1);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-offload-test-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-offload-cache-"));
  dirs.push(dir);
  return join(dir, "cloud-assets.json");
}

function fakeUpload() {
  let n = 0;
  return vi.fn(async (file: UploadableFile) => {
    n += 1;
    return { asset_id: `asset_${n}`, url: `https://assets.example/${n}/${file.filename}` };
  });
}

// HEAD answers like the asset CDN: the stored size, or 404 once the asset is gone.
function fakeHead(status: number, size: number): typeof fetch {
  return vi.fn(
    async () => new Response(null, { status, headers: { "content-length": String(size) } }),
  ) as unknown as typeof fetch;
}

const html = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("offloadHeavyMedia", () => {
  it("rewrites every reference in the staged copy and drops the file from the zip", async () => {
    const indexHtml = html(
      `<style>.bg { background: url("media/bg.png"); }</style>` +
        `<video src="media/clip.mp4" poster="media/bg.png"><source src="./media/clip.mp4" /></video>` +
        `<img srcset="media/bg.png 1x, media/small.png 2x" />` +
        `<div style="background-image: url(media/bg.png)"></div>` +
        `<audio src="/media/voice.mp3"></audio>` +
        `<div data-composition-src="compositions/scene.html"></div>`,
    );
    const dir = project({
      "index.html": indexHtml,
      // Sub-compositions are inlined into the root, so a root-relative src resolves from the project root.
      "compositions/scene.html": html(
        `<video src="media/clip.mp4"></video><img src="../media/bg.png" />`,
      ),
      "styles/main.css": `.x { background: url('../media/bg.png'); }`,
      "media/clip.mp4": HEAVY,
      "media/bg.png": HEAVY,
      "media/voice.mp3": HEAVY,
      "media/small.png": "tiny",
    });
    const fileMap = buildPublishFileMap(dir);
    const upload = fakeUpload();

    const report = await offloadHeavyMedia(dir, fileMap, {
      apiBaseUrl: "https://api.example",
      upload,
      cachePath: cachePath(),
    });

    const url = (path: string) => report.find((item) => item.path === path)!.url!;
    expect(report.map((item) => [item.path, item.action])).toEqual([
      ["media/bg.png", "upload"],
      ["media/clip.mp4", "upload"],
      ["media/voice.mp3", "upload"],
    ]);
    const index = fileMap.get("index.html")!.toString();
    expect(index).toContain(`url("${url("media/bg.png")}")`);
    expect(index).toContain(`src="${url("media/clip.mp4")}" poster="${url("media/bg.png")}"`);
    expect(index).toContain(`<source src="${url("media/clip.mp4")}"`);
    expect(index).toContain(`srcset="${url("media/bg.png")} 1x, media/small.png 2x"`);
    expect(index).toContain(`url(${url("media/bg.png")})`);
    expect(index).toContain(`<audio src="${url("media/voice.mp3")}"`);
    const scene = fileMap.get("compositions/scene.html")!.toString();
    expect(scene).toContain(`<video src="${url("media/clip.mp4")}"`);
    expect(scene).toContain(`<img src="${url("media/bg.png")}"`);
    expect(fileMap.get("styles/main.css")!.toString()).toContain(`url('${url("media/bg.png")}')`);
    expect([...fileMap.keys()].sort()).toEqual([
      "compositions/scene.html",
      "index.html",
      "media/small.png",
      "styles/main.css",
    ]);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(indexHtml);
  });

  it("reuses a cached asset that is still served, without uploading again", async () => {
    const dir = project({
      "index.html": html(`<video src="clip.mp4"></video>`),
      "clip.mp4": HEAVY,
    });
    const cache = cachePath();
    const upload = fakeUpload();
    const opts = { apiBaseUrl: "https://api.example", upload, cachePath: cache };

    await offloadHeavyMedia(dir, buildPublishFileMap(dir), opts);
    const second = buildPublishFileMap(dir);
    const report = await offloadHeavyMedia(dir, second, {
      ...opts,
      fetchImpl: fakeHead(200, HEAVY.byteLength),
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(report).toEqual([
      expect.objectContaining({
        path: "clip.mp4",
        action: "cached",
        url: "https://assets.example/1/clip.mp4",
      }),
    ]);
    expect(second.get("index.html")!.toString()).toContain("https://assets.example/1/clip.mp4");
  });

  it("uploads again when the cached asset URL no longer serves the file", async () => {
    const dir = project({
      "index.html": html(`<video src="clip.mp4"></video>`),
      "clip.mp4": HEAVY,
    });
    const opts = {
      apiBaseUrl: "https://api.example",
      upload: fakeUpload(),
      cachePath: cachePath(),
    };

    await offloadHeavyMedia(dir, buildPublishFileMap(dir), opts);
    const report = await offloadHeavyMedia(dir, buildPublishFileMap(dir), {
      ...opts,
      fetchImpl: fakeHead(404, 0),
    });

    expect(opts.upload).toHaveBeenCalledTimes(2);
    expect(report[0]).toMatchObject({ action: "upload", url: "https://assets.example/2/clip.mp4" });
  });

  it("re-encodes media the asset API refuses and uploads the accepted format", async () => {
    const dir = project({
      "index.html": html(`<video src="take.mkv"></video>`),
      "take.mkv": HEAVY,
    });
    const reencoder: Reencoder = {
      choose: vi.fn(async () => "video" as const),
      run: vi.fn(async () => ({
        bytes: Buffer.from("h264"),
        filename: "take.mp4",
        contentType: "video/mp4",
      })),
    };
    const upload = fakeUpload();
    const fileMap = buildPublishFileMap(dir);

    const report = await offloadHeavyMedia(dir, fileMap, {
      apiBaseUrl: "https://api.example",
      upload,
      reencoder,
      cachePath: cachePath(),
    });

    expect(reencoder.run).toHaveBeenCalledWith(join(dir, "take.mkv"), "video");
    expect(upload.mock.calls[0]![0]).toMatchObject({
      filename: "take.mp4",
      contentType: "video/mp4",
    });
    expect(report[0]).toMatchObject({ path: "take.mkv", action: "reencode" });
    expect(fileMap.get("index.html")!.toString()).toContain("https://assets.example/1/take.mp4");
    expect(fileMap.has("take.mkv")).toBe(false);
  });

  it("fails naming the file when a re-encode is still over the asset cap", async () => {
    const dir = project({
      "index.html": html(`<video src="long.mkv"></video>`),
      "long.mkv": HEAVY,
    });
    const reencoder: Reencoder = {
      choose: async () => "video",
      run: async () => ({
        bytes: { byteLength: 201 * 1024 * 1024 } as Uint8Array,
        filename: "long.mp4",
        contentType: "video/mp4",
      }),
    };
    const upload = fakeUpload();

    await expect(
      offloadHeavyMedia(dir, buildPublishFileMap(dir), {
        apiBaseUrl: "https://api.example",
        upload,
        reencoder,
        cachePath: cachePath(),
      }),
    ).rejects.toThrow(/^long\.mkv is 201(\.0)? MB after re-encoding/);
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps a zip copy of a file a script names, since only markup can be rewritten", async () => {
    const dir = project({
      "index.html": html(`<video src="clip.mp4"></video><script src="main.js"></script>`),
      "main.js": `new Audio("music.mp3").play();`,
      "clip.mp4": HEAVY,
      "music.mp3": HEAVY,
    });
    const fileMap = buildPublishFileMap(dir);

    const report = await offloadHeavyMedia(dir, fileMap, {
      apiBaseUrl: "https://api.example",
      upload: fakeUpload(),
      cachePath: cachePath(),
    });

    expect(report.find((item) => item.path === "music.mp3")).toMatchObject({
      kept_in_archive: true,
    });
    expect(fileMap.has("music.mp3")).toBe(true);
    expect(fileMap.has("clip.mp4")).toBe(false);
  });

  it("leaves small media and remote URLs alone", async () => {
    const dir = project({
      "index.html": html(`<img src="logo.png" /><video src="https://cdn.example/a.mp4"></video>`),
      "logo.png": "small",
    });
    const fileMap = buildPublishFileMap(dir);
    const upload = fakeUpload();

    const report = await offloadHeavyMedia(dir, fileMap, {
      apiBaseUrl: "https://api.example",
      upload,
      cachePath: cachePath(),
    });

    expect(report).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(fileMap.has("logo.png")).toBe(true);
  });
});
