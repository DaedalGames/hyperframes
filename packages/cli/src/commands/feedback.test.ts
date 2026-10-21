import { parseArgs, type ArgsDef } from "citty";
import { afterEach, expect, it, vi } from "vitest";
import { FEEDBACK_ROLE_ERROR, parseFeedbackRole } from "../utils/feedbackSource.js";

const mocks = vi.hoisted(() => ({
  // Never settles: waiting on it would hang the command.
  flush: vi.fn(() => new Promise<void>(() => {})),
  submitFeedback: vi.fn(async (_input: { env?: string }) => {}),
  submitCatalogSearchMiss: vi.fn(async () => {}),
}));
vi.mock("../telemetry/client.js", () => ({ shouldTrack: () => true, flush: mocks.flush }));
const trackRenderFeedback = vi.hoisted(() => vi.fn());
const trackFeedbackComment = vi.hoisted(() => vi.fn());
const trackCatalogSearchMiss = vi.hoisted(() => vi.fn());
vi.mock("../telemetry/events.js", () => ({
  trackCatalogSearchMiss,
  trackFeedbackComment,
  trackRenderFeedback,
}));
vi.mock("../telemetry/feedback.js", () => ({ getDoctorSummary: async () => "os=test" }));

afterEach(() => vi.unstubAllEnvs());
vi.mock("../telemetry/config.js", () => ({ readConfig: () => ({ anonymousId: "a" }) }));
vi.mock("../utils/submitFeedback.js", () => ({
  submitFeedback: mocks.submitFeedback,
  submitCatalogSearchMiss: mocks.submitCatalogSearchMiss,
}));

it.each([
  ["a rating", { role: "developer", rating: "8" }, mocks.submitFeedback],
  [
    "a catalog search miss",
    { role: "developer", "search-miss": "typewriter" },
    mocks.submitCatalogSearchMiss,
  ],
])("sends %s without waiting on the telemetry upload", async (_, args, submit) => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: feedback } = await import("./feedback.js");
  await feedback.run?.({ args } as never);
  expect(submit).toHaveBeenCalled();
});

it("tells person feedback from agent feedback, with the email only an app's env can attach", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("HYPERFRAMES_FEEDBACK_EMAIL", " person@example.com ");
  const { default: feedback } = await import("./feedback.js");
  await feedback.run?.({
    args: { role: "other", rating: "6", comment: "hi", source: "person" },
  } as never);
  expect(mocks.submitFeedback).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "person", email: "person@example.com" }),
  );
  // The email goes only into the report: never telemetry, never the environment summary.
  expect(JSON.stringify(trackRenderFeedback.mock.calls)).not.toContain("person@example.com");
  expect(JSON.stringify(mocks.submitFeedback.mock.lastCall?.[0].env)).not.toContain(
    "person@example.com",
  );
  vi.unstubAllEnvs();
  await feedback.run?.({ args: { role: "other", rating: "6", source: "agent" } } as never);
  expect(mocks.submitFeedback).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "agent", email: undefined }),
  );
});

it("refuses a source that is neither person nor agent, and sends nothing", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.submitFeedback.mockClear();
  const { default: feedback } = await import("./feedback.js");
  await expect(
    feedback.run?.({ args: { role: "other", rating: "6", source: "bot" } } as never),
  ).rejects.toThrow();
  expect(mocks.submitFeedback).not.toHaveBeenCalled();
});

it("sends a comment with no rating as its own report, never as a rating", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  trackRenderFeedback.mockClear();
  const comment = "MISSING FEATURE: trim a clip | WORKAROUND: none";
  const { default: feedback } = await import("./feedback.js");
  await feedback.run?.({ args: { role: "other", comment, source: "agent" } } as never);
  expect(trackRenderFeedback).not.toHaveBeenCalled();
  expect(trackFeedbackComment).toHaveBeenLastCalledWith(expect.objectContaining({ comment }));
  expect(mocks.submitFeedback).toHaveBeenLastCalledWith(
    expect.objectContaining({ rating: undefined, comment }),
  );
});

it.each([
  ["neither a rating nor a comment", { role: "other" }],
  ["a blank comment with no rating", { role: "other", comment: "   " }],
  [
    "--file-issue with no rating",
    { role: "other", comment: "MISSING FEATURE: x", "file-issue": true },
  ],
])("refuses %s, and sends nothing", async (_, args) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.submitFeedback.mockClear();
  const { default: feedback } = await import("./feedback.js");
  await expect(feedback.run?.({ args } as never)).rejects.toThrow();
  expect(mocks.submitFeedback).not.toHaveBeenCalled();
});

it("keeps the rating error for an unreadable rating, so a retry keeps the rating", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { default: feedback } = await import("./feedback.js");
  await expect(
    feedback.run?.({ args: { role: "other", rating: "8/10", comment: "x" } } as never),
  ).rejects.toThrow();
  expect(String(errors.mock.calls.at(-1)?.[0])).toContain(
    "Rating must be an integer between 0 and 10",
  );
});

it.each([
  ["a rating", { rating: "8" }],
  ["a comment", { comment: "MISSING FEATURE: x" }],
  ["a catalog search miss", { "search-miss": "typewriter" }],
])(
  "refuses %s with no role or a made-up one, in one line naming all ten, and sends nothing",
  async (_, args) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = [
      mocks.submitFeedback,
      mocks.submitCatalogSearchMiss,
      trackRenderFeedback,
      trackFeedbackComment,
      trackCatalogSearchMiss,
    ];
    const { default: feedback } = await import("./feedback.js");
    for (const role of [undefined, "ceo"]) {
      for (const fn of sent) fn.mockClear();
      await expect(feedback.run?.({ args: { ...args, role } } as never)).rejects.toThrow();
      expect(String(errors.mock.calls.at(-1)?.[0])).toContain(FEEDBACK_ROLE_ERROR);
      for (const fn of sent) expect(fn).not.toHaveBeenCalled();
    }
  },
);

it("sends the role with the report and its telemetry on every path", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: feedback } = await import("./feedback.js");
  const role = expect.objectContaining({ role: "educator" });

  await feedback.run?.({ args: { role: "educator", rating: "9" } } as never);
  expect(mocks.submitFeedback).toHaveBeenLastCalledWith(role);
  expect(trackRenderFeedback).toHaveBeenLastCalledWith(role);

  await feedback.run?.({ args: { role: "educator", comment: "MISSING FEATURE: x" } } as never);
  expect(mocks.submitFeedback).toHaveBeenLastCalledWith(role);
  expect(trackFeedbackComment).toHaveBeenLastCalledWith(role);

  await feedback.run?.({ args: { role: "educator", "search-miss": "typewriter" } } as never);
  expect(mocks.submitCatalogSearchMiss).toHaveBeenLastCalledWith(role);
  expect(trackCatalogSearchMiss).toHaveBeenLastCalledWith(role);
});

it("ships only examples that pass a valid --role", async () => {
  const { default: feedback, examples } = await import("./feedback.js");
  for (const [, command] of examples) {
    const argv = (command.match(/"[^"]*"|\S+/g) ?? []).slice(2).map((t) => t.replace(/^"|"$/g, ""));
    const args = parseArgs(argv, feedback.args as ArgsDef);
    expect(parseFeedbackRole(args.role as string | undefined), command).not.toBeNull();
  }
});
