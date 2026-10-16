import {
  escapeCssAttributeValue,
  escapeCssIdentifier,
  parseAttributeSelector,
  replaceSelectorAttributeTokens,
  replaceSelectorIdTokens,
} from "@hyperframes/core/selector-id-tokens";

export interface ClipboardAttributeRewrite {
  name: string;
  before: string;
  after: string;
}

type Predicate = NonNullable<ReturnType<typeof parseAttributeSelector>>;
const MATCHES = {
  "=": (actual, value) => actual === value,
  "~=": (actual, value) => !!value && actual.split(/[ \t\r\n\f]+/).includes(value),
  "|=": (actual, value) => actual === value || actual.startsWith(value + "-"),
  "^=": (actual, value) => !!value && actual.startsWith(value),
  "$=": (actual, value) => !!value && actual.endsWith(value),
  "*=": (actual, value) => !!value && actual.includes(value),
} satisfies Record<Predicate["operator"], (actual: string, value: string) => boolean>;

function attributeMatches(parsed: Predicate, reference: ClipboardAttributeRewrite): boolean {
  const name = parsed.name.toLowerCase();
  if (parsed.namespace.kind === "any") return reference.name.split(":").at(-1) === name;
  if (parsed.namespace.kind === "named")
    return reference.name === `${parsed.namespace.prefix}:${name}`;
  return reference.name === name;
}

function predicateChanges(parsed: Predicate, references: readonly ClipboardAttributeRewrite[]) {
  const fold =
    parsed.flag?.toLowerCase() === "i"
      ? (text: string) => text.replace(/[A-Z]/g, (char) => char.toLowerCase())
      : (text: string) => text;
  const matches = (value: string) => MATCHES[parsed.operator](fold(value), fold(parsed.value));
  const include = new Set<string>();
  const exclude = new Set<string>();
  const exact = (value: string) =>
    `[${parsed.rawName}="${escapeCssAttributeValue(value)}"${parsed.flag ? ` ${parsed.flag}` : ""}]`;
  for (const reference of references) {
    if (!attributeMatches(parsed, reference)) continue;
    const before = matches(reference.before);
    const after = matches(reference.after);
    if (before === after) continue;
    (before ? include : exclude).add(exact(reference.after));
  }
  return { include, exclude };
}

function rewritePredicate(
  predicate: string,
  references: readonly ClipboardAttributeRewrite[],
): string {
  const parsed = parseAttributeSelector(predicate);
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
