// HeyGen's v3 job routes through the hyperframes credential chain (API key, host token or OAuth, refreshed). A paid
// call carries an Idempotency-Key derived from what it asks for, so running the same command again picks up the
// same job instead of paying for a second one; every job is logged to .hyperframes/heygen-jobs.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCloudAuthHeaders, resolveCloudBaseUrl } from "../cloud/auth.js";
import { Fix } from "../measure/media.js";

export interface Job {
  id: string;
  status: string;
  failure_code?: string;
  failure_message?: string;
  [field: string]: unknown;
}

const RUNNING = new Set(["pending", "processing", "queued", "running", "waiting", "in_progress"]);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The same request always gets the same key: a re-run is a resume, never a second charge. */
export function idempotencyKey(route: string, parts: readonly (string | Buffer)[]): string {
  const h = createHash("sha256").update(route);
  for (const p of parts) h.update(p).update("\0");
  return `hf-${h.digest("hex").slice(0, 40)}`;
}

// The plans and credits pages are not live yet; HYPERFRAMES_PLANS_URL / HYPERFRAMES_CREDITS_URL override them.
export const plansUrl = () => process.env["HYPERFRAMES_PLANS_URL"] || "https://hyperframes.studio/";
const creditsUrl = () => process.env["HYPERFRAMES_CREDITS_URL"] || plansUrl();

/** A refused call says what to do: sign in, subscribe, add credits, or change the request. */
function refusal(status: number, body: unknown): Fix {
  const err = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  const code = String(err.code ?? err.failure_code ?? "");
  const message = String(err.message ?? err.failure_message ?? "").slice(0, 300);
  const url = typeof err.url === "string" ? err.url : undefined;
  // The fix is the one line the agent relays as printed.
  if (/hf_subscription_required/i.test(code))
    return new Fix(
      "this needs a HyperFrames plan; nothing was charged",
      `Subscribe: ${url ?? plansUrl()}`,
    );
  if (/hf_usage_exhausted/i.test(code))
    return new Fix(
      "out of HyperFrames credits; nothing was charged",
      `Add credits: ${url ?? creditsUrl()}`,
    );
  if (/api_key_required/i.test(code))
    return new Fix(
      "this HeyGen feature is not available with this sign-in yet; nothing was charged",
      "continue without this step",
    );
  if (status === 401 || status === 403)
    return new Fix(
      `HeyGen refused the credential (${status}${message ? `: ${message}` : ""})`,
      "npx hyperframes auth login",
    );
  if (status === 402 || /insufficient|credit|usage_exhausted|quota/i.test(code))
    return new Fix(
      `HeyGen says there is not enough credit (${code || status})`,
      "top up at https://app.heygen.com, or sign in with npx hyperframes auth login to use the plan's allowance",
    );
  if (/content_policy/i.test(code))
    return new Fix(
      `HeyGen declined the content: ${message || code}`,
      "reword the prompt once without the flagged part",
    );
  return new Fix(
    `HeyGen ${status}${code ? ` ${code}` : ""}: ${message || "request refused"}`,
    "fix the request it names, then run again",
  );
}

async function call(
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  key?: string,
): Promise<Job> {
  const headers: Record<string, string> = {
    ...(await resolveCloudAuthHeaders().catch(() => {
      throw new Fix("no HeyGen sign-in on this machine", "npx hyperframes auth login");
    })),
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  let res: Response;
  try {
    res = await fetch(`${resolveCloudBaseUrl()}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(method === "POST" ? 180_000 : 30_000),
    });
  } catch (err) {
    throw new Fix(
      `no answer from HeyGen for ${route} (${err instanceof Error ? err.message : String(err)})`,
      "run the same command again: it resumes the same job",
    );
  }
  const value: unknown = await res.json().catch(() => null);
  if (res.status >= 500 || value === null)
    throw new Fix(
      `HeyGen ${res.status} for ${route} with no readable answer`,
      "run the same command again: it resumes the same job",
    );
  if (!res.ok) throw refusal(res.status, value);
  const data = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(data))
    throw new Fix(`HeyGen answered ${route} with no job`, "run the same command again");
  const id = data.id ?? data.job_id ?? data.video_id ?? data.generation_id;
  return {
    ...data,
    id: typeof id === "string" ? id : "",
    status: String(data.status ?? (id ? "pending" : "completed")),
  };
}

export interface JobLog {
  /** The project whose .hyperframes/heygen-jobs.jsonl records the job; omitted, nothing is logged. */
  projectDir?: string;
  /** What the job is for, in a few words. */
  what: string;
}

function log(entry: JobLog, record: Record<string, unknown>) {
  if (!entry.projectDir) return;
  const dir = join(entry.projectDir, ".hyperframes");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "heygen-jobs.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), what: entry.what, ...record })}\n`,
  );
}

export interface RunOptions {
  /** How long to wait for the job to finish before handing back its id. */
  timeoutMs?: number;
  intervalMs?: number;
  onWait?: (job: Job) => void;
  log?: JobLog;
}

/** Starts a job (or picks up the one this key already started) and polls `pollRoute(id)` until it ends. */
export async function runJob(
  route: string,
  body: unknown,
  key: string,
  pollRoute: (id: string) => string,
  opts: RunOptions = {},
): Promise<Job> {
  const started = Date.now();
  let job = await call("POST", route, body, key);
  if (opts.log) log(opts.log, { route, id: job.id, key, status: job.status });
  while (RUNNING.has(job.status.toLowerCase())) {
    if (Date.now() - started > (opts.timeoutMs ?? 15 * 60_000))
      throw new Fix(
        `HeyGen job ${job.id} is still ${job.status}`,
        "run the same command again later: it picks up this job",
      );
    opts.onWait?.(job);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5000));
    job = await call("GET", pollRoute(job.id));
  }
  if (opts.log) log(opts.log, { route, id: job.id, key, status: job.status });
  if (!/^(completed|succeeded|success|done)$/i.test(job.status))
    throw refusal(422, {
      error: { code: job.failure_code ?? job.status, message: job.failure_message ?? "" },
    });
  return job;
}

/** A plain GET, for reads that are not jobs. */
export const getJson = (route: string) => call("GET", route);
