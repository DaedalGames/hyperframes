import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cloud/auth.js", () => ({
  resolveCloudAuthHeaders: async () => ({ "x-api-key": "k" }),
  resolveCloudBaseUrl: () => "https://api.example.test",
}));

const { pageUrl, readPlan } = await import("./plan.js");

const asked: string[] = [];
const answer = (data: unknown) =>
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ code: 100, data }));
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("readPlan", () => {
  it("reads the plan the way the subscription route sends it", async () => {
    answer({
      subscription: { plan_name: "pro", status: "active" },
      usage: { remaining_units: 25000 },
    });
    expect(await readPlan()).toEqual({ plan: "pro", credits: 25000 });
    expect(asked.at(-1)).toBe("https://api2.example.test/v1/payment/hyperframes/subscription");
    answer({ subscription: null, usage: { remaining_units: 0 } });
    expect(await readPlan()).toEqual({ plan: "none", credits: 0 });
    answer({
      subscription: { plan_name: "pro", status: "incomplete" },
      usage: { remaining_units: 0 },
    });
    expect((await readPlan())?.plan).toBe("none");
  });
});

const SPACE = "abcdef0123456789abcdef0123456789";
const signedInAs = (space: unknown) => answer({ space_info: { space_id: space } });
const signedOut = () => vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));

describe("pageUrl", () => {
  it("links the web app for HYPERFRAMES_ENV and tells the page the buyer came from the CLI", async () => {
    signedOut();
    vi.stubEnv("HYPERFRAMES_PLANS_URL", "");
    vi.stubEnv("HYPERFRAMES_CREDITS_URL", "");
    vi.stubEnv("HYPERFRAMES_ENV", "prod");
    expect(await pageUrl("plans")).toBe("https://hyperframes.studio/pricing?from=cli");
    expect(await pageUrl("credits")).toBe("https://hyperframes.studio/pricing?from=cli");
    expect(await pageUrl("plans", { feature: "reverse", rs: "rvs_x" })).toBe(
      "https://hyperframes.studio/pricing?from=cli&feature=reverse&rs=rvs_x",
    );
    expect(await pageUrl("credits", { needed: 180, tool: "reverse" })).toBe(
      "https://hyperframes.studio/pricing?from=cli&needed_credits=180&tool=reverse",
    );
    vi.stubEnv("HYPERFRAMES_ENV", "dev");
    expect(await pageUrl("plans")).toBe("https://hyperframes.studio/pricing?from=cli");
    vi.stubEnv("HYPERFRAMES_PLANS_URL", "https://example.test/plans");
    expect(await pageUrl("plans")).toBe("https://example.test/plans?from=cli");
  });

  it("carries the workspace the sign-in is bound to on every link, read from account.get", async () => {
    signedInAs(SPACE);
    vi.stubEnv("HYPERFRAMES_PLANS_URL", "");
    vi.stubEnv("HYPERFRAMES_CREDITS_URL", "");
    for (const kind of ["plans", "credits"] as const) {
      const url = new URL(await pageUrl(kind, { needed: 5 }));
      expect(url.searchParams.get("workspace_hint")).toBe(SPACE);
      expect(url.searchParams.get("from")).toBe("cli");
    }
    expect(asked.at(-1)).toBe("https://api2.example.test/v1/pacific/account.get");
  });

  it("carries none when signed out, when the read fails, or when the id is not a workspace id", async () => {
    signedOut();
    expect(new URL(await pageUrl("plans")).searchParams.has("workspace_hint")).toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(new URL(await pageUrl("plans")).searchParams.has("workspace_hint")).toBe(false);
    for (const bad of ["a/../b", "", 7, "x".repeat(65)]) {
      signedInAs(bad);
      expect(new URL(await pageUrl("plans")).searchParams.has("workspace_hint")).toBe(false);
    }
  });
});
