import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

import * as fs from "node:fs";
import { removeScratch } from "./removeScratch.js";

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
});
