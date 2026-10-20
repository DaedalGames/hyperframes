import { afterEach, describe, expect, it } from "vitest";
import { STUDIO_PREVIEW_MARK_META } from "../studioPreviewMark";
import { revealClip } from "./clipReveal";
import {
  CLIP_HIDDEN_ATTR,
  hideTimedClipsUntilFirstPass,
  revealTimedClipsAfterFirstPass,
  showHiddenClips,
} from "./timedClipHide";

const injectedSelectors = () =>
  Array.from(document.head.querySelectorAll("style")).flatMap((style) =>
    Array.from(style.sheet!.cssRules).map((rule) => (rule as CSSStyleRule).selectorText),
  );

afterEach(() => {
  revealTimedClipsAfterFirstPass();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("hideTimedClipsUntilFirstPass", () => {
  it("injects no rule that matches an element's inline style, in playback or Studio preview", () => {
    document.head.append(
      Object.assign(document.createElement("meta"), { name: STUDIO_PREVIEW_MARK_META }),
    );
    hideTimedClipsUntilFirstPass();
    const selectors = injectedSelectors();
    expect(selectors.length).toBeGreaterThan(2);
    expect(selectors.filter((selector) => /\[style\b/.test(selector))).toEqual([]);
  });

  it("hides a hidden clip's contents by the runtime's mark alone", () => {
    hideTimedClipsUntilFirstPass();
    document.body.innerHTML = `<div data-start="5" ${CLIP_HIDDEN_ATTR}><p style="visibility: visible">Later</p></div>`;
    expect(getComputedStyle(document.querySelector("p")!).visibility).toBe("hidden");
  });

  it("keeps a hidden clip's contents hidden over an author's important visibility rule", () => {
    document.head.innerHTML = "<style>p.title { visibility: visible !important; }</style>";
    hideTimedClipsUntilFirstPass();
    document.body.innerHTML = `<div data-start="5" ${CLIP_HIDDEN_ATTR}><p class="title">Later</p></div>`;
    expect(getComputedStyle(document.querySelector("p")!).visibility).toBe("hidden");
  });
});

describe("showHiddenClips", () => {
  it("lifts the mark while the clips show and puts it back with their inline hide", () => {
    hideTimedClipsUntilFirstPass();
    document.body.innerHTML = `<div data-start="5" ${CLIP_HIDDEN_ATTR} style="visibility: hidden"><p>Later</p></div>`;
    const clip = document.querySelector<HTMLElement>("[data-start]")!;

    const hideAgain = showHiddenClips();
    expect([clip.hasAttribute(CLIP_HIDDEN_ATTR), clip.style.visibility]).toEqual([
      false,
      "visible",
    ]);
    hideAgain();
    expect([clip.hasAttribute(CLIP_HIDDEN_ATTR), clip.style.visibility]).toEqual([true, "hidden"]);
  });
});

describe("revealClip", () => {
  it("shows a clip and lifts its mark until put back, and leaves an unmarked element unmarked", () => {
    document.body.innerHTML = `<div id="marked" ${CLIP_HIDDEN_ATTR} style="visibility: hidden"></div><div id="plain"></div>`;
    const marked = document.getElementById("marked")!;
    const plain = document.getElementById("plain")!;

    const putMarkedBack = revealClip(marked, "important");
    const putPlainBack = revealClip(plain);
    expect([marked.style.cssText, marked.hasAttribute(CLIP_HIDDEN_ATTR)]).toEqual([
      "visibility: visible !important;",
      false,
    ]);
    expect([plain.style.visibility, plain.hasAttribute(CLIP_HIDDEN_ATTR)]).toEqual([
      "visible",
      false,
    ]);
    putMarkedBack();
    putPlainBack();
    expect([marked.hasAttribute(CLIP_HIDDEN_ATTR), plain.hasAttribute(CLIP_HIDDEN_ATTR)]).toEqual([
      true,
      false,
    ]);
  });
});
