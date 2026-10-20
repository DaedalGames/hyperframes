/** The visibility pass's mark on a timed clip it hides; the runtime's rules hide the clip's contents by it. */
export const CLIP_HIDDEN_ATTR = "data-hf-clip-hidden";

export function liftClipHiddenMark(el: Element): () => void {
  if (!el.hasAttribute(CLIP_HIDDEN_ATTR)) return () => {};
  el.removeAttribute(CLIP_HIDDEN_ATTR);
  return function putClipHiddenMarkBack() {
    el.setAttribute(CLIP_HIDDEN_ATTR, "");
  };
}
