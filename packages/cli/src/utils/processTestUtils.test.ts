import { expect, it } from "vitest";
import { ownedDescendants } from "./processTestUtils.js";

const entry = (parent: number, started: bigint) => ({ parent, name: "node.exe", started });

it("does not own a process that started before the parent whose pid it carries", () => {
  const table = new Map([
    [100, entry(1, 50n)],
    [200, entry(100, 60n)],
    [300, entry(100, 10n)],
    [400, entry(300, 70n)],
  ]);
  expect(ownedDescendants(table, 100)).toEqual([200]);
});

it("owns the whole tree where every child started after its parent", () => {
  const table = new Map([
    [100, entry(1, 50n)],
    [200, entry(100, 60n)],
    [300, entry(200, 70n)],
  ]);
  expect(ownedDescendants(table, 100)).toEqual([200, 300]);
});

it("owns children by parent pid alone where no start is listed", () => {
  const table = new Map([
    [100, { parent: 1, name: "node" }],
    [200, { parent: 100, name: "chrome" }],
  ]);
  expect(ownedDescendants(table, 100)).toEqual([200]);
});
