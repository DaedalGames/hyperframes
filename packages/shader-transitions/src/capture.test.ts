import { afterEach, describe, expect, it, vi } from "vitest";
import { isHtmlInCanvasCaptureSupported } from "./capture.js";

// A window as core's html-in-canvas check reads it: drawElementImage on the 2D context, the form on the canvas.
function stubBrowser(canvas: object, drawElementImage = true): void {
  const document = { createElement: () => canvas };
  vi.stubGlobal("window", {
    document,
    CanvasRenderingContext2D: { prototype: drawElementImage ? { drawElementImage() {} } : {} },
  });
  vi.stubGlobal("document", document);
}

describe("isHtmlInCanvasCaptureSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false outside the browser", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);

    expect(isHtmlInCanvasCaptureSupported()).toBe(false);
  });

  it("returns true for Chrome 155's layoutsubtree form", () => {
    stubBrowser({ requestPaint() {}, layoutSubtree: true });

    expect(isHtmlInCanvasCaptureSupported()).toBe(true);
  });

  it("returns true for Chrome 157+'s drawable form, which has no layoutSubtree", () => {
    stubBrowser({ requestPaint() {}, updateElementGeometry() {} });

    expect(isHtmlInCanvasCaptureSupported()).toBe(true);
  });

  it("returns false when drawElementImage is missing", () => {
    stubBrowser({ requestPaint() {}, layoutSubtree: true }, false);

    expect(isHtmlInCanvasCaptureSupported()).toBe(false);
  });
});
