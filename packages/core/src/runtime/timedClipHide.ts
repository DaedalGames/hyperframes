import { CLIP_HIDDEN_ATTR, olderShaderBuildOnPage, revealClip } from "./clipReveal";
import {
  RUNTIME_STAMPED_ATTR,
  STUDIO_PREVIEW_MARK_META,
  STUDIO_PREVIEW_UPCOMING_ATTR,
} from "../studioPreviewMark";

// Hides timed non-media clips from script evaluation until the first visibility pass decides them;
// before it, a paused page painted every clip at once. Media is left to init's media pass.
// The rule and its flag live on the page, so every runtime copy shares them.
const HIDE_ATTR = "data-hf-first-pass-hide";
const HIDE_UNTIL_FIRST_PASS =
  "[data-start]:not(video, audio, img) { visibility: hidden !important; }";
const PREVIEW_HIDE_UNTIL_FIRST_PASS = 'img[loading="lazy"] { display: none !important; }';
const SKIP_ATTR = "data-hf-skip-hidden-images";
export { CLIP_HIDDEN_ATTR };
const SKIPPABLE_CLIP = `[data-start]:not(video, audio, img, [${STUDIO_PREVIEW_UPCOMING_ATTR}], [${RUNTIME_STAMPED_ATTR}])`;
export const SKIPPED_CLIP = `${SKIPPABLE_CLIP}[${CLIP_HIDDEN_ATTR}]`;
const STUDIO_PREVIEW_MARK = `meta[name="${STUDIO_PREVIEW_MARK_META}"]`;
const CONTENTS_ATTR = "data-hf-hidden-clip-contents";
// Doubled to keep the weight the rule had when it also matched the inline hide.
const HIDDEN_CLIP = `[${CLIP_HIDDEN_ATTR}][${CLIP_HIDDEN_ATTR}]`;
// Compatibility path for shader-transitions builds that reveal clips by inline style alone (see
// keepInlineHideRulesForOlderShaders); the [style] selector is what costs WebKit a re-serialization per write.
const HIDDEN_CLIP_BY_INLINE_STYLE = `[${CLIP_HIDDEN_ATTR}][style*="visibility: hidden"]`;
const skipHiddenImages = (clip: string) =>
  `${SKIPPABLE_CLIP}${clip} img { display: none !important; }`;
const hideHiddenClipContents = (clip: string) =>
  `${clip} * { visibility: hidden !important; } ` +
  `svg${clip}, svg${clip} *, ${clip} svg, ${clip} svg * { filter: none !important; }`;

export function showHiddenClips(): () => void {
  const hidden = Array.from(document.querySelectorAll<HTMLElement>(`[${CLIP_HIDDEN_ATTR}]`));
  const putMarksBack = hidden.map((el) => revealClip(el));
  return () => {
    for (const el of hidden) el.style.visibility = "hidden";
    for (const putMarkBack of putMarksBack) putMarkBack();
  };
}

type FirstPassWindow = Window & {
  __hfFirstPassHidden?: boolean;
  __hyperframeRuntimeBootstrapped?: boolean;
};

function appendStyle(parent: Element, attr: string, css: string): void {
  const style = document.createElement("style");
  style.setAttribute(attr, "");
  style.textContent = css;
  parent.appendChild(style);
}

/** True in Studio's preview, where hidden clips' images are neither fetched nor decoded until due. */
export function skipsHiddenImages(): boolean {
  return document.querySelector(`style[${SKIP_ATTR}]`) !== null;
}

export function hideTimedClipsUntilFirstPass(): void {
  if (typeof document === "undefined") return;
  const parent = document.head ?? document.documentElement;
  if (!parent) return;
  const preview = document.querySelector(STUDIO_PREVIEW_MARK) !== null;
  if (preview && !skipsHiddenImages())
    appendStyle(parent, SKIP_ATTR, skipHiddenImages(HIDDEN_CLIP));
  if (!document.querySelector(`style[${CONTENTS_ATTR}]`))
    appendStyle(parent, CONTENTS_ATTR, hideHiddenClipContents(HIDDEN_CLIP));
  const win = window as FirstPassWindow;
  // A runtime that already initialised may never run another pass to lift a new rule.
  if (win.__hfFirstPassHidden || win.__hyperframeRuntimeBootstrapped) return;
  const css = preview
    ? `${HIDE_UNTIL_FIRST_PASS} ${PREVIEW_HIDE_UNTIL_FIRST_PASS}`
    : HIDE_UNTIL_FIRST_PASS;
  appendStyle(parent, HIDE_ATTR, css);
  win.__hfFirstPassHidden = true;
}

/** True when this call lifted the rule; callers then re-register what skipped hidden elements (grading). */
export function revealTimedClipsAfterFirstPass(): boolean {
  const win = window as FirstPassWindow;
  if (!win.__hfFirstPassHidden) return false;
  win.__hfFirstPassHidden = false;
  for (const style of document.querySelectorAll(`style[${HIDE_ATTR}]`)) style.remove();
  return true;
}

/** Run once composition scripts have loaded. Removable once published builds older than revealClip are retired. */
export function keepInlineHideRulesForOlderShaders(): void {
  if (!olderShaderBuildOnPage()) return;
  const skip = document.querySelector(`style[${SKIP_ATTR}]`);
  if (skip) skip.textContent = skipHiddenImages(HIDDEN_CLIP_BY_INLINE_STYLE);
  const contents = document.querySelector(`style[${CONTENTS_ATTR}]`);
  if (contents) contents.textContent = hideHiddenClipContents(HIDDEN_CLIP_BY_INLINE_STYLE);
}
