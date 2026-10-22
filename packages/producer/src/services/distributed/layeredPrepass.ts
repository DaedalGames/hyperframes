import { prepareFrameForCapture, type CaptureSession } from "@hyperframes/engine";
import { createLayeredChunkClassifier, type LayeredChunkDecision } from "./layeredEligibility.js";
import { createLayeredFrameReader } from "./layeredFrameReader.js";
import type { LayeredPaintLayer, LayeredGeometry, LayeredFrame } from "./layeredFrameState.js";
import type { ChunkFrameRange } from "./renderChunk.js";

type PrepassStats = { prepassMs: number; fullReads: number };
export type LayeredPrepassResult = PrepassStats &
  (
    | (Extract<LayeredChunkDecision, { kind: "eligible" }> & {
        layers: LayeredPaintLayer[];
        geometry: LayeredGeometry;
      })
    | Extract<LayeredChunkDecision, { kind: "fallback" }>
  );

export async function certifyLayeredChunk(
  session: CaptureSession,
  range: ChunkFrameRange,
  capturePreparedFrame?: (frame: Extract<LayeredFrame, { kind: "candidate" }>) => Promise<void>,
): Promise<LayeredPrepassResult> {
  const classifier = createLayeredChunkClassifier(range);
  const fps = session.options.fps;
  const started = performance.now();
  let reader: Awaited<ReturnType<typeof createLayeredFrameReader>> | undefined;
  let layers: LayeredPaintLayer[] = [];
  let geometry: LayeredGeometry = { videos: [], clips: [] };
  try {
    for (let frameIndex = range.startFrame; frameIndex < range.endFrame; frameIndex++) {
      await prepareFrameForCapture(session, frameIndex, (frameIndex * fps.den) / fps.num);
      reader ??= await createLayeredFrameReader(session.page);
      const frame = await reader.read();
      classifier.observe(frameIndex, frame);
      if (frame.kind === "fallback") break;
      layers = frame.layers;
      geometry = frame.geometry;
      const decision = classifier.decision();
      if (decision.kind === "fallback" && decision.reason !== "incomplete_frames") break;
      await capturePreparedFrame?.(frame);
    }
  } finally {
    await reader?.dispose();
  }
  const stats = { prepassMs: performance.now() - started, fullReads: reader?.fullReads() ?? 0 };
  const decision = classifier.decision();
  if (decision.kind === "fallback") return { ...decision, ...stats };
  return { ...decision, ...stats, layers, geometry };
}
