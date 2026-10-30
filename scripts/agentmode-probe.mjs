// Times the agent-mode test's first batch of CLI spawns on Windows under several environments.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const cliEntry = resolve("packages/cli/src/cli.ts");
const FIRST = [["init"], ["add"], ["catalog"], ["media-use"], ["media-use", "doctor"]];
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const SYSTEM_KEYS = ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA",
  "PATHEXT", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles"];

function envFor(variant, home) {
  const base = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CI: "1", CLAUDECODE: "1" };
  if (variant === "system") for (const k of SYSTEM_KEYS) if (process.env[k]) base[k] = process.env[k];
  if (variant === "nocache") base.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
  return base;
}

function run(args, env, cwd) {
  const start = performance.now();
  return new Promise((done) => {
    const child = spawn("bun", ["run", cliEntry, ...args, "--help"], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    let out = "";
    let firstMs = -1;
    child.stdout.on("data", (c) => {
      if (firstMs < 0) firstMs = Math.round(performance.now() - start);
      out += c;
    });
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code, signal) =>
      done({ cmd: args.join(" "), ms: Math.round(performance.now() - start), firstMs, code, signal, usage: out.includes("USAGE") }));
  });
}

function burn(n) {
  const src = "const { parentPort } = require('node:worker_threads'); let x = 0; for (;;) { x = (x + Math.random()) % 1e9; }";
  return Array.from({ length: n }, () => new Worker(src, { eval: true }));
}

let lagMax = 0;
let lagLast = performance.now();
setInterval(() => {
  const now = performance.now();
  lagMax = Math.max(lagMax, now - lagLast - 50);
  lagLast = now;
}, 50).unref();
const VARIANTS = (process.env.VARIANTS ?? "test,system,nocache").split(",");
const LOADS = (process.env.LOADS ?? "quiet,loaded").split(",");
const results = [];
for (const load of LOADS) {
  const burners = load === "loaded" ? burn(cpus().length) : [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const variant of VARIANTS) {
      lagMax = 0;
      const home = mkdtempSync(join(tmpdir(), "hf-probe-"));
      const env = envFor(variant, home);
      const t0 = performance.now();
      const batch = await Promise.all(FIRST.map((a) => run(a, env, home)));
      const second = await run(["render"], env, home);
      const row = { load, round, variant, lagMs: Math.round(lagMax), batchMs: Math.round(performance.now() - t0),
        maxMs: Math.max(...batch.map((r) => r.ms)), batch, warmRenderMs: second.ms };
      results.push(row);
      console.log(`${load} r${round} ${variant} max=${row.maxMs} lag=${row.lagMs} warm=${second.ms} ` +
        batch.map((r) => `${r.cmd}:${r.firstMs}/${r.ms}${r.code === 0 && r.usage ? "" : "!" + r.code + r.signal}`).join(" "));
      rmSync(home, { recursive: true, force: true });
    }
  }
  for (const w of burners) await w.terminate();
}
writeFileSync("agentmode-probe.json", JSON.stringify(results, null, 1));
const summary = {};
for (const r of results) {
  const k = `${r.load}/${r.variant}`;
  summary[k] ??= { rounds: 0, over8s: 0, over15s: 0, maxes: [] };
  summary[k].rounds++; summary[k].maxes.push(r.maxMs);
  if (r.maxMs > 8000) summary[k].over8s++;
  if (r.maxMs > 15000) summary[k].over15s++;
}
for (const [k, v] of Object.entries(summary)) {
  const s = v.maxes.sort((a, b) => a - b);
  console.log(`SUMMARY ${k} rounds=${v.rounds} over8s=${v.over8s} over15s=${v.over15s} median=${s[s.length >> 1]} worst=${s[s.length - 1]}`);
}
