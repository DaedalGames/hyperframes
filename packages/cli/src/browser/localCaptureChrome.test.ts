import { describe, expect, it } from "vitest";
import { localCaptureChrome } from "./launch.js";

const page = (attributes: string) => `<div data-composition-id="main" ${attributes}></div>`;
const viewport = { width: 640, height: 360 };

describe("the flags a local capture launches Chrome with", () => {
  it("turn WebGPU on for a composition that declares it", async () => {
    const chrome = await localCaptureChrome(
      page("data-requires-webgpu"),
      viewport,
      "/no/chrome",
      "software",
    );
    expect(chrome.requiresWebGpu).toBe(true);
    expect(chrome.args).toContain("--enable-unsafe-webgpu");
  });

  it("leave WebGPU off in software mode for a composition that does not need it", async () => {
    const chrome = await localCaptureChrome(page(""), viewport, "/no/chrome", "software");
    expect(chrome.requiresWebGpu).toBe(false);
    expect(chrome.args).not.toContain("--enable-unsafe-webgpu");
  });
});
