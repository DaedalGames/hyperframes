import { SCENE_PART_ATTR } from "../sceneParts";
import { STUDIO_PREVIEW_FAR_SCENE_ATTR as FAR } from "../studioPreviewMark";

type Span = { start: number; end: number } | null;

const HOSTS = `[${SCENE_PART_ATTR}]:not(style, script)`;
const OUT_OF_FLOW = new Set(["absolute", "fixed"]);

type Timed = { host: HTMLElement; span: { start: number; end: number } };

/** Whether each span, sorted by start, is the playing one or a neighbour; between scenes, the one before the gap plays. */
function nearPlayhead(spans: Array<{ start: number; end: number }>, time: number): boolean[] {
  const playing = spans.flatMap((span, i) => (span.start <= time && time <= span.end ? [i] : []));
  const before = spans.filter((span) => span.start <= time).length - 1;
  const lo = playing.length > 0 ? playing[0]! : before;
  const hi = playing.length > 0 ? playing[playing.length - 1]! : before;
  return spans.map((_, i) => i >= lo - 1 && i <= hi + 1);
}

function farFrom(timed: Timed[], time: number): Set<HTMLElement> {
  const near = nearPlayhead(
    timed.map((s) => s.span),
    time,
  );
  return new Set(timed.filter((_, i) => !near[i]).map((s) => s.host));
}

/**
 * Preview scenes beyond the playing scene's neighbours stay mounted but skip style, layout and paint.
 * Each keeps the size it had when last rendered, so a script measuring its host reads the same box.
 * Only preview bundles tag scene hosts, so a render never gets here with any.
 */
export function createFarSceneSkip(spanOf: (host: Element) => Span): (time: number) => void {
  let hosts: HTMLElement[] | null = null;
  let sheet: HTMLStyleElement | null = null;
  const sizes = new Map<string, string>();
  const timedHosts = (list: HTMLElement[]): Timed[] =>
    list
      .map((host) => ({ host, span: spanOf(host) }))
      .filter((s): s is Timed => Number.isFinite(s.span?.start))
      .sort((a, b) => a.span.start - b.span.start);
  // Each host's box and position as of its last render, reported after layout: read at a cut, where the cut
  // leaves the page's style dirty, they would force a full style and layout pass first.
  const rendered = new WeakMap<Element, { size: string; outOfFlow: boolean }>();
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const { target, borderBoxSize } of entries) {
            const box = borderBoxSize?.[0];
            if (!box) continue;
            rendered.set(target, {
              size: `${Math.round(box.inlineSize)}px ${Math.round(box.blockSize)}px`,
              outOfFlow: OUT_OF_FLOW.has(getComputedStyle(target).position),
            });
          }
        })
      : null;
  // Read directly only for a host not reported yet; measured before any is marked, so one layout serves them all.
  const lastRender = (host: HTMLElement) =>
    rendered.get(host) ?? {
      size: `${host.offsetWidth}px ${host.offsetHeight}px`,
      outOfFlow: OUT_OF_FLOW.has(getComputedStyle(host).position),
    };
  // True when a size changed.
  const measureLeaving = (far: Set<HTMLElement>): boolean => {
    let resized = false;
    for (const host of far) {
      if (host.hasAttribute(FAR)) continue;
      const { size, outOfFlow } = lastRender(host);
      // Containment makes a host a containing block and margin boundary; only an out-of-flow one already is.
      if (!outOfFlow) {
        far.delete(host);
        continue;
      }
      const name = host.getAttribute(SCENE_PART_ATTR)!;
      resized ||= sizes.get(name) !== size;
      sizes.set(name, size);
    }
    return resized;
  };
  const writeSheet = () => {
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
  };
  return (time) => {
    if (!hosts || hosts.some((host) => !host.isConnected)) {
      // An observed element stays alive with its observer, so a host that left the page is let go.
      for (const host of hosts ?? []) if (!host.isConnected) observer?.unobserve(host);
      hosts = Array.from(document.querySelectorAll<HTMLElement>(HOSTS));
      for (const host of hosts) observer?.observe(host);
    }
    if (hosts.length === 0) return;
    const far = farFrom(timedHosts(hosts), time);
    if (measureLeaving(far) || !sheet?.isConnected) writeSheet();
    for (const host of hosts)
      if (far.has(host) !== host.hasAttribute(FAR)) host.toggleAttribute(FAR);
  };
}
