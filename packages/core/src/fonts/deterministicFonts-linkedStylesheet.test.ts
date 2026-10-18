// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectDeterministicFontFaces } from "./deterministicFonts.js";

const projectDir = mkdtempSync(join(tmpdir(), "hf-linked-stylesheet-"));
const fetchImpl = Object.assign(async () => new Response("", { status: 404 }), {
  preconnect: fetch.preconnect,
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

it("embeds families requested only by a local linked stylesheet, honouring its own @font-face", async () => {
  mkdirSync(join(projectDir, "compositions/assets"), { recursive: true });
  writeFileSync(
    join(projectDir, "compositions/assets/title.css"),
    `.title { font-family: "Montserrat", sans-serif; }`,
  );
  writeFileSync(
    join(projectDir, "own.css"),
    `@font-face { font-family: "Inter"; src: url(inter.woff2); } p { font-family: Inter; }`,
  );
  const html = `<html><head>
    <link rel="stylesheet" href="compositions/assets/title.css">
    <link rel="stylesheet" href="own.css?v=2">
    <link rel="stylesheet" href="missing.css">
  </head><body><h1 class="title">Title</h1><p>Body</p></body></html>`;

  const result = await injectDeterministicFontFaces(html, {
    fetchImpl,
    allowSystemFontCapture: false,
    stylesheetBaseDir: projectDir,
  });

  expect(result).toContain(`font-family: "Montserrat";`);
  expect(result).not.toContain(`font-family: "Inter";`);
  expect(result).toContain(`<link rel="stylesheet" href="compositions/assets/title.css">`);
});
