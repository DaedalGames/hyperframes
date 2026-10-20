import { strict as assert } from "node:assert";
import { test } from "node:test";

import { moduleExports, packageSurface } from "./public-api-surface.mjs";

const reader = (files) => (path) => files[path];

test("moduleExports follows relative export * chains and keeps package re-exports opaque", () => {
  const read = reader({
    "p/src/index.ts": [
      'export * from "./a.js";',
      'export * as helpers from "./helpers";',
      'export { b as renamed, type C } from "./b.js";',
      'export * from "@hyperframes/core";',
      "export const one = 1, two = 2;",
      "export function make() {}",
      "export interface Options {}",
      "export type Id = string;",
      "export default class Thing {}",
      "const hidden = 3;",
      "export { hidden as visible };",
    ].join("\n"),
    "p/src/a.ts": 'export enum Mode { A }\nexport default 1;\nexport * from "./index.js";',
    "p/src/helpers/index.ts": "export const helper = 1;",
    "p/src/b.ts": "export const b = 1;\nexport type C = number;",
  });
  assert.deepEqual(moduleExports("p/src/index.ts", read).sort(), [
    '* from "@hyperframes/core"',
    "C",
    "Id",
    "Mode",
    "Options",
    "default",
    "helpers",
    "make",
    "one",
    "renamed",
    "two",
    "visible",
  ]);
});

test("packageSurface lists subpaths, bins and root exports, and skips private packages", () => {
  const read = reader({
    "packages/a/package.json": JSON.stringify({
      name: "@x/a",
      bin: { a: "./bin/a.mjs" },
      exports: {
        ".": { bun: "./src/index.ts", node: "./dist/index.js" },
        "./extra": "./src/extra.ts",
      },
      publishConfig: { exports: { "./published-only": "./dist/p.js" } },
    }),
    "packages/a/src/index.ts": "export const run = 1;",
    "packages/b/package.json": JSON.stringify({
      name: "@x/b",
      private: true,
      exports: { ".": "./src/index.ts" },
    }),
  });
  assert.deepEqual(packageSurface("packages/a/package.json", read), [
    "@x/a exports .",
    "@x/a exports ./extra",
    "@x/a exports ./published-only",
    "@x/a bin a",
    "@x/a export run",
  ]);
  assert.deepEqual(packageSurface("packages/b/package.json", read), []);
});

test("packageSurface reads a root entry built into dist/ from its src/ source", () => {
  const read = reader({
    "packages/player/package.json": JSON.stringify({
      name: "@x/player",
      exports: { ".": { types: "./dist/player.d.ts", import: "./dist/player.js" } },
    }),
    "packages/player/src/player.ts": "export class Player {}",
  });
  assert.deepEqual(packageSurface("packages/player/package.json", read), [
    "@x/player exports .",
    "@x/player export Player",
  ]);
});
