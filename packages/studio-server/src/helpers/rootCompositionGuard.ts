import { parseHTML } from "linkedom";
import { querySelectorAllWithTemplates } from "./sourceMutation.js";

function rootCompositionIds(html: string): Set<string> {
  if (!html.includes("data-composition-id")) return new Set();
  const shell = /<!doctype|<html[\s>]/i.test(html);
  const { document } = parseHTML(
    shell ? html : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
  );
  return new Set(
    querySelectorAllWithTemplates(document, "[data-composition-id]")
      .filter((el) => !el.parentElement?.closest("[data-composition-id]"))
      .map((el) => el.getAttribute("data-composition-id") ?? ""),
  );
}

/** Why a write must not land, or null: it removes a root composition the file had, emptying the video. */
export function rootCompositionRefusal(path: string, before: string, after: string): string | null {
  const kept = rootCompositionIds(after);
  const lost = [...rootCompositionIds(before)].find((id) => !kept.has(id));
  return lost === undefined
    ? null
    : `Refused to save ${path}: the change would remove its root composition "${lost}" and everything in it. The file was left as it was.`;
}
