import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fpsToFfmpegArg, type Fps } from "@hyperframes/core";
import type { FrameLookupTable } from "@hyperframes/engine";
import type { Page } from "puppeteer-core";
import type { LayeredGeometry, LayeredVideoGeometry } from "./layeredFrameState.js";
import { saveLayeredImage, type LayeredImage } from "./layeredDom.js";

/** Image2 receives the existing lookup's exact selected paths, including holds and loops. */
export function writeLayeredSequence(paths: readonly string[], directory: string, fps: Fps) {
  if (paths.length === 0) throw Error("Empty layered image sequence");
  mkdirSync(directory, { recursive: true });
  const extension = extname(paths[0]!);
  for (const [index, path] of paths.entries()) {
    if (extname(path) !== extension) throw Error("Mixed layered image codecs");
    symlinkSync(
      resolve(path),
      join(directory, `frame_${String(index).padStart(6, "0")}${extension}`),
    );
  }
  return [
    "-framerate",
    fpsToFfmpegArg(fps),
    "-start_number",
    "0",
    "-i",
    join(directory, `frame_%06d${extension}`),
  ];
}

export function selectLayeredVideoFrames(
  table: FrameLookupTable,
  geometry: LayeredGeometry,
  range: { startFrame: number; endFrame: number },
  fps: Fps,
): Map<string, string[]> | null {
  const paths = new Map(geometry.videos.map((video) => [video.videoId, [] as string[]]));
  for (let frame = range.startFrame; frame < range.endFrame; frame++) {
    const active = table.getActiveFramePayloads((frame * fps.den) / fps.num);
    for (const [videoId, selected] of paths) {
      const payload = active.get(videoId);
      if (!payload) return null;
      selected.push(payload.framePath);
    }
  }
  return paths;
}

export async function captureLayeredVideoAssets(input: {
  page: Page;
  geometry: LayeredVideoGeometry;
  clips: LayeredGeometry["clips"];
  width: number;
  height: number;
  directory: string;
}): Promise<{ maskPath: string; shadow: LayeredImage | null }> {
  const { page, geometry, clips, width, height, directory } = input;
  mkdirSync(directory, { recursive: true });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const [x, y, w, h] = geometry.rect;
  const box = { left: 0, top: 0, right: width, bottom: height };
  for (const [left, top, cw, ch] of clips) {
    box.left = Math.max(box.left, left);
    box.top = Math.max(box.top, top);
    box.right = Math.min(box.right, left + cw);
    box.bottom = Math.min(box.bottom, top + ch);
  }
  await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
  await page.evaluate(
    ({ x, y, w, h, box, geometry }) => {
      const wrapper = document.createElement("div");
      Object.assign(wrapper.style, {
        position: "absolute",
        overflow: "hidden",
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${Math.max(0, box.right - box.left)}px`,
        height: `${Math.max(0, box.bottom - box.top)}px`,
      });
      const shape = document.createElement("div");
      shape.id = "shape";
      Object.assign(shape.style, {
        position: "absolute",
        left: `${x - box.left}px`,
        top: `${y - box.top}px`,
        width: `${w}px`,
        height: `${h}px`,
        background: "transparent",
        boxShadow: geometry.boxShadow,
        borderTopLeftRadius: geometry.radii[0],
        borderTopRightRadius: geometry.radii[1],
        borderBottomRightRadius: geometry.radii[2],
        borderBottomLeftRadius: geometry.radii[3],
      });
      wrapper.append(shape);
      document.body.append(wrapper);
    },
    { x, y, w, h, box, geometry },
  );
  const shadow =
    geometry.boxShadow === "none"
      ? null
      : saveLayeredImage(
          Buffer.from(await page.screenshot({ type: "png", omitBackground: true })),
          directory,
        );
  await page.evaluate(() => {
    const shape = document.getElementById("shape")!;
    shape.style.boxShadow = "none";
    shape.style.background = "white";
  });
  // Local mask coordinates preserve Chrome's radius and ancestor clipping pixels.
  const maskPath = join(directory, "mask.png");
  const png = await page.screenshot({
    type: "png",
    omitBackground: true,
    captureBeyondViewport: true,
    clip: { x, y, width: w, height: h },
  });
  writeFileSync(maskPath, png);
  return { maskPath, shadow };
}
