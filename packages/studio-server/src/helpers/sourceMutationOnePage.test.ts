import { describe, expect, it } from "vitest";
import {
  parseSourceDocument,
  removeElementsFromDocument,
  removeElementsFromHtml,
  serializeSourceDocument,
  splitElementInDocument,
  splitElementInHtml,
  type SourceMutationTarget,
} from "./sourceMutation.js";

const words = Array.from(
  { length: 6 },
  (_, i) =>
    `<div id="w${i}" class="clip" data-start="${i * 2}" data-duration="1" data-track-index="5">w${i}</div>`,
).join("\n");
const PAGE = `<!doctype html>
<html>
  <head><style>#talk { opacity: 1 } #w1 { color: red }</style></head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="12">
<video id="talk" class="clip" src="talk.mp4" data-start="0" data-duration="12" data-track-index="0"></video>
<audio id="voice" class="clip" src="talk.mp4" data-start="0" data-duration="12" data-track-index="2"></audio>
${words}
    </div>
    <script>const tl = gsap.timeline({ paused: true }); tl.to("#w1", { opacity: 0, duration: 0.5 }, 2.2); tl.to("#talk", { scale: 1.1, duration: 2 }, 6); window.__timelines = { main: tl };</script>
  </body>
</html>
`;

type Edit =
  | { split: SourceMutationTarget; at: number; newId: string }
  | { remove: SourceMutationTarget[] };

const EDITS: Edit[] = [
  { split: { id: "talk" }, at: 5, newId: "talk-2" },
  { split: { id: "voice" }, at: 5, newId: "voice-2" },
  { remove: [{ id: "w1" }, { id: "w3" }] },
  { split: { id: "talk-2" }, at: 8, newId: "talk-3" },
  { remove: [{ id: "voice-2" }] },
  { split: { id: "w4" }, at: 8.5, newId: "w4-2" },
];

describe("source edits on one parsed page", () => {
  it("write, step by step, the same bytes as the same edits each parsing the page again", () => {
    let html = PAGE;
    const page = parseSourceDocument(PAGE);
    for (const edit of EDITS) {
      if ("split" in edit) {
        const again = splitElementInHtml(html, edit.split, edit.at, edit.newId);
        const once = splitElementInDocument(page.document, edit.split, edit.at, edit.newId);
        expect({ ...once, html: again.html }).toEqual(again);
        html = again.html;
      } else {
        html = removeElementsFromHtml(html, edit.remove);
        removeElementsFromDocument(page.document, edit.remove);
      }
      expect(serializeSourceDocument(page)).toBe(html);
    }
    expect(html).toContain('id="talk-3"');
  });

  it("find a clip by its id after a split as a page parsed again does, its new ids written into the page", () => {
    const page = parseSourceDocument(PAGE);
    splitElementInDocument(page.document, { id: "talk" }, 5, "talk-2");
    const again = parseSourceDocument(serializeSourceDocument(page));
    // An hfId that names nothing, with the id of a clip whose own hfId the page holds: refused on both.
    const stale = { hfId: "hf-missing", id: "talk-2" };
    expect(removeElementsFromDocument(again.document, [stale])).toBe(false);
    expect(removeElementsFromDocument(page.document, [stale])).toBe(false);
  });

  it("leave the page as it was when a split is refused", () => {
    const page = parseSourceDocument(PAGE);
    const before = serializeSourceDocument(page);
    const split = splitElementInDocument(page.document, { id: "talk" }, 40, "late");
    expect(split).toEqual({ matched: false, newId: null, refusal: "outside-clip" });
    expect(serializeSourceDocument(page)).toBe(before);
  });
});
