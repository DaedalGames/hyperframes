import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  OPT_OUT_LABEL,
  cliSurface,
  optOutReason,
  surfaceDiff,
  touchesCli,
  touchesDocs,
  touchesPackages,
  verdict,
} from "./check-docs-impact.mjs";

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

test("cliSurface lists commands, flags with their value type, and aliases, leaving hidden ones out", () => {
  const tree = command(
    {},
    {
      render: command({
        output: flag("string", ["o"]),
        quiet: flag("boolean"),
        old: flag("boolean", [], { hidden: true }),
      }),
      validate: command({}, {}, { deprecated: true }),
      events: command({}, {}, { hidden: true }),
      auth: command({}, { login: command({ token: flag("string") }) }),
    },
  );
  assert.deepEqual(cliSurface(tree), [
    "hyperframes",
    "hyperframes render",
    "hyperframes render --output <string>",
    "hyperframes render -o = --output",
    "hyperframes render --quiet",
    "hyperframes validate (deprecated)",
    "hyperframes auth",
    "hyperframes auth login",
    "hyperframes auth login --token <string>",
  ]);
});

test("surfaceDiff reports removals before additions and ignores reordering", () => {
  assert.deepEqual(surfaceDiff(["a", "b", "c"], ["c", "a", "d"]), ["- b", "+ d"]);
  assert.deepEqual(surfaceDiff(["a"], ["a"]), []);
});

test("a flag that changes from boolean to string-valued is a surface change", () => {
  const before = cliSurface(command({}, { lint: command({ fix: flag("boolean") }) }));
  const after = cliSurface(command({}, { lint: command({ fix: flag("string") }) }));
  assert.deepEqual(surfaceDiff(before, after), [
    "- hyperframes lint --fix",
    "+ hyperframes lint --fix <string>",
  ]);
});

test("optOutReason accepts the label as a name or a label object, or a docs-impact: none body line", () => {
  assert.equal(optOutReason({ labels: [OPT_OUT_LABEL] }), `labelled ${OPT_OUT_LABEL}`);
  assert.equal(optOutReason({ labels: [{ name: OPT_OUT_LABEL }] }), `labelled ${OPT_OUT_LABEL}`);
  assert.ok(optOutReason({ body: "## What\n\nDocs-Impact: none, internal helper only\n" }));
  assert.equal(
    optOutReason({ labels: ["docs"], body: "Mentions docs-impact: none mid-sentence." }),
    null,
  );
  assert.equal(optOutReason({}), null);
});

test("changed-file filters: CLI sources without tests or fixtures, package entries and manifests, docs", () => {
  assert.ok(touchesCli(["packages/cli/src/commands/render.ts"]));
  assert.ok(touchesCli(["packages/cli/src/cli.ts"]));
  assert.ok(!touchesCli(["packages/cli/src/commands/render.test.ts"]));
  assert.ok(!touchesCli(["packages/cli/src/commands/__fixtures__/clip.mp4"]));
  assert.ok(!touchesCli(["packages/cli/scripts/build-copy.mjs"]));
  assert.ok(touchesPackages(["packages/sdk/src/index.ts"]));
  assert.ok(touchesPackages(["packages/core/package.json"]));
  assert.ok(!touchesPackages(["packages/core/README.md"]));
  assert.ok(touchesDocs(["docs/packages/cli.mdx"]));
  assert.ok(!touchesDocs(["DOCS_GUIDELINES.md"]));
});

test("verdict passes with no surface change or with an excuse, and fails otherwise unless dry-run", () => {
  assert.equal(verdict({ changed: 0, excuse: null }).pass, true);
  assert.deepEqual(verdict({ changed: 2, excuse: "it changes docs/" }), {
    pass: true,
    message: "passes, it changes docs/.",
  });
  assert.equal(verdict({ changed: 2, excuse: null }).pass, false);
  assert.match(verdict({ changed: 2, excuse: null }).message, /docs-not-needed/);
  assert.equal(verdict({ changed: 2, excuse: null, dryRun: true }).pass, true);
});
