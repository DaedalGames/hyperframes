import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, LaunchOptions, PuppeteerNode } from "puppeteer-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserPathFromEnv,
  chromeMajorCeiling,
  exceedsChromeCeiling,
  launchRenderBrowser,
} from "./chromeHostCeiling.js";

describe("chromeMajorCeiling", () => {
  it.each([
    ["darwin", "21.6.0", 150],
    ["darwin", "22.1.0", undefined],
    ["linux", "21.0.0", undefined],
    ["win32", "10.0.19045", undefined],
  ])("%s %s -> %s", (platform, release, expected) => {
    expect(chromeMajorCeiling(platform, release)).toBe(expected);
  });
});

describe("exceedsChromeCeiling", () => {
  it.each([
    ["mac-152.0.7977.30", 150, true],
    ["mac_arm-150.0.7871.124", 150, false],
    ["151.0.1.2", 150, true],
    ["mac-152.0.7977.30", undefined, false],
  ])("%s with ceiling %s -> %s", (name, ceiling, expected) => {
    expect(exceedsChromeCeiling(name, ceiling)).toBe(expected);
  });
});

describe("browserPathFromEnv", () => {
  it("names a launcher module before either browser binary", () => {
    expect(
      browserPathFromEnv({
        HYPERFRAMES_BROWSER_LAUNCHER: "/host/launcher.mjs",
        HYPERFRAMES_BROWSER_PATH: "/opt/chrome",
        PRODUCER_HEADLESS_SHELL_PATH: "/opt/shell",
      }),
    ).toEqual({ name: "HYPERFRAMES_BROWSER_LAUNCHER", path: "/host/launcher.mjs" });
  });
});

describe("launchRenderBrowser", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const launcherModule = (source: string) => {
    const dir = mkdtempSync(join(tmpdir(), "hyperframes-launcher-"));
    dirs.push(dir);
    const file = join(dir, "launcher.mjs");
    writeFileSync(file, source);
    return file;
  };
  const browser = { marker: "browser" } as unknown as Browser;
  const options: LaunchOptions = { headless: true, args: ["--font-render-hinting=none"] };

  it("calls puppeteer.launch with the options unchanged when no launcher is set", async () => {
    const launch = vi.fn(async () => browser);
    const puppeteer = { launch } as unknown as PuppeteerNode;

    await expect(launchRenderBrowser(puppeteer, options, {})).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledWith(options);
  });

  it("hands the options and puppeteer to the launcher module instead", async () => {
    const file = launcherModule(
      "export async function launch(options, puppeteer) { return { options, puppeteer }; }",
    );
    const launch = vi.fn();
    const puppeteer = { launch } as unknown as PuppeteerNode;

    const result = await launchRenderBrowser(puppeteer, options, {
      HYPERFRAMES_BROWSER_LAUNCHER: file,
    });

    expect(result).toEqual({ options, puppeteer });
    expect(launch).not.toHaveBeenCalled();
  });

  it("says so when the module has no launch export", async () => {
    const file = launcherModule("export const start = () => {};");
    const puppeteer = { launch: vi.fn() } as unknown as PuppeteerNode;

    await expect(
      launchRenderBrowser(puppeteer, options, { HYPERFRAMES_BROWSER_LAUNCHER: file }),
    ).rejects.toThrow(
      `HYPERFRAMES_BROWSER_LAUNCHER="${file}" does not export launch(options, puppeteer).`,
    );
  });
});
