import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// An agent's macOS seatbelt refuses uptime: "uv_uptime returned EPERM (operation not permitted)".
vi.mock("node:os", async (actual) => ({
  ...(await actual<typeof import("node:os")>()),
  uptime: () => {
    throw Object.assign(new Error("A system error occurred: uv_uptime returned EPERM"), {
      code: "ERR_SYSTEM_ERROR",
    });
  },
}));

// Without /proc, as on macOS, so Linux CI takes the uptime path too.
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: ((path: string, ...rest: unknown[]) => {
      if (path === "/proc/sys/kernel/random/boot_id")
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync,
  };
});

const { createRenderWorkDir } = await import("./renderDirOwner.js");

describe("a render work dir where the system refuses uptime", () => {
  it("is still created and stamped with its owner", () => {
    const parent = mkdtempSync(join(tmpdir(), "hf-render-dir-sandbox-"));
    try {
      const dir = createRenderWorkDir(join(parent, "work-"), parent);
      const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf-8"));
      expect(owner.pid).toBe(process.pid);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
