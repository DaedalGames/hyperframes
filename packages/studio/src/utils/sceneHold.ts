import type { TimelineElement } from "../player";

type SceneHoldingWindow = Window & { __hfHoldScenes?: (names: string[]) => Promise<void> };

/** Mounts, in a preview that unmounts far scenes, the scenes holding a timeline element; nothing elsewhere. */
export async function holdScenesOf(
  iframe: HTMLIFrameElement | null,
  element: TimelineElement | null,
): Promise<void> {
  const names = element
    ? [...(element.compositionAncestors ?? []), element.parentCompositionId ?? ""]
    : [];
  try {
    await (iframe?.contentWindow as SceneHoldingWindow | null)?.__hfHoldScenes?.(
      names.filter(Boolean),
    );
  } catch {
    // A preview torn down meanwhile has nothing to mount.
  }
}
