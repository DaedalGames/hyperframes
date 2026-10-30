import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Browser, LaunchOptions, PuppeteerNode } from "puppeteer-core";
import { afterEach, expect, it, vi } from "vitest";
import { launchManagedBrowser } from "./launch.js";

const treeKill = vi.hoisted(() => vi.fn<(pid: number) => Promise<void>>());
vi.mock("../utils/processTree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/processTree.js")>()),
  terminateWindowsProcessTree: treeKill,
}));

afterEach(() => {
  treeKill.mockReset();
  vi.restoreAllMocks();
});

it("kills a browser that acknowledged close but never exits, so every caller's close() returns", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "pipe" });
  const browser = { process: () => child, close: () => once(child, "exit") } as unknown as Browser;
  const puppeteer = {
    launch: async (_options: LaunchOptions) => browser,
  } as unknown as PuppeteerNode;
  try {
    const launched = await launchManagedBrowser(puppeteer, { headless: true }, { diagnose: false });
    await launched.close();
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    child.kill("SIGKILL");
  }
});

it("on Windows ends the browser's whole tree while its root still lives, since children outlive a killed root", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "pipe" });
  let rootAliveAtTreeKill: boolean | undefined;
  treeKill.mockImplementation(async () => {
    rootAliveAtTreeKill = child.exitCode === null && child.signalCode === null;
  });
  const browser = { process: () => child, close: () => once(child, "exit") } as unknown as Browser;
  const puppeteer = {
    launch: async (_options: LaunchOptions) => browser,
  } as unknown as PuppeteerNode;
  try {
    const launched = await launchManagedBrowser(puppeteer, { headless: true }, { diagnose: false });
    await launched.close();
    expect(treeKill).toHaveBeenCalledWith(child.pid);
    expect(rootAliveAtTreeKill).toBe(true);
  } finally {
    child.kill("SIGKILL");
  }
});
