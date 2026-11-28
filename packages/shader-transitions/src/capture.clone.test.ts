// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScene, forceSceneVisibleInClone } from "./capture.js";

describe("forceSceneVisibleInClone", () => {
  it("shows the scene and its timed clips while the runtime's first-pass hide rule is up", () => {
    document.head.innerHTML =
      "<style>[data-start]:not(video, audio, img) { visibility: hidden !important; }</style>";
    document.body.innerHTML = '<div id="scene" data-start="0"><p data-start="0">Title</p></div>';
    const scene = document.getElementById("scene") as HTMLElement;

    forceSceneVisibleInClone(scene, document);

    const title = scene.querySelector("p") as HTMLElement;
    expect([scene, title].map((el) => getComputedStyle(el).visibility)).toEqual([
      "visible",
      "visible",
    ]);
  });

  it("shows the contents of a scene the runtime marked hidden", () => {
    document.head.innerHTML =
      "<style>[data-hf-clip-hidden] * { visibility: hidden !important; }</style>";
    document.body.innerHTML =
      '<div id="scene" data-start="5" data-hf-clip-hidden style="visibility: hidden"><p>Title</p></div>';
    const scene = document.getElementById("scene") as HTMLElement;

    forceSceneVisibleInClone(scene, document);

    expect(getComputedStyle(scene.querySelector("p") as HTMLElement).visibility).toBe("visible");
  });
});

describe("captureScene with html-in-canvas", () => {
  const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const FORM_MEMBERS = {
    layoutsubtree: ["requestPaint", "layoutSubtree"],
    drawable: ["requestPaint", "updateElementGeometry"],
  } as const;

  // The scene copy each drawElementImage call draws, and the canvas it draws on.
  function stubHtmlInCanvas(form: keyof typeof FORM_MEMBERS) {
    vi.stubGlobal(
      "CanvasRenderingContext2D",
      class {
        drawElementImage(): void {}
      },
    );
    for (const name of FORM_MEMBERS[form]) canvasProto[name] = () => {};
    const drawn: Array<{ el: HTMLElement; canvas: HTMLCanvasElement }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return {
        fillRect: () => {},
        drawImage: () => {},
        drawElementImage: (el: HTMLElement) => drawn.push({ el, canvas: this }),
      };
    } as unknown as HTMLCanvasElement["getContext"]);
    return drawn;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const name of ["requestPaint", "layoutSubtree", "updateElementGeometry"]) {
      delete canvasProto[name];
    }
  });

  it("draws a scene the runtime hid, and its timed clips, visible when asked to", async () => {
    document.body.innerHTML =
      '<div id="scene" style="visibility: hidden; opacity: 0"><p data-start="0" style="visibility: hidden">Title</p></div>';
    const drawn = stubHtmlInCanvas("layoutsubtree");

    await captureScene(document.getElementById("scene") as HTMLElement, "#000", 16, 9, {
      forceVisible: true,
    });

    const el = drawn[0]!.el;
    const title = el.querySelector("p") as HTMLElement;
    expect([el.style.opacity, el.style.visibility, title.style.visibility]).toEqual([
      "1",
      "visible",
      "visible",
    ]);
  });

  it.each([
    ["layoutsubtree", "layoutsubtree", null, false],
    ["drawable", "content", "drawable", true],
  ] as const)(
    "draws a scene in the %s form, with that form's attributes",
    async (form, canvasAttr, canvasValue, copyMarked) => {
      document.body.innerHTML = '<div id="scene"><p>Title</p></div>';
      const drawn = stubHtmlInCanvas(form);

      await captureScene(document.getElementById("scene") as HTMLElement, "#000", 16, 9);

      expect(drawn).toHaveLength(1);
      const { el, canvas } = drawn[0]!;
      expect(canvas.getAttribute(canvasAttr)).toBe(canvasValue ?? "");
      expect(el.hasAttribute("drawable")).toBe(copyMarked);
    },
  );
});
