import { describe, expect, it } from "vitest";
import {
  FEEDBACK_ROLE_ERROR,
  FEEDBACK_ROLES,
  feedbackEmail,
  parseFeedbackRole,
  parseFeedbackSource,
} from "./feedbackSource.js";

describe("parseFeedbackSource", () => {
  it.each([
    [undefined, undefined],
    ["person", "person"],
    [" agent ", "agent"],
    ["Person", null],
    ["", null],
  ])("%j reads as %j", (raw, expected) => {
    expect(parseFeedbackSource(raw)).toBe(expected);
  });
});

describe("parseFeedbackRole", () => {
  it.each([
    [" ai-builder ", "ai-builder"],
    ["unknown", "unknown"],
    [undefined, null],
    ["", null],
    ["Developer", null],
    ["ceo", null],
  ])("%j reads as %j", (raw, expected) => {
    expect(parseFeedbackRole(raw)).toBe(expected);
  });

  it("accepts exactly the ten roles, and the error names every one on one line", () => {
    expect(FEEDBACK_ROLES).toEqual([
      "ai-builder",
      "developer",
      "marketer",
      "creator",
      "designer",
      "founder",
      "agency",
      "educator",
      "other",
      "unknown",
    ]);
    for (const role of FEEDBACK_ROLES) expect(parseFeedbackRole(role)).toBe(role);
    expect(FEEDBACK_ROLE_ERROR).toBe(`--role is required, one of: ${FEEDBACK_ROLES.join(", ")}`);
    expect(FEEDBACK_ROLE_ERROR).not.toContain("\n");
  });
});

describe("feedbackEmail", () => {
  it("reads only HYPERFRAMES_FEEDBACK_EMAIL, trimmed, and nothing when blank", () => {
    expect(feedbackEmail({ HYPERFRAMES_FEEDBACK_EMAIL: " a@b.co " })).toBe("a@b.co");
    expect(feedbackEmail({ HYPERFRAMES_FEEDBACK_EMAIL: "  " })).toBeUndefined();
    expect(feedbackEmail({ EMAIL: "a@b.co" })).toBeUndefined();
  });
});
