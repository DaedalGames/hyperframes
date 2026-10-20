// The visibility pass's mark on a timed clip it hides. The runtime's injected rules hide the clip's
// contents by this mark alone, so whatever forces a hidden clip visible lifts it through here.
export const CLIP_HIDDEN_ATTR = "data-hf-clip-hidden";

/** Lifts the hidden-clip mark so a clip forced visible shows its contents; the call it returns puts it back. */
export function liftClipHiddenMark(el: Element): () => void {
  if (!el.hasAttribute(CLIP_HIDDEN_ATTR)) return () => {};
  el.removeAttribute(CLIP_HIDDEN_ATTR);
  return () => el.setAttribute(CLIP_HIDDEN_ATTR, "");
}
