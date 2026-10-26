import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createStagingDir } from "./stagingDir.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    mkdtempSync: vi.fn(() => {
      throw Object.assign(new Error("path too long"), { code: "ENOENT" });
    }),
  };
});

const roots: string[] = [];
const root = () => {
  const made = join(tmpdir(), `hf-staging-${process.pid}-${roots.length}`);
  fs.mkdirSync(made, { recursive: true });
  roots.push(made);
  return made;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createStagingDir", () => {
  it("makes a fresh private directory without mkdtemp, which fails on long Windows paths", () => {
    const parent = root();
    const first = createStagingDir(parent, ".stage-");
    const second = createStagingDir(parent, ".stage-");
    expect(first).not.toBe(second);
    expect(basename(first)).toMatch(/^\.stage-[0-9a-f]{8}$/);
    expect(statSync(first).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(first).mode & 0o777).toBe(0o700);
    expect(fs.mkdtempSync).not.toHaveBeenCalled();
  });

  it("tries another name when one is taken, and gives up after five", () => {
    const parent = root();
    const taken = createStagingDir(parent, ".s-", () => "same");
    expect(taken).toBe(join(parent, ".s-same"));
    const names = ["same", "same", "next"];
    expect(createStagingDir(parent, ".s-", () => names.shift() ?? "x")).toBe(
      join(parent, ".s-next"),
    );
    expect(() => createStagingDir(parent, ".s-", () => "same")).toThrow(/EEXIST/);
  });
});
