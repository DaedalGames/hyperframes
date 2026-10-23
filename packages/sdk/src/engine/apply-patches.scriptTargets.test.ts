import { describe, expect, it } from "vitest";
import { parseMutable } from "./model.js";
import { applyOverrideSet, applyPatchesToDocument } from "./apply-patches.js";
import { serializeDocument } from "./serialize.js";

// The failing shape: the script dereferences the lookup unguarded, so a removed node throws.
const HTML = `<!DOCTYPE html><html><body>
<div data-composition-id="c" data-width="1920" data-height="1080">
<svg><path data-hf-id="hf-arch" id="arch-path" d="M0 0"></path></svg>
<div data-hf-id="hf-plain" id="plain">keep</div>
</div>
<script>const len = document.getElementById('arch-path').getTotalLength();</script>
</body></html>`;

describe("a stored delete a script looks up", () => {
  it("is hidden, not removed, when overrides are replayed", () => {
    const parsed = parseMutable(HTML);
    applyOverrideSet(parsed, { "hf-arch": null });
    const arch = parsed.document.getElementById("arch-path");
    expect(arch).not.toBeNull();
    expect(arch?.getAttribute("style")).toContain("display: none");
  });

  it("is removed as before when no script looks it up", () => {
    const parsed = parseMutable(HTML);
    applyOverrideSet(parsed, { "hf-plain": null });
    expect(parsed.document.getElementById("plain")).toBeNull();
    expect(serializeDocument(parsed)).toContain("arch-path");
  });

  it("is still removed by a plain patch, which undo and redo rely on", () => {
    const parsed = parseMutable(HTML);
    applyPatchesToDocument(parsed, [{ op: "remove", path: "/elements/hf-arch" }]);
    expect(parsed.document.getElementById("arch-path")).toBeNull();
  });
});
