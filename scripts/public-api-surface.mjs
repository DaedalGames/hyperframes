// The public API the workspace packages publish at a git revision, as sorted lines:
//   "<package> exports <subpath>"  every key of `exports` / `publishConfig.exports`
//   "<package> bin <name>"         every executable in `bin`
//   "<package> export <name>"      every name the root entry (`exports["."]`) exports, through `export *` chains
// A package is public when its package.json is not `private` and declares `exports`, the same rule as
// scripts/package-subpaths.mjs. Reading from git (not the working tree) lets one checkout compare two revisions.
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** A reader for files at `ref`: `read(path)` is the file's text, or undefined when the revision has no such file. */
export function gitReader(ref, cwd) {
  const files = new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "packages"], {
      cwd,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  );
  const cache = new Map();
  return (path) => {
    if (!files.has(path)) return undefined;
    if (!cache.has(path))
      cache.set(
        path,
        execFileSync("git", ["show", `${ref}:${path}`], {
          cwd,
          encoding: "utf8",
          maxBuffer: 1 << 26,
        }),
      );
    return cache.get(path);
  };
}

// Same precedence as package-subpaths.mjs's sourceTarget: the file a workspace consumer actually loads.
function sourceTarget(target) {
  if (typeof target === "string") return target;
  return target?.bun ?? target?.browser ?? target?.import ?? target?.node ?? target?.default;
}

function resolveModule(from, specifier, read) {
  const base = posix.join(posix.dirname(from), specifier);
  const stem = base.replace(/\.(?:[mc]?js|tsx?)$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => stem + ext),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((path) => read(path) !== undefined);
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function declaredExports(statement) {
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
}

/** Every name the module at `path` exports, following relative `export *`; a package re-export stays `* from "<pkg>"`. */
export function moduleExports(path, read, seen = new Set()) {
  if (seen.has(path)) return [];
  seen.add(path);
  const file = ts.createSourceFile(path, read(path) ?? "", ts.ScriptTarget.Latest, false);
  const names = [];
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement))
      names.push(statement.isExportEquals ? "export=" : "default");
    else if (!ts.isExportDeclaration(statement)) names.push(...declaredExports(statement));
    else if (statement.exportClause && ts.isNamedExports(statement.exportClause))
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    else if (statement.exportClause) names.push(statement.exportClause.name.text);
    else {
      const specifier = statement.moduleSpecifier.text;
      const target = specifier.startsWith(".") ? resolveModule(path, specifier, read) : undefined;
      if (!target) names.push(`* from "${specifier}"`);
      else names.push(...moduleExports(target, read, seen).filter((name) => name !== "default"));
    }
  }
  return names;
}

// A root entry built into dist/ (player) is read from the source file tsup builds it from.
function rootSource(dir, target, read) {
  if (typeof target !== "string") return undefined;
  const path = posix.normalize(posix.join(dir, target));
  if (read(path) !== undefined) return path;
  const source = path.replace(`${dir}/dist/`, `${dir}/src/`).replace(/\.[mc]?js$/, ".ts");
  return read(source) !== undefined ? source : undefined;
}

/** Surface lines for one package.json (its path and text) read through `read`. */
export function packageSurface(manifestPath, read) {
  const pkg = JSON.parse(read(manifestPath));
  if (pkg.private === true || pkg.exports == null) return [];
  const dir = posix.dirname(manifestPath);
  const subpaths = new Set([
    ...Object.keys(pkg.exports),
    ...Object.keys(pkg.publishConfig?.exports ?? {}),
  ]);
  const bins = typeof pkg.bin === "string" ? [pkg.name] : Object.keys(pkg.bin ?? {});
  const entry = rootSource(dir, sourceTarget(pkg.exports["."]), read);
  const symbols = entry ? moduleExports(entry, read) : [];
  return [
    ...[...subpaths].map((subpath) => `${pkg.name} exports ${subpath}`),
    ...bins.map((bin) => `${pkg.name} bin ${bin}`),
    ...symbols.map((symbol) => `${pkg.name} export ${symbol}`),
  ];
}

/** The public API of every workspace package at `ref`, sorted and deduplicated. */
export function publicApiSurface(ref, cwd) {
  const read = gitReader(ref, cwd);
  const manifests = execFileSync("git", ["ls-tree", "--name-only", ref, "packages/"], {
    cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((dir) => `${dir}/package.json`)
    .filter((path) => read(path) !== undefined);
  return [...new Set(manifests.flatMap((path) => packageSurface(path, read)))].sort();
}
