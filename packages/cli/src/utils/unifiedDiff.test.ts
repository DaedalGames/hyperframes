import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./unifiedDiff.js";

/** Applies a diff's hunks back onto `before` to check it reproduces `after`. */
function apply(before: string, diff: string): string {
  const lines = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let at = 0;
  for (const row of diff.split("\n").slice(3)) {
    if (row.startsWith("@@")) {
      const first = Number(/-(\d+)/.exec(row)![1]);
      const start = /-0,0/.test(row) ? 0 : first - 1;
      out.push(...lines.slice(at, start));
      at = start;
    } else if (row.startsWith("\\")) continue;
    else if (row.startsWith("+")) out.push(row.slice(1));
    else if (row.startsWith("-")) at++;
    else (out.push(row.slice(1)), at++);
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

describe("unifiedDiff", () => {
  it("marks a missing final newline like git", () => {
    expect(unifiedDiff("a.html", "A", "A2")).toBe(
      "diff --git a/a.html b/a.html\n--- a/a.html\n+++ b/a.html\n@@ -1 +1 @@\n-A\n\\ No newline at end of file\n+A2\n\\ No newline at end of file",
    );
  });

  it("is empty for equal text, and shows a whole added or deleted file", () => {
    expect(unifiedDiff("a", "x\n", "x\n")).toBe("");
    expect(unifiedDiff("a", "", "x\ny\n")).toContain("@@ -0,0 +1,2 @@\n+x\n+y");
    expect(unifiedDiff("a", "x\ny\n", "")).toContain("@@ -1,2 +0,0 @@\n-x\n-y");
  });

  it("keeps three lines of context and splits distant changes into hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const after = lines.map((l) => (l === "l2" || l === "l27" ? `${l}!` : l));
    const diff = unifiedDiff("a", `${lines.join("\n")}\n`, `${after.join("\n")}\n`);
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain("@@ -1,6 +1,6 @@");
    expect(diff).toContain("@@ -25,6 +25,6 @@");
  });

  it("matches git's own diff and reproduces the new text on random edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-udiff-"));
    try {
      let seed = 7;
      const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
      for (let round = 0; round < 40; round++) {
        const before = Array.from({ length: rand(25) }, () => `w${rand(6)}`);
        const after = before.filter(() => rand(4) > 0);
        for (let i = rand(5); i > 0; i--) after.splice(rand(after.length + 1), 0, `n${rand(9)}`);
        const eol = rand(3) === 0 ? "" : "\n";
        const a = before.length ? before.join("\n") + eol : "";
        const b = after.length ? after.join("\n") + (rand(3) === 0 ? "" : "\n") : "";
        const mine = unifiedDiff("f", a, b);
        expect(apply(a, mine).replace(/\n?$/, "")).toBe(b.replace(/\n$/, ""));
        writeFileSync(join(dir, "a"), a);
        writeFileSync(join(dir, "b"), b);
        const git = spawnSync(
          "git",
          ["diff", "--no-index", "--no-color", "--no-prefix", "a", "b"],
          { cwd: dir, encoding: "utf-8" },
        );
        if (git.error) continue;
        const body = (text: string) => text.slice(text.indexOf("@@")).trimEnd();
        expect(body(mine)).toBe(a === b ? "" : body(git.stdout));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
