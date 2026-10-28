import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { findFFmpeg } from "../browser/ffmpeg.js";

vi.mock("../cloud/auth.js", () => ({
  resolveCloudAuthHeaders: async () => ({ "x-api-key": "k" }),
  resolveCloudBaseUrl: () => "https://api.test",
}));

const { generate, urlOf } = await import("./generate.js");
const { priceOf } = await import("./pricing.js");
const ffmpeg = findFFmpeg();
const project = mkdtempSync(join(tmpdir(), "hf-generate-test-"));
writeFileSync(join(project, "index.html"), "<html></html>");
afterAll(() => rmSync(project, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("generate", () => {
  it("finds the file URL wherever the route keeps it", () => {
    expect(
      urlOf({ id: "a", status: "completed", images: [{ url: "https://x/i.png" }] }, [
        "images.0.url",
      ]),
    ).toBe("https://x/i.png");
    expect(
      urlOf({ id: "a", status: "completed", video_url: "ftp://no" }, ["video_url"]),
    ).toBeNull();
  });

  it.skipIf(!ffmpeg)("edits a picture from a reference, downloads it and records it", async () => {
    const ref = join(project, "ref.png");
    execFileSync(ffmpeg!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x36",
      "-frames:v",
      "1",
      ref,
    ]);
    const sent: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === "https://files.test/plate.png") return new Response(new Uint8Array([1, 2, 3]));
      return json({
        data: {
          id: "img1",
          status: "completed",
          images: [{ url: "https://files.test/plate.png" }],
        },
      });
    });
    const r = await generate({
      type: "image",
      out: join(project, "assets/plate.png"),
      prompt: "empty room",
      references: [ref],
    });
    expect(sent[0]!.body).toMatchObject({
      model: "nano-banana-2",
      prompt: "empty room",
      reference_images: [{ type: "base64", media_type: "image/jpeg" }],
    });
    expect(readFileSync(r.out)).toEqual(Buffer.from([1, 2, 3]));
    const ledger = readFileSync(join(project, ".media/manifest.jsonl"), "utf8");
    expect(ledger).toContain('"source":"generated"');
    expect(ledger).toContain('"references":["ref.png"]');
  });

  it.skipIf(!ffmpeg)("re-shoots a person speaking a stretch of the original voice", async () => {
    const [face, voice] = [join(project, "face.png"), join(project, "voice.m4a")];
    execFileSync(ffmpeg!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=36x64",
      "-frames:v",
      "1",
      face,
    ]);
    execFileSync(ffmpeg!, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1", voice]);
    const guide = join(project, "guide.mp4");
    execFileSync(ffmpeg!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=d=1:s=180x320",
      guide,
    ]);
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      if (url === "https://files.test/s.mp4") return new Response(new Uint8Array([7]));
      return json({
        data: { id: "v2", status: "completed", video_url: "https://files.test/s.mp4" },
      });
    });
    await generate({
      type: "video",
      out: join(project, "assets/presenter.mp4"),
      prompt: "talks to camera",
      references: [face],
      audio: voice,
      motion: guide,
      seconds: 8,
      aspect: "9:16",
    });
    expect(sent[0]).toMatchObject({
      mode: "reference_to_video",
      duration: 8,
      aspect_ratio: "9:16",
      reference_images: [{ media_type: "image/jpeg" }],
      reference_audio: [{ media_type: "audio/mpeg" }],
      reference_videos: [{ media_type: "video/mp4" }],
    });
    expect(readFileSync(join(project, ".media/manifest.jsonl"), "utf8")).toContain(
      '"audio":"voice.m4a"',
    );
    await expect(
      generate({ type: "video", out: "x.mp4", prompt: "p", audio: voice, firstFrame: face }),
    ).rejects.toThrow(/--first-frame cannot be used/);
  });

  it("waits for a queued shot and downloads it", async () => {
    const answers = [
      json({ data: { video_id: "v1", status: "pending" } }),
      json({ data: { id: "v1", status: "processing" } }),
      json({ data: { id: "v1", status: "completed", video_url: "https://files.test/v1.mp4" } }),
      new Response(new Uint8Array([9])),
    ];
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return answers.shift()!;
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = generate({
      type: "video",
      out: join(project, "assets/shot.mp4"),
      prompt: "push in",
      seconds: 6,
    });
    await vi.runAllTimersAsync();
    const r = await pending;
    vi.useRealTimers();
    expect(urls.slice(0, 3)).toEqual([
      "https://api.test/v3/models/videos",
      "https://api.test/v3/models/videos/v1",
      "https://api.test/v3/models/videos/v1",
    ]);
    expect(existsSync(r.out)).toBe(true);
    expect(r.job).toBe("v1");
  });

  it("prices before making", () => {
    expect(priceOf({ type: "video", out: "a.mp4", seconds: 6 }).usd).toBe(0.12);
    expect(priceOf({ type: "music", out: "a.mp3" }).usd).toBe(0.09);
    expect(
      priceOf({
        type: "image",
        out: "a.png",
        model: "gpt-image-2.5",
        aspect: "1:1",
        references: ["a", "b"],
      }).usd,
    ).toBe(0.07);
    expect(priceOf({ type: "voice", out: "a.mp3" }).usd).toBeNull();
  });
});
