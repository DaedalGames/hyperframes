// Each mp4 chunk becomes one movie fragment (its video plus the plan audio packets starting in
// its range); chunk 0 keeps the init segment. Sequence numbers and decode times are rewritten
// to their place in the render, so the pieces' bytes in order are the final fragmented MP4.

import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { finished, pipeline } from "node:stream/promises";
import type { Fps } from "@hyperframes/core";
import { appendRenderProvenanceArgs, describeFfmpegFailure, runFfmpeg } from "@hyperframes/engine";
import { runFfprobeJson } from "../render/audioPadTrim.js";
import type { ChunkSliceJson } from "../render/stages/freezePlan.js";

const MOVFLAGS = "+empty_moov+default_base_moof+delay_moov+skip_trailer";
// Max consecutive samples per track inside the fragment's mdat (~0.5 s of video).
const FRAG_INTERLEAVE = "16";

/** Where AAC packet `j` of the plan audio starts: `firstStart + j * packetSamples`, in samples. */
interface AacPacketGrid {
  sampleRate: number;
  firstStart: number;
  packetSamples: number;
  packetCount: number;
}

/** Input-side `-ss` / `-t` that select exactly packets `[first, end)` for one chunk. */
interface AudioCut {
  seekSeconds: number | null;
  durationSeconds: number | null;
  firstPacket: number;
  packetCount: number;
}

// A chunk owns the packets starting in its frame range (chunk 0 also the priming before 0).
// Cuts sit half a packet before a packet start so ffmpeg's rounding cannot move them.
export function audioCutForChunk(
  grid: AacPacketGrid,
  chunks: readonly ChunkSliceJson[],
  index: number,
  fps: Fps,
): AudioCut | null {
  const firstPacketAt = (frame: number): number =>
    Math.min(
      grid.packetCount,
      Math.max(
        0,
        Math.ceil(
          (frame * fps.den * grid.sampleRate - grid.firstStart * fps.num) /
            (grid.packetSamples * fps.num),
        ),
      ),
    );
  const first = index === 0 ? 0 : firstPacketAt(chunks[index]!.startFrame);
  const end =
    index === chunks.length - 1 ? grid.packetCount : firstPacketAt(chunks[index + 1]!.startFrame);
  if (end <= first) return null;
  const cutSeconds = (packet: number): number =>
    (grid.firstStart + packet * grid.packetSamples - grid.packetSamples / 2) / grid.sampleRate;
  const seekSeconds = index === 0 ? null : cutSeconds(first);
  const durationSeconds = end === grid.packetCount ? null : cutSeconds(end) - (seekSeconds ?? 0);
  return { seekSeconds, durationSeconds, firstPacket: first, packetCount: end - first };
}

interface FfprobeAudioGrid {
  streams?: { sample_rate?: string; time_base?: string; nb_frames?: string }[];
  packets?: { pts?: number; duration?: number }[];
}

async function probeAacPacketGrid(audioPath: string): Promise<AacPacketGrid> {
  const probe = await runFfprobeJson<FfprobeAudioGrid>([
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate,time_base,nb_frames:packet=pts,duration",
    "-read_intervals",
    "%+#1",
    "-of",
    "json",
    "--",
    audioPath,
  ]);
  const stream = probe.streams?.[0] ?? {};
  const packet = probe.packets?.[0] ?? {};
  const sampleRate = Number(stream.sample_rate);
  const [tbNum = NaN, tbDen = NaN] = String(stream.time_base).split("/").map(Number);
  const toSamples = (ticks?: number): number => (Number(ticks) * sampleRate * tbNum) / tbDen;
  const grid = {
    sampleRate,
    firstStart: toSamples(packet.pts),
    packetSamples: toSamples(packet.duration),
    packetCount: Number(stream.nb_frames),
  };
  const counts = [grid.sampleRate, grid.packetSamples, grid.packetCount];
  if (!Number.isFinite(grid.firstStart) || !counts.every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error(`[fmp4Piece] could not read the AAC packet grid: ${JSON.stringify(probe)}`);
  }
  return grid;
}

interface PieceInput {
  videoPath: string;
  audioPath: string | null;
  outputPath: string;
  chunks: readonly ChunkSliceJson[];
  chunkIndex: number;
  fps: Fps;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Mux one encoded chunk and its audio packets into a finished piece at `outputPath`. */
export async function buildFragmentedPiece(input: PieceInput): Promise<void> {
  const grid = input.audioPath ? await probeAacPacketGrid(input.audioPath) : null;
  const cut = grid ? audioCutForChunk(grid, input.chunks, input.chunkIndex, input.fps) : null;
  const muxedPath = `${input.outputPath}.frag.mp4`;
  const args = ["-i", input.videoPath];
  if (cut) {
    if (cut.seekSeconds !== null) args.push("-ss", cut.seekSeconds.toFixed(6));
    if (cut.durationSeconds !== null) args.push("-t", cut.durationSeconds.toFixed(6));
    args.push("-i", input.audioPath!, "-map", "0:v:0", "-map", "1:a:0");
    // A seek keeps the packet before the cut unless told not to; chunk 0 never
    // seeks, so its priming packet (and the edit list that hides it) survive.
    if (cut.seekSeconds !== null) args.push("-copypriorss", "0");
  } else {
    args.push("-map", "0:v:0");
  }
  args.push("-c", "copy", "-movflags", MOVFLAGS, "-frag_interleave", FRAG_INTERLEAVE);
  appendRenderProvenanceArgs(args, muxedPath);
  args.push("-y", muxedPath);
  const result = await runFfmpeg(args, { signal: input.signal, timeout: input.timeoutMs });
  if (!result.success) {
    throw new Error(
      `[fmp4Piece] piece mux failed: ${describeFfmpegFailure(result, input.timeoutMs)}`,
    );
  }
  const slice = input.chunks[input.chunkIndex]!;
  await placePiece(muxedPath, input.outputPath, {
    keepInit: input.chunkIndex === 0,
    sequenceNumber: input.chunkIndex + 1,
    videoStartFrame: slice.startFrame,
    videoFrames: slice.endFrame - slice.startFrame,
    fps: input.fps,
    audio: cut ? { cut, grid: grid! } : null,
  });
}

interface PiecePlacement {
  keepInit: boolean;
  sequenceNumber: number;
  videoStartFrame: number;
  videoFrames: number;
  fps: Fps;
  audio: { cut: AudioCut; grid: AacPacketGrid } | null;
}

interface Box {
  type: string;
  start: number;
  bodyStart: number;
  end: number;
}

/** The box whose header sits at `off` in `src`, which holds the bytes at file offset `at`. */
function boxAt(src: Buffer, off: number, at: number, limit: number): Box {
  let size = src.readUInt32BE(off);
  let bodyStart = at + 8;
  if (size === 1) {
    size = Number(src.readBigUInt64BE(off + 8));
    bodyStart = at + 16;
  }
  if (size < 8 || at + size > limit) throw new Error(`[fmp4Piece] malformed box at ${at}`);
  return { type: src.toString("latin1", off + 4, off + 8), start: at, bodyStart, end: at + size };
}

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  for (let at = start; at < end; at = boxes.at(-1)!.end) boxes.push(boxAt(buf, at, at, end));
  return boxes;
}

function children(buf: Buffer, parent: Box, type: string): Box[] {
  return readBoxes(buf, parent.bodyStart, parent.end).filter((box) => box.type === type);
}

function child(buf: Buffer, parent: Box, type: string): Box {
  const found = children(buf, parent, type)[0];
  if (!found) throw new Error(`[fmp4Piece] ${parent.type} has no ${type}`);
  return found;
}

/** Top-level box headers of a file, read without loading the payloads. */
function scanFile(fd: number, fileSize: number): Box[] {
  const header = Buffer.alloc(16);
  const boxes: Box[] = [];
  for (let at = 0; at < fileSize; at = boxes.at(-1)!.end) {
    readSync(fd, header, 0, 16, at);
    boxes.push(boxAt(header, 0, at, fileSize));
  }
  return boxes;
}

function readBox(fd: number, box: Box): Buffer {
  const buf = Buffer.alloc(box.end - box.start);
  readSync(fd, buf, 0, buf.length, box.start);
  return buf;
}

interface Track {
  handler: string;
  timescale: number;
  /** Media time the track's edit list starts presenting at (0 without one). */
  editStart: number;
}

function readEditStart(moov: Buffer, trak: Box): number {
  const edts = children(moov, trak, "edts")[0];
  if (!edts) return 0;
  const elst = child(moov, edts, "elst");
  const wide = moov[elst.bodyStart] === 1;
  const entries = moov.readUInt32BE(elst.bodyStart + 4);
  for (let i = 0, at = elst.bodyStart + 8; i < entries; i++, at += wide ? 20 : 12) {
    const offset = at + (wide ? 8 : 4);
    const mediaTime = wide ? Number(moov.readBigInt64BE(offset)) : moov.readInt32BE(offset);
    if (mediaTime !== -1) return mediaTime;
  }
  return 0;
}

/** track_ID -> handler, timescale and edit start, from the piece's own moov. */
function readTracks(moov: Buffer): Map<number, Track> {
  const tracks = new Map<number, Track>();
  const root = readBoxes(moov, 0, moov.length)[0]!;
  for (const trak of children(moov, root, "trak")) {
    const tkhd = child(moov, trak, "tkhd");
    const trackId = moov.readUInt32BE(tkhd.bodyStart + (moov[tkhd.bodyStart] === 1 ? 20 : 12));
    const mdia = child(moov, trak, "mdia");
    const mdhd = child(moov, mdia, "mdhd");
    const timescale = moov.readUInt32BE(mdhd.bodyStart + (moov[mdhd.bodyStart] === 1 ? 20 : 12));
    const hdlr = child(moov, mdia, "hdlr");
    const handler = moov.toString("latin1", hdlr.bodyStart + 8, hdlr.bodyStart + 12);
    tracks.set(trackId, { handler, timescale, editStart: readEditStart(moov, trak) });
  }
  return tracks;
}

function videoTicks(frames: number, timescale: number, fps: Fps): number {
  const ticks = (frames * timescale * fps.den) / fps.num;
  if (!Number.isInteger(ticks)) {
    throw new Error(
      `[fmp4Piece] ${frames} frames is not a whole tick count at timescale ${timescale}`,
    );
  }
  return ticks;
}

function decodeTimeOffset(track: Track, placement: PiecePlacement): bigint {
  const { handler, timescale } = track;
  if (handler === "vide") {
    // Chunks encode without B-frames, so frame k presents at media time k.
    // A delayed start would shift every piece by its own delay.
    if (track.editStart !== 0) {
      throw new Error(
        `[fmp4Piece] video starts at media time ${track.editStart}; expected 0 (no B-frames)`,
      );
    }
    return BigInt(videoTicks(placement.videoStartFrame, timescale, placement.fps));
  }
  const audio = placement.audio;
  if (handler === "soun" && audio && timescale === audio.grid.sampleRate) {
    return BigInt(audio.cut.firstPacket * audio.grid.packetSamples);
  }
  throw new Error(`[fmp4Piece] unexpected ${handler} track at timescale ${timescale}`);
}

/** Rewrite one moof in memory; returns the samples it holds per handler type. */
function rewriteMoof(
  moof: Buffer,
  tracks: Map<number, Track>,
  placement: PiecePlacement,
): Map<string, number> {
  const samples = new Map<string, number>();
  const root = readBoxes(moof, 0, moof.length)[0]!;
  moof.writeUInt32BE(placement.sequenceNumber, child(moof, root, "mfhd").bodyStart + 4);
  for (const traf of children(moof, root, "traf")) {
    const track = tracks.get(moof.readUInt32BE(child(moof, traf, "tfhd").bodyStart + 4));
    if (!track) throw new Error("[fmp4Piece] traf names a track the moov does not declare");
    const tfdt = child(moof, traf, "tfdt");
    if (moof[tfdt.bodyStart] !== 1) throw new Error("[fmp4Piece] expected a 64-bit tfdt");
    const at = tfdt.bodyStart + 4;
    moof.writeBigUInt64BE(moof.readBigUInt64BE(at) + decodeTimeOffset(track, placement), at);
    for (const trun of children(moof, traf, "trun")) {
      samples.set(
        track.handler,
        (samples.get(track.handler) ?? 0) + moof.readUInt32BE(trun.bodyStart + 4),
      );
    }
  }
  return samples;
}

function assertSampleCounts(samples: Map<string, number>, placement: PiecePlacement): void {
  const expected = new Map<string, number>([["vide", placement.videoFrames]]);
  if (placement.audio) expected.set("soun", placement.audio.cut.packetCount);
  for (const [handler, count] of expected) {
    if (samples.get(handler) !== count) {
      throw new Error(
        `[fmp4Piece] ${handler} samples in piece ${samples.get(handler) ?? 0}, expected ${count}`,
      );
    }
  }
}

/**
 * Turn ffmpeg's standalone single-fragment file into its piece of the whole
 * render: patch the moof in place, then keep the init (chunk 0) or drop it.
 */
export async function placePiece(
  srcPath: string,
  dstPath: string,
  placement: PiecePlacement,
): Promise<void> {
  const fd = openSync(srcPath, "r+");
  let moofStart: number;
  try {
    const boxes = scanFile(fd, fstatSync(fd).size);
    const types = boxes.map((box) => box.type).join(",");
    if (types !== "ftyp,moov,moof,mdat") {
      throw new Error(`[fmp4Piece] expected ftyp,moov,moof,mdat in the piece, got ${types}`);
    }
    const [, moovBox, moofBox] = boxes as [Box, Box, Box, Box];
    const tracks = readTracks(readBox(fd, moovBox));
    const moof = readBox(fd, moofBox);
    assertSampleCounts(rewriteMoof(moof, tracks, placement), placement);
    writeSync(fd, moof, 0, moof.length, moofBox.start);
    moofStart = moofBox.start;
  } finally {
    closeSync(fd);
  }
  if (placement.keepInit) {
    renameSync(srcPath, dstPath);
    return;
  }
  await pipeline(createReadStream(srcPath, { start: moofStart }), createWriteStream(dstPath));
  rmSync(srcPath, { force: true });
}

/** Local join: the pieces already form one file, in order. */
export async function concatenatePieces(
  piecePaths: readonly string[],
  outputPath: string,
): Promise<void> {
  const out = createWriteStream(outputPath);
  for (const path of piecePaths) {
    await pipeline(createReadStream(path, { highWaterMark: 1 << 20 }), out, { end: false });
  }
  out.end();
  await finished(out);
}
