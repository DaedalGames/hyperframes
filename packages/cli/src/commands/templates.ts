import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveCloudAuthHeaders } from "../cloud/auth.js";
import { billingBaseUrl } from "../heygen/plan.js";
import { c } from "../ui/colors.js";
import { failCommand } from "../utils/commandResult.js";
import { defineCommand } from "../utils/defineCommand.js";

export interface TemplatePack {
  /** The private bundle's id on the plan-gated route. */
  id: string;
  sha256: string;
  bytes: number;
}

// ponytail: packs are pinned here, so a new pack ships with a CLI release; move to a public index if templates change faster.
export const TEMPLATES: Record<string, TemplatePack> = {
  "fern-brand-explained": {
    id: "M9004",
    sha256: "11baf11bf25cf2cf320d34aaeac9003d12e0f23061e57809e8b5409fa6c3b38d",
    bytes: 20172129,
  },
  "kurzgesagt-science-explainer": {
    id: "M9003",
    sha256: "44c8432816ca8f529565a3d0a55ecb218d7f62403f6946a9495b4920a6c475e6",
    bytes: 25564278,
  },
  "vox-america-explained": {
    id: "M9001",
    sha256: "984d5bd27de053f5955daa7d87d5fe2ab48df7e9170bcd777115836ba7700523",
    bytes: 36705888,
  },
  "xiaolin-yikouqi": {
    id: "M9002",
    sha256: "3e131225e253f8c213479423fa5883c8fae3fbeb805ceff1210030de1b72fd65",
    bytes: 152167805,
  },
};

/** A pull that stopped, with the one line the agent relays. Nothing was written. */
export class PullRefused extends Error {}

const LINK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

async function bundleUrl(pack: TemplatePack, retries = 1): Promise<string> {
  const headers = await resolveCloudAuthHeaders().catch(() => {
    throw new PullRefused("Not signed in. Run `npx hyperframes auth login`.");
  });
  const route = `${billingBaseUrl()}/v1/hyperframes/moments/${pack.id}/bundle?sha256=${pack.sha256}`;
  const res = await fetch(route, {
    headers: { ...headers, accept: "application/json" },
    signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
  });
  if (res.status === 503 && retries > 0) return bundleUrl(pack, retries - 1);
  if (res.status === 401) throw new PullRefused("Not signed in. Run `npx hyperframes auth login`.");
  if (res.status === 402)
    throw new PullRefused(
      "Creator templates are part of HyperFrames Pro; nothing was downloaded. Run `npx hyperframes billing subscribe`: it opens the page and waits.",
    );
  if (res.status === 404) throw new PullRefused("That template version is no longer available.");
  if (!res.ok) throw new PullRefused(`HeyGen could not hand over the template (${res.status}).`);
  const body = (await res.json()) as { data?: { url?: string } };
  if (!body.data?.url) throw new PullRefused("HeyGen answered without a download link.");
  return body.data.url;
}

async function download(url: string, pack: TemplatePack): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new PullRefused(`The download failed (${res.status}). Run it again.`);
  const data = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (data.length !== pack.bytes || sha256 !== pack.sha256)
    throw new PullRefused("The download does not match the template's hash; nothing was unpacked.");
  return data;
}

function assertSafeEntries(archive: string): void {
  const names = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  for (const name of names.split("\n"))
    if (name.startsWith("/") || name.split("/").includes(".."))
      throw new PullRefused(`The template holds an unsafe path (${name}); nothing was unpacked.`);
}

/** Unpacks the pack beside `dest` and moves it in whole, so `dest` only ever holds a complete template. */
function unpack(data: Buffer, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const work = mkdtempSync(`${dest}.part-`);
  try {
    const archive = join(work, "template.tar.gz");
    const out = join(work, "template");
    writeFileSync(archive, data);
    assertSafeEntries(archive);
    mkdirSync(out);
    execFileSync("tar", ["-xzf", archive, "-C", out, "--no-same-owner"]);
    renameSync(out, dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Fetches the template into `<dir>/templates/<slug>/` and returns that path; one already there stays as it is. */
export async function pullTemplate(slug: string, dir: string): Promise<string> {
  const pack = TEMPLATES[slug];
  if (!pack)
    throw new PullRefused(
      `No template "${slug}". Templates: ${Object.keys(TEMPLATES).join(", ")}.`,
    );
  const dest = resolve(dir, "templates", slug);
  if (existsSync(dest)) return dest;
  unpack(await download(await bundleUrl(pack), pack), dest);
  return dest;
}

/** Downloads a creator template for a HyperFrames Pro account. The server decides who may have it. */
export default defineCommand({
  meta: {
    name: "templates",
    description: "Pull a creator template into this project (HyperFrames Pro)",
  },
  args: {
    action: { type: "positional", description: "pull", required: true },
    slug: {
      type: "positional",
      description: "The template, from the skill's README",
      required: true,
    },
    dir: {
      type: "string",
      description: "Project folder (default: the current folder)",
    },
  },
  async run({ args }) {
    if (args.action !== "pull") {
      console.error(c.error("Use `templates pull <slug>`."));
      failCommand();
      return;
    }
    try {
      const path = await pullTemplate(String(args.slug), args.dir ?? ".");
      console.log(c.success(`✓ ${path}`));
    } catch (error) {
      if (!(error instanceof PullRefused)) throw error;
      console.error(c.error(error.message));
      failCommand();
    }
  },
});
