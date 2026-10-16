import postcss from "postcss";
import { escapeCssIdentifier, replaceSelectorIdTokens } from "@hyperframes/core/selector-id-tokens";
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

function localUrls(value: string, renames: ReadonlyMap<string, string>): string {
  return value.replace(VALUE_TOKENS, (full, open, quote, id: string, close) => {
    const renamed = open && renames.get(id);
    return renamed ? `${open}${quote}#${renamed}${quote}${close}` : full;
  });
}

function stylesheet(css: string, renames: ReadonlyMap<string, string>): string {
  try {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      rule.selector = replaceSelectorIdTokens(
        rule.selector,
        [...renames.keys()],
        (id) => `#${escapeCssIdentifier(renames.get(id) ?? id)}`,
      );
    });
    root.walkDecls((decl) => {
      decl.value = localUrls(decl.value, renames);
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
  return URL_ATTRIBUTES.has(name) ? localUrls(value, renames) : value;
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

function attributeEdit(
  attr: HtmlAttributeSpan,
  renames: ReadonlyMap<string, string>,
): SourceEdit | null {
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
  };
}

/** Rebind a clone's own references before insertion; destination styles and scripts stay untouched. */
export function rebindClipboardReferences(
  html: string,
  renames: ReadonlyMap<string, string>,
): string {
  if (!renames.size) return html;
  const edits: SourceEdit[] = [];
  for (const tag of scanHtmlOpeningTags(html)) {
    if (tag.name === "style" && tag.rawTextEnd !== null) {
      const css = html.slice(tag.end, tag.rawTextEnd);
      const text = stylesheet(css, renames);
      if (text !== css) edits.push({ start: tag.end, end: tag.rawTextEnd, text });
    }
    for (const attr of tag.attributes) {
      const edit = attributeEdit(attr, renames);
      if (edit) edits.push(edit);
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return html;
}
