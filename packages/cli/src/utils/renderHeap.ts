// Auto worker sizing never runs more capture workers than this process's V8 heap can feed, and Node sizes its
// default heap from the memory it sees: 2,096 MB in a 10 GB container, which the budget floors to one worker on any
// number of cores. A render that only the heap holds back relaunches itself once with the heap auto sizing needs,
// never more than half the memory.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { getHeapStatistics } from "node:v8";
import { getSystemTotalMb, heapMbForAutoWorkers } from "@hyperframes/engine";

// V8 takes the flag with dashes or underscores.
const HEAP_FLAG = /--max[-_]old[-_]space[-_]size/;

/** Set in the relaunched process (to the heap it was given), so it never relaunches again. */
export const RENDER_HEAP_ENV = "HF_RENDER_HEAP_MB";

export interface RenderHeapFacts {
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
  currentMb: number;
  neededMb: number;
  memoryMb: number;
}

function liveFacts(): RenderHeapFacts {
  return {
    env: process.env,
    execArgv: process.execArgv,
    currentMb: Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)),
    neededMb: heapMbForAutoWorkers(),
    memoryMb: getSystemTotalMb(),
  };
}

/** The heap (MB) to relaunch the render with, or null when this process's heap already suffices or is set by hand. */
export function renderHeapToRelaunch(facts: RenderHeapFacts = liveFacts()): number | null {
  const setByHand =
    HEAP_FLAG.test(facts.env.NODE_OPTIONS ?? "") ||
    facts.execArgv.some((arg) => HEAP_FLAG.test(arg));
  if (facts.env[RENDER_HEAP_ENV] || setByHand) return null;
  const target = Math.min(facts.neededMb, Math.floor(facts.memoryMb / 2));
  // Below one worker's share (640 MB) more, the budget would give the same count.
  return target >= facts.currentMb + 640 ? target : null;
}

/** Runs this same command in a child Node with the given heap, passing signals on; resolves to its exit code. */
export function relaunchWithHeap(heapMb: number): Promise<number> {
  const child = spawn(
    process.execPath,
    [...process.execArgv, `--max-old-space-size=${heapMb}`, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, [RENDER_HEAP_ENV]: String(heapMb) } },
  );
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  // A detached render leaves SIGHUP at its default (renderCancellation.ts), so forwarding it would kill the child.
  const signals: NodeJS.Signals[] =
    process.env.HYPERFRAMES_RENDER_DETACHED === "1"
      ? ["SIGINT", "SIGTERM"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, forward);
  return new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => {
      for (const s of signals) process.off(s, forward);
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0));
    });
  });
}
