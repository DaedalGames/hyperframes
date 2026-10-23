/**
 * Whether an inline script of the document looks an element up by id.
 *
 * A removed node makes `document.getElementById('x').getTotalLength()` throw before the timeline registers,
 * so a stored delete that a script still depends on is hidden instead of removed.
 */

// The string handed to getElementById / querySelector(All); a template's ${...} stands for any text.
const LOOKUP = /(getElementById|querySelector(?:All)?)\s*\(\s*(["'`])([\s\S]*?)\2/g;
const SELECTOR_ID = /#((?:[\w-]|\$\{[^}]*\})+)/g;
const PLACEHOLDER = /\$\{[^}]*\}/;

function idPattern(text: string): RegExp {
  const parts = text.split(new RegExp(PLACEHOLDER.source, "g"));
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[\\w-]+")}$`);
}

function lookedUpPatterns(scripts: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const [, method, , argument] of scripts.matchAll(LOOKUP)) {
    const ids =
      method === "getElementById"
        ? [argument ?? ""]
        : Array.from((argument ?? "").matchAll(SELECTOR_ID), (match) => match[1] ?? "");
    patterns.push(...ids.map(idPattern));
  }
  return patterns;
}

export function scriptLooksUp(document: Document, el: Element): boolean {
  const scripts = Array.from(
    document.querySelectorAll("script:not([src])"),
    (s) => s.textContent ?? "",
  );
  const patterns = lookedUpPatterns(scripts.join("\n"));
  if (patterns.length === 0) return false;
  return [el, ...Array.from(el.querySelectorAll("[id]"))].some((node) => {
    const id = node.getAttribute("id");
    return id !== null && patterns.some((pattern) => pattern.test(id));
  });
}
