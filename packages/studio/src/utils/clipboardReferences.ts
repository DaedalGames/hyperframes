import postcss from "postcss";
import { rebindClipboardSelector, type ClipboardAttributeRewrite } from "./clipboardSelectors";
import {
  decodeAuthoredAttribute,
  scanHtmlOpeningTags,
  type HtmlAttributeSpan,
} from "@hyperframes/parsers/html-attribute-spans";

const URL_ATTRIBUTES = new Set([
  "style",
  "fill",
  "stroke",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);
const VALUE_TOKENS =
  /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\/\*[\s\S]*?\*\/|(?<![\w-])(url\(\s*)(["']?)#([^"')\s]+)\2(\s*\))/gi;

export function rebindClipboardUrls(value: string, renames: ReadonlyMap<string, string>): string {
  return value.replace(VALUE_TOKENS, (full, open, quote, id: string, close) => {
    const renamed = open && renames.get(id);
    return renamed ? `${open}${quote}#${renamed}${quote}${close}` : full;
  });
}

function stylesheet(
  css: string,
  renames: ReadonlyMap<string, string>,
  attributes: readonly ClipboardAttributeRewrite[],
): string {
  try {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      rule.selector = rebindClipboardSelector(rule.selector, renames, attributes);
    });
    root.walkDecls((decl) => {
      decl.value = rebindClipboardUrls(decl.value, renames);
    });
    return root.toString();
  } catch {
    return css;
  }
}

function attributeValue(name: string, value: string, renames: ReadonlyMap<string, string>): string {
  if ((name === "href" || name.endsWith(":href")) && value.startsWith("#")) {
    const renamed = renames.get(value.slice(1));
    return renamed ? `#${renamed}` : value;
  }
  return URL_ATTRIBUTES.has(name) ? rebindClipboardUrls(value, renames) : value;
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

function attributeEdit(
  attr: HtmlAttributeSpan,
  renames: ReadonlyMap<string, string>,
): (SourceEdit & { reference: ClipboardAttributeRewrite }) | null {
  if (attr.kind !== "value") return null;
  const value = decodeAuthoredAttribute(attr.value);
  const rewritten = attributeValue(attr.name, value, renames);
  if (rewritten === value) return null;
  const quote = attr.quote || '"';
  const encoded = rewritten
    .replace(/&/g, "&amp;")
    .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? "&quot;" : "&#39;");
  return {
    start: attr.valueStart,
    end: attr.valueEnd,
    text: attr.quote ? encoded : `"${encoded}"`,
    reference: { name: attr.name, before: value, after: rewritten },
  };
}

export function clipboardAttributeRewrites(
  html: string,
  renames: ReadonlyMap<string, string>,
): ClipboardAttributeRewrite[] {
  return scanHtmlOpeningTags(html).flatMap((tag) =>
    tag.attributes.flatMap((attr) => {
      const edit = attributeEdit(attr, renames);
      return edit ? [edit.reference] : [];
    }),
  );
}

/** Rebind a clone's own references before insertion; destination styles and scripts stay untouched. */
export function rebindClipboardReferences(
  html: string,
  renames: ReadonlyMap<string, string>,
): string {
  if (!renames.size) return html;
  const edits: SourceEdit[] = [];
  const attributes: ClipboardAttributeRewrite[] = [];
  const tags = scanHtmlOpeningTags(html);
  for (const tag of tags)
    for (const attr of tag.attributes) {
      const edit = attributeEdit(attr, renames);
      if (edit) {
        edits.push(edit);
        attributes.push(edit.reference);
      }
    }
  for (const tag of tags) {
    if (tag.name !== "style" || tag.rawTextEnd === null) continue;
    const css = html.slice(tag.end, tag.rawTextEnd);
    const text = stylesheet(css, renames, attributes);
    if (text !== css) edits.push({ start: tag.end, end: tag.rawTextEnd, text });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return html;
}
