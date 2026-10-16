import {
  decodeAuthoredAttribute,
  scanHtmlOpeningTags,
} from "@hyperframes/parsers/html-attribute-spans";

const OWNER = "data-hf-element-style";

export function includeElementClipboardStyles(saved: Document, html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const ids = new Set(Array.from(template.content.querySelectorAll("[id]"), (node) => node.id));
  const styles = Array.from(saved.querySelectorAll(`style[${OWNER}]`))
    .filter((style) => ids.has(style.getAttribute(OWNER)!))
    .map((style) => style.outerHTML)
    .join("");
  if (!styles) return html;
  const close = html.match(/<\/[^>]+>\s*$/);
  if (!close || close.index === undefined) return html;
  return html.slice(0, close.index) + styles + html.slice(close.index);
}

function insertStyles(source: string, styles: string): string {
  const tags = scanHtmlOpeningTags(source);
  const head = tags.find((tag) => tag.name === "head");
  if (head) return source.slice(0, head.end) + styles + source.slice(head.end);
  const html = tags.find((tag) => tag.name === "html");
  const index = html?.end ?? tags[0]?.start ?? source.length;
  return source.slice(0, index) + `<head>${styles}</head>` + source.slice(index);
}

/** Styles travel inside copied markup, then leave its structural selector tree before insertion. */
export function hoistElementClipboardStyles(
  source: string,
  html: string,
  renames: ReadonlyMap<string, string>,
): { content: string; html: string } {
  const styles: string[] = [];
  const edits: Array<{ start: number; end: number }> = [];
  for (const tag of scanHtmlOpeningTags(html)) {
    if (tag.name !== "style" || tag.rawTextEnd === null) continue;
    const owner = tag.attributes.find((attr) => attr.name === OWNER);
    if (!owner || owner.kind !== "value") continue;
    const id = decodeAuthoredAttribute(owner.value);
    const style = document.createElement("style");
    style.setAttribute(OWNER, renames.get(id) ?? id);
    style.textContent = html.slice(tag.end, tag.rawTextEnd);
    styles.push(style.outerHTML);
    const close = html.indexOf(">", tag.rawTextEnd);
    edits.push({ start: tag.start, end: close < 0 ? html.length : close + 1 });
  }
  for (const edit of edits.reverse()) html = html.slice(0, edit.start) + html.slice(edit.end);
  return { content: styles.length ? insertStyles(source, styles.join("")) : source, html };
}
