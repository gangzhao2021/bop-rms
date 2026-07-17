import { builtinModules } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  discoverModules,
  discoverSourceFiles,
  inspectModuleReference,
  parseCanonicalModuleSpecifier,
  parseSourceReferences,
  sourceExtensions,
} from "../import-boundary/validate.mjs";

const registryPath = "tooling/domain-layer-boundary/domain-dependencies.manifest.ts";
const classifications = new Set([
  "domain-safe",
  "orm-database",
  "http-transport",
  "provider-sdk",
  "runtime-io",
]);
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const exportSubpathPattern = /^\.(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const builtins = new Set(
  builtinModules.map((value) => (value.startsWith("node:") ? value.slice(5) : value)),
);
const classificationCodes = new Map([
  ["orm-database", "DOMAIN_ORM_DATABASE_DEPENDENCY"],
  ["http-transport", "DOMAIN_HTTP_DEPENDENCY"],
  ["provider-sdk", "DOMAIN_PROVIDER_SDK_DEPENDENCY"],
  ["runtime-io", "DOMAIN_RUNTIME_IO_DEPENDENCY"],
]);

export const domainLayerBoundaryUsage = `BOP-RMS Domain Layer Technology Dependency Test

Usage:
  pnpm domain-layer-boundary:check
  node tooling/domain-layer-boundary/validate.mjs [--root <repository-root>]

Scans Canonical Module src/domain source and rejects Application,
Infrastructure, Interface, ORM/database, HTTP, Provider SDK, runtime I/O,
dynamic, unresolved, unsafe, or unclassified dependencies.
`;

export class DomainLayerBoundaryError extends Error {}

const diagnostic = (code, file, line, message) => ({
  code,
  file: file.replaceAll("\\", "/"),
  line,
  message,
});
const formatDiagnostic = (item) => `${item.file}:${item.line} [${item.code}] ${item.message}`;
const compareDiagnostics = (left, right) =>
  left.file.localeCompare(right.file, "en") ||
  left.line - right.line ||
  left.code.localeCompare(right.code, "en") ||
  left.message.localeCompare(right.message, "en");

async function state(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

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

function literal(node, parsed) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((element) => literal(element, parsed));
  if (ts.isObjectLiteralExpression(node)) {
    const result = {};
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
      )
        throw new DomainLayerBoundaryError(
          "registry must use explicit literal property assignments",
        );
      result[property.name.text] = literal(property.initializer, parsed);
    }
    return result;
  }
  const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  throw new DomainLayerBoundaryError(
    `registry contains non-literal ${ts.SyntaxKind[node.kind]} at line ${line}`,
  );
}

async function readRegistry(root, diagnostics) {
  const absolute = join(root, registryPath);
  let value;
  try {
    const source = await readFile(absolute, "utf8");
    const parsed = ts.createSourceFile(
      absolute,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let candidate;
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(parsed) === "domainDependenciesManifestInput" &&
        node.initializer
      )
        candidate = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    if (!candidate)
      throw new DomainLayerBoundaryError("domainDependenciesManifestInput literal is missing");
    value = literal(candidate, parsed);
  } catch (error) {
    diagnostics.push(diagnostic("DOMAIN_UNCLASSIFIED_DEPENDENCY", registryPath, 1, error.message));
    return new Map();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !Array.isArray(value.dependencies) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["dependencies", "version"])
  ) {
    diagnostics.push(
      diagnostic(
        "DOMAIN_UNCLASSIFIED_DEPENDENCY",
        registryPath,
        1,
        "registry must be a closed version-1 object with dependencies",
      ),
    );
    return new Map();
  }
  const records = new Map();
  const folded = new Map();
  for (const record of value.dependencies) {
    const lower = typeof record?.packageName === "string" ? record.packageName.toLowerCase() : null;
    if (lower && folded.has(lower)) {
      diagnostics.push(
        diagnostic(
          folded.get(lower) === record.packageName
            ? "DOMAIN_UNCLASSIFIED_DEPENDENCY"
            : "CASE_CONFLICT",
          registryPath,
          1,
          `duplicate or case-conflicting dependency ${record.packageName}`,
        ),
      );
      continue;
    }
    const keys =
      record && typeof record === "object" && !Array.isArray(record)
        ? Object.keys(record).sort()
        : [];
    const validShape =
      JSON.stringify(keys) === JSON.stringify(["allowedSubpaths", "classification", "packageName"]);
    const subpaths = Array.isArray(record?.allowedSubpaths) ? record.allowedSubpaths : [];
    const unique = new Set(subpaths);
    const validSubpaths = subpaths.every(
      (value) => typeof value === "string" && exportSubpathPattern.test(value),
    );
    const validClassification = classifications.has(record?.classification);
    const validAllowance =
      record?.classification === "domain-safe" ? subpaths.length > 0 : subpaths.length === 0;
    if (
      !validShape ||
      typeof record?.packageName !== "string" ||
      !packageNamePattern.test(record.packageName) ||
      !validClassification ||
      !validSubpaths ||
      unique.size !== subpaths.length ||
      !validAllowance
    ) {
      diagnostics.push(
        diagnostic(
          "DOMAIN_UNCLASSIFIED_DEPENDENCY",
          registryPath,
          1,
          `invalid dependency classification record for ${String(record?.packageName)}`,
        ),
      );
      continue;
    }
    folded.set(lower, record.packageName);
    records.set(record.packageName, {
      ...record,
      allowedSubpaths: new Set(subpaths),
    });
  }
  return records;
}

const inside = (parent, target) => target === parent || target.startsWith(`${parent}${sep}`);

async function exactPath(root, target) {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { kind: "escape" };
  let current = root;
  if (!rel) return { kind: "exact", state: await state(root), path: root };
  for (const segment of rel.split(sep)) {
    let entries;
    try {
      entries = await readdir(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { kind: "missing" };
      throw error;
    }
    if (!entries.includes(segment)) {
      const collision = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      return collision ? { kind: "case", collision } : { kind: "missing" };
    }
    current = join(current, segment);
    const currentState = await state(current);
    if (currentState?.isSymbolicLink()) return { kind: "symlink", path: current };
    if (!currentState) return { kind: "missing" };
  }
  return { kind: "exact", state: await state(current), path: current };
}

async function resolveFile(moduleRoot, requested) {
  if (!inside(moduleRoot, requested)) return { kind: "escape" };
  const candidates = [requested];
  const requestedExtension = extname(requested).toLowerCase();
  const typeAlternatives = new Map([
    [".js", [".ts", ".tsx"]],
    [".jsx", [".tsx", ".ts"]],
    [".mjs", [".mts"]],
    [".cjs", [".cts"]],
  ]);
  if (typeAlternatives.has(requestedExtension)) {
    const stem = requested.slice(0, -requestedExtension.length);
    for (const extension of typeAlternatives.get(requestedExtension))
      candidates.push(`${stem}${extension}`);
  } else if (!sourceExtensions.has(requestedExtension))
    for (const extension of sourceExtensions) candidates.push(`${requested}${extension}`);
  for (const extension of sourceExtensions) candidates.push(join(requested, `index${extension}`));
  for (const candidate of candidates) {
    const result = await exactPath(moduleRoot, candidate);
    if (["case", "symlink", "escape"].includes(result.kind)) return result;
    if (result.kind === "exact" && result.state?.isFile()) return result;
  }
  return { kind: "missing" };
}

async function moduleAliases(module) {
  const packageJson = JSON.parse(await readFile(join(module.root, "package.json"), "utf8"));
  const imports = packageJson.imports ?? {};
  const configPath = join(module.root, "tsconfig.json");
  const configState = await state(configPath);
  if (!configState) return { imports, paths: {}, baseUrl: module.root };
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error)
    throw new DomainLayerBoundaryError(
      ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, module.root);
  if (parsed.errors.length)
    throw new DomainLayerBoundaryError(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("; "),
    );
  return {
    imports,
    paths: parsed.options.paths ?? {},
    baseUrl: parsed.options.baseUrl ?? module.root,
  };
}

function aliasTarget(specifier, module, aliases) {
  if (specifier.startsWith("#")) {
    const value = aliases.imports[specifier];
    if (
      specifier.includes("*") ||
      typeof value !== "string" ||
      !value.startsWith("./") ||
      value.includes("*")
    )
      return { kind: "invalid" };
    return { kind: "path", path: resolve(module.root, value) };
  }
  if (Object.hasOwn(aliases.paths, specifier)) {
    const values = aliases.paths[specifier];
    if (
      specifier.includes("*") ||
      !Array.isArray(values) ||
      values.length !== 1 ||
      typeof values[0] !== "string" ||
      values[0].includes("*")
    )
      return { kind: "invalid" };
    return { kind: "path", path: resolve(aliases.baseUrl, values[0]) };
  }
  const matchesWildcard = (key) => {
    if (!key.includes("*")) return false;
    const [prefix, suffix] = key.split("*");
    return specifier.startsWith(prefix) && specifier.endsWith(suffix);
  };
  const wildcardImport = Object.keys(aliases.imports).some(matchesWildcard);
  const wildcardPath = Object.keys(aliases.paths).some(matchesWildcard);
  if ((specifier.startsWith("#") && wildcardImport) || wildcardPath) return { kind: "invalid" };
  return { kind: "none" };
}

function packageTarget(specifier) {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (segments.length < 2) return null;
    return {
      packageName: `${segments[0]}/${segments[1]}`,
      subpath: segments.length === 2 ? "." : `./${segments.slice(2).join("/")}`,
    };
  }
  return {
    packageName: segments[0],
    subpath: segments.length === 1 ? "." : `./${segments.slice(1).join("/")}`,
  };
}

function classifyPackage(root, file, reference, target, registry, diagnostics) {
  const exact = registry.get(target.packageName);
  if (!exact) {
    const folded = [...registry.keys()].find(
      (name) => name.toLowerCase() === target.packageName.toLowerCase(),
    );
    diagnostics.push(
      diagnostic(
        folded ? "CASE_CONFLICT" : "DOMAIN_UNCLASSIFIED_DEPENDENCY",
        relative(root, file),
        reference.line,
        folded
          ? `${target.packageName} conflicts with exact dependency ${folded}`
          : `${target.packageName} has no Domain dependency classification`,
      ),
    );
    return;
  }
  if (exact.classification === "domain-safe") {
    if (!exact.allowedSubpaths.has(target.subpath))
      diagnostics.push(
        diagnostic(
          "DOMAIN_UNCLASSIFIED_DEPENDENCY",
          relative(root, file),
          reference.line,
          `${target.packageName} subpath ${target.subpath} is not Domain-safe`,
        ),
      );
    return;
  }
  diagnostics.push(
    diagnostic(
      classificationCodes.get(exact.classification),
      relative(root, file),
      reference.line,
      `${reference.kind} ${reference.value} is classified ${exact.classification}`,
    ),
  );
}

async function inspectPathReference(
  root,
  module,
  domainRoot,
  file,
  reference,
  requested,
  diagnostics,
) {
  const result = await resolveFile(module.root, requested);
  const fileName = relative(root, file);
  if (result.kind === "escape")
    diagnostics.push(
      diagnostic(
        "PATH_ESCAPE",
        fileName,
        reference.line,
        `${reference.kind} target escapes Module`,
      ),
    );
  else if (result.kind === "case")
    diagnostics.push(
      diagnostic(
        "CASE_CONFLICT",
        fileName,
        reference.line,
        `${reference.kind} target is not exact-case`,
      ),
    );
  else if (result.kind === "symlink")
    diagnostics.push(
      diagnostic(
        "SYMLINK_PATH",
        fileName,
        reference.line,
        `${reference.kind} target crosses a symbolic path`,
      ),
    );
  else if (result.kind === "missing")
    diagnostics.push(
      diagnostic(
        "DOMAIN_UNRESOLVED_REFERENCE",
        fileName,
        reference.line,
        `${reference.kind} target ${reference.value} cannot be resolved`,
      ),
    );
  else if (inside(domainRoot, result.path)) return;
  else {
    const relativeTarget = relative(join(module.root, "src"), result.path).replaceAll("\\", "/");
    const segment = relativeTarget.split("/")[0];
    const code =
      segment === "application"
        ? "DOMAIN_TO_APPLICATION"
        : segment === "infrastructure"
          ? "DOMAIN_TO_INFRASTRUCTURE"
          : segment === "interfaces"
            ? "DOMAIN_TO_INTERFACE"
            : "DOMAIN_UNCLASSIFIED_DEPENDENCY";
    diagnostics.push(
      diagnostic(code, fileName, reference.line, `${reference.kind} targets src/${relativeTarget}`),
    );
  }
}

async function inspectReference(
  root,
  module,
  domainRoot,
  file,
  reference,
  modules,
  byPackage,
  registry,
  aliases,
  diagnostics,
) {
  const fileName = relative(root, file);
  if (reference.value === null || typeof reference.value !== "string") {
    diagnostics.push(
      diagnostic(
        "DOMAIN_DYNAMIC_REFERENCE",
        fileName,
        reference.line,
        `${reference.kind} target must be one string literal`,
      ),
    );
    return;
  }
  const specifier = reference.value;
  if (isAbsolute(specifier)) {
    diagnostics.push(
      diagnostic("PATH_ESCAPE", fileName, reference.line, `${reference.kind} target is absolute`),
    );
    return;
  }
  if (specifier.startsWith(".")) {
    await inspectPathReference(
      root,
      module,
      domainRoot,
      file,
      reference,
      resolve(dirname(file), specifier),
      diagnostics,
    );
    return;
  }
  const alias = aliasTarget(specifier, module, aliases);
  if (alias.kind === "invalid") {
    diagnostics.push(
      diagnostic(
        "DOMAIN_UNRESOLVED_REFERENCE",
        fileName,
        reference.line,
        `alias ${specifier} is unsupported or ambiguous`,
      ),
    );
    return;
  }
  if (alias.kind === "path") {
    await inspectPathReference(root, module, domainRoot, file, reference, alias.path, diagnostics);
    return;
  }
  const canonical = parseCanonicalModuleSpecifier(specifier);
  if (canonical) {
    inspectModuleReference(root, module, file, reference, modules, byPackage, diagnostics);
    if (byPackage.has(canonical.packageName))
      classifyPackage(root, file, reference, canonical, registry, diagnostics);
    return;
  }
  if (/^@(bop|rms)\//iu.test(specifier)) {
    diagnostics.push(
      diagnostic(
        "CASE_CONFLICT",
        fileName,
        reference.line,
        `${specifier} is not an exact Canonical Module package`,
      ),
    );
    return;
  }
  const builtin = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (builtins.has(builtin)) {
    diagnostics.push(
      diagnostic(
        "DOMAIN_RUNTIME_IO_DEPENDENCY",
        fileName,
        reference.line,
        `${reference.kind} ${specifier} uses the Node runtime`,
      ),
    );
    return;
  }
  if (specifier.startsWith("node:")) {
    diagnostics.push(
      diagnostic(
        "DOMAIN_UNRESOLVED_REFERENCE",
        fileName,
        reference.line,
        `${specifier} is not a pinned Node built-in`,
      ),
    );
    return;
  }
  const target = packageTarget(specifier);
  if (!target) {
    diagnostics.push(
      diagnostic(
        "DOMAIN_UNRESOLVED_REFERENCE",
        fileName,
        reference.line,
        `${specifier} is not a resolvable package target`,
      ),
    );
    return;
  }
  classifyPackage(root, file, reference, target, registry, diagnostics);
}

export async function validateDomainLayerBoundaries({
  root = process.cwd(),
  readSource = readFile,
} = {}) {
  root = await realpath(root);
  const diagnostics = [];
  let fatal = false;
  const registry = await readRegistry(root, diagnostics);
  const modules = await discoverModules(root, diagnostics);
  const byPackage = new Map(modules.map((module) => [module.packageName, module]));
  for (const module of modules.sort((left, right) =>
    left.packageName.localeCompare(right.packageName, "en"),
  )) {
    const domainRoot = join(module.root, "src/domain");
    let domainState;
    try {
      const result = await exactPath(module.root, domainRoot);
      if (result.kind === "missing") continue;
      if (result.kind === "case") {
        diagnostics.push(
          diagnostic(
            "CASE_CONFLICT",
            relative(root, domainRoot),
            1,
            "Domain root must use exact src/domain case",
          ),
        );
        continue;
      }
      if (result.kind === "symlink") {
        diagnostics.push(
          diagnostic(
            "SYMLINK_PATH",
            relative(root, domainRoot),
            1,
            "Domain root must not be symbolic",
          ),
        );
        continue;
      }
      domainState = result.state;
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "UNREADABLE_DOMAIN_SOURCE",
          relative(root, domainRoot),
          1,
          `Domain root cannot be read: ${error.message}`,
        ),
      );
      fatal = true;
      continue;
    }
    if (!domainState?.isDirectory()) {
      diagnostics.push(
        diagnostic(
          "DOMAIN_UNRESOLVED_REFERENCE",
          relative(root, domainRoot),
          1,
          "Domain root must be a directory",
        ),
      );
      continue;
    }
    let aliases;
    try {
      aliases = await moduleAliases(module);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "DOMAIN_UNRESOLVED_REFERENCE",
          relative(root, join(module.root, "tsconfig.json")),
          1,
          `Module alias configuration is invalid: ${error.message}`,
        ),
      );
      continue;
    }
    let files;
    try {
      files = await discoverSourceFiles(domainRoot, root, diagnostics);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "UNREADABLE_DOMAIN_SOURCE",
          relative(root, domainRoot),
          1,
          `Domain root cannot be read: ${error.message}`,
        ),
      );
      fatal = true;
      continue;
    }
    for (const file of files) {
      let source;
      try {
        source = await readSource(file, "utf8");
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "UNREADABLE_DOMAIN_SOURCE",
            relative(root, file),
            1,
            `Domain source cannot be read: ${error.message}`,
          ),
        );
        fatal = true;
        continue;
      }
      for (const reference of parseSourceReferences(source, file))
        await inspectReference(
          root,
          module,
          domainRoot,
          file,
          reference,
          modules,
          byPackage,
          registry,
          aliases,
          diagnostics,
        );
    }
  }
  diagnostics.sort(compareDiagnostics);
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    output: diagnostics.map(formatDiagnostic).join("\n"),
    exitCode: fatal ? 2 : diagnostics.length ? 1 : 0,
  };
}

function options(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  if (argv.length === 0) return { root: process.cwd() };
  if (argv.length === 2 && argv[0] === "--root") return { root: resolve(argv[1]) };
  throw new DomainLayerBoundaryError("expected --root <repository-root> or --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) process.stdout.write(domainLayerBoundaryUsage);
    else {
      const result = await validateDomainLayerBoundaries(parsed);
      if (result.exitCode === 0) process.stdout.write("Domain layer boundaries valid\n");
      else {
        process.stderr.write(`${result.output}\n`);
        process.exitCode = result.exitCode;
      }
    }
  } catch (error) {
    process.stderr.write(`Domain Layer Boundary error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
