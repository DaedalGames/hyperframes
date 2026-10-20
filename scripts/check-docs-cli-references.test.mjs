import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  cliArguments,
  codeSpans,
  flagSpellings,
  invocationProblems,
  pageProblems,
  shellCommands,
} from "./check-docs-cli-references.mjs";

const flag = (type, aliases = [], extra = {}) => ({
  type,
  aliases,
  hidden: false,
  deprecated: false,
  ...extra,
});
const command = (flags = {}, subCommands = {}, extra = {}) => ({
  hidden: false,
  deprecated: false,
  flags,
  subCommands,
  ...extra,
});

const TREE = command(
  { version: flag("boolean", ["V"]) },
  {
    render: command({
      output: flag("string", ["o"]),
      quality: flag("enum"),
      browserGpu: flag("boolean"),
      legacy: flag("boolean", [], { deprecated: true }),
    }),
    init: command({
      example: flag("string", ["e"]),
      template: flag("string", ["t"], { hidden: true }),
    }),
    validate: command({}, {}, { deprecated: true }),
    cloud: command(
      { region: flag("string") },
      { render: command({ "dry-run": flag("boolean") }), list: command() },
    ),
  },
);

const messages = (args) => invocationProblems(TREE, args).map((p) => `${p.severity}: ${p.message}`);

test("codeSpans joins backslash-continued fenced lines and reports the first line", () => {
  const page = [
    "intro",
    "```bash",
    "npx hyperframes render \\",
    "  --output out.mp4 \\",
    "  --quality high",
    "```",
  ].join("\n");
  assert.deepEqual(codeSpans(page), [
    { line: 3, text: "npx hyperframes render  --output out.mp4  --quality high" },
  ]);
});

test("codeSpans reads inline code, catalog command props, and fences nested in components", () => {
  const page = [
    "Run `hyperframes lint` then ``hyperframes check``.",
    '<InstallCommand command="npx hyperframes add grain" />',
    "<Tab>",
    "  ```bash",
    "  hyperframes preview",
    "  ```",
    "</Tab>",
  ].join("\n");
  assert.deepEqual(codeSpans(page), [
    { line: 1, text: "hyperframes lint" },
    { line: 1, text: "hyperframes check" },
    { line: 2, text: "npx hyperframes add grain" },
    { line: 5, text: "  hyperframes preview" },
  ]);
});

test("codeSpans skips code marked cli-references: ignore on its line or the line above", () => {
  const page = [
    "{/* cli-references: ignore */}",
    "prints `hyperframes auto-updated to v1`",
    "`hyperframes lint`",
  ].join("\n");
  assert.deepEqual(codeSpans(page), [{ line: 3, text: "hyperframes lint" }]);
});

test("shellCommands splits chained commands and drops comments, keeping quoted words whole", () => {
  assert.deepEqual(
    shellCommands('cd app && npx hyperframes render --output "my film.mp4" # then share'),
    [
      ["cd", "app"],
      ["npx", "hyperframes", "render", "--output", '"my film.mp4"'],
    ],
  );
  assert.deepEqual(shellCommands("hyperframes lint | tee log; hyperframes check"), [
    ["hyperframes", "lint"],
    ["tee", "log"],
    ["hyperframes", "check"],
  ]);
});

test("cliArguments recognises runners, pinned versions and env prefixes, and leaves other tools alone", () => {
  const args = (line) => cliArguments(shellCommands(line)[0]);
  assert.deepEqual(args("hyperframes render"), ["render"]);
  assert.deepEqual(args("npx -y hyperframes@latest lint --json"), ["lint", "--json"]);
  assert.deepEqual(args("$ bunx @hyperframes/cli@0.8.0 check"), ["check"]);
  assert.deepEqual(args("HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes doctor"), ["doctor"]);
  assert.equal(args("npx skills add heygen-com/hyperframes --skill hyperframes-cli"), null);
  assert.equal(args("npm install -g hyperframes"), null);
  assert.equal(args("/hyperframes make me a video"), null);
});

test("flagSpellings accepts kebab and camel spellings, aliases and the global flags", () => {
  const spellings = flagSpellings(TREE.subCommands.render);
  for (const spelling of ["browser-gpu", "browserGpu", "o", "output", "help", "h", "json", "v"])
    assert.ok(spellings.has(spelling), spelling);
  assert.ok(!spellings.has("out"));
});

test("known commands, flags, negations, aliases and combined short flags pass", () => {
  assert.deepEqual(
    messages(["render", "./film", "-o", "out.mp4", "--no-browser-gpu", "--quality=high"]),
    [],
  );
  assert.deepEqual(messages(["cloud", "render", "--dry-run"]), []);
  assert.deepEqual(messages(["--version"]), []);
  assert.deepEqual(messages(["render", "-oh", "x"]), []);
});

test("unknown commands, subcommands and flags are errors with a suggestion when one is close", () => {
  assert.deepEqual(messages(["rendr"]), [
    "error: unknown command `hyperframes rendr` (did you mean render?)",
  ]);
  assert.deepEqual(messages(["cloud", "lst"]), [
    "error: unknown subcommand `hyperframes cloud lst` (did you mean list?)",
  ]);
  assert.deepEqual(messages(["render", "--out", "x.mp4"]), [
    "error: `hyperframes render` has no --out (did you mean --output?)",
  ]);
  assert.deepEqual(messages(["render", "--fps", "30"]), [
    "error: `hyperframes render` has no --fps",
  ]);
  assert.deepEqual(messages(["init", "-ez"]), ["error: `hyperframes init` has no -z"]);
});

test("placeholders, values, negative numbers and words after -- are not read as commands or flags", () => {
  assert.deepEqual(messages(["render", "<dir>", "--output", "<file>", "--<flag>", "..."]), []);
  assert.deepEqual(messages(["render", "--output", "-1"]), []);
  assert.deepEqual(messages(["render", "--", "--anything"]), []);
  assert.deepEqual(messages(["cloud", "<subcommand>"]), []);
  // A string flag's value is not where citty looks for the subcommand.
  assert.deepEqual(messages(["cloud", "--region", "eu", "list"]), []);
});

test("deprecated commands and flags, and hidden flags, are warnings", () => {
  assert.deepEqual(messages(["validate"]), ["warning: `hyperframes validate` is deprecated"]);
  assert.deepEqual(messages(["render", "--legacy"]), [
    "warning: `hyperframes render --legacy` is deprecated",
  ]);
  assert.deepEqual(messages(["init", "-t", "blank"]), [
    "warning: `hyperframes init -t` is hidden from --help",
  ]);
});

test("pageProblems reports the line a multi-line command starts on", () => {
  const page = [
    "# Render",
    "",
    "```bash",
    "npx hyperframes render \\",
    "  --output out.mp4 \\",
    "  --qualty high",
    "```",
  ].join("\n");
  assert.deepEqual(pageProblems(TREE, page), [
    {
      line: 4,
      severity: "error",
      message: "`hyperframes render` has no --qualty (did you mean --quality?)",
    },
  ]);
});
