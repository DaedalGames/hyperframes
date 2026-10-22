import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  decodePng,
  encodePng,
  type CaptureSession,
  type FrameLookupTable,
} from "@hyperframes/engine";
import {
  captureLayeredVideoAssets,
  selectLayeredVideoFrames,
  writeLayeredSequence,
} from "./layeredAssets.js";
import { createLayeredDomCapture, type LayeredImage } from "./layeredDom.js";
import { buildLayeredGraph, type LayeredGraphLayer } from "./layeredGraph.js";
import { certifyLayeredChunk } from "./layeredPrepass.js";
import type { LayeredPaintLayer } from "./layeredFrameState.js";
import type { ChunkFrameRange } from "./renderChunk.js";

function normalizeImages(images: LayeredImage[], directory: string) {
  const x = Math.min(...images.map((image) => image.x));
  const y = Math.min(...images.map((image) => image.y));
  const width = Math.max(...images.map((image) => image.x + image.width)) - x;
  const height = Math.max(...images.map((image) => image.y + image.height)) - y;
  const paths = new Map<string, string>();
  mkdirSync(directory, { recursive: true });
  const sequence = images.map((image) => {
    const key = JSON.stringify(image);
    const existing = paths.get(key);
    if (existing !== undefined) return existing;
    const source = decodePng(readFileSync(image.path));
    const pixels = Buffer.alloc(width * height * 4);
    for (let row = 0; row < source.height; row++) {
      pixels.set(
        source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4),
        ((row + image.y - y) * width + image.x - x) * 4,
      );
    }
    const path = join(directory, `${paths.size}.png`);
    writeFileSync(path, encodePng(width, height, pixels));
    paths.set(key, path);
    return path;
  });
  return { paths: sequence, x, y };
}

/** Each root child is an atomic paint surface. Splitting a contiguous run preserves its order. */
function captureLayers(layers: LayeredPaintLayer[]): LayeredPaintLayer[] {
  return layers.flatMap<LayeredPaintLayer>((layer) => {
    if (layer.kind === "video") return [layer];
    return layer.childIndices.map((index) => ({ kind: "dom" as const, childIndices: [index] }));
  });
}

/** The caller owns the prepared session. Refused sessions must be closed before ordinary capture. */
export async function captureCertifiedLayers(input: {
  session: CaptureSession;
  table: FrameLookupTable;
  range: ChunkFrameRange;
  directory: string;
}) {
  const { session, table, range, directory } = input;
  if ((session.options.deviceScaleFactor ?? 1) !== 1)
    return { kind: "fallback" as const, reason: "unsupported_geometry" as const };
  const domImages: LayeredImage[][] = [];
  let capture: Awaited<ReturnType<typeof createLayeredDomCapture>> | undefined;
  const started = performance.now();
  let certificate;
  try {
    certificate = await certifyLayeredChunk(session, range, async (frame) => {
      const domLayers = captureLayers(frame.layers).filter((layer) => layer.kind === "dom");
      if (!capture) {
        capture = await createLayeredDomCapture(session.page, join(directory, "dom-assets"));
        for (let index = 0; index <= domLayers.length; index++) domImages.push([]);
      }
      domImages[0]!.push(await capture.capture("background"));
      for (const [index, layer] of domLayers.entries())
        domImages[index + 1]!.push(await capture.capture(layer));
    });
  } finally {
    await capture?.dispose();
  }
  const preparedPassMs = performance.now() - started;
  if (certificate.kind === "fallback") {
    rmSync(directory, { recursive: true, force: true });
    return { ...certificate, preparedPassMs };
  }
  const fps = session.options.fps;
  const sourceFrames = selectLayeredVideoFrames(table, certificate.geometry, range, fps);
  if (sourceFrames === null) {
    rmSync(directory, { recursive: true, force: true });
    return { kind: "fallback" as const, reason: "missing_video_frame" as const, preparedPassMs };
  }
  const layers: LayeredGraphLayer[] = [];
  const inputArgs: string[] = [];
  let nextInput = 0;
  const addStatic = (path: string) => {
    inputArgs.push("-loop", "1", "-framerate", `${fps.num}/${fps.den}`, "-i", path);
    return nextInput++;
  };
  const addSequence = (paths: string[], name: string) => {
    inputArgs.push(...writeLayeredSequence(paths, join(directory, name), fps));
    return nextInput++;
  };
  const decorations = new Map<string, Awaited<ReturnType<typeof captureLayeredVideoAssets>>>();
  const assetPage = await session.page.browser().newPage();
  try {
    for (const [index, geometry] of certificate.geometry.videos.entries()) {
      decorations.set(
        geometry.videoId,
        await captureLayeredVideoAssets({
          page: assetPage,
          geometry,
          clips: certificate.geometry.clips,
          width: session.options.width,
          height: session.options.height,
          directory: join(directory, `decoration-${index}`),
        }),
      );
    }
  } finally {
    await assetPage.close();
  }
  const domInputs = domImages.map((images, index) => {
    const normalized = normalizeImages(images, join(directory, `dom-normalized-${index}`));
    return {
      kind: "dom" as const,
      inputIndex: addSequence(normalized.paths, `dom-input-${index}`),
      x: normalized.x,
      y: normalized.y,
    };
  });
  layers.push(domInputs[0]!);
  let domIndex = 1;
  for (const layer of captureLayers(certificate.layers)) {
    if (layer.kind === "dom") {
      layers.push(domInputs[domIndex++]!);
      continue;
    }
    const geometry = certificate.geometry.videos.find((video) => video.videoId === layer.videoId)!;
    const decoration = decorations.get(layer.videoId)!;
    if (decoration.shadow)
      layers.push({
        kind: "dom",
        inputIndex: addStatic(decoration.shadow.path),
        x: decoration.shadow.x,
        y: decoration.shadow.y,
      });
    layers.push({
      kind: "video",
      geometry,
      inputIndex: addSequence(sourceFrames.get(layer.videoId)!, `video-input-${layers.length}`),
      maskInputIndex: addStatic(decoration.maskPath),
    });
  }
  const graph = buildLayeredGraph({
    width: session.options.width,
    height: session.options.height,
    fps,
    frames: range.endFrame - range.startFrame,
    layers,
    opaqueBackground: session.options.format === "jpeg",
  });
  return {
    kind: "captured" as const,
    inputArgs,
    graph,
    certificate,
    domCaptures: capture?.captures() ?? 0,
    domTimings: capture?.timings(),
    preparedPassMs,
  };
}
