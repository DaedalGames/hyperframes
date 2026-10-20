// Prints the CLI's command tree as JSON: every command and subcommand, with the flags each one declares.
// It loads the real citty definitions rather than parsing --help, so docs checks see exactly what the CLI parses.
// Run with bun after `bun run --cwd packages/core build`: the command modules import core's generated sources.
//
//   bun scripts/cli-command-tree.ts [--root <checkout>]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);

interface CittyArg {
  type?: string;
  alias?: string | string[];
  hidden?: boolean;
  description?: string;
}

interface CittyCommand {
  meta?: Resolvable<{ name?: string; description?: string; hidden?: boolean }>;
  args?: Resolvable<Record<string, CittyArg>>;
  subCommands?: Resolvable<Record<string, Resolvable<CittyCommand>>>;
}

export interface TreeFlag {
  type: string;
  aliases: string[];
  hidden: boolean;
  deprecated: boolean;
}

export interface TreeCommand {
  hidden: boolean;
  deprecated: boolean;
  flags: Record<string, TreeFlag>;
  subCommands: Record<string, TreeCommand>;
}

const DEPRECATED = /\bdeprecated\b/i;

async function settle<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}

/** Each `name: () => import("./commands/<file>.js").then((m) => m.<export>)` entry of cli.ts's commandLoaders. */
export function commandLoaders(
  cliSource: string,
): { name: string; file: string; exportName: string }[] {
  const block = cliSource.match(/const commandLoaders = \{([\s\S]*?)\n\};/)?.[1];
  if (!block) throw new Error("cli.ts no longer declares `const commandLoaders = { ... };`");
  const entries = [
    ...block.matchAll(
      /^ {2}"?([a-z][a-z-]*)"?: \(\) =>[\s\S]*?import\("\.\/commands\/([\w-]+)\.js"\)\.then\(\(m\) => m\.(\w+)\)/gm,
    ),
  ].map((m) => ({ name: m[1]!, file: m[2]!, exportName: m[3]! }));
  const declared = block.match(/^ {2}"?[a-z][a-z-]*"?: \(\) =>/gm)?.length ?? 0;
  if (entries.length !== declared)
    throw new Error(
      `Read ${entries.length} of cli.ts's ${declared} command loaders; update the pattern`,
    );
  return entries;
}

async function describe(command: CittyCommand): Promise<TreeCommand> {
  const meta = (await settle(command.meta)) ?? {};
  const args = (await settle(command.args)) ?? {};
  const subs = (await settle(command.subCommands)) ?? {};
  const flags: Record<string, TreeFlag> = {};
  for (const [name, def] of Object.entries(args)) {
    if (def.type === "positional") continue;
    flags[name] = {
      type: def.type ?? "string",
      aliases: def.alias === undefined ? [] : [def.alias].flat(),
      hidden: def.hidden === true,
      deprecated: DEPRECATED.test(def.description ?? ""),
    };
  }
  const subCommands: Record<string, TreeCommand> = {};
  for (const [name, sub] of Object.entries(subs)) {
    const resolved = await settle(sub);
    if (resolved) subCommands[name] = await describe(resolved);
  }
  return {
    hidden: meta.hidden === true,
    deprecated: DEPRECATED.test(meta.description ?? ""),
    flags,
    subCommands,
  };
}

export async function cliCommandTree(root: string): Promise<TreeCommand> {
  const cliDir = join(root, "packages", "cli", "src");
  const subCommands: Record<string, TreeCommand> = {};
  for (const loader of commandLoaders(readFileSync(join(cliDir, "cli.ts"), "utf8"))) {
    const url = pathToFileURL(join(cliDir, "commands", `${loader.file}.ts`)).href;
    const mod = (await import(url)) as Record<string, CittyCommand>;
    const command = mod[loader.exportName];
    if (!command) throw new Error(`commands/${loader.file}.ts has no export ${loader.exportName}`);
    subCommands[loader.name] = await describe(command);
  }
  // The root answers --version/-V before citty runs (cli.ts's fast path) and --help/-h through citty.
  const version = { type: "boolean", aliases: ["V"], hidden: false, deprecated: false };
  return { hidden: false, deprecated: false, flags: { version }, subCommands };
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf("--root");
  const root = resolve(
    rootFlag < 0 ? join(import.meta.dirname, "..") : process.argv[rootFlag + 1]!,
  );
  process.env.HYPERFRAMES_NO_TELEMETRY = "1";
  const json = `${JSON.stringify(await cliCommandTree(root), null, 2)}\n`;
  // Some command modules start timers or handles at import, so exit once a piped stdout has drained.
  process.stdout.write(json, () => process.exit(0));
}
