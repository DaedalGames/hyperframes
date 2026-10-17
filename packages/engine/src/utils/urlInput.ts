import { existsSync } from "node:fs";
import { redactUrlQueryStrings } from "@hyperframes/core";

// The Lambda nodejs image (Amazon Linux 2023) ships the first; Debian/Ubuntu the second; macOS the third.
const CA_BUNDLES = [
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
];

/** ffmpeg and ffprobe skip TLS certificate checks unless told to; an https input must be verified. */
export function urlInputArgs(input: string, caBundles: readonly string[] = CA_BUNDLES): string[] {
  if (!/^https:\/\//i.test(input)) return [];
  const caFile = caBundles.find((path) => existsSync(path));
  if (!caFile) {
    throw new Error(
      `[FFmpeg] cannot verify TLS for an https input: no CA bundle at ${caBundles.join(", ")}`,
    );
  }
  return ["-tls_verify", "1", "-ca_file", caFile];
}

/** A signed URL grants access until it expires: strip query strings from every string field of an error. */
export function redactUrlQueriesInError<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  const fields = error as unknown as Record<string, unknown>;
  for (const key of ["message", "stack", ...Object.keys(error)]) {
    if (typeof fields[key] === "string") fields[key] = redactUrlQueryStrings(fields[key]);
  }
  return error;
}
