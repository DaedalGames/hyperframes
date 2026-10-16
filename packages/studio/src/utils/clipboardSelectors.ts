import {
  escapeCssAttributeValue,
  escapeCssIdentifier,
  parseAttributeSelector,
  parseAttributeSelectorPresence,
  replaceSelectorAttributeTokens,
  replaceSelectorIdTokens,
} from "@hyperframes/core/selector-id-tokens";

export interface ClipboardAttributeRewrite {
  name: string;
  afterName?: string;
  target?: string;
  before: string;
  after: string;
}

type ValuePredicate = NonNullable<ReturnType<typeof parseAttributeSelector>>;
type Predicate = ValuePredicate | NonNullable<ReturnType<typeof parseAttributeSelectorPresence>>;
const MATCHES = {
  "=": (actual, value) => actual === value,
  "~=": (actual, value) => !!value && actual.split(/[ \t\r\n\f]+/).includes(value),
  "|=": (actual, value) => actual === value || actual.startsWith(value + "-"),
  "^=": (actual, value) => !!value && actual.startsWith(value),
  "$=": (actual, value) => !!value && actual.endsWith(value),
  "*=": (actual, value) => !!value && actual.includes(value),
} satisfies Record<ValuePredicate["operator"], (actual: string, value: string) => boolean>;

function attributeMatches(parsed: Predicate, attributeName: string): boolean {
  const name = parsed.name.toLowerCase();
  if (parsed.namespace.kind === "any") return attributeName.split(":").at(-1) === name;
  if (parsed.namespace.kind === "named")
    return attributeName === `${parsed.namespace.prefix}:${name}`;
  return attributeName === name;
}

function valueMatches(parsed: Predicate, value: string): boolean {
  if (!("operator" in parsed)) return true;
  const fold =
    parsed.flag?.toLowerCase() === "i"
      ? (text: string) => text.replace(/[A-Z]/g, (char) => char.toLowerCase())
      : (text: string) => text;
  return MATCHES[parsed.operator](fold(value), fold(parsed.value));
}

function outputPredicate(parsed: Predicate, reference: ClipboardAttributeRewrite): string {
  const afterName = reference.afterName ?? reference.name;
  const name = attributeMatches(parsed, afterName)
    ? parsed.rawName
    : escapeCssIdentifier(afterName);
  const flag = "flag" in parsed && parsed.flag ? ` ${parsed.flag}` : "";
  const guard = reference.target ? `:where(${reference.target})` : "";
  return `${guard}[${name}="${escapeCssAttributeValue(reference.after)}"${flag}]`;
}

function predicateChanges(parsed: Predicate, references: readonly ClipboardAttributeRewrite[]) {
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const reference of references) {
    const before =
      attributeMatches(parsed, reference.name) && valueMatches(parsed, reference.before);
    const after =
      attributeMatches(parsed, reference.afterName ?? reference.name) &&
      valueMatches(parsed, reference.after);
    if (before !== after) (before ? include : exclude).add(outputPredicate(parsed, reference));
  }
  return { include, exclude };
}

function rewritePredicate(
  predicate: string,
  references: readonly ClipboardAttributeRewrite[],
): string {
  const parsed = parseAttributeSelector(predicate) ?? parseAttributeSelectorPresence(predicate);
  if (!parsed) return predicate;
  const { include, exclude } = predicateChanges(parsed, references);
  if (!include.size && !exclude.size) return predicate;
  const unchanged = exclude.size
    ? `${predicate}:where(:not(${[...exclude].join(", ")}))`
    : predicate;
  return include.size ? `:is(${unchanged}, ${[...include].join(", ")})` : unchanged;
}

export function rebindClipboardSelector(
  selector: string,
  ids: ReadonlyMap<string, string>,
  attributes: readonly ClipboardAttributeRewrite[] = [],
): string {
  const references = [
    ...attributes,
    ...Array.from(ids, ([before, after]) => ({ name: "id", before, after })),
  ];
  const rewritten = replaceSelectorIdTokens(
    selector,
    [...ids.keys()],
    (id) => `#${escapeCssIdentifier(ids.get(id) ?? id)}`,
  );
  return replaceSelectorAttributeTokens(rewritten, (predicate) =>
    rewritePredicate(predicate, references),
  );
}
