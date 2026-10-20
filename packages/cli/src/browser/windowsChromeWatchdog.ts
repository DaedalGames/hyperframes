import { spawn, type ChildProcess } from "node:child_process";

const WATCHDOG_PROFILE_ENV = "HF_CHROME_PROFILE";

const SWEEP = `$p=$env:${WATCHDOG_PROFILE_ENV}; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;

const WATCHDOG = `let clean = false;
const done = () => {
  if (!clean) require("node:child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(SWEEP)}], { windowsHide: true, timeout: 20000 });
  process.exit(0);
};
process.stdin.on("data", (data) => { clean ||= String(data).includes("clean"); });
process.stdin.on("end", done);
process.stdin.on("error", done);`;

export interface ChromeWatchdog {
  release(clean: boolean): void;
}

function profileOf(chrome: ChildProcess): string | undefined {
  const arg = chrome.spawnargs.find((value) => value.startsWith("--user-data-dir="));
  return arg?.slice("--user-data-dir=".length).replace(/^"|"$/g, "") || undefined;
}

/** Windows does not end a process's children with it: this sweeps the profile's processes once the CLI is gone. */
export function watchChromeTree(chrome: ChildProcess): ChromeWatchdog | undefined {
  const profile = profileOf(chrome);
  if (process.platform !== "win32" || !profile) return undefined;
  const watchdog = spawn(process.execPath, ["-e", WATCHDOG], {
    detached: true,
    env: { ...process.env, [WATCHDOG_PROFILE_ENV]: profile },
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  watchdog.on("error", () => {});
  watchdog.stdin?.on("error", () => {});
  watchdog.unref();
  (watchdog.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  let released = false;
  return {
    release(clean) {
      if (released) return;
      released = true;
      watchdog.stdin?.end(clean ? "clean" : "");
    },
  };
}
