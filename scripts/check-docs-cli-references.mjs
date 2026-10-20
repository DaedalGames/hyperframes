// Every `hyperframes <command> [--flag]` the docs show in code must exist in the CLI the repo builds.
// The command tree comes from scripts/cli-command-tree.ts, which loads the real citty definitions, so a
// renamed or removed command or flag fails here instead of in a reader's terminal.
//
// Code that only looks like a command (CLI output quoted inline) opts out with
// `{/* cli-references: ignore */}` on its line or the line above.
//
//   node scripts/check-docs-cli-references.mjs [--tree <tree.json>] [docs-dir]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

// Release logs record what the CLI accepted at the time; old flags there are history, not drift.
const HISTORY_PAGES = new Set(["changelog.mdx", "weekly-updates.mdx"]);
const IGNORE = "{/* cli-references: ignore */}";

// Flags citty and the CLI accept on every command (packages/cli/src/utils/reject-unknown-flags.ts).
const ALWAYS_KNOWN = ["help", "h", "version", "v", "json"];

// Words that may come before `hyperframes` when a line runs it: package runners and shell prompts.
const RUNNERS = new Set(["$", ">", "npx", "bunx", "pnpx", "pnpm", "yarn", "npm", "dlx", "exec"]);
const RUNNER_FLAGS = new Set(["-y", "--yes"]);
const INVOCATION = /^(?:hyperframes|@hyperframes\/cli)(?:@[\w.-]+)?$/;
const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=/;
// `<name>`, `[options]`, `{id}`, `$VAR`, `...`: the docs' stand-ins for a value the reader supplies.
const PLACEHOLDER = /[<>[\]{}$|]|\.\.\.|…/;

/** Each piece of code on an MDX page as `{ line, text }`: fenced lines (joined across `\` continuations), inline code, command props. */
export function codeSpans(source) {
  const spans = [];
  const lines = source.split("\n");
  let fence = null;
  let pending = null;
  for (const [index, raw] of lines.entries()) {
    const ignored = raw.includes(IGNORE) || (lines[index - 1] ?? "").includes(IGNORE);
    const marker = raw.match(/^\s*(`{3,}|~{3,})/);
    if (marker && (!fence || raw.trim().startsWith(fence))) {
      fence = fence ? null : marker[1];
      pending = null;
      continue;
    }
    if (fence) {
      const line = pending?.line ?? index + 1;
      const text = pending ? `${pending.text} ${raw.trim()}` : raw;
      if (/\\\s*$/.test(text)) {
        pending = { line, text: text.replace(/\\\s*$/, "") };
        continue;
      }
      pending = null;
      if (!ignored) spans.push({ line, text });
      continue;
    }
    if (ignored) continue;
    for (const m of raw.matchAll(/(`+)([^`]+?)\1(?!`)/g))
      spans.push({ line: index + 1, text: m[2] });
    // Catalog pages hand the install line to a component: <InstallCommand command="npx hyperframes add x" />.
    for (const m of raw.matchAll(/\bcommand=(?:"([^"]*)"|\{"([^"]*)"\})/g))
      spans.push({ line: index + 1, text: m[1] ?? m[2] });
  }
  return spans;
}

/** Shell-ish words per command: quotes group, an unquoted `#` starts a comment, `&&`/`||`/`|`/`;`/`&` end a command. */
export function shellCommands(text) {
  const commands = [[]];
  const pattern = /"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[|;&]|#.*$|[^\s"'|;&#]+(?:#\S*)?/g;
  for (const [token] of text.matchAll(pattern)) {
    if (token.startsWith("#")) break;
    if (["&&", "||", "|", ";", "&"].includes(token)) commands.push([]);
    else commands.at(-1).push(token);
  }
  return commands.filter((words) => words.length > 0);
}

/** The words after `hyperframes` when the command runs our CLI, else null (`npm i -g hyperframes`, `skills add …/hyperframes`). */
export function cliArguments(words) {
  const at = words.findIndex((word) => INVOCATION.test(word));
  if (at < 0) return null;
  const lead = words.slice(0, at);
  const runsCli = lead.every(
    (word) => RUNNERS.has(word) || RUNNER_FLAGS.has(word) || ENV_ASSIGNMENT.test(word),
  );
  return runsCli ? words.slice(at + 1) : null;
}

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const unquote = (word) => word.replace(/^(["'])(.*)\1$/, "$2");
const isFlag = (word) =>
  word.startsWith("-") && word !== "-" && word !== "--" && !/^-\d/.test(word);

/** Every spelling (`x` of `--x` / `-x`) the command accepts, mapped to its flag. Mirrors reject-unknown-flags.ts. */
export function flagSpellings(command) {
  const spellings = new Map(ALWAYS_KNOWN.map((name) => [name, { type: "boolean", global: true }]));
  for (const [name, flag] of Object.entries(command.flags)) {
    for (const spelling of [name, kebab(name), camel(name), ...flag.aliases])
      spellings.set(spelling, flag);
  }
  return spellings;
}

// citty's findSubCommandIndex: the first word that is neither a flag nor a string/enum flag's value; `--` ends the search.
function subCommandIndex(words, spellings) {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--") return -1;
    if (!isFlag(words[i])) return i;
    const flag = spellings.get(words[i].replace(/^-{1,2}/, ""));
    if (!words[i].includes("=") && (flag?.type === "string" || flag?.type === "enum")) i++;
  }
  return -1;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** ` (did you mean x?)` for the nearest candidate a typo or a shortened name could have meant. */
function suggestion(word, candidates, prefix = "") {
  const near = candidates
    .map((candidate) => ({ candidate, distance: editDistance(word, candidate) }))
    .filter(
      ({ candidate, distance }) =>
        distance <= Math.max(1, word.length >> 2) || candidate.startsWith(word),
    )
    .sort((a, b) => a.distance - b.distance)[0];
  return near ? ` (did you mean ${prefix}${near.candidate}?)` : "";
}

// `--name`, `--name=value`, `--no-name` -> the names citty could read it as; `-abc` -> one name per letter.
function flagReadings(word) {
  if (word.startsWith("--")) {
    const name = word.slice(2).split("=")[0];
    return [name.startsWith("no-") ? [name, name.slice(3)] : [name]];
  }
  return [...word.slice(1).split("=")[0]].map((letter) => [letter]);
}

function flagProblems(command, shown, words) {
  const spellings = flagSpellings(command);
  const problems = [];
  for (const word of words) {
    if (word === "--") break;
    if (!isFlag(word) || PLACEHOLDER.test(word.split("=")[0])) continue;
    const dashes = word.startsWith("--") ? "--" : "-";
    for (const readings of flagReadings(word)) {
      const flag = readings.map((name) => spellings.get(name)).find(Boolean);
      const name = `${dashes}${readings[0]}`;
      if (!flag) {
        const hint = dashes === "--" ? suggestion(readings[0], [...spellings.keys()], "--") : "";
        problems.push({ severity: "error", message: `\`${shown}\` has no ${name}${hint}` });
      } else if (flag.deprecated || flag.hidden) {
        const state = flag.deprecated ? "deprecated" : "hidden from --help";
        problems.push({ severity: "warning", message: `\`${shown} ${name}\` is ${state}` });
      }
    }
  }
  return problems;
}

/** Problems with one invocation (the words after `hyperframes`), as `{ severity: "error" | "warning", message }`. */
export function invocationProblems(tree, args) {
  const problems = [];
  let command = tree;
  let words = args;
  const path = ["hyperframes"];
  for (;;) {
    const hasSubs = Object.keys(command.subCommands).length > 0;
    const at = hasSubs ? subCommandIndex(words, flagSpellings(command)) : -1;
    problems.push(...flagProblems(command, path.join(" "), at < 0 ? words : words.slice(0, at)));
    if (at < 0) return problems;
    const name = unquote(words[at]);
    const next = command.subCommands[name];
    if (!next) {
      if (PLACEHOLDER.test(name)) return problems;
      const kind = path.length === 1 ? "command" : "subcommand";
      const hint = suggestion(name, Object.keys(command.subCommands));
      problems.push({
        severity: "error",
        message: `unknown ${kind} \`${path.join(" ")} ${name}\`${hint}`,
      });
      return problems;
    }
    path.push(name);
    if (next.deprecated)
      problems.push({ severity: "warning", message: `\`${path.join(" ")}\` is deprecated` });
    command = next;
    words = words.slice(at + 1);
  }
}

/** Problems on one page, each with the line its command starts on. */
export function pageProblems(tree, source) {
  return codeSpans(source).flatMap(({ line, text }) =>
    shellCommands(text)
      .map(cliArguments)
      .filter(Boolean)
      .flatMap((args) => invocationProblems(tree, args).map((problem) => ({ line, ...problem }))),
  );
}

function mdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return mdxFiles(path);
    return entry.name.endsWith(".mdx") ? [path] : [];
  });
}

export function checkDocs(tree, docsDir) {
  return mdxFiles(docsDir)
    .filter((file) => !HISTORY_PAGES.has(relative(docsDir, file)))
    .sort()
    .flatMap((file) =>
      pageProblems(tree, readFileSync(file, "utf8")).map((problem) => ({
        file: relative(ROOT, file),
        ...problem,
      })),
    );
}

function loadTree(treePath) {
  if (treePath) return JSON.parse(readFileSync(treePath, "utf8"));
  const json = execFileSync("bun", [join(ROOT, "scripts", "cli-command-tree.ts")], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(json);
}

function main() {
  const args = process.argv.slice(2);
  const treeAt = args.indexOf("--tree");
  const treePath = treeAt < 0 ? undefined : args[treeAt + 1];
  const docsArg = args.find((arg, i) => !arg.startsWith("--") && (treeAt < 0 || i !== treeAt + 1));
  const docsDir = resolve(docsArg ?? join(ROOT, "docs"));
  const problems = checkDocs(loadTree(treePath), docsDir);
  const errors = problems.filter((p) => p.severity === "error").length;
  for (const p of problems) console.log(`${p.file}:${p.line}: ${p.severity}: ${p.message}`);
  console.log(
    `${errors} error(s), ${problems.length - errors} warning(s) in the docs' CLI references.`,
  );
  if (errors > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
