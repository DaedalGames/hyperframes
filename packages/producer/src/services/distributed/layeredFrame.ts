import {
  MEDIA_RENDER_ID_ATTR,
  RENDER_FRAME_ID_PREFIX,
  RENDER_FRAME_ID_SUFFIX,
} from "@hyperframes/core";
import type { Page } from "puppeteer-core";
import {
  classifyLayeredFrame,
  LAYERED_NODE_LIMIT,
  type LayeredFrameState,
  type LayeredNodeState,
  type LayeredFrame,
} from "./layeredFrameState.js";

export async function readLayeredFrameState(page: Page): Promise<LayeredFrameState> {
  return page.evaluate(
    ({ renderIdAttr, prefix, suffix, nodeLimit }): LayeredFrameState => {
      const videos = [...document.querySelectorAll("video")];
      const root = videos[0]?.closest("[data-composition-id]") ?? null;
      const nodes = root === null ? [] : [...root.querySelectorAll("*")];
      if (nodes.length > nodeLimit || videos.length > nodeLimit) return { kind: "scene_limit" };
      const cache = new Map<Element, LayeredNodeState>();
      const read = (node: Element): LayeredNodeState => {
        const cached = cache.get(node);
        if (cached) return cached;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const pseudos = ["::before", "::after"].map((pseudo) => getComputedStyle(node, pseudo));
        const matrix = new DOMMatrix(style.transform === "none" ? undefined : style.transform);
        const facts: LayeredNodeState = {
          tag: node.tagName.toUpperCase(),
          rect: [rect.x, rect.y, rect.width, rect.height],
          position: style.position,
          zIndex: style.zIndex,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          transforms: [
            style.transform,
            ...["translate", "rotate", "scale"].map((key) => style.getPropertyValue(key)),
          ],
          matrix: { is2D: matrix.is2D, a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d },
          filter: style.filter,
          clipPath: style.clipPath,
          legacyClip: style.clip,
          zoom: style.zoom,
          contentVisibility: style.contentVisibility,
          imageRendering: style.imageRendering,
          maskImage: style.getPropertyValue("mask-image"),
          mixBlendMode: style.mixBlendMode,
          backdropFilter: style.getPropertyValue("backdrop-filter"),
          perspective: style.perspective,
          transformStyle: style.transformStyle,
          radii: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ],
          pseudoContents: pseudos.map((style) => style.content),
          pseudoEffects: pseudos.map((style) => ({
            mixBlendMode: style.mixBlendMode,
            backdropFilter: style.getPropertyValue("backdrop-filter"),
            perspective: style.perspective,
            transformStyle: style.transformStyle,
          })),
          pseudoZIndices: pseudos
            .filter((style) => style.content !== "none" && style.content !== "normal")
            .map((style) => style.zIndex),
          objectFit: style.objectFit,
          objectPosition: style.objectPosition,
          boxShadow: style.boxShadow,
          backgroundImage: style.backgroundImage,
          backgroundColor: style.backgroundColor,
          outlineStyle: style.outlineStyle,
          spacing: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ],
          overflow: [style.overflowX, style.overflowY],
          shadowRoot: node.shadowRoot !== null,
          topLayer: node.matches(":modal, :popover-open"),
        };
        cache.set(node, facts);
        return facts;
      };
      const hasText = (node: Element): boolean =>
        [...node.childNodes].some(
          (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
        );
      const readAncestors = (node: Element | null) => {
        const ancestors = [];
        for (let ancestor = node?.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestors.length >= nodeLimit) return null;
          ancestors.push({
            node: read(ancestor),
            extraPaint:
              hasText(ancestor) ||
              [...ancestor.children].some(
                (child) =>
                  child !== root &&
                  !child.contains(root) &&
                  !["SCRIPT", "STYLE", "LINK", "HEAD"].includes(child.tagName),
              ),
          });
        }
        return ancestors;
      };
      const ancestors = readAncestors(root);
      if (ancestors === null) return { kind: "scene_limit" };
      const proxies = new Map<Element, string>();
      const videoStates = videos.map((video) => {
        const id = video.getAttribute(renderIdAttr) || video.id;
        const proxy = document.getElementById(`${prefix}${id}${suffix}`);
        const ready =
          proxy instanceof HTMLImageElement &&
          proxy.parentElement === root &&
          proxy.complete &&
          proxy.naturalWidth > 0;
        if (proxy) proxies.set(proxy, id);
        return {
          id,
          direct: root !== null && video.parentElement === root,
          ready,
          proxy: proxy ? read(proxy) : null,
        };
      });
      const unsupportedRules = (rules: CSSRuleList): boolean =>
        [...rules].some((rule) => {
          if (rule instanceof CSSStyleRule && /::(?!before\b|after\b)/i.test(rule.selectorText))
            return true;
          if (rule instanceof CSSImportRule && rule.styleSheet !== null)
            return unsupportedRules(rule.styleSheet.cssRules);
          if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule)
            return unsupportedRules(rule.cssRules);
          return false;
        });
      return {
        kind: "observed",
        root: root ? read(root) : null,
        rootText: root ? hasText(root) : false,
        unsupportedPseudo: [...document.styleSheets, ...document.adoptedStyleSheets].some((sheet) =>
          unsupportedRules(sheet.cssRules),
        ),
        ancestors,
        nodes: nodes.map(read),
        videos: videoStates,
        children: (root === null ? [] : [...root.children]).map((child) => {
          const videoId = proxies.get(child);
          const facts = {
            node: read(child),
            descendantZIndices: [
              ...read(child).pseudoZIndices,
              ...[...child.querySelectorAll("*")].flatMap((node) => {
                const facts = read(node);
                return [facts.zIndex, ...facts.pseudoZIndices];
              }),
            ],
          };
          if (videoId === undefined) return { ...facts, kind: "dom" as const };
          return { ...facts, kind: "video" as const, videoId };
        }),
      };
    },
    {
      renderIdAttr: MEDIA_RENDER_ID_ATTR,
      prefix: RENDER_FRAME_ID_PREFIX,
      suffix: RENDER_FRAME_ID_SUFFIX,
      nodeLimit: LAYERED_NODE_LIMIT,
    },
  );
}

export async function readLayeredFrame(page: Page): Promise<LayeredFrame> {
  return classifyLayeredFrame(await readLayeredFrameState(page));
}
