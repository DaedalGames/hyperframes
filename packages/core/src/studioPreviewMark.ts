export const STUDIO_PREVIEW_MARK_META = "hyperframes-studio-preview";
/** Media deferral without the preview's image skipping: a capture's still loads only the media near its moment. */
export const DEFER_MEDIA_META = "hyperframes-defer-media";
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

/** Whether `doc` loads media only near the playhead: Studio's preview, or a capture build that asks for that alone. */
export const defersMedia = (doc: Document): boolean =>
  doc.querySelector(
    `meta[name="${STUDIO_PREVIEW_MARK_META}"], meta[name="${DEFER_MEDIA_META}"]`,
  ) !== null;
