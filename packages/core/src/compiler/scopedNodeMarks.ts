import { parse } from "acorn";

const HF_MARK_RE = /\b__hf[A-Z]\w*\b/g;
const HF_NAME_RE = /^__hf[A-Z]\w*$/;

type AstNode = { type: string; start: number; [key: string]: unknown };
type Visit = [node: AstNode, parent: AstNode | null];

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

const isIdentifier = (value: unknown, name?: string): value is AstNode =>
  isNode(value) && value.type === "Identifier" && (name === undefined || value.name === name);

const nameOf = (node: AstNode) => String(node.name);

const children = (node: AstNode): AstNode[] =>
  Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(isNode);

function* walk(node: AstNode, parent: AstNode | null): Generator<Visit> {
  yield [node, parent];
  for (const child of children(node)) yield* walk(child, node);
}

const isMember = (node: unknown, computed: boolean): node is AstNode =>
  isNode(node) && node.type === "MemberExpression" && Boolean(node.computed) === computed;

const isScopedQuery = (init: unknown): boolean =>
  isNode(init) &&
  init.type === "CallExpression" &&
  isMember(init.callee, false) &&
  isIdentifier(init.callee.object, "document") &&
  isIdentifier(init.callee.property, "querySelectorAll");

const patternNames = (pattern: AstNode | undefined): AstNode[] => {
  if (!pattern || pattern.type === "MemberExpression") return [];
  return isIdentifier(pattern) ? [pattern] : children(pattern).flatMap(patternNames);
};

const nodesIn = (value: unknown): AstNode[] =>
  (Array.isArray(value) ? value : [value]).filter(isNode);

/** Identifiers each node binds: declarators, parameters, function and class names, catch parameters. */
function boundBy(node: AstNode): AstNode[] {
  if (node.type === "VariableDeclarator" || node.type === "CatchClause")
    return nodesIn(node.id ?? node.param).flatMap(patternNames);
  const own = /^(Function|Class)/.test(node.type) ? nodesIn(node.id) : [];
  const params = node.type.includes("Function") ? nodesIn(node.params) : [];
  return [...own, ...params].flatMap(patternNames);
}

const isPropertyName = (node: AstNode, parent: AstNode | null) =>
  (isMember(parent, false) && parent.property === node) ||
  (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand);

const PATTERN_TYPES = new Set([
  "ArrayPattern",
  "ObjectPattern",
  "Property",
  "AssignmentPattern",
  "RestElement",
]);

/** The pattern or expression a target sits at the top of, climbing out of destructuring. */
function patternTop(
  node: AstNode,
  parents: Map<AstNode, AstNode | null>,
): [AstNode, AstNode | null] {
  let top = node;
  let parent = parents.get(node) ?? null;
  while (
    parent &&
    PATTERN_TYPES.has(parent.type) &&
    !(parent.type === "AssignmentPattern" && parent.right === top)
  ) {
    top = parent;
    parent = parents.get(parent) ?? null;
  }
  return [top, parent];
}

/** Whether `node` is written: assigned (destructured too), a for-in/of target, updated or deleted. */
function isWritten(node: AstNode, parents: Map<AstNode, AstNode | null>): boolean {
  const [top, parent] = patternTop(node, parents);
  if (!parent) return false;
  if (parent.type === "AssignmentExpression" || /^For(In|Of)Statement$/.test(parent.type))
    return parent.left === top;
  return (
    parent.type === "UpdateExpression" ||
    (parent.type === "UnaryExpression" && parent.operator === "delete")
  );
}

/** `list[i]` and `list.length` read keep a list a list; writing an entry, or any other use, may change what it holds. */
const isListUse = (node: AstNode, parent: AstNode | null, parents: Map<AstNode, AstNode | null>) =>
  parent?.type === "MemberExpression" &&
  parent.object === node &&
  (Boolean(parent.computed) || isIdentifier(parent.property, "length")) &&
  !isWritten(parent, parents);

function bindingsByName(visits: Visit[]) {
  const bindings = new Map<string, AstNode[]>();
  const declared = new Set<AstNode>();
  for (const [node] of visits)
    for (const id of boundBy(node)) {
      declared.add(id);
      bindings.set(nameOf(id), [...(bindings.get(nameOf(id)) ?? []), node]);
    }
  return { bindings, declared };
}

const isSoleScopedQuery = ([binding, ...more]: AstNode[]) =>
  more.length === 0 &&
  binding?.type === "VariableDeclarator" &&
  isIdentifier(binding.id) &&
  isScopedQuery(binding.init);

const rebindsDocument = ([node]: Visit) =>
  node.type === "WithStatement" ||
  (node.type === "AssignmentExpression" &&
    patternNames(node.left as AstNode).some((id) => isIdentifier(id, "document"))) ||
  (node.type === "UpdateExpression" && isIdentifier(node.argument, "document"));

/** `document` is the scene's scoped one only when the script never binds, assigns or `with`-shadows that name. */
const trustsDocument = (visits: Visit[], bindings: Map<string, AstNode[]>) =>
  !bindings.has("document") && !visits.some(rebindsDocument);

/** Names bound once, to the scoped `document.querySelectorAll(...)`, and only ever indexed or measured. */
function scopedLists(visits: Visit[]): Set<string> {
  const { bindings, declared } = bindingsByName(visits);
  if (!trustsDocument(visits, bindings)) return new Set();
  const lists = new Set([...bindings].filter(([, b]) => isSoleScopedQuery(b)).map(([n]) => n));
  const parents = new Map(visits);
  for (const [node, parent] of visits) {
    const otherUse = !declared.has(node) && !isPropertyName(node, parent);
    if (isIdentifier(node) && otherUse && !isListUse(node, parent, parents))
      lists.delete(nameOf(node));
  }
  return lists;
}

/** Where `list[i].__hfX` names its mark, when `list` is a scoped query's result; else null. */
function scopedMarkStart(node: AstNode, lists: Set<string>): number | null {
  const { object, property } = node;
  if (!isMember(node, false) || !isIdentifier(property) || !HF_NAME_RE.test(nameOf(property)))
    return null;
  const indexed = isMember(object, true) && isIdentifier(object.object);
  return indexed && lists.has(nameOf(object.object as AstNode)) ? property.start : null;
}

function parsed(script: string): AstNode | null {
  try {
    return parse(script, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AstNode;
  } catch {
    return null;
  }
}

/** The first `__hf` mark a scene script shares with other scenes: every one but a scoped query node's own. */
export function sharedHfMark(script: string): { index: number; text: string } | null {
  const marks = [...script.matchAll(HF_MARK_RE)];
  const program = marks.length > 0 ? parsed(script) : null;
  const visits = program ? [...walk(program, null)] : [];
  const lists = scopedLists(visits);
  const scoped = new Set(visits.map(([node]) => scopedMarkStart(node, lists)));
  const shared = marks.find((mark) => !scoped.has(mark.index));
  return shared ? { index: shared.index, text: shared[0] } : null;
}
