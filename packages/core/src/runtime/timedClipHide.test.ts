import { afterEach, describe, expect, it } from "vitest";
import { STUDIO_PREVIEW_MARK_META } from "../studioPreviewMark";
import { liftClipHiddenMark } from "./clipReveal";
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
    document.body.innerHTML = `<div data-start="5" ${CLIP_HIDDEN_ATTR} style="visibility: hidden"><p style="visibility: visible">Later</p></div>`;
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

describe("liftClipHiddenMark", () => {
  it("lifts a clip's mark and puts it back, and leaves an unmarked element alone", () => {
    document.body.innerHTML = `<div id="marked" ${CLIP_HIDDEN_ATTR}></div><div id="plain"></div>`;
    const marked = document.getElementById("marked")!;
    const plain = document.getElementById("plain")!;

    const putMarkedBack = liftClipHiddenMark(marked);
    const putPlainBack = liftClipHiddenMark(plain);
    expect([marked.hasAttribute(CLIP_HIDDEN_ATTR), plain.hasAttribute(CLIP_HIDDEN_ATTR)]).toEqual([
      false,
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
