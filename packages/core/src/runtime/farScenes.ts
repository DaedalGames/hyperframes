import { SCENE_PART_ATTR } from "../sceneParts";
import { STUDIO_PREVIEW_FAR_SCENE_ATTR as FAR } from "../studioPreviewMark";

type Span = { start: number; end: number } | null;

const HOSTS = `[${SCENE_PART_ATTR}]:not(style, script)`;
const OUT_OF_FLOW = new Set(["absolute", "fixed"]);

/**
 * Preview scenes beyond the playing scene's neighbours stay mounted but skip style, layout and paint.
 * Each keeps the size it had when last rendered, so a script measuring its host reads the same box.
 * Only preview bundles tag scene hosts, so a render never gets here with any.
 */
export function createFarSceneSkip(spanOf: (host: Element) => Span): (time: number) => void {
  let hosts: HTMLElement[] | null = null;
  let sheet: HTMLStyleElement | null = null;
  const sizes = new Map<string, string>();
  return (time) => {
    if (!hosts || hosts.some((host) => !host.isConnected))
      hosts = Array.from(document.querySelectorAll<HTMLElement>(HOSTS));
    if (hosts.length === 0) return;
    const timed = hosts
      .map((host) => ({ host, span: spanOf(host) }))
      .filter((s): s is { host: HTMLElement; span: { start: number; end: number } } =>
        Number.isFinite(s.span?.start),
      )
      .sort((a, b) => a.span.start - b.span.start);
    let lo = -1;
    let hi = -1;
    timed.forEach(({ span }, i) => {
      if (span.start > time || time > span.end) return;
      if (lo < 0) lo = i;
      hi = i;
    });
    // Between scenes, the one before the gap stands in for the playing one.
    if (lo < 0) lo = hi = timed.filter(({ span }) => span.start <= time).length - 1;
    const far = new Set(timed.filter((_, i) => i < lo - 1 || i > hi + 1).map((s) => s.host));
    // Measured before any is marked, so one layout serves them all.
    let resized = false;
    for (const host of far) {
      if (host.hasAttribute(FAR)) continue;
      // Containment makes a host a containing block and margin boundary; only an out-of-flow one already is.
      if (!OUT_OF_FLOW.has(getComputedStyle(host).position)) {
        far.delete(host);
        continue;
      }
      const name = host.getAttribute(SCENE_PART_ATTR)!;
      const size = `${host.offsetWidth}px ${host.offsetHeight}px`;
      if (sizes.get(name) === size) continue;
      sizes.set(name, size);
      resized = true;
    }
    if (resized || !sheet?.isConnected) {
      sheet ??= document.createElement("style");
      sheet.textContent = [
        `[${FAR}] { content-visibility: hidden; }`,
        ...Array.from(
          sizes,
          ([name, size]) =>
            `[${SCENE_PART_ATTR}="${CSS.escape(name)}"][${FAR}] { contain-intrinsic-size: ${size}; }`,
        ),
      ].join("\n");
      if (!sheet.isConnected) document.head.appendChild(sheet);
    }
    for (const host of hosts)
      if (far.has(host) !== host.hasAttribute(FAR)) host.toggleAttribute(FAR);
  };
}
