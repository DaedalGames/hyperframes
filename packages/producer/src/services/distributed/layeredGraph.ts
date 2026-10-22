import { fpsToFfmpegArg, type Fps } from "@hyperframes/core";
import type { LayeredVideoGeometry } from "./layeredFrameState.js";

export type LayeredGraphLayer =
  | { kind: "dom"; inputIndex: number; x: number; y: number }
  | { kind: "video"; inputIndex: number; maskInputIndex: number; geometry: LayeredVideoGeometry };

/** RGB layers stay RGB until the shared encoder performs its output conversion. */
export function buildLayeredGraph(input: {
  width: number;
  height: number;
  fps: Fps;
  frames: number;
  layers: LayeredGraphLayer[];
  opaqueBackground?: boolean;
}) {
  const { width, height, frames, layers } = input;
  const clock = `settb=${input.fps.den}/${input.fps.num},setpts=N`;
  const graph = [
    `color=c=${input.opaqueBackground ? "white" : "black@0"}:s=${width}x${height}:r=${fpsToFfmpegArg(input.fps)},format=rgba,trim=end_frame=${frames},${clock}[base0]`,
  ];
  for (const [index, layer] of layers.entries()) {
    const label = `layer${index}`;
    let x = 0;
    let y = 0;
    if (layer.kind === "dom") {
      x = layer.x;
      y = layer.y;
      graph.push(`[${layer.inputIndex}:v]format=rgba,${clock}[${label}]`);
    } else {
      const { rect, objectFit, opacity } = layer.geometry;
      const [left, top, w, h] = rect;
      x = left;
      y = top;
      const fit =
        objectFit === "cover"
          ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
          : `scale=${w}:${h}:flags=lanczos`;
      graph.push(
        `[${layer.inputIndex}:v]${fit},setsar=1,format=rgba,${clock},split[video${index}][sourceAlpha${index}]`,
      );
      graph.push(`[sourceAlpha${index}]alphaextract[alpha${index}]`);
      graph.push(`[${layer.maskInputIndex}:v]format=rgba,alphaextract,${clock}[mask${index}]`);
      graph.push(
        `[alpha${index}][mask${index}]blend=all_mode=multiply[combinedAlpha${index}]`,
        `[video${index}][combinedAlpha${index}]alphamerge,colorchannelmixer=aa=${opacity}[${label}]`,
      );
    }
    graph.push(
      `[base${index}][${label}]overlay=x=${x}:y=${y}:format=rgb:alpha=straight:shortest=1[base${index + 1}]`,
    );
  }
  return { graph: graph.join(";"), outputLabel: `base${layers.length}` };
}
