import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { testProcessDescendants, testProcessIsAlive, waitForTestCondition } from "../utils/processTestUtils.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cmd = (pids: number[]) =>
  pids.length
    ? execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { @(${pids.join(",")}) -contains $_.ProcessId } | ForEach-Object { [string]$_.ProcessId + ' ppid=' + $_.ParentProcessId + ' ' + (($_.CommandLine -split ' ' | Where-Object { $_ -like '--type=*' -or $_ -like '--user-data-dir*' -or $_ -like '-e' }) -join ' ') + ' name=' + $_.Name }"`, { encoding: "utf8" })
    : "(none)\n";

it("debug orphan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-orph-dbg-"));
  mkdirSync(join(dir, "compositions"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><body><div data-composition-id="main" data-width="320" data-height="180" data-duration="1"><div data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="0" data-duration="1"></div></div><script>window.__timelines={main:{duration:()=>1,seek:()=>{},pause:()=>{}}};</script></body></html>`);
  writeFileSync(join(dir, "compositions/scene.html"), `<template id="scene"><div data-composition-id="scene"><div id="box" style="width:1px;height:1px"></div><script>const el=document.getElementById("box");while(el.offsetWidth<2){el.style.height="1px";}</script></div></template>`);
  const child = spawn(process.execPath, ["--import", "tsx", cli, "check", dir, "--json", "--no-browser-gpu", "--samples=1"], { env: { ...process.env, CI: "1", HYPERFRAMES_NO_TELEMETRY: "1" }, stdio: ["ignore", "ignore", "ignore"] });
  const chrome = new Set<number>(); const nodes = new Set<number>();
  const record = () => { for (const p of testProcessDescendants(child.pid!, /chrom/i)) chrome.add(p); for (const p of testProcessDescendants(child.pid!, /^node/i)) nodes.add(p); };
  await waitForTestCondition(() => { record(); return chrome.size >= 3; }, 30_000);
  await sleep(3000); record();
  console.error(`ORPHDBG before kill: chrome=${chrome.size} nodes=${[...nodes]}\n${cmd([...chrome, ...nodes])}`);
  const t0 = Date.now();
  child.kill("SIGKILL");
  for (const at of [2000, 5000, 10000, 20000]) {
    await sleep(at - (Date.now() - t0));
    const left = [...chrome].filter(testProcessIsAlive); const wd = [...nodes].filter(testProcessIsAlive);
    console.error(`ORPHDBG +${at}ms chrome alive=${left.length} watchdog alive=${wd.length}\n${cmd([...left, ...wd])}`);
  }
  for (const p of [...chrome, ...nodes]) { try { process.kill(p, "SIGKILL"); } catch {} }
}, 120_000);
