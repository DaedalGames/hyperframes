export type FeedbackSource = "person" | "agent";

const SOURCES: readonly string[] = ["person", "agent"];

/** The `--source` value, undefined when absent, null when it is neither. */
export function parseFeedbackSource(raw: string | undefined): FeedbackSource | null | undefined {
  if (raw === undefined) return undefined;
  const source = raw.trim();
  return SOURCES.includes(source) ? (source as FeedbackSource) : null;
}

export const FEEDBACK_ROLES = [
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
] as const;

export type FeedbackRole = (typeof FEEDBACK_ROLES)[number];

export const FEEDBACK_ROLE_ERROR = `--role is required, one of: ${FEEDBACK_ROLES.join(", ")}`;

/** The `--role` value (who the person running the agent is), null when absent or not in the list. */
export function parseFeedbackRole(raw: string | undefined): FeedbackRole | null {
  const role = raw?.trim();
  return FEEDBACK_ROLES.find((r) => r === role) ?? null;
}

export const FEEDBACK_EMAIL_ENV = "HYPERFRAMES_FEEDBACK_EMAIL";

/** Set only by the launching app (never a flag or a project `.env`); unverified, so never proof of identity. */
export function feedbackEmail(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[FEEDBACK_EMAIL_ENV]?.trim() || undefined;
}
