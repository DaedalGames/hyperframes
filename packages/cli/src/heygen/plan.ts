// The HyperFrames plan and credits the signed-in account holds, and the web pages that change them.
import { resolveCloudAuthHeaders, resolveCloudBaseUrl } from "../cloud/auth.js";

export interface Plan {
  plan: string;
  credits: number;
  mock?: boolean;
}

const UNPAID = new Set(["incomplete", "incomplete_expired"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ponytail: HYPERFRAMES_MOCK_PLAN="pro:25000" | "none" stands in when the server will not answer the CLI client
// (EF admits only the Desktop client today); drop it once the CLI client is registered.
function mockPlan(): Plan | null {
  const raw = process.env["HYPERFRAMES_MOCK_PLAN"]?.trim();
  if (!raw) return null;
  const [plan = "none", credits = "0"] = raw.split(":");
  return { plan, credits: Number(credits) || 0, mock: true };
}

/** The plan from `/v1/payment/hyperframes/subscription`, else the mock, else null. */
export async function readPlan(): Promise<Plan | null> {
  try {
    const res = await fetch(`${resolveCloudBaseUrl()}/v1/payment/hyperframes/subscription`, {
      headers: { ...(await resolveCloudAuthHeaders()), accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);
    const data = isRecord(body) && isRecord(body.data) ? body.data : body;
    if (!res.ok || !isRecord(data)) return mockPlan();
    const usage = isRecord(data.usage) ? data.usage : {};
    // Shaped as studio-contracts' BillingSubscription: `subscription` is null on Free, and an unpaid placeholder
    // carries its plan's name before the first invoice funds it.
    const sub = isRecord(data.subscription) ? data.subscription : null;
    const paid = !!sub && !UNPAID.has(String(sub.status));
    return {
      plan: paid ? String(sub.plan_name ?? "paid") : "none",
      credits: Number(usage.remaining_units ?? 0) || 0,
    };
  } catch {
    return mockPlan();
  }
}

export const plansUrl = () =>
  process.env["HYPERFRAMES_PLANS_URL"] || "https://hyperframes.studio/pricing";
export const creditsUrl = () =>
  process.env["HYPERFRAMES_CREDITS_URL"] || "https://hyperframes.studio/account/plan";

/** A plans or credits page link carrying the fields the web side reads (source, needed credits, the waiting step). */
export function pageUrl(
  kind: "plans" | "credits",
  fields: { needed?: number; tool?: string; base?: string } = {},
): string {
  const url = new URL(fields.base ?? (kind === "plans" ? plansUrl() : creditsUrl()));
  url.searchParams.set("source", "cli");
  if (fields.needed) url.searchParams.set("needed_credits", String(fields.needed));
  if (fields.tool) url.searchParams.set("tool", fields.tool);
  return url.toString();
}
