// @vitest-environment jsdom
import React, { act } from "react";
import postcss from "postcss";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { encodeElementClipboard, type ElementClipboard } from "@hyperframes/core/element-clipboard";
import { useClipboard } from "./useClipboard";
import { usePlayerStore } from "../player";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const SOURCE =
  '<html><body><div data-composition-id="main" data-duration="10"></div></body></html>';
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mount(payload: ElementClipboard) {
  const files: Record<string, string> = { "index.html": SOURCE, "compositions/b.html": SOURCE };
  const records: Array<{ files: Record<string, { before: string; after: string }> }> = [];
  let path = "index.html";
  const systemText = encodeElementClipboard(payload);
  vi.stubGlobal("navigator", { clipboard: { readText: async () => systemText } });
  vi.stubGlobal("fetch", async (url: string) => {
    const file = decodeURIComponent(String(url).split("/files/")[1] ?? "");
    if (!(file in files)) throw new Error(`Unexpected project file: ${file}`);
    return new Response(JSON.stringify({ content: files[file] }));
  });
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const reload = () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(files[path]!);
    iframe.contentDocument!.close();
  };
  let clipboard: ReturnType<typeof useClipboard> | undefined;
  function Harness() {
    clipboard = useClipboard({
      projectId: "p",
      activeCompPath: path,
      domEditSelectionRef: { current: null },
      showToast: () => {},
      writeProjectFile: async (file, content) => {
        files[file] = content;
      },
      recordEdit: async (record) => {
        records.push(record);
      },
      reloadPreview: reload,
      handleTimelineElementsDelete: async (ids) => {
        const before = files[path]!;
        const doc = parse(before);
        for (const element of ids) doc.getElementById(element.id)?.remove();
        files[path] = doc.documentElement.outerHTML;
        records.push({ files: { [path]: { before, after: files[path]! } } });
        reload();
      },
      handleDomEditElementDelete: async () => {
        throw new Error("Expected timeline deletion");
      },
      previewIframeRef: { current: iframe },
      waitForPendingDomEditSaves: async () => {},
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<Harness />));
  reload();
  usePlayerStore.setState({
    currentTime: 0,
    elements: [],
    selectedElementId: null,
    selectedElementIds: new Set(),
  });
  const select = (id: string) => {
    const clip = parse(files[path]!).getElementById(id)!;
    const element = {
      id,
      domId: id,
      hfId: clip.getAttribute("data-hf-id")!,
      tag: "div",
      start: 0,
      duration: 5,
      track: 0,
      sourceFile: path,
    };
    usePlayerStore.setState({
      elements: [element],
      selectedElementId: id,
      selectedElementIds: new Set([id]),
    });
  };
  return {
    api: () => clipboard!,
    files,
    records,
    select,
    doc: () => parse(files[path]!),
    preview: () => iframe.contentDocument!,
    navigate: (next: string) => {
      path = next;
      act(() => root?.render(<Harness />));
      reload();
    },
  };
}

function embeddedSelectors(clip: Element): string[] {
  const selectors: string[] = [];
  postcss.parse(clip.querySelector("style")!.textContent!).walkRules((rule) => {
    selectors.push(rule.selector);
  });
  return selectors;
}

async function pasteTwiceInOtherFile(view: ReturnType<typeof mount>) {
  view.navigate("compositions/b.html");
  usePlayerStore.setState({ elements: [], selectedElementId: null, selectedElementIds: new Set() });
  await view.api().handlePaste();
  await view.api().handlePaste();
}

it.each([".title{color:red}", "@media all{@supports (display:block){.title{color:red}}}"])(
  "rebinds only embedded styles when repeatedly pasting an imported clip into another file: %s",
  async (css) => {
    const view = mount({
      html: '<div class="title">Title</div>',
      css,
      width: 100,
      height: 50,
      warnings: [],
    });
    await view.api().handlePaste();
    const original = view.doc().querySelector(".clip")!;
    view.select(original.id);
    await view.api().handleCopy();
    view.files["compositions/b.html"] = SOURCE.replace(
      "<body>",
      `<head><style>#${original.id}{background:blue}</style></head><body>`,
    );
    await pasteTwiceInOtherFile(view);
    const doc = view.doc();
    const clips = Array.from(doc.querySelectorAll(".clip"));
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.id)).toContain(`${original.id}-2`);
    for (const clip of clips) {
      const selectors = embeddedSelectors(clip);
      expect(selectors.some((selector) => clip.querySelector(".title")!.matches(selector))).toBe(
        true,
      );
      expect(
        selectors.some((selector) =>
          clips
            .find((other) => other !== clip)!
            .querySelector(".title")!
            .matches(selector),
        ),
      ).toBe(false);
    }
    expect(doc.head.textContent).toBe(`#${original.id}{background:blue}`);
    expect(view.records).toHaveLength(3);
    expect(view.records[2]!.files["compositions/b.html"]!.after).toBe(
      view.files["compositions/b.html"],
    );
    expect(view.preview().querySelectorAll(".clip")).toHaveLength(2);
  },
);

it("keeps duplicated SVG definitions and all accepted local fragment consumers after cutting the original", async () => {
  const view = mount({
    html: '<svg viewBox="0 0 100 100"><defs><symbol id="shape"><rect width="100" height="100" fill="red"/></symbol><linearGradient id="paint"><stop stop-color="red"/></linearGradient><clipPath id="cut"><rect width="100" height="100"/></clipPath><mask id="mask"><rect width="100" height="100" fill="white"/></mask><filter id="fx"><feGaussianBlur stdDeviation="0"/></filter><marker id="mark"><path d="M0 0L1 1"/></marker></defs><use href="#shape"/><use xlink:href="#shape"/><rect class="painted" fill="url(#paint)" stroke="url(#paint)" clip-path="url(#cut)" mask="url(#mask)" filter="url(#fx)" marker-start="url(#mark)" marker-mid="url(#mark)" marker-end="url(#mark)" style="fill:url(#paint);filter:url(#fx)"/></svg>',
    css: ".painted{fill:url(#paint);clip-path:url(#cut)}",
    width: 100,
    height: 100,
    warnings: [],
  });
  await view.api().handlePaste();
  const original = view.doc().querySelector(".clip")!;
  view.select(original.id);
  expect(await view.api().handleDuplicate()).toBe(true);
  const duplicateId = `${original.id}-2`;
  const duplicatedFile = view.files["index.html"]!;
  view.select(original.id);
  await view.api().handleCut();
  const doc = view.doc();
  const duplicate = doc.getElementById(duplicateId)!;
  expect(doc.querySelectorAll(".clip")).toHaveLength(1);
  expect(doc.getElementById(original.id)).toBeNull();
  const refs: string[] = [];
  for (const el of duplicate.querySelectorAll("*"))
    for (const attr of el.attributes) {
      if (attr.name.endsWith("href") && attr.value.startsWith("#")) refs.push(attr.value.slice(1));
      for (const match of attr.value.matchAll(/url\(["']?#([^"')]+)["']?\)/g)) refs.push(match[1]!);
    }
  postcss.parse(duplicate.querySelector("style")!.textContent!).walkDecls((decl) => {
    for (const match of decl.value.matchAll(/url\(["']?#([^"')]+)["']?\)/g)) refs.push(match[1]!);
  });
  expect(refs.length).toBeGreaterThanOrEqual(14);
  for (const ref of refs) {
    expect(duplicate.querySelector(`[id="${ref}"]`), ref).not.toBeNull();
    expect(view.preview().getElementById(ref), ref).not.toBeNull();
  }
  expect(view.records[1]!.files["index.html"]!.after).toBe(duplicatedFile);
  expect(view.records[2]!.files["index.html"]!.before).toBe(duplicatedFile);
});

it("rebinds fragment predicates on cross-file clones while preserving unrelated title predicates", async () => {
  const view = mount({ html: "<div>unused</div>", css: "", width: 100, height: 50, warnings: [] });
  view.files["index.html"] = SOURCE.replace(
    "</div></body>",
    '<div id="authored" class="clip" data-start="0" data-duration="5" data-track-index="0"><style>use[href="#shape"]{opacity:.25}[title="#shape"]{color:red}</style><svg><symbol id="shape"><rect width="100" height="100"/></symbol><use href="#shape"/></svg><span title="#shape">Literal</span></div></div></body>',
  );
  view.navigate("index.html");
  view.select("authored");
  await view.api().handleCopy();
  await pasteTwiceInOtherFile(view);
  for (const clip of view.doc().querySelectorAll(".clip")) {
    const selectors = embeddedSelectors(clip);
    expect(selectors.some((selector) => clip.querySelector("use")!.matches(selector))).toBe(true);
    expect(selectors).toContain('[title="#shape"]');
    expect(clip.querySelector("span")!.getAttribute("title")).toBe("#shape");
  }
  expect(view.records[1]!.files["compositions/b.html"]!.after).toBe(
    view.files["compositions/b.html"],
  );
});

it("preserves the clone's own SVG gradient while the original still exists after same-file Copy/Paste", async () => {
  const view = mount({
    html: '<svg><defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient></defs><rect class="painted" width="100" height="100"/></svg>',
    css: ".painted{fill:url(#paint)}",
    width: 100,
    height: 100,
    warnings: [],
  });
  await view.api().handlePaste();
  const originalId = view.doc().querySelector(".clip")!.id;
  view.select(originalId);
  await view.api().handleCopy();
  await view.api().handlePaste();
  const doc = view.doc();
  const clone = doc.getElementById(`${originalId}-2`)!;
  expect(doc.querySelector(".clip")).toBe(clone);
  const fills: string[] = [];
  for (const style of doc.querySelectorAll("style"))
    postcss.parse(style.textContent!).walkRules((rule) => {
      if (clone.querySelector(".painted")!.matches(rule.selector))
        rule.walkDecls("fill", (decl) => {
          fills.push(decl.value);
        });
    });
  const gradient = clone.querySelector("linearGradient")!;
  expect(fills.at(-1)?.replace(/["']/g, "")).toBe(`url(#${gradient.id})`);
  gradient.querySelector("stop")!.setAttribute("stop-color", "blue");
  view.files["index.html"] = doc.documentElement.outerHTML;
  view.navigate("index.html");
  expect(
    view.preview().getElementById(gradient.id)!.querySelector("stop")!.getAttribute("stop-color"),
  ).toBe("blue");
  expect(
    view.preview().getElementById(originalId)!.querySelector("stop")!.getAttribute("stop-color"),
  ).toBe("red");
  expect(view.records[1]!.files["index.html"]!.after).toContain(`#${gradient.id}`);
});

it.each(["#title", '[id="title"]'])("preserves initial imported selector %s", async (selector) => {
  const view = mount({
    html: '<div><span id="title">Heading</span></div>',
    css: `${selector}{color:red}`,
    width: 100,
    height: 50,
    warnings: [],
  });
  await view.api().handlePaste();
  const clip = view.doc().querySelector(".clip")!;
  const selectors = embeddedSelectors(clip);
  expect(selectors.some((rule) => clip.querySelector("span")!.matches(rule))).toBe(true);
  expect(view.preview().querySelector(".clip span")!.id).toBe(clip.querySelector("span")!.id);
  expect(view.records[0]!.files["index.html"]!.after).toBe(view.files["index.html"]);
});

it("preserves fragment-attribute predicates on the initial accepted SVG import", async () => {
  const view = mount({
    html: '<svg><symbol id="shape"><rect width="100" height="100"/></symbol><use href="#shape"/></svg>',
    css: 'use[href="#shape"]{opacity:.25}',
    width: 100,
    height: 100,
    warnings: [],
  });
  await view.api().handlePaste();
  const clip = view.doc().querySelector(".clip")!;
  const selectors = embeddedSelectors(clip);
  expect(selectors.some((selector) => clip.querySelector("use")!.matches(selector))).toBe(true);
});
