import { existsSync } from "node:fs";
import { redactUrlQueryStrings } from "@hyperframes/core";
import { SELF_CONTAINED_FORMATS, mediaInputFormatArgs } from "@hyperframes/parsers/ff-binaries";
import { resolveRestrictPageNetwork } from "../config.js";
import { getFfmpegBinary, getFfprobeBinary } from "./ffmpegBinaries.js";

// The Lambda nodejs image (Amazon Linux 2023) ships the first; Debian/Ubuntu the second; macOS the third.
const CA_BUNDLES = [
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
];

// Lambda's ffprobe 4.0 accepts these but not -reconnect_on_network_error; a stalled read fails after 30 s.
const RECONNECT_ARGS = ["-rw_timeout", "30000000", "-reconnect", "1", "-reconnect_delay_max", "2"];

const contentAddressedUrls = new Map<string, string>();
const withoutQuery = (url: string) => url.split(/[?#]/, 1)[0] ?? url;

/** A URL whose bytes can never change (its path holds their hash), so probes of it are cacheable. A render declares
 * only its operator's own files, so with a restricted page network these are also the URLs read directly. */
export function declareContentAddressedUrl(url: string, sha256: string): void {
  contentAddressedUrls.set(withoutQuery(url), sha256);
}

export function contentAddressedSha256(url: string): string | undefined {
  return contentAddressedUrls.get(withoutQuery(url));
}

/** A media input with a URL scheme ffmpeg would open itself (two letters or more, so `C:\` stays a path). */
const SCHEME = /^([a-z][a-z0-9+.-]+):/i;
const PROXIED_PROTOCOLS = "http,https,tls,tcp,httpproxy";

/** How a media input is read with a restricted page network: a local file as it is, an https URL the render declared
 * directly, any other http(s) URL only through the public-only capture proxy. Any other scheme is refused. */
function restrictedRoute(input: string): "local" | "declared" | "proxy" {
  const scheme = SCHEME.exec(input)?.[1]?.toLowerCase();
  if (scheme === undefined || scheme === "file") return "local";
  if (scheme === "https" && contentAddressedSha256(input)) return "declared";
  if (scheme === "http" || scheme === "https") return "proxy";
  throw new Error(
    `[FFmpeg] a ${scheme}: input is not read with a restricted page network`,
  );
}

export function selfContainedFormatArgs(): string[] {
  return resolveRestrictPageNetwork() ? ["-format_whitelist", SELF_CONTAINED_FORMATS] : [];
}

/** Every input of composition media reads only demuxers that open nothing by themselves. ffmpeg and ffprobe skip TLS certificate checks unless told to; an https input must be verified, and on a render service be a self-contained container that names only HTTPS. */
export function urlInputArgs(
  input: string,
  {
    tool = "ffmpeg",
    caBundles = CA_BUNDLES,
  }: { tool?: "ffmpeg" | "ffprobe"; caBundles?: readonly string[] } = {},
): string[] {
  const mediaFormats = () =>
    mediaInputFormatArgs(tool === "ffprobe" ? getFfprobeBinary() : getFfmpegBinary());
  const restricted = resolveRestrictPageNetwork();
  const route = restricted ? restrictedRoute(input) : undefined;
  if (route === "proxy" && !/^https:\/\//i.test(input))
    return [...RECONNECT_ARGS, ...networkRetryFor(tool), ...proxiedLimits(), ...UNSET_PROXY];
  if (!/^https:\/\//i.test(input)) return mediaFormats();
  const caFile = caBundles.find((path) => existsSync(path));
  if (!caFile) {
    throw new Error(
      `[FFmpeg] cannot verify TLS for an https input: no CA bundle at ${caBundles.join(", ")}`,
    );
  }
  const networkRetry = networkRetryFor(tool);
  const renderServiceLimits =
    route === "proxy"
      ? [...proxiedLimits(), ...UNSET_PROXY]
      : restricted
        ? ["-protocol_whitelist", "https,tls,tcp", ...selfContainedFormatArgs()]
        : mediaFormats();
  return [
    "-tls_verify",
    "1",
    "-ca_file",
    caFile,
    ...RECONNECT_ARGS,
    ...networkRetry,
    ...renderServiceLimits,
  ];
}

const networkRetryFor = (tool: "ffmpeg" | "ffprobe") =>
  tool === "ffmpeg" ? ["-reconnect_on_network_error", "1"] : [];
const proxiedLimits = () => [
  "-protocol_whitelist",
  PROXIED_PROTOCOLS,
  ...selfContainedFormatArgs(),
];
// Port 9 (discard) answers nothing: a read that never went through withPublicOnlyProxy reaches no host at all.
const UNSET_PROXY = ["-http_proxy", "http://127.0.0.1:9"];

type Routed = { args: string[]; env: NodeJS.ProcessEnv; close(): Promise<void> };

/** With a restricted page network, `args` with each http(s) input the render did not declare (given by its index)
 * preceded by its limits and `-http_proxy` to a public-only proxy, stopped by `close`. Undefined, with nothing
 * awaited, when no input needs the proxy, so a local read spawns exactly as before. */
export function withPublicOnlyProxy(
  args: readonly string[],
  inputAt: readonly number[],
): Promise<Routed> | undefined {
  if (!resolveRestrictPageNetwork()) return undefined;
  const proxied = inputAt.filter((at) => restrictedRoute(args[at]!) === "proxy");
  return proxied.length === 0 ? undefined : startProxyFor(args, proxied);
}

async function startProxyFor(args: readonly string[], proxied: readonly number[]): Promise<Routed> {
  const { logRefusal, startCaptureProxy } = await import(
    "../services/publicNetwork/captureProxy.js"
  );
  const proxy = await startCaptureProxy(null, logRefusal);
  const out = [...args];
  // From the last input back, so each earlier index still points at its input.
  for (const at of [...proxied].sort((a, b) => b - a)) {
    const flagAt = out[at - 1] === "-i" || out[at - 1] === "--" ? at - 1 : at;
    out.splice(flagAt, 0, ...proxiedLimits(), "-http_proxy", proxy.url);
  }
  // ffmpeg skips its proxy for a host `no_proxy` names.
  const { no_proxy: _a, NO_PROXY: _b, ...env } = process.env;
  return { args: out, env, close: () => proxy.close() };
}

/** Where each `-i` input sits in an ffmpeg command line. */
export const ffmpegInputIndexes = (args: readonly string[]): number[] =>
  args.flatMap((arg, at) => (arg === "-i" && at + 1 < args.length ? [at + 1] : []));

/** A signed URL grants access until it expires: strip query strings from every string field of an error and its causes. */
export function redactUrlQueriesInError<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  const fields = error as unknown as Record<string, unknown>;
  for (const key of ["message", "stack", ...Object.keys(error)]) {
    if (typeof fields[key] === "string") fields[key] = redactUrlQueryStrings(fields[key]);
  }
  if (error.cause !== error) redactUrlQueriesInError(error.cause);
  return error;
}
