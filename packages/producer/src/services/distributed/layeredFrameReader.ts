import { MEDIA_RENDER_ID_ATTR, renderFrameIdForRenderId } from "@hyperframes/core";
import { isTransientBrowserError } from "@hyperframes/engine";
import type { Page } from "puppeteer-core";
import { readLayeredFrame } from "./layeredFrame.js";
import type { LayeredFrame } from "./layeredFrameState.js";

export async function createLayeredFrameReader(page: Page) {
  const videoIds = await page.evaluate(
    (attr) =>
      [...document.querySelectorAll("video")].map((video) => video.getAttribute(attr) || video.id),
    MEDIA_RENDER_ID_ATTR,
  );
  const guard = await page.evaluateHandle((proxyIds) => {
    const videos = [...document.querySelectorAll("video")];
    const proxies = proxyIds.map((id) => document.getElementById(id));
    const root = videos[0]?.closest("[data-composition-id]") ?? null;
    const relevant = new Set<Element>([
      ...videos,
      ...proxies.filter((node): node is HTMLElement => node !== null),
    ]);
    for (let node = root; node; node = node.parentElement) relevant.add(node);
    const children = root ? [...root.children] : [];
    let above: Element[] = [];
    const safePaint = new Set([
      "transform",
      "transform-origin",
      "translate",
      "rotate",
      "scale",
      "opacity",
    ]);
    const inlineShape = (text: string) => {
      const style = document.createElement("div").style;
      style.cssText = text;
      return [...style]
        .filter((key) => !safePaint.has(key))
        .sort()
        .map((key) => [key, style.getPropertyValue(key), style.getPropertyPriority(key)]);
    };
    const isAbove = (node: Element) =>
      above.some((group) => group === node || group.contains(node));
    const pending: MutationRecord[] = [];
    const observer = new MutationObserver((records) => pending.push(...records));
    observer.observe(document, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    const empty = new Map(
      [...document.querySelectorAll("*")].map((node) => [node, node.matches(":empty")]),
    );
    const unescapeCss = (text: string) =>
      text.replace(
        /\\(?:([0-9a-f]{1,6})\s?|([^\n\r\f]))/gi,
        (_match, hex: string | undefined, character: string | undefined) => {
          if (hex === undefined) return character ?? "";
          const point = Number.parseInt(hex, 16);
          if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
            return "\ufffd";
          return String.fromCodePoint(point);
        },
      );
    const readStylesheets = () => {
      const selectors: string[] = [];
      const rules = (sheet: CSSStyleSheet): string => {
        const visit = (rule: CSSRule): string => {
          if (rule instanceof CSSImportRule)
            return rule.cssText + (rule.styleSheet === null ? "" : rules(rule.styleSheet));
          if (rule instanceof CSSStyleRule) selectors.push(rule.selectorText);
          if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule) {
            for (const child of rule.cssRules) visit(child);
          }
          return rule.cssText;
        };
        return `${sheet.disabled}:${sheet.media.mediaText}:${[...sheet.cssRules].map(visit).join("\n")}`;
      };
      const css = [...document.styleSheets, ...document.adoptedStyleSheets].map(rules).join("\n");
      return { css, selectors };
    };
    const textStructureChanged = (record: MutationRecord, node: Element): boolean => {
      const textOnly = [...record.addedNodes, ...record.removedNodes].every(
        (child) => child.nodeType === Node.TEXT_NODE,
      );
      const nowEmpty = node.matches(":empty");
      const unchanged = textOnly && empty.get(node) === nowEmpty;
      empty.set(node, nowEmpty);
      return !unchanged;
    };
    const paintChanged = (node: Element, previousStyle: string | null): boolean => {
      const style = getComputedStyle(node);
      new DOMMatrix(style.transform === "none" ? undefined : style.transform);
      return (
        JSON.stringify(inlineShape(previousStyle ?? "")) !==
        JSON.stringify(inlineShape(node.getAttribute("style") ?? ""))
      );
    };
    const attributeChanges = (
      node: Element,
      attributeName: string | null,
      oldValue: string | null,
      attributesNeedingFullRead: ReadonlySet<"style" | "src">,
    ): boolean => {
      if (attributeName === null) return true;
      if (oldValue === node.getAttribute(attributeName)) return false;
      if (attributeName === "src")
        return !proxies.includes(node as HTMLElement) || attributesNeedingFullRead.has("src");
      if (attributeName !== "style" || attributesNeedingFullRead.has("style")) return true;
      if (relevant.has(node)) return false;
      if (!isAbove(node)) return true;
      return paintChanged(node, oldValue);
    };
    const identities = new WeakMap<Element, number>();
    let nextIdentity = 0;
    const identity = (node: Element) => {
      let id = identities.get(node);
      if (id === undefined) {
        id = nextIdentity++;
        identities.set(node, id);
      }
      return id;
    };
    let previousDependencies: string | undefined;
    let previous: string | undefined;
    let uncacheable = false;
    let previousCss: string | undefined;
    const readDependencies = () => {
      const { css, selectors } = readStylesheets();
      const dependencies = selectors.filter((selector) =>
        /\[[^\]]*\b(style|src)\b|:(hover|active|focus|focus-within|focus-visible|target|checked|disabled|modal|popover-open|fullscreen|dir)\b/i.test(
          unescapeCss(selector),
        ),
      );
      const opaqueDependency = dependencies.some((selector) => selector.includes("::"));
      const matches = JSON.stringify(
        dependencies.map((selector) => [
          selector,
          [...document.querySelectorAll(selector)].map(identity),
        ]),
      );
      const dependencyChanged = previousDependencies !== matches;
      previousDependencies = matches;
      const attributesNeedingFullRead = new Set<"style" | "src">();
      for (const attribute of ["style", "src"] as const) {
        const readsAttribute = new RegExp(`attr\\(\\s*${attribute}\\b`, "i").test(unescapeCss(css));
        if (dependencyChanged || opaqueDependency || readsAttribute)
          attributesNeedingFullRead.add(attribute);
      }
      return { css, dependencyChanged, opaqueDependency, attributesNeedingFullRead };
    };
    return {
      certifyAbove(childIndices: number[]): void {
        above = childIndices.flatMap((index) => {
          const child = root?.children[index];
          return child === undefined ? [] : [child];
        });
      },
      changed(): boolean {
        const { css, dependencyChanged, opaqueDependency, attributesNeedingFullRead } =
          readDependencies();
        if (previousCss !== undefined && css !== previousCss) uncacheable = true;
        previousCss = css;
        const records = [...pending.splice(0), ...observer.takeRecords()];
        const mutated = records.some((record) => {
          const node = record.target;
          if (node instanceof Text && node.parentElement !== null)
            return textStructureChanged(record, node.parentElement);
          if (!(node instanceof Element)) return true;
          if (record.type === "childList") return textStructureChanged(record, node);
          return attributeChanges(
            node,
            record.attributeName,
            record.oldValue,
            attributesNeedingFullRead,
          );
        });
        const animated = document.getAnimations().some((animation) => {
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element))
            return true;
          if (!isAbove(effect.target) || attributesNeedingFullRead.has("style")) return true;
          return effect
            .getKeyframes()
            .some((frame) =>
              Object.keys(frame).some(
                (key) =>
                  ![
                    "offset",
                    "computedOffset",
                    "easing",
                    "composite",
                    "transform",
                    "opacity",
                  ].includes(key),
              ),
            );
        });
        if (mutated) uncacheable = true;
        const boundary = children.map((node) => {
          const style = getComputedStyle(node);
          return [style.zIndex, style.position, style.display];
        });
        const signature = JSON.stringify({
          boundary,
          children: root ? [...root.children].map((node) => children.indexOf(node)) : [],
          critical: [...relevant].map((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return [
              [rect.x, rect.y, rect.width, rect.height],
              [...style].map((key) => style.getPropertyValue(key)),
              getComputedStyle(node, "::before").content,
              getComputedStyle(node, "::after").content,
            ];
          }),
        });
        const changed =
          previous !== signature ||
          dependencyChanged ||
          uncacheable ||
          animated ||
          opaqueDependency;
        previous = signature;
        return changed;
      },
      dispose() {
        observer.disconnect();
      },
    };
  }, videoIds.map(renderFrameIdForRenderId));
  let cached: LayeredFrame | undefined;
  let fullReads = 0;
  const reader = {
    async read(): Promise<LayeredFrame> {
      try {
        if ((await guard.evaluate((state) => state.changed())) || cached === undefined) {
          fullReads += 1;
          cached = await readLayeredFrame(page);
          const layers = cached.kind === "candidate" ? cached.layers : [];
          const lastVideo = layers.map((layer) => layer.kind).lastIndexOf("video");
          const above = layers
            .slice(lastVideo + 1)
            .flatMap((layer) => (layer.kind === "dom" ? layer.childIndices : []));
          await guard.evaluate((state, indices) => state.certifyAbove(indices), above);
        }
        return cached;
      } catch {
        return { kind: "fallback", reason: "observation_error" };
      }
    },
    fullReads: () => fullReads,
    async dispose(): Promise<void> {
      try {
        await guard.evaluate((state) => state.dispose());
      } catch (error) {
        if (!isTransientBrowserError(error)) throw error;
      } finally {
        await guard.dispose();
      }
    },
  };
  await reader.read();
  return reader;
}
