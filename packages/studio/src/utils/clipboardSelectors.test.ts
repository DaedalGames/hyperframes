// @vitest-environment jsdom
import { expect, it } from "vitest";
import { rebindClipboardSelector } from "./clipboardSelectors";

it.each([
  '[id="Title"]',
  '[id="title" i]',
  '[id^="Ti"]',
  '[id$="tle"]',
  '[id*="itl"]',
  '[id|="Title"]',
  '[id~="Title"]',
  '[id$="-1"]',
  ':not([id="Title"])',
])("preserves renamed ID predicate matching for %s", (selector) => {
  const ids = new Map([
    ["Title", "capture-node-1"],
    ["other", "capture-node-2"],
  ]);
  const rewritten = rebindClipboardSelector(selector, ids);
  for (const [before, after] of ids) {
    const original = document.createElement("span");
    original.id = before;
    const clone = document.createElement("span");
    clone.id = after;
    expect(clone.matches(rewritten)).toBe(original.matches(selector));
  }
});

it("uses only recorded attribute writes and preserves unrelated predicates and strings", () => {
  const selector = 'use[href="#paint"], [fill="url(#paint)"], [title="#paint"]';
  const rewritten = rebindClipboardSelector(selector, new Map([["paint", "copy-paint"]]), [
    { name: "href", before: "#paint", after: "#copy-paint" },
    { name: "fill", before: "url(#paint)", after: 'url("#copy-paint")' },
  ]);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#copy-paint");
  expect(use.matches(rewritten)).toBe(true);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("fill", 'url("#copy-paint")');
  expect(rect.matches(rewritten)).toBe(true);
  expect(rewritten).toContain('[title="#paint"]');
});
