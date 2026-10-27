// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryWho } from "./historyLog";
import { openProjectHistory } from "./projectHistory";

// Windows refuses a rename onto a file another process has open for a moment (an indexer, antivirus).
const held = vi.hoisted(() => ({ name: null as string | null, refused: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const renameSync = ((from: string, to: string) => {
    if (held.name && basename(String(to)) === held.name && held.refused === 0) {
      held.refused += 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), {
        code: "EPERM",
        syscall: "rename",
      });
    }
    return original.renameSync(from, to);
  }) as typeof original.renameSync;
  return { ...original, renameSync };
});

const you: HistoryWho = { kind: "person", name: "You" };
const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  held.name = null;
  held.refused = 0;
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("a project file held open for a moment", () => {
  it("still takes Undo and Redo: the file is put back once the hold lets go", async () => {
    const projectDir = tempDir("hf-history-held-");
    const historyRoot = tempDir("hf-history-held-root-");
    const file = join(projectDir, "index.html");
    writeFileSync(file, "v1");
    const history = await openProjectHistory({ projectDir, historyRoot });
    cleanup.push(() => history.close());
    const window = await history.beginWindow(you, "Your edit");
    writeFileSync(file, "v2");
    await window.close();

    held.name = "index.html";
    expect(await history.step("back", you)).toMatchObject({ ok: true });
    expect(held.refused).toBe(1);
    expect(readFileSync(file, "utf-8")).toBe("v1");

    held.refused = 0;
    expect(await history.step("forward", you)).toMatchObject({ ok: true });
    expect(held.refused).toBe(1);
    expect(readFileSync(file, "utf-8")).toBe("v2");
  });
});
