import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "@hyperframes/engine";
import type { Page } from "puppeteer-core";
import type { LayeredPaintLayer } from "./layeredFrameState.js";

export type LayeredImage = { path: string; x: number; y: number; width: number; height: number };

export function saveLayeredImage(png: Buffer, directory: string): LayeredImage {
  const { width, height, data } = decodePng(png);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) {
    left = 0;
    top = 0;
    right = 0;
    bottom = 0;
  }
  const w = right - left + 1;
  const h = bottom - top + 1;
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    pixels.set(
      data.subarray(((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4),
      y * w * 4,
    );
  }
  const cropped = encodePng(w, h, pixels);
  const path = join(directory, `${createHash("sha256").update(cropped).digest("hex")}.png`);
  writeFileSync(path, cropped);
  return { path, x: left, y: top, width: w, height: h };
}

/** Inspector stylesheets isolate paint without changing author attributes or child indices. */
export async function createLayeredDomCapture(page: Page, directory: string) {
  mkdirSync(directory, { recursive: true });
  const client = await page.createCDPSession();
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { frameTree } = await client.send("Page.getFrameTree");
  const { styleSheetId } = await client.send("CSS.createStyleSheet", {
    frameId: frameTree.frame.id,
  });
  const rootSelector = await page.evaluate(() => {
    const root = document.querySelector("video")?.closest("[data-composition-id]");
    if (!root) throw Error("Certified root disappeared");
    const parts = [];
    for (let node: Element | null = root; node; node = node.parentElement) {
      const index = node.parentElement ? [...node.parentElement.children].indexOf(node) + 1 : 1;
      parts.unshift(`:nth-child(${index})`);
    }
    return parts.join(" > ");
  });
  const cache = new Map<string, LayeredImage>();
  let captures = 0;
  const timings = { keyMs: 0, screenshotMs: 0, cropMs: 0 };
  await client.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  const fontState = await page.evaluateHandle(() => {
    const ids = new WeakMap<FontFace, number>();
    let nextId = 0;
    return () =>
      [...document.fonts].map((font) => {
        if (!ids.has(font)) ids.set(font, nextId++);
        return [
          ids.get(font),
          ...[
            "family",
            "status",
            "style",
            "weight",
            "stretch",
            "unicodeRange",
            "variant",
            "featureSettings",
            "variationSettings",
            "display",
            "ascentOverride",
            "descentOverride",
            "lineGapOverride",
            "sizeAdjust",
          ].map((name) => Reflect.get(font, name)),
        ];
      });
  });
  return {
    async capture(
      layer: Extract<LayeredPaintLayer, { kind: "dom" }> | "background",
    ): Promise<LayeredImage> {
      const indices = layer === "background" ? [] : layer.childIndices;
      // Read before installing the mask. CSSOM, animation and inherited styles are part of the key.
      const keyStarted = performance.now();
      const key = await page.evaluate(
        async (indices, fonts) => {
          const root = document.querySelector("video")?.closest("[data-composition-id]");
          if (!root) throw Error("Certified root disappeared");
          const roots = indices.map((index) => root.children[index]);
          if (roots.some((node) => node === undefined)) throw Error("Certified child disappeared");
          const nodes = roots.flatMap((node) => [node!, ...node!.querySelectorAll("*")]);
          if (indices.length === 0) {
            for (let node: Element | null = root; node; node = node.parentElement) nodes.push(node);
          }
          // These surfaces can change paint without a computed-style or text change.
          const liveTags = [
            "INPUT",
            "TEXTAREA",
            "SELECT",
            "OPTION",
            "PROGRESS",
            "METER",
            "DETAILS",
            "LI",
            "OL",
            "UL",
            "IMG",
            "OBJECT",
            "EMBED",
          ];
          let uncacheable = document.getAnimations().length > 0;
          const isLive = (node: Element | null) =>
            node instanceof HTMLElement &&
            (node.isContentEditable || liveTags.includes(node.tagName));
          if (isLive(document.activeElement)) uncacheable = true;
          const facts = nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            if (isLive(node)) uncacheable = true;
            const styles = [undefined, "::before", "::after"].map((pseudo) => {
              const style = getComputedStyle(node, pseudo);
              const values = [...style].map((name) => style.getPropertyValue(name));
              if (
                values.some((value) => /\b(url|paint)\(/i.test(value)) ||
                style.maskImage !== "none"
              )
                uncacheable = true;
              if (pseudo && !["none", "normal", '""'].includes(style.content)) uncacheable = true;
              return values;
            });
            return [
              node.tagName,
              indices.length === 0 ? null : node.textContent,
              [...node.attributes].map((attribute) => [attribute.name, attribute.value]),
              [rect.x, rect.y, rect.width, rect.height],
              [node.scrollLeft, node.scrollTop],
              styles,
            ];
          });
          if (!crypto.subtle || uncacheable) return null;
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify([fonts(), facts])),
          );
          return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        },
        indices,
        fontState,
      );
      timings.keyMs += performance.now() - keyStarted;
      const cacheKey = JSON.stringify([layer, key]);
      const cached = key === null ? undefined : cache.get(cacheKey);
      if (cached) return cached;
      const selectors = await page.evaluate(
        ({ indices, rootSelector }) => {
          const root = document.querySelector("video")!.closest("[data-composition-id]")!;
          return [...root.children].flatMap((_child, index) =>
            indices.includes(index)
              ? []
              : [
                  `${rootSelector} > :nth-child(${index + 1})`,
                  `${rootSelector} > :nth-child(${index + 1}) *`,
                ],
          );
        },
        { indices, rootSelector },
      );
      const clear =
        layer === "background"
          ? ""
          : `${rootSelector
              .split(" > ")
              .map((_part, index, parts) => parts.slice(0, index + 1).join(" > "))
              .join(
                ",",
              )}{background:transparent!important;box-shadow:none!important;border-color:transparent!important;outline:none!important}`;
      await client.send("CSS.setStyleSheetText", {
        styleSheetId,
        text: `${selectors.join(",")}{visibility:hidden!important}${clear}`,
      });
      try {
        const screenshotStarted = performance.now();
        const result = await client.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        });
        timings.screenshotMs += performance.now() - screenshotStarted;
        const cropStarted = performance.now();
        const image = saveLayeredImage(Buffer.from(result.data, "base64"), directory);
        timings.cropMs += performance.now() - cropStarted;
        if (key !== null) cache.set(cacheKey, image);
        captures++;
        return image;
      } finally {
        await client.send("CSS.setStyleSheetText", { styleSheetId, text: "" });
      }
    },
    captures: () => captures,
    timings: () => ({ ...timings }),
    async dispose() {
      try {
        await client.send("CSS.setStyleSheetText", { styleSheetId, text: "" });
        await client.send("Emulation.setDefaultBackgroundColorOverride", {});
      } finally {
        try {
          await client.detach();
        } finally {
          await fontState.dispose();
        }
      }
    },
  };
}
