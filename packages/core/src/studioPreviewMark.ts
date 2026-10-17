export const STUDIO_PREVIEW_MARK_META = "hyperframes-studio-preview";
/** The mark's content: Studio's own preview, or a capture build (a still shot right after a seek). */
export const STUDIO_PREVIEW_MARK = { preview: "preview", capture: "capture" } as const;
export const STUDIO_PREVIEW_UPCOMING_ATTR = "data-hf-upcoming";
export const STUDIO_PREVIEW_LAZY_ATTR = "data-hf-preview-lazy";
export const STUDIO_PREVIEW_ERRORS = "__hfPreviewErrors";
export const PREVIEW_RASTER_ATTR = "data-hf-preview-raster";
export const RUNTIME_STAMPED_ATTR = "data-hf-autostamped";
export const PREVIEW_ONLY_ATTRS = [
  STUDIO_PREVIEW_UPCOMING_ATTR,
  STUDIO_PREVIEW_LAZY_ATTR,
  PREVIEW_RASTER_ATTR,
  RUNTIME_STAMPED_ATTR,
] as const;

export function applyAuthoredTiming(
  el: Element,
  attrs: ReadonlyArray<readonly [name: string, value: string]>,
): void {
  for (const [name, value] of attrs) el.setAttribute(name, value);
  el.removeAttribute(RUNTIME_STAMPED_ATTR);
}

const markOf = (doc: Document) =>
  doc.querySelector(`meta[name="${STUDIO_PREVIEW_MARK_META}"]`)?.getAttribute("content") ?? null;

/** Whether `doc` loads media only near the playhead: any marked page, the preview or a capture build. */
export const defersMedia = (doc: Document): boolean =>
  doc.querySelector(`meta[name="${STUDIO_PREVIEW_MARK_META}"]`) !== null;

/** Whether `doc` skips hidden clips' images: the preview only (a mark without content is one); a capture keeps
 * every image eager, so a still right after a seek never shows a scene before its images. */
export const skipsImagesOfHiddenClips = (doc: Document): boolean =>
  defersMedia(doc) && markOf(doc) !== STUDIO_PREVIEW_MARK.capture;
