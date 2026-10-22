export type LayeredFallbackReason =
  | "observation_error"
  | "unsupported_sampling"
  | "scene_complexity"
  | "no_video"
  | "nested_video"
  | "unsupported_stacking"
  | "unsupported_effect"
  | "unsupported_geometry"
  | "video_decoration"
  | "missing_video_frame"
  | "changing_video_layout"
  | "incomplete_frames";

export type LayeredFrame =
  | {
      kind: "candidate";
      signature: string;
      videoCount: number;
      layers: LayeredPaintLayer[];
      geometry: LayeredGeometry;
    }
  | { kind: "fallback"; reason: LayeredFallbackReason };

export const LAYERED_NODE_LIMIT = 512;

export interface LayeredEffects {
  mixBlendMode: string;
  backdropFilter: string;
  perspective: string;
  transformStyle: string;
}

export interface LayeredNodeState extends LayeredEffects {
  tag: string;
  rect: [number, number, number, number];
  position: string;
  zIndex: string;
  display: string;
  visibility: string;
  opacity: string;
  transforms: string[];
  matrix: { is2D: boolean; a: number; b: number; c: number; d: number };
  filter: string;
  clipPath: string;
  legacyClip: string;
  zoom: string;
  contentVisibility: string;
  imageRendering: string;
  maskImage: string;
  radii: string[];
  pseudoContents: string[];
  pseudoEffects: LayeredEffects[];
  pseudoZIndices: string[];
  objectFit: string;
  objectPosition: string;
  boxShadow: string;
  backgroundImage: string;
  backgroundColor: string;
  outlineStyle: string;
  spacing: string[];
  overflow: string[];
  shadowRoot: boolean;
  topLayer: boolean;
}

export type LayeredFrameState =
  | { kind: "scene_limit" }
  | {
      kind: "observed";
      root: LayeredNodeState | null;
      rootText: boolean;
      unsupportedPseudo: boolean;
      ancestors: { node: LayeredNodeState; extraPaint: boolean }[];
      nodes: LayeredNodeState[];
      children: ({ node: LayeredNodeState; descendantZIndices: string[] } & (
        | { kind: "video"; videoId: string }
        | { kind: "dom" }
      ))[];
      videos: { id: string; direct: boolean; ready: boolean; proxy: LayeredNodeState | null }[];
    };

function hasEffect(node: LayeredEffects): boolean {
  return (
    node.mixBlendMode !== "normal" ||
    node.backdropFilter !== "none" ||
    node.perspective !== "none" ||
    node.transformStyle !== "flat"
  );
}

function hasPseudo(node: LayeredNodeState): boolean {
  return node.pseudoContents.some((content) => content !== "none" && content !== "normal");
}

function hasUnsupportedClipBox(node: LayeredNodeState): boolean {
  if (node.overflow.some((value) => !["visible", "hidden", "clip"].includes(value))) return true;
  return (
    node.overflow.some((value) => value !== "visible") &&
    node.spacing.some((value) => value !== "0px")
  );
}

function hasNonRectangularClip(node: LayeredNodeState): boolean {
  return (
    node.clipPath !== "none" ||
    node.maskImage !== "none" ||
    node.radii.some((radius) => radius !== "0px")
  );
}

function hasUnsupportedBox(node: LayeredNodeState): boolean {
  return node.legacyClip !== "auto" || node.zoom !== "1" || node.contentVisibility !== "visible";
}

function hasUnsupportedContainer(node: LayeredNodeState): boolean {
  return (
    hasUnsupportedBox(node) ||
    Number(node.zIndex) < 0 ||
    node.opacity !== "1" ||
    node.transforms.some((value) => value !== "none") ||
    node.filter !== "none" ||
    hasEffect(node) ||
    hasPseudo(node) ||
    hasNonRectangularClip(node) ||
    hasUnsupportedClipBox(node)
  );
}

function hasUnmodeledPaint(node: LayeredNodeState): boolean {
  return (
    ["CANVAS", "IFRAME", "SVG", "DIALOG"].includes(node.tag) ||
    node.tag.includes("-") ||
    node.topLayer ||
    node.shadowRoot ||
    hasEffect(node) ||
    node.pseudoEffects.some(hasEffect)
  );
}

function isTranslation(matrix: LayeredNodeState["matrix"]): boolean {
  return matrix.is2D && matrix.a === 1 && matrix.d === 1 && matrix.b === 0 && matrix.c === 0;
}

function hasVideoBox(node: LayeredNodeState): boolean {
  return (
    node.display !== "none" &&
    node.visibility === "visible" &&
    node.rect.every(Number.isSafeInteger) &&
    node.rect[0] >= 0 &&
    node.rect[1] >= 0 &&
    node.rect[2] > 0 &&
    node.rect[3] > 0
  );
}

function hasUnsupportedVideoStyle(node: LayeredNodeState): boolean {
  return (
    hasUnsupportedBox(node) ||
    node.imageRendering !== "auto" ||
    !["fill", "cover"].includes(node.objectFit) ||
    node.objectPosition !== "50% 50%" ||
    node.clipPath !== "none" ||
    node.filter !== "none" ||
    node.maskImage !== "none" ||
    node.radii.some((radius) => !/^\d+(\.\d+)?px$/.test(radius))
  );
}

function hasVideoDecoration(node: LayeredNodeState): boolean {
  return (
    hasPseudo(node) ||
    (node.boxShadow !== "none" && (node.opacity !== "1" || node.boxShadow.includes("inset"))) ||
    node.backgroundImage !== "none" ||
    node.backgroundColor !== "rgba(0, 0, 0, 0)" ||
    node.outlineStyle !== "none" ||
    node.spacing.some((value) => value !== "0px")
  );
}

function videoRefusal(node: LayeredNodeState): LayeredFallbackReason | null {
  if (
    !isTranslation(node.matrix) ||
    node.transforms.slice(1).some((value) => value !== "none") ||
    !hasVideoBox(node) ||
    hasUnsupportedVideoStyle(node)
  )
    return "unsupported_geometry";
  if (hasVideoDecoration(node)) return "video_decoration";
  return null;
}

type ObservedFrame = Extract<LayeredFrameState, { kind: "observed" }>;

function containerRefusal(
  state: ObservedFrame,
  root: LayeredNodeState,
): LayeredFallbackReason | null {
  if (state.ancestors.some(({ node, extraPaint }) => extraPaint || hasUnsupportedContainer(node)))
    return "unsupported_stacking";
  if (
    state.rootText ||
    !["relative", "absolute"].includes(root.position) ||
    hasUnsupportedContainer(root)
  )
    return "unsupported_stacking";
  if (state.unsupportedPseudo || state.nodes.some(hasUnmodeledPaint)) return "unsupported_effect";
  return null;
}

export interface LayeredVideoGeometry {
  videoId: string;
  rect: LayeredNodeState["rect"];
  opacity: number;
  radii: string[];
  objectFit: "fill" | "cover";
  boxShadow: string;
}

export interface LayeredGeometry {
  videos: LayeredVideoGeometry[];
  clips: LayeredNodeState["rect"][];
}

type VideoLayout = LayeredVideoGeometry;
type VideoInputs = Extract<LayeredFrameState, { kind: "observed" }>["videos"];

function classifyVideos(
  videos: VideoInputs,
): { kind: "videos"; layouts: VideoLayout[] } | Extract<LayeredFrame, { kind: "fallback" }> {
  if (new Set(videos.map((video) => video.id)).size !== videos.length) {
    return { kind: "fallback", reason: "missing_video_frame" };
  }
  const videoLayouts: VideoLayout[] = [];
  for (const video of videos) {
    const node = video.proxy;
    if (!video.id || !node || !video.ready)
      return { kind: "fallback", reason: "missing_video_frame" };
    const reason = videoRefusal(node);
    if (reason) return { kind: "fallback", reason };
    videoLayouts.push({
      videoId: video.id,
      rect: node.rect,
      opacity: Number(node.opacity),
      radii: node.radii,
      objectFit: node.objectFit === "cover" ? "cover" : "fill",
      boxShadow: node.boxShadow,
    });
  }
  return { kind: "videos", layouts: videoLayouts };
}

export function classifyLayeredFrame(state: LayeredFrameState): LayeredFrame {
  if (state.kind === "scene_limit") return { kind: "fallback", reason: "scene_complexity" };
  if (state.videos.length === 0) return { kind: "fallback", reason: "no_video" };
  if (!state.root || state.videos.some((video) => !video.direct))
    return { kind: "fallback", reason: "nested_video" };
  const refusal = containerRefusal(state, state.root);
  if (refusal) return { kind: "fallback", reason: refusal };
  const videos = classifyVideos(state.videos);
  if (videos.kind === "fallback") return videos;
  const paintOrder = resolveLayeredPaintOrder(state.children);
  if (paintOrder.kind === "fallback") return paintOrder;
  const geometry: LayeredGeometry = {
    videos: videos.layouts,
    clips: [state.root, ...state.ancestors.map(({ node }) => node)]
      .filter((node) => node.overflow.some((value) => value !== "visible"))
      .map((node) => node.rect),
  };
  return {
    kind: "candidate",
    geometry,
    videoCount: state.videos.length,
    layers: paintOrder.layers,
    signature: JSON.stringify({
      videoLayouts: videos.layouts,
      layers: paintOrder.layers,
      clip: [state.root, ...state.ancestors.map(({ node }) => node)].map((node) => [
        node.rect,
        node.overflow,
      ]),
    }),
  };
}

export type LayeredPaintLayer =
  | { kind: "video"; videoId: string; childIndex: number }
  | { kind: "dom"; childIndices: number[] };

function stackingLevel(child: ObservedFrame["children"][number]): number | null {
  const { node } = child;
  if (!["absolute", "relative"].includes(node.position)) return null;
  const z = node.zIndex === "auto" ? 0 : Number(node.zIndex);
  if (!Number.isSafeInteger(z) || z < 0) return null;
  if (
    node.zIndex === "auto" &&
    child.descendantZIndices.some((value) => value !== "auto" && value !== "0")
  ) {
    return null;
  }
  return z;
}

export function resolveLayeredPaintOrder(
  children: ObservedFrame["children"],
): { kind: "layers"; layers: LayeredPaintLayer[] } | Extract<LayeredFrame, { kind: "fallback" }> {
  const ordered = [];
  for (const [childIndex, child] of children.entries()) {
    const { node } = child;
    if (["VIDEO", "SCRIPT", "STYLE", "LINK"].includes(node.tag) || node.display === "none")
      continue;
    const z = stackingLevel(child);
    if (z === null) return { kind: "fallback", reason: "unsupported_stacking" };
    ordered.push({ childIndex, child, z });
  }
  ordered.sort((a, b) => a.z - b.z || a.childIndex - b.childIndex);
  const layers: LayeredPaintLayer[] = [];
  for (const { childIndex, child } of ordered) {
    if (child.kind === "video") layers.push({ kind: "video", videoId: child.videoId, childIndex });
    else {
      const previous = layers.at(-1);
      if (previous?.kind === "dom") previous.childIndices.push(childIndex);
      else layers.push({ kind: "dom", childIndices: [childIndex] });
    }
  }
  return { kind: "layers", layers };
}
