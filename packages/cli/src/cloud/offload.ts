/**
 * Moves a cloud render's heavy media out of the project zip into HeyGen assets and points the
 * staged copy's references at the asset URLs. The project on disk is never touched.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { rewriteAssetPath } from "@hyperframes/parsers/asset-paths";
import {
  cleanAssetUrl,
  isRemoteOrInlineUrl,
  resolveLocalAssetCandidates,
} from "@hyperframes/parsers/asset-resolution";
import { findFFmpeg, findFFprobe, getFFmpegInstallHint } from "../browser/ffmpeg.js";
import { formatBytes } from "../ui/format.js";
import {
  type HtmlAttributeResolver,
  rewriteCssUrls,
  rewriteHtmlAttributes,
  rewriteStyleBlocks,
} from "../utils/publishProject.js";

const execFileAsync = promisify(execFile);

/** Media at or above this size leaves the zip as a HeyGen asset. */
export const OFFLOAD_MIN_BYTES = 5 * 1024 * 1024;

const MiB = 1024 * 1024;
const AUDIO_MAX_BYTES = 1_500_000_000;

// What POST /v3/assets/direct-uploads takes as-is, and its per-type cap.
const ACCEPTED: Record<string, { contentType: string; maxBytes: number }> = {
  ".mp4": { contentType: "video/mp4", maxBytes: 200 * MiB },
  ".m4v": { contentType: "video/mp4", maxBytes: 200 * MiB },
  ".mov": { contentType: "video/quicktime", maxBytes: 200 * MiB },
  ".webm": { contentType: "video/webm", maxBytes: 200 * MiB },
  ".png": { contentType: "image/png", maxBytes: 200 * MiB },
  ".jpg": { contentType: "image/jpeg", maxBytes: 200 * MiB },
  ".jpeg": { contentType: "image/jpeg", maxBytes: 200 * MiB },
  ".webp": { contentType: "image/webp", maxBytes: 200 * MiB },
  ".wav": { contentType: "audio/wav", maxBytes: AUDIO_MAX_BYTES },
  ".mp3": { contentType: "audio/mpeg", maxBytes: AUDIO_MAX_BYTES },
};

const VIDEO_EXTS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".mts",
  ".flv",
  ".wmv",
  ".ogv",
  ".3gp",
]);
const AUDIO_EXTS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".aif",
  ".aiff",
  ".wma",
]);

/** Visually lossless re-encodes for media the asset API refuses or caps. Quality lives here. */
const REENCODE_PRESETS = {
  video: {
    ext: ".mp4",
    contentType: "video/mp4",
    args: ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p"],
    audio: ["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"],
  },
  hdrVideo: {
    ext: ".mp4",
    contentType: "video/mp4",
    args: ["-c:v", "libx265", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p10le"],
    audio: ["-tag:v", "hvc1", "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"],
  },
  alphaVideo: {
    ext: ".webm",
    contentType: "video/webm",
    args: ["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-pix_fmt", "yuva420p"],
    audio: ["-c:a", "libopus", "-b:a", "256k"],
  },
  audio: {
    ext: ".wav",
    contentType: "audio/wav",
    args: ["-vn"],
    audio: ["-c:a", "pcm_s16le"],
  },
} as const;

export type PresetName = keyof typeof REENCODE_PRESETS;

export interface OffloadedMedia {
  path: string;
  size_bytes: number;
  /** What happened (or, on a dry run, would happen) to the file. */
  action: "upload" | "reencode" | "cached";
  url?: string;
  /** Still referenced from a script or data file, so a copy also stays in the zip. */
  kept_in_archive?: boolean;
}

export interface UploadableFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface OffloadOptions {
  /** Cache key namespace, so assets from one API host are never reused on another. */
  apiBaseUrl: string;
  /** Absent on a dry run: nothing is encoded, uploaded or fetched. */
  upload?: (file: UploadableFile) => Promise<{ asset_id: string; url: string }>;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  /** Overrides ffprobe/ffmpeg for tests. */
  reencoder?: Reencoder;
  onFile?: (item: OffloadedMedia) => void;
}

export interface Reencoder {
  choose: (sourcePath: string, kind: "video" | "audio") => Promise<PresetName>;
  run: (sourcePath: string, preset: PresetName) => Promise<UploadableFile>;
}

interface CacheEntry {
  asset_id: string;
  url: string;
  size_bytes: number;
}

function defaultOffloadCachePath(): string {
  return join(homedir(), ".cache", "hyperframes", "cloud-assets.json");
}

function readCache(path: string): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeCache(path: string, cache: Record<string, CacheEntry>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, path);
}

// Asset URLs are public and unsigned, so HEAD needs no auth; a deleted or replaced asset fails it.
async function stillServed(entry: CacheEntry, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(entry.url, { method: "HEAD" });
    return res.ok && Number(res.headers.get("content-length")) === entry.size_bytes;
  } catch {
    return false;
  }
}

function mediaKind(path: string): "video" | "audio" | "image" | null {
  const ext = extname(path).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ACCEPTED[ext]) return "image";
  return null;
}

interface VideoProbe {
  alpha: boolean;
  hdr: boolean;
  codec?: string;
  color: { primaries?: string; transfer?: string; space?: string };
}

async function probeVideo(path: string): Promise<VideoProbe> {
  const ffprobe = findFFprobe();
  if (!ffprobe)
    throw new Error(`Re-encoding needs ffprobe. Install ffmpeg: ${getFFmpegInstallHint()}`);
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt,color_primaries,color_transfer,color_space:stream_tags",
    "-of",
    "json",
    path,
  ]);
  const stream = (JSON.parse(stdout).streams?.[0] ?? {}) as Record<string, unknown>;
  const tags = (stream.tags ?? {}) as Record<string, string>;
  const alphaTag = Object.entries(tags).some(
    ([k, v]) => k.toLowerCase() === "alpha_mode" && v === "1",
  );
  const transfer = stream.color_transfer as string | undefined;
  return {
    // VP9 alpha keeps pix_fmt yuv420p and flags the plane only in the ALPHA_MODE tag.
    alpha: alphaTag || /^(yuva|rgba|argb|bgra|abgr|gbrap|ya)/.test(String(stream.pix_fmt ?? "")),
    hdr: transfer === "smpte2084" || transfer === "arib-std-b67",
    codec: stream.codec_name as string | undefined,
    color: {
      primaries: stream.color_primaries as string | undefined,
      transfer,
      space: stream.color_space as string | undefined,
    },
  };
}

// ffmpeg's native VP8/VP9 decoders drop the alpha plane; libvpx keeps it.
function alphaDecoderArgs(probe: VideoProbe): string[] {
  if (!probe.alpha) return [];
  if (probe.codec === "vp9") return ["-c:v", "libvpx-vp9"];
  if (probe.codec === "vp8") return ["-c:v", "libvpx"];
  return [];
}

function hdrColorArgs({ color }: VideoProbe): string[] {
  return [
    ...(color.primaries ? ["-color_primaries", color.primaries] : []),
    ...(color.transfer ? ["-color_trc", color.transfer] : []),
    ...(color.space ? ["-colorspace", color.space] : []),
  ];
}

async function ffmpegReencode(sourcePath: string, presetName: PresetName): Promise<UploadableFile> {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) throw new Error(`Re-encoding needs ffmpeg. Install it: ${getFFmpegInstallHint()}`);
  const preset = REENCODE_PRESETS[presetName];
  const probe = presetName === "audio" ? undefined : await probeVideo(sourcePath);
  const decoder = probe ? alphaDecoderArgs(probe) : [];
  const color = presetName === "hdrVideo" && probe ? hdrColorArgs(probe) : [];
  const workDir = mkdtempSync(join(tmpdir(), "hf-offload-"));
  const outPath = join(workDir, `${basename(sourcePath, extname(sourcePath))}${preset.ext}`);
  try {
    await execFileAsync(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        ...decoder,
        "-i",
        sourcePath,
        ...preset.args,
        ...color,
        ...preset.audio,
        outPath,
      ],
      { maxBuffer: 16 * MiB },
    );
    return {
      bytes: readFileSync(outPath),
      filename: basename(outPath),
      contentType: preset.contentType,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function choosePreset(sourcePath: string, kind: "video" | "audio"): Promise<PresetName> {
  if (kind === "audio") return "audio";
  const probe = await probeVideo(sourcePath);
  return probe.alpha ? "alphaVideo" : probe.hdr ? "hdrVideo" : "video";
}

const ffmpegReencoder: Reencoder = { choose: choosePreset, run: ffmpegReencode };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Where a staged file's bytes live on disk, writing a temp copy only for files outside the project. */
function sourcePathFor(absDir: string, path: string, bytes: Buffer, tempFiles: string[]): string {
  const onDisk = join(absDir, path);
  if (existsSync(onDisk)) return onDisk;
  const dir = mkdtempSync(join(tmpdir(), "hf-offload-src-"));
  tempFiles.push(dir);
  const copy = join(dir, basename(path));
  writeFileSync(copy, bytes);
  return copy;
}

interface OffloadContext {
  absDir: string;
  opts: OffloadOptions;
  cachePath: string;
  cache: Record<string, CacheEntry>;
  fetchImpl: typeof fetch;
  reencoder: Reencoder;
  tempFiles: string[];
}

interface FilePlan {
  key: string;
  preset?: PresetName;
  sourcePath: string;
  contentType?: string;
}

async function planFile(
  ctx: OffloadContext,
  path: string,
  bytes: Buffer,
): Promise<FilePlan | null> {
  const kind = mediaKind(path);
  if (!kind || bytes.byteLength < OFFLOAD_MIN_BYTES) return null;
  const keyFor = (variant: string) => `${ctx.opts.apiBaseUrl} ${sha256Hex(bytes)} ${variant}`;
  const accepted = ACCEPTED[extname(path).toLowerCase()];
  if (accepted && bytes.byteLength <= accepted.maxBytes) {
    return { key: keyFor("as-is"), sourcePath: "", contentType: accepted.contentType };
  }
  // Images the API refuses or caps stay in the zip; the archive size check names them.
  if (kind === "image") return null;
  const sourcePath = sourcePathFor(ctx.absDir, path, bytes, ctx.tempFiles);
  const preset = await ctx.reencoder.choose(sourcePath, kind);
  // Keyed by encode settings too, so changing a preset re-encodes instead of reusing old output.
  return { key: keyFor(JSON.stringify(REENCODE_PRESETS[preset])), preset, sourcePath };
}

async function offloadFile(
  ctx: OffloadContext,
  path: string,
  bytes: Buffer,
): Promise<OffloadedMedia | null> {
  const plan = await planFile(ctx, path, bytes);
  if (!plan) return null;
  const item: OffloadedMedia = {
    path,
    size_bytes: bytes.byteLength,
    action: plan.preset ? "reencode" : "upload",
  };
  const hit = ctx.cache[plan.key];
  if (hit && (!ctx.opts.upload || (await stillServed(hit, ctx.fetchImpl)))) {
    return { ...item, action: "cached", url: hit.url };
  }
  if (!ctx.opts.upload) return item;
  return { ...item, url: await uploadPlanned(ctx, ctx.opts.upload, path, bytes, plan) };
}

async function uploadPlanned(
  ctx: OffloadContext,
  upload: NonNullable<OffloadOptions["upload"]>,
  path: string,
  bytes: Buffer,
  plan: FilePlan,
): Promise<string> {
  const file = plan.preset
    ? await ctx.reencoder.run(plan.sourcePath, plan.preset)
    : { bytes, filename: basename(path), contentType: plan.contentType! };
  const maxBytes = ACCEPTED[extname(file.filename).toLowerCase()]?.maxBytes ?? 0;
  if (file.bytes.byteLength > maxBytes) {
    throw new Error(
      `${path} is ${formatBytes(file.bytes.byteLength)} after re-encoding at visually lossless quality, over the ${formatBytes(maxBytes)} a HeyGen asset can hold.`,
    );
  }
  const asset = await upload(file);
  ctx.cache[plan.key] = {
    asset_id: asset.asset_id,
    url: asset.url,
    size_bytes: file.bytes.byteLength,
  };
  writeCache(ctx.cachePath, ctx.cache);
  return asset.url;
}

/**
 * Upload each heavy media file as an asset (or reuse a cached one still served), point its references at the
 * asset URL and drop it from `fileMap`. Without `upload`, plans the same outcome with no encode or network.
 */
export async function offloadHeavyMedia(
  projectDir: string,
  fileMap: Map<string, Buffer>,
  opts: OffloadOptions,
): Promise<OffloadedMedia[]> {
  const cachePath = opts.cachePath ?? defaultOffloadCachePath();
  const ctx: OffloadContext = {
    absDir: resolve(projectDir),
    opts,
    cachePath,
    cache: readCache(cachePath),
    fetchImpl: opts.fetchImpl ?? fetch,
    reencoder: opts.reencoder ?? ffmpegReencoder,
    tempFiles: [],
  };
  const urls = new Map<string, string>();
  const report: OffloadedMedia[] = [];
  try {
    for (const [path, bytes] of [...fileMap].sort(([a], [b]) => a.localeCompare(b))) {
      const item = await offloadFile(ctx, path, bytes);
      if (!item) continue;
      // A dry run rewrites to a stand-in URL so the reported archive size matches the real one.
      urls.set(path, item.url ?? `https://assets.invalid/${report.length}`);
      report.push(item);
      opts.onFile?.(item);
    }
  } finally {
    for (const dir of ctx.tempFiles) rmSync(dir, { recursive: true, force: true });
  }

  if (urls.size === 0) return report;
  rewriteReferences(ctx.absDir, fileMap, urls);
  const assetUrls = [...urls.values()];
  for (const item of report) {
    if (isStillMentioned(fileMap, item.path, assetUrls)) item.kept_in_archive = true;
    else fileMap.delete(item.path);
  }
  return report;
}

const TEXT_EXTS = /\.(html?|css|m?js|cjs|json|svg|xml|txt)$/i;

// A file named only in script or data text has no reference we can rewrite, so it keeps a zip copy.
function isStillMentioned(
  fileMap: Map<string, Buffer>,
  path: string,
  assetUrls: string[],
): boolean {
  const name = basename(path);
  for (const [entryPath, content] of fileMap) {
    if (entryPath === path || !TEXT_EXTS.test(entryPath) || !content.includes(name)) continue;
    // Asset URLs end in names like original.mp4 that can collide with a project file's name.
    const text = assetUrls.reduce((acc, url) => acc.replaceAll(url, ""), content.toString("utf-8"));
    if (text.includes(name)) return true;
  }
  return false;
}

function rewriteReferences(
  absDir: string,
  fileMap: Map<string, Buffer>,
  urls: Map<string, string>,
): void {
  const urlFor = (rootRelative: string): string | null => {
    for (const candidate of resolveLocalAssetCandidates(absDir, rootRelative)) {
      const url = urls.get(relative(absDir, candidate).replaceAll("\\", "/"));
      if (url) return url;
    }
    return null;
  };

  for (const [entryPath, content] of [...fileMap]) {
    const isHtml = /\.html?$/i.test(entryPath);
    if (!isHtml && !entryPath.toLowerCase().endsWith(".css")) continue;
    const referrerAbsDir = resolve(absDir, dirname(entryPath));
    const resolveTarget: HtmlAttributeResolver = (raw) => {
      const clean = cleanAssetUrl(raw);
      if (!clean || isRemoteOrInlineUrl(clean)) return null;
      if (clean.startsWith("/")) return urlFor(clean);
      // HTML srcs resolve the way the renderer inlines sub-compositions; a stylesheet's url() is relative to it.
      return urlFor(
        isHtml
          ? rewriteAssetPath(entryPath, clean, (p) => fileMap.has(p))
          : posix.join(posix.dirname(entryPath), clean),
      );
    };

    if (!isHtml) {
      const result = rewriteCssUrls(
        content.toString("utf-8"),
        referrerAbsDir,
        entryPath,
        resolveTarget,
      );
      if (result.modified) fileMap.set(entryPath, Buffer.from(result.css, "utf-8"));
      continue;
    }
    const { document } = parseHTML(content.toString("utf-8"));
    const attrs = rewriteHtmlAttributes(document, referrerAbsDir, entryPath, resolveTarget, {
      attrs: ["src", "poster", "href"],
    });
    const srcsets = rewriteSrcsets(document, resolveTarget);
    const styles = rewriteStyleBlocks(document, referrerAbsDir, entryPath, resolveTarget);
    if (attrs || srcsets || styles) {
      fileMap.set(entryPath, Buffer.from(document.toString(), "utf-8"));
    }
  }
}

function rewriteSrcsets(document: Document, resolveTarget: HtmlAttributeResolver): boolean {
  let modified = false;
  for (const el of document.querySelectorAll("[srcset]")) {
    const srcset = el.getAttribute("srcset") ?? "";
    // A data: candidate carries its own commas; leave such a srcset as authored.
    if (srcset.includes("data:")) continue;
    let changed = false;
    const next = srcset
      .split(",")
      .map((part) => {
        const [url, ...descriptors] = part.trim().split(/\s+/);
        const target = url ? resolveTarget(url, "") : null;
        if (!target) return part.trim();
        changed = true;
        return [target, ...descriptors].join(" ");
      })
      .join(", ");
    if (changed) {
      el.setAttribute("srcset", next);
      modified = true;
    }
  }
  return modified;
}
