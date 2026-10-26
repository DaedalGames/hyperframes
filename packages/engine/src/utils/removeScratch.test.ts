import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

import * as fs from "node:fs";
import { removeScratch, takeScratchLeftovers } from "./removeScratch.js";
import { renameWithRetry } from "./renameWithRetry.js";

describe("removeScratch", () => {
  it("removes a folder and what is in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-scratch-"));
    writeFileSync(join(dir, "a.wav"), "x");
    removeScratch(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not fail when the system refuses the removal", () => {
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    });
    expect(() => removeScratch(join(tmpdir(), "hf-scratch-missing"))).not.toThrow();
  });

  it("reports what it could not remove once, and a copy that cannot clear its source leaves it", () => {
    const refuse = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    };
    const dir = mkdtempSync(join(tmpdir(), "hf-scratch-"));
    const from = join(dir, "from.wav");
    const to = join(dir, "to.wav");
    writeFileSync(from, "audio");
    takeScratchLeftovers();
    vi.mocked(fs.rmSync).mockImplementationOnce(refuse);
    renameWithRetry(from, to, { platform: "win32", rename: refuse });
    expect(readFileSync(to, "utf-8")).toBe("audio");
    expect(existsSync(from)).toBe(true);
    expect(takeScratchLeftovers()).toEqual([from]);
    expect(takeScratchLeftovers()).toEqual([]);
  });
});
