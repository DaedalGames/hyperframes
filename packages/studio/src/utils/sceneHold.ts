import type { TimelineElement } from "../player";

type SceneHoldingWindow = Window & { __hfHoldScenes?: (names: string[]) => Promise<void> };

/**
 * Mounts, in a preview that unmounts far scenes, the scenes holding a timeline element.
 * Elsewhere there is nothing to wait for, so it returns nothing and a caller goes on in the same turn.
 */
export function holdScenesOf(
  iframe: HTMLIFrameElement | null,
  element: TimelineElement | null,
): Promise<void> | undefined {
  let hold: SceneHoldingWindow["__hfHoldScenes"];
  try {
    hold = (iframe?.contentWindow as SceneHoldingWindow | null)?.__hfHoldScenes;
  } catch {
    return undefined; // A cross-origin preview has no scenes to mount.
  }
  if (!hold) return undefined;
  const names = element
    ? [...(element.compositionAncestors ?? []), element.parentCompositionId ?? ""]
    : [];
  // A preview torn down meanwhile has nothing to mount.
  return hold(names.filter(Boolean)).catch(() => {});
}
