import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { validateModuleManifest } from "../module-manifest/validate.mjs";

export const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const ignored = new Set([".git", ".turbo", "build", "coverage", "dist", "node_modules"]);
const privateSegments = new Set([
  "src",
  "private",
  "internal",
  "domain",
  "infrastructure",
  "persistence",
  "orm",
  "database",
  "migration",
  "migrations",
  "adapter",
  "adapters",
]);

export const importBoundaryUsage = `BOP-RMS Import Boundary Architecture Test

Usage:
  pnpm import-boundary:check
  node tooling/import-boundary/validate.mjs [--root <repository-root>]

Discovers packages/bop/* and packages/rms/* from their canonical Manifest and
package export map. Checks static/type imports, re-exports, import-equals,
require(), and dynamic imports. Violations are sorted and exit nonzero.
`;
export class ImportBoundaryError extends Error {}

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}
function literal(node) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const result = {};
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
      )
        throw new ImportBoundaryError("Manifest must use explicit property assignments");
      result[property.name.text] = literal(property.initializer);
    }
    return result;
  }
  throw new ImportBoundaryError(`Manifest contains non-literal ${ts.SyntaxKind[node.kind]}`);
}
function extractManifest(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let candidate;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(parsed) === "moduleManifestInput" &&
      node.initializer
    )
      candidate = node.initializer;
    if (
      !candidate &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineModuleManifest" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(unwrap(node.arguments[0]))
    )
      candidate = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!candidate)
    throw new ImportBoundaryError("module.manifest.ts has no literal Manifest payload");
  return literal(candidate);
}
const diagnostic = (code, file, line, message) => ({
  code,
  file: file.replaceAll("\\", "/"),
  line,
  message,
});
const formatted = (item) => `${item.file}:${item.line} [${item.code}] ${item.message}`;
async function json(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new ImportBoundaryError(`${file}: invalid JSON: ${error.message}`);
  }
}
function targets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targets);
}

export async function discoverModules(root, diagnostics) {
  const modules = [];
  for (const [segment, layer] of [
    ["bop", "BOP"],
    ["rms", "RMS"],
  ]) {
    const layerRoot = join(root, "packages", segment);
    let entries = [];
    try {
      entries = await readdir(layerRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const names = new Map();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const folded = entry.name.toLowerCase();
      if (names.has(folded))
        diagnostics.push(
          diagnostic(
            "MODULE_CASE_CONFLICT",
            relative(root, layerRoot),
            1,
            `${names.get(folded)} conflicts with ${entry.name}`,
          ),
        );
      else names.set(folded, entry.name);
      const moduleRoot = join(layerRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        diagnostics.push(
          diagnostic(
            "INVALID_MODULE_PATH",
            relative(root, moduleRoot),
            1,
            "Module must be a real directory",
          ),
        );
        continue;
      }
      const manifestFile = join(moduleRoot, "src/module.manifest.ts");
      const packageFile = join(moduleRoot, "package.json");
      try {
        const [source, packageJson] = await Promise.all([
          readFile(manifestFile, "utf8"),
          json(packageFile),
        ]);
        const manifest = extractManifest(source, manifestFile);
        for (const message of validateModuleManifest(manifest).errors)
          diagnostics.push(
            diagnostic("INVALID_MANIFEST", relative(root, manifestFile), 1, message),
          );
        const packageName = `@${segment}/${entry.name}`;
        if (
          manifest.layer !== layer ||
          manifest.moduleName !== entry.name ||
          manifest.packageName !== packageName ||
          packageJson.name !== packageName
        )
          diagnostics.push(
            diagnostic(
              "MODULE_IDENTITY_MISMATCH",
              relative(root, manifestFile),
              1,
              `directory, Manifest, Layer, and package must identify ${packageName}`,
            ),
          );
        const manifestExports = [...(manifest.publicExports ?? [])].sort();
        const packageExports = Object.keys(packageJson.exports ?? {}).sort();
        if (JSON.stringify(manifestExports) !== JSON.stringify(packageExports))
          diagnostics.push(
            diagnostic(
              "EXPORT_MAP_MISMATCH",
              relative(root, packageFile),
              1,
              `Manifest exports ${JSON.stringify(manifestExports)} must equal package exports ${JSON.stringify(packageExports)}`,
            ),
          );
        for (const [subpath, value] of Object.entries(packageJson.exports ?? {})) {
          const exportTargets = targets(value);
          if (exportTargets.length === 0)
            diagnostics.push(
              diagnostic(
                "INVALID_EXPORT_TARGET",
                relative(root, packageFile),
                1,
                `${subpath} has no target`,
              ),
            );
          for (const target of exportTargets) {
            const absolute = resolve(moduleRoot, target);
            if (
              isAbsolute(target) ||
              (!absolute.startsWith(`${moduleRoot}${sep}`) && absolute !== moduleRoot)
            )
              diagnostics.push(
                diagnostic(
                  "EXPORT_PATH_ESCAPE",
                  relative(root, packageFile),
                  1,
                  `${subpath} target ${target} escapes the Module`,
                ),
              );
            else
              try {
                if (!(await stat(absolute)).isFile()) throw new Error();
              } catch {
                diagnostics.push(
                  diagnostic(
                    "MISSING_EXPORT_TARGET",
                    relative(root, packageFile),
                    1,
                    `${subpath} target ${target} is missing`,
                  ),
                );
              }
          }
        }
        modules.push({
          root: moduleRoot,
          layer,
          moduleName: entry.name,
          packageName,
          manifest,
          exports: new Set(packageExports),
        });
      } catch (error) {
        diagnostics.push(
          diagnostic("MODULE_DISCOVERY_FAILED", relative(root, moduleRoot), 1, error.message),
        );
      }
    }
  }
  const identities = new Map();
  for (const module of modules) {
    const key = module.packageName.toLowerCase();
    if (identities.has(key))
      diagnostics.push(
        diagnostic(
          "DUPLICATE_MODULE_IDENTITY",
          relative(root, module.root),
          1,
          `${module.packageName} conflicts with ${identities.get(key)}`,
        ),
      );
    else identities.set(key, module.packageName);
  }
  return modules;
}

export async function discoverSourceFiles(root, repositoryRoot, diagnostics) {
  const result = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      if (entry.isSymbolicLink()) {
        diagnostics.push(
          diagnostic(
            "SYMLINK_PATH",
            relative(repositoryRoot, join(directory, entry.name)),
            1,
            "Module source tree must not contain symbolic links",
          ),
        );
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) await walk(path);
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase()))
        result.push(path);
    }
  }
  await walk(root);
  return result;
}
export function parseSourceReferences(source, file) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    [".tsx", ".jsx"].includes(extname(file)) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result = [];
  const add = (node, value, kind) =>
    result.push({
      value,
      kind,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
    });
  const call = (node, kind) =>
    node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      ? add(node, node.arguments[0].text, kind)
      : add(node, null, kind);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(
        node.moduleSpecifier,
        node.moduleSpecifier.text,
        ts.isImportDeclaration(node) ? "import" : "re-export",
      );
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    )
      add(
        node,
        ts.isStringLiteralLike(node.moduleReference.expression)
          ? node.moduleReference.expression.text
          : null,
        "import-equals",
      );
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    )
      add(node, node.argument.literal.text, "import-type");
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      call(node, "dynamic-import");
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    )
      call(node, "require");
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}
export function parseCanonicalModuleSpecifier(specifier) {
  const match = /^@(bop|rms)\/([^/]+)(\/.*)?$/u.exec(specifier);
  return match
    ? { packageName: `@${match[1]}/${match[2]}`, subpath: match[3] ? `.${match[3]}` : "." }
    : null;
}
export const findOwningModule = (path, modules) =>
  modules.find((module) => path === module.root || path.startsWith(`${module.root}${sep}`));

export function inspectModuleReference(
  root,
  sourceModule,
  file,
  reference,
  modules,
  byPackage,
  diagnostics,
) {
  const fileName = relative(root, file);
  if (reference.value === null) {
    diagnostics.push(
      diagnostic(
        "UNRESOLVED_DYNAMIC_IMPORT",
        fileName,
        reference.line,
        `${reference.kind} target must be one string literal`,
      ),
    );
    return;
  }
  const specifier = reference.value;
  if (
    file.endsWith(`${sep}src${sep}module.manifest.ts`) &&
    specifier === "../../../../tooling/module-manifest/module.manifest.js"
  )
    return;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const targetModule = findOwningModule(resolve(dirname(file), specifier), modules);
    if (!targetModule)
      diagnostics.push(
        diagnostic(
          "PATH_ESCAPE",
          fileName,
          reference.line,
          `${reference.kind} ${specifier} escapes the Module`,
        ),
      );
    else if (targetModule !== sourceModule)
      diagnostics.push(
        diagnostic(
          "CROSS_MODULE_RELATIVE_IMPORT",
          fileName,
          reference.line,
          `${reference.kind} must use ${targetModule.packageName} public export`,
        ),
      );
    return;
  }
  const parsed = parseCanonicalModuleSpecifier(specifier);
  if (!parsed) {
    if (/^@(bop|rms)\//iu.test(specifier))
      diagnostics.push(
        diagnostic(
          "INVALID_MODULE_PACKAGE",
          fileName,
          reference.line,
          `${specifier} uses an invalid canonical Module package scope`,
        ),
      );
    return;
  }
  if (parsed.subpath.split("/").includes("..")) {
    diagnostics.push(
      diagnostic(
        "PACKAGE_PATH_ESCAPE",
        fileName,
        reference.line,
        `${specifier} escapes its package export map`,
      ),
    );
    return;
  }
  const target = byPackage.get(parsed.packageName);
  if (!target) {
    const folded = [...byPackage.keys()].find(
      (name) => name.toLowerCase() === parsed.packageName.toLowerCase(),
    );
    diagnostics.push(
      diagnostic(
        folded ? "PACKAGE_CASE_CONFLICT" : "UNKNOWN_MODULE_PACKAGE",
        fileName,
        reference.line,
        `${specifier} is not an exact canonical Module package`,
      ),
    );
    return;
  }
  const privateSegment = parsed.subpath
    .toLowerCase()
    .split("/")
    .find((segment) => privateSegments.has(segment));
  if (privateSegment)
    diagnostics.push(
      diagnostic(
        "PRIVATE_MODULE_IMPORT",
        fileName,
        reference.line,
        `${specifier} exposes private segment ${privateSegment}`,
      ),
    );
  if (
    !target.exports.has(parsed.subpath) ||
    !target.manifest.publicExports.includes(parsed.subpath)
  )
    diagnostics.push(
      diagnostic(
        "UNEXPORTED_MODULE_SUBPATH",
        fileName,
        reference.line,
        `${specifier} is not a declared public export`,
      ),
    );
  if (sourceModule !== target) {
    if (sourceModule.layer === "BOP" && target.layer === "RMS")
      diagnostics.push(
        diagnostic(
          "BOP_TO_RMS_IMPORT",
          fileName,
          reference.line,
          `${sourceModule.packageName} cannot import ${specifier}`,
        ),
      );
    const allowed = sourceModule.manifest.allowedSynchronousDependencies.some(
      (dependency) =>
        dependency.packageName === target.packageName &&
        dependency.moduleName === target.moduleName &&
        dependency.layer === target.layer,
    );
    if (!allowed)
      diagnostics.push(
        diagnostic(
          "UNDECLARED_MODULE_DEPENDENCY",
          fileName,
          reference.line,
          `${target.packageName} is not an exact allowed dependency of ${sourceModule.packageName}`,
        ),
      );
  }
}

export async function validateImportBoundaries({ root = process.cwd() } = {}) {
  root = await realpath(root);
  const diagnostics = [];
  const modules = await discoverModules(root, diagnostics);
  const byPackage = new Map(modules.map((module) => [module.packageName, module]));
  for (const module of modules.sort((a, b) => a.packageName.localeCompare(b.packageName, "en")))
    for (const file of await discoverSourceFiles(module.root, root, diagnostics))
      for (const reference of parseSourceReferences(await readFile(file, "utf8"), file))
        inspectModuleReference(root, module, file, reference, modules, byPackage, diagnostics);
  diagnostics.sort((a, b) => formatted(a).localeCompare(formatted(b), "en"));
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    output: diagnostics.map(formatted).join("\n"),
  };
}
function options(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (argv.length === 0) return { root: process.cwd() };
  if (argv.length === 2 && argv[0] === "--root") return { root: resolve(argv[1]) };
  throw new ImportBoundaryError("expected --root <repository-root> or --help");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) process.stdout.write(importBoundaryUsage);
    else {
      const result = await validateImportBoundaries(parsed);
      if (result.valid) process.stdout.write("Import boundaries valid\n");
      else {
        process.stderr.write(`${result.output}\n`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`Import Boundary error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
