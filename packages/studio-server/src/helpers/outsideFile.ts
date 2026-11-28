import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { MIME_TYPES } from "./mime.js";
import {
  AUDIO_EXTS,
  CONVERTIBLE_IMAGE_EXTS,
  isControlByte,
  MEDIA_INPUT_ARGS,
  mediaInputArgs,
  startsAsMediaPlaylist,
  VIDEO_EXTS,
} from "./mediaExtensions.js";
import { realFilePath } from "./safePath.js";
import { realFilePathOff } from "./projectDisk.js";
import { isWithinProjectRoot } from "@hyperframes/parsers/asset-resolution";
import type { StudioApiAdapter } from "../types.js";

export {
  AUDIO_EXTS,
  CONVERTIBLE_IMAGE_EXTS,
  MEDIA_INPUT_ARGS,
  mediaInputArgs,
  startsAsMediaPlaylist,
  VIDEO_EXTS,
};

const COPIED_TYPE = /^(?:image|video|audio|font)\/|^text\/(?:css|javascript);/;

const extensionsOf = (type: RegExp) =>
  Object.entries(MIME_TYPES)
    .filter(([, mime]) => type.test(mime))
    .map(([extension]) => extension);

/** What a local render brings in from outside the project: the preview server's image, video, audio, font, CSS and
 * JS types, and the media cloud render re-encodes or converts. */
const OUTSIDE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...extensionsOf(COPIED_TYPE),
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
  ...CONVERTIBLE_IMAGE_EXTS,
]);

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(extensionsOf(/^text\/javascript;/));

/** What an upload copies from outside the project: the same types without scripts. */
export const UPLOADED_OUTSIDE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  [...OUTSIDE_FILE_EXTENSIONS].filter((extension) => !SCRIPT_EXTENSIONS.has(extension)),
);

const TYPESCRIPT_OR_TRANSPORT_STREAM = new Set([".ts", ".mts"]);
const TS_SYNC_BYTE = 0x47;

const TS_PACKETS = [
  { size: 188, offset: 0 },
  { size: 192, offset: 4 },
];

function readRegularFileHead(path: string, length: number): Buffer | null {
  let fd: number;
  try {
    // A FIFO would wait for a writer on a blocking open; fstat refuses it first.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const head = Buffer.alloc(length);
    return head.subarray(0, readSync(fd, head, 0, length, 0));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

async function readRegularFileHeadOff(path: string, length: number): Promise<Buffer | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) return null;
  try {
    if (!(await file.stat()).isFile()) return null;
    const head = Buffer.alloc(length);
    return head.subarray(0, (await file.read(head, 0, length, 0)).bytesRead);
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

const TS_HEAD_BYTES = 4 * 192;

function isTransportStreamHead(head: Buffer | null): boolean {
  if (!head?.some(isControlByte)) return false;
  return TS_PACKETS.some(({ size, offset }) => {
    const starts = [];
    for (let at = offset; at < head.length; at += size) starts.push(at);
    return starts.length >= 2 && starts.every((at) => head[at] === TS_SYNC_BYTE);
  });
}

const startsAsTransportStream = (path: string) =>
  isTransportStreamHead(readRegularFileHead(path, TS_HEAD_BYTES));

type TypeNames = "no" | "yes" | "sniff";

function typeNames(absPath: string, realPath: string, extensions: ReadonlySet<string>): TypeNames {
  const names = [absPath, realPath].map((path) => extname(path).toLowerCase());
  if (!names.every((extension) => extensions.has(extension))) return "no";
  return names.some((extension) => TYPESCRIPT_OR_TRANSPORT_STREAM.has(extension)) ? "sniff" : "yes";
}

const copiedOnce = (names: TypeNames, transportStream: boolean) =>
  names === "yes" || (names === "sniff" && transportStream);

function isCopiedType(absPath: string, extensions: ReadonlySet<string>): boolean {
  const names = typeNames(absPath, realFilePath(absPath), extensions);
  return copiedOnce(names, names === "sniff" && startsAsTransportStream(absPath));
}

export const isCopiedOutsideFileType = (absPath: string): boolean =>
  isCopiedType(absPath, OUTSIDE_FILE_EXTENSIONS);

export const isUploadedOutsideFileType = (absPath: string): boolean =>
  isCopiedType(absPath, UPLOADED_OUTSIDE_FILE_EXTENSIONS);

const ENV_FILE = /^\.env([._-].*|rc)?$/;

export function isEnvOrGitPath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/);
  return segments.includes(".git") || ENV_FILE.test(segments.at(-1) ?? "");
}

const SYSTEM_DIRS = ["/etc", "/proc", "/sys", "/dev", "/private/etc"];

const isOutside = (fromDir: string) =>
  fromDir === ".." || fromDir.startsWith(`..${sep}`) || isAbsolute(fromDir);

function inPrivateLocation(projectDir: string, path: string): boolean {
  const posixPath = path.replaceAll("\\", "/");
  if (SYSTEM_DIRS.some((dir) => posixPath === dir || posixPath.startsWith(`${dir}/`))) return true;
  const fromParent = relative(dirname(projectDir), path);
  return (
    (isOutside(fromParent) ? path : fromParent).split(/[\\/]/).some((s) => s.startsWith(".")) ||
    inHomeAppData(projectDir, path)
  );
}

function isUnder(path: string, ...dir: string[]): boolean {
  const lowerPath = path.toLowerCase();
  const lowerDir = join(homedir(), ...dir).toLowerCase();
  return lowerPath === lowerDir || lowerPath.startsWith(`${lowerDir}${sep}`);
}

const CLOUD_DRIVE_FOLDERS = ["Mobile Documents", "CloudStorage"];

function homeAppDataFolder(path: string): string | null {
  if (isUnder(path, "AppData")) return "AppData";
  const cloudDrive = CLOUD_DRIVE_FOLDERS.some((folder) => isUnder(path, "Library", folder));
  if (isUnder(path, "Library") && !cloudDrive) return "Library";
  return null;
}

function inHomeAppData(projectDir: string, path: string): boolean {
  const folder = homeAppDataFolder(path);
  const parent = dirname(projectDir);
  return (
    folder !== null && (homeAppDataFolder(parent) !== folder || isOutside(relative(parent, path)))
  );
}

/** An existing file outside the project that publish leaves out: env files, Git data, hidden, system and app-data folders. */
export const isPrivateOutsideFile = (projectDir: string, absPath: string): boolean =>
  privateOutside(projectDir, absPath, {
    realProjectDir: realFilePath(projectDir),
    realPath: realFilePath(absPath),
  });

interface RealPaths {
  realProjectDir: string;
  realPath: string;
}

function privateOutside(projectDir: string, absPath: string, real: RealPaths): boolean {
  return (
    isEnvOrGitPath(absPath) ||
    isEnvOrGitPath(real.realPath) ||
    inPrivateLocation(projectDir, absPath) ||
    inPrivateLocation(real.realProjectDir, real.realPath)
  );
}

export const linksOutside = (projectDir: string, filePath: string): boolean =>
  isOutside(relative(realFilePath(projectDir), realFilePath(filePath)));

export interface OutsideFilePolicy {
  includeScripts?: boolean;
}

interface OutsideLinkFacts {
  private: boolean;
  folder: boolean;
  uploaded: boolean;
  copied: boolean;
}

function refusalOf(facts: OutsideLinkFacts, policy: OutsideFilePolicy): LeftOutReason | null {
  if (facts.private) return "blocklisted";
  if (facts.folder || facts.uploaded) return null;
  if (!facts.copied) return "file_type";
  return policy.includeScripts ? null : "script";
}

const typesOf = (path: string, realPath: string) => ({
  uploaded: typeNames(path, realPath, UPLOADED_OUTSIDE_FILE_EXTENSIONS),
  copied: typeNames(path, realPath, OUTSIDE_FILE_EXTENSIONS),
});

const sniffs = (types: ReturnType<typeof typesOf>) =>
  types.uploaded === "sniff" || types.copied === "sniff";

export function outsideLinkRefusal(
  projectDir: string,
  path: string,
  policy: OutsideFilePolicy = {},
): LeftOutReason | null {
  const real = { realProjectDir: realFilePath(projectDir), realPath: realFilePath(path) };
  const types = typesOf(path, real.realPath);
  const transportStream = sniffs(types) && startsAsTransportStream(path);
  const facts = {
    private: privateOutside(projectDir, path, real),
    folder: statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
    uploaded: copiedOnce(types.uploaded, transportStream),
    copied: copiedOnce(types.copied, transportStream),
  };
  return refusalOf(facts, policy);
}

async function outsideLinkRefusalOff(projectDir: string, path: string, real: RealPaths) {
  const types = typesOf(path, real.realPath);
  const head = sniffs(types) ? await readRegularFileHeadOff(path, TS_HEAD_BYTES) : null;
  const transportStream = isTransportStreamHead(head);
  const facts = {
    private: privateOutside(projectDir, path, real),
    folder: (await stat(path).catch(() => null))?.isDirectory() === true,
    uploaded: copiedOnce(types.uploaded, transportStream),
    copied: copiedOnce(types.copied, transportStream),
  };
  return refusalOf(facts, {});
}

/** Real paths when a link under `projectDir` takes `path` outside it; null, reading no real path, when none does. */
async function linkedOutsideOff(projectDir: string, path: string): Promise<RealPaths | null> {
  let at = projectDir;
  for (const part of relative(projectDir, path).split(sep).filter(Boolean)) {
    at = join(at, part);
    const entry = await lstat(at).catch(() => null);
    if (!entry) return null;
    if (!entry.isSymbolicLink()) continue;
    const [realProjectDir, realPath] = await Promise.all([
      realFilePathOff(projectDir),
      realFilePathOff(path),
    ]);
    return isOutside(relative(realProjectDir, realPath)) ? { realProjectDir, realPath } : null;
  }
  return null;
}

/** `blocklisted`: a private location; `received`: reached from an imported file; `file_type`: not a type uploads copy; `network_share`: on another computer; `script`: a script a local render was not told to run; `not_approved`: the person has not approved uploading it. */
export type LeftOutReason =
  | "blocklisted"
  | "received"
  | "file_type"
  | "private"
  | "network_share"
  | "script"
  | "not_approved"
  | "unreadable";

const WHY: Record<Exclude<LeftOutReason, "file_type">, string> = {
  private: "which holds secrets or tool data",
  blocklisted: "which is outside the project in a private location",
  received: "which leads outside the project and came in with an imported project",
  network_share: "which is on another computer's network share or is a Windows device path",
  script: "which is a script outside the project",
  not_approved: "which is outside the project and was not approved for upload",
  unreadable: "which could not be read",
};

export const INCLUDE_OUTSIDE_FILES_HINT = "Pass --include-outside-files to upload it.";

const COPIED_TYPES = {
  upload: "an image, video, audio, font or CSS file",
  render: "an image, video, audio, font, CSS or JS file",
};

export function leftOutWarning(
  file: string,
  reference: string,
  reason: LeftOutReason,
  from: "upload" | "render" = "upload",
): string {
  const why =
    reason === "file_type"
      ? `which is outside the project and is not ${COPIED_TYPES[from]}`
      : WHY[reason];
  const warning = `${file} references ${reference}, ${why}; it was left out of the ${from}.`;
  if (reason === "file_type") return `${warning} Move it into the project to include it.`;
  if (reason === "not_approved") return `${warning} ${INCLUDE_OUTSIDE_FILES_HINT}`;
  if (reason !== "script") return warning;
  return `${warning} Move it into the project, or pass --include-outside-files to hyperframes render, to run it.`;
}

export async function servesProjectPath(
  adapter: Pick<StudioApiAdapter, "outsideAssetsAllowed">,
  projectDir: string,
  path: string,
): Promise<boolean> {
  if (!isWithinProjectRoot(projectDir, path)) return false;
  const real = await linkedOutsideOff(projectDir, path).catch(() => "unresolvable" as const);
  if (real === null) return true;
  if (real === "unresolvable" || (await outsideLinkRefusalOff(projectDir, path, real)))
    return false;
  return (await adapter.outsideAssetsAllowed?.(projectDir)) ?? true;
}
