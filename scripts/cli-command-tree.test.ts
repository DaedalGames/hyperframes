import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { commandLoaders, describeCommand, type CittyCommand } from "./cli-command-tree.ts";

const cliSource = readFileSync(
  join(import.meta.dirname, "..", "packages", "cli", "src", "cli.ts"),
  "utf8",
);

test("commandLoaders reads every entry of cli.ts's commandLoaders, including multi-line ones", () => {
  const loaders = commandLoaders(cliSource);
  const byName = new Map(loaders.map((loader) => [loader.name, loader]));
  assert.ok(loaders.length > 40);
  assert.deepEqual(byName.get("render"), { name: "render", file: "render", exportName: "default" });
  assert.deepEqual(byName.get("media-treatment"), {
    name: "media-treatment",
    file: "media-treatment",
    exportName: "mediaTreatmentCommand",
  });
  assert.equal(byName.get("preview")?.file, "preview");
});

test("commandLoaders fails loudly when an entry stops matching the pattern", () => {
  const changed = cliSource.replace(
    'render: () => import("./commands/render.js").then((m) => m.default),',
    'render: () => load("render"),',
  );
  assert.throws(() => commandLoaders(changed), /update the pattern/);
  assert.throws(() => commandLoaders("export {};"), /commandLoaders/);
});

test("describeCommand resolves lazy parts and records flags, aliases, hidden and deprecated", async () => {
  const command: CittyCommand = {
    meta: () => ({ name: "cloud", description: "Cloud renders" }),
    args: {
      dir: { type: "positional" },
      output: { type: "string", alias: "o" },
      quiet: { type: "boolean", alias: ["q", "s"] },
      legacy: { type: "boolean", hidden: true, description: "Deprecated alias for --quiet" },
    },
    subCommands: {
      list: () =>
        Promise.resolve({ meta: { description: "(deprecated, use ls)" }, args: () => ({}) }),
    },
  };
  assert.deepEqual(await describeCommand(command), {
    hidden: false,
    deprecated: false,
    flags: {
      output: { type: "string", aliases: ["o"], hidden: false, deprecated: false },
      quiet: { type: "boolean", aliases: ["q", "s"], hidden: false, deprecated: false },
      legacy: { type: "boolean", aliases: [], hidden: true, deprecated: true },
    },
    subCommands: { list: { hidden: false, deprecated: true, flags: {}, subCommands: {} } },
  });
});
