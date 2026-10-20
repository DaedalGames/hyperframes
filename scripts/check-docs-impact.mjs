// A pull request that changes what users type or import must change the docs with it.
//
// Fails when, between the merge base and HEAD, either surface changed and nothing under docs/ did:
//   CLI      every command, subcommand and flag the citty definitions declare (scripts/cli-command-tree.ts),
//            hidden ones excepted; flag value types and deprecation count as changes.
//   exports  every public package's exports subpaths, bin names and root-entry exports
//            (scripts/public-api-surface.mjs).
// The PR opts out with the `docs-not-needed` label or a `docs-impact: none` line in its body
// (PR_LABELS: JSON array of label names or label objects; PR_BODY: the body).
//
//   node scripts/check-docs-impact.mjs [--base <ref>] [--dry-run] [--base-tree <json>] [--head-tree <json>]
//
// The base CLI tree is built from a temporary worktree (bun install + core build), only when the CLI's
// sources changed. --dry-run prints the verdict and exits 0.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicApiSurface } from "./public-api-surface.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const OPT_OUT_LABEL = "docs-not-needed";
const OPT_OUT_BODY = /^\s*docs-impact:\s*none\b/im;

const CLI_SOURCE =
  /^packages\/cli\/src\/(?!.*\.test\.tsx?$)(?!(?:.*\/)?(?:__fixtures__|fixtures)\/)/;
const PACKAGE_SOURCE = /^packages\/[^/]+\/(?:package\.json$|src\/)/;

/** One line per user-visible command, flag and alias, e.g. `hyperframes render --output <string>`. */
export function cliSurface(tree, path = ["hyperframes"]) {
  const shown = path.join(" ");
  const lines = [path.length > 1 ? `${shown}${tree.deprecated ? " (deprecated)" : ""}` : shown];
  for (const [name, flag] of Object.entries(tree.flags)) {
    if (flag.hidden) continue;
    const value = flag.type === "boolean" ? "" : ` <${flag.type}>`;
    lines.push(`${shown} --${name}${value}${flag.deprecated ? " (deprecated)" : ""}`);
    for (const alias of flag.aliases) lines.push(`${shown} -${alias} = --${name}`);
  }
  for (const [name, sub] of Object.entries(tree.subCommands)) {
    if (!sub.hidden) lines.push(...cliSurface(sub, [...path, name]));
  }
  return lines;
}

/** `-` lines the base had and HEAD lost, then `+` lines HEAD added. */
export function surfaceDiff(base, head) {
  const before = new Set(base);
  const after = new Set(head);
  return [
    ...base.filter((line) => !after.has(line)).map((line) => `- ${line}`),
    ...head.filter((line) => !before.has(line)).map((line) => `+ ${line}`),
  ];
}

/** Why the PR may skip docs, or null. */
export function optOutReason({ labels = [], body = "" }) {
  const names = labels.map((label) => (typeof label === "string" ? label : label?.name));
  if (names.includes(OPT_OUT_LABEL)) return `labelled ${OPT_OUT_LABEL}`;
  if (OPT_OUT_BODY.test(body)) return "the body says `docs-impact: none`";
  return null;
}

export const touchesDocs = (files) => files.some((file) => file.startsWith("docs/"));
export const touchesCli = (files) => files.some((file) => CLI_SOURCE.test(file));
export const touchesPackages = (files) => files.some((file) => PACKAGE_SOURCE.test(file));

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
}

// Output is kept for the error a failed step throws, not printed: installs and builds are noisy.
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", GIT_LFS_SKIP_SMUDGE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const treeAt = (root) =>
  JSON.parse(run("bun", [join(ROOT, "scripts", "cli-command-tree.ts"), "--root", root], root));

// The base revision's command modules need their own dependencies and generated core sources.
function baseTree(sha) {
  const dir = mkdtempSync(join(tmpdir(), "hf-docs-impact-"));
  try {
    run("git", ["worktree", "add", "--detach", dir, sha], ROOT);
    run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], dir);
    run("bun", ["run", "--cwd", "packages/core", "build"], dir);
    return treeAt(dir);
  } finally {
    git(["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function flag(args, name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function parseLabels(raw) {
  if (!raw) return [];
  const labels = JSON.parse(raw);
  return Array.isArray(labels) ? labels : [];
}

function report(heading, lines) {
  if (lines.length === 0) return;
  console.log(heading);
  for (const line of lines) console.log(`  ${line}`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const base = git(["merge-base", flag(args, "--base") ?? "origin/main", "HEAD"]);
  const files = git(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean);
  const pr = { labels: parseLabels(process.env.PR_LABELS), body: process.env.PR_BODY ?? "" };
  const excuse = touchesDocs(files) ? "it changes docs/" : optOutReason(pr);
  if (excuse && !dryRun) {
    console.log(`Docs impact: passes, ${excuse}.`);
    return;
  }

  const baseTreePath = flag(args, "--base-tree");
  const headTreePath = flag(args, "--head-tree");
  const cliChanges =
    touchesCli(files) || baseTreePath
      ? surfaceDiff(
          cliSurface(baseTreePath ? readJson(baseTreePath) : baseTree(base)),
          cliSurface(headTreePath ? readJson(headTreePath) : treeAt(ROOT)),
        )
      : [];
  const exportChanges = touchesPackages(files)
    ? surfaceDiff(publicApiSurface(base, ROOT), publicApiSurface("HEAD", ROOT))
    : [];

  report("CLI commands and flags changed:", cliChanges);
  report("Public package exports changed:", exportChanges);
  if (cliChanges.length + exportChanges.length === 0) {
    console.log("Docs impact: passes, no CLI command, flag or public export changed.");
    return;
  }
  if (excuse) {
    console.log(`Docs impact: passes, ${excuse}.`);
    return;
  }
  console.log(
    `\nDocs impact${dryRun ? " (dry run)" : ""}: update docs/ for the changes above, or opt out with the \`${OPT_OUT_LABEL}\` label` +
      " or a `docs-impact: none` line in the PR body (say why).",
  );
  if (!dryRun) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
