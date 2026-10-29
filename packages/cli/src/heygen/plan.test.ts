import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cloud/auth.js", () => ({
  resolveCloudAuthHeaders: async () => ({ "x-api-key": "k" }),
  resolveCloudBaseUrl: () => "https://api.dev.heygen.com",
}));

const { readPlan } = await import("./plan.js");

const asked: string[] = [];
const answer = (data: unknown) =>
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ code: 100, data }));
  });

afterEach(() => vi.unstubAllGlobals());

describe("readPlan", () => {
  it("reads the plan the way the subscription route sends it", async () => {
    answer({
      subscription: { plan_name: "pro", status: "active" },
      usage: { remaining_units: 25000 },
    });
    expect(await readPlan()).toEqual({ plan: "pro", credits: 25000 });
    expect(asked.at(-1)).toBe("https://api2.dev.heygen.com/v1/payment/hyperframes/subscription");
    answer({ subscription: null, usage: { remaining_units: 0 } });
    expect(await readPlan()).toEqual({ plan: "none", credits: 0 });
    answer({
      subscription: { plan_name: "pro", status: "incomplete" },
      usage: { remaining_units: 0 },
    });
    expect((await readPlan())?.plan).toBe("none");
  });
});
