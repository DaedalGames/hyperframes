import { execFileSync } from "node:child_process";
import puppeteer, { type Browser } from "puppeteer-core";
import { expect, it } from "vitest";
import { launchManagedBrowser } from "./launch.js";
import { ensureBrowser } from "./manager.js";
import { processIsAlive } from "../utils/processTree.js";

function directChildren(pid: number): number[] {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return out
    .split(/\r?\n/)
    .map(Number)
    .filter((child) => Number.isInteger(child) && child > 0);
}

// A browser whose graceful close never answers is ended by force; its renderer and GPU processes must go too.
it.skipIf(process.platform !== "win32")(
  "a force-closed browser leaves none of its Chrome processes alive",
  async () => {
    const { executablePath } = await ensureBrowser();
    const hanging = {
      launch: async (options: Parameters<typeof puppeteer.launch>[0]) => {
        const browser = await puppeteer.launch(options);
        browser.close = () => new Promise<void>(() => {});
        return browser;
      },
    } as unknown as typeof puppeteer;
    const launched: Browser = await launchManagedBrowser(hanging, {
      executablePath,
      headless: true,
    });
    const page = await launched.newPage();
    await page.goto("about:blank");
    const root = launched.process()?.pid;
    expect(root).toBeDefined();
    const children = directChildren(root!);
    expect(children.length).toBeGreaterThan(0);

    await launched.close();

    expect(children.filter(processIsAlive)).toEqual([]);
  },
  90_000,
);
