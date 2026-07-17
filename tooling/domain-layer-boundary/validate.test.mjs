import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { validateDomainLayerBoundaries } from "./validate.mjs";

const roots = [];
const removedRoots = [];
const cli = join(process.cwd(), "tooling/domain-layer-boundary/validate.mjs");

const identity = (layer, name) => ({
  moduleName: name,
  packageName: `@${layer.toLowerCase()}/${name}`,
  layer,
});

async function writeRegistry(root, dependencies = []) {
  const file = join(root, "tooling/domain-layer-boundary/domain-dependencies.manifest.ts");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `const domainDependenciesManifestInput = ${JSON.stringify({ version: 1, dependencies }, null, 2)} as const;\nexport default domainDependenciesManifestInput;\n`,
  );
}

async function writeModule(
  root,
  {
    layer = "BOP",
    name = "synthetic-domain",
    dependencies = [],
    exports = { ".": "./src/index.ts" },
    packageImports,
    paths,
    domain = true,
  } = {},
) {
  const module = identity(layer, name);
  const moduleRoot = join(root, "packages", layer.toLowerCase(), name);
  const manifest = {
    ...module,
    lifecycle: "Later",
    publicExports: Object.keys(exports),
    allowedSynchronousDependencies: dependencies,
    consumedEvents: [],
    publishedEvents: [],
    ownedDatabase: { schema: null, tables: [] },
    ownedJobs: [],
    featureFlags: [],
    killSwitches: [],
    piiClassification: {
      classes: ["none"],
      handling: {
        logs: "redacted",
        urls: "prohibited",
        analytics: "deidentified",
        fixtures: "synthetic-only",
      },
    },
    moduleOwner: { role: "Synthetic Test Owner" },
  };
  await mkdir(join(moduleRoot, "src"), { recursive: true });
  if (domain) await mkdir(join(moduleRoot, "src/domain"), { recursive: true });
  await writeFile(
    join(moduleRoot, "src/module.manifest.ts"),
    `const moduleManifestInput = ${JSON.stringify(manifest, null, 2)} as const;\nexport default moduleManifestInput;\n`,
  );
  await writeFile(
    join(moduleRoot, "package.json"),
    `${JSON.stringify(
      {
        name: module.packageName,
        type: "module",
        exports,
        ...(packageImports ? { imports: packageImports } : {}),
      },
      null,
      2,
    )}\n`,
  );
  for (const target of Object.values(exports)) {
    const path = join(moduleRoot, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const synthetic = true;\n");
  }
  if (paths)
    await writeFile(
      join(moduleRoot, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { baseUrl: ".", paths } }, null, 2)}\n`,
    );
  return { module, moduleRoot };
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "bop-domain-layer-boundary-"));
  roots.push(root);
  await writeRegistry(root, options.registry ?? []);
  const context = await writeModule(root, options.module);
  return { root, ...context };
}

async function source(context, text, name = "consumer.ts") {
  const file = join(context.moduleRoot, "src/domain", name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${text}\n`);
  return file;
}

const codes = async (root, options = {}) =>
  (await validateDomainLayerBoundaries({ root, ...options })).diagnostics.map((item) => item.code);

afterEach(async () => {
  const pending = roots.splice(0);
  await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })));
  removedRoots.push(...pending);
});

afterAll(async () => {
  for (const root of removedRoots)
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("Domain Layer Technology Dependency Test", () => {
  it.each([
    ["static relative", 'import "./model.js";', undefined],
    ["type-only relative", 'import type { Model } from "./model.js";', undefined],
    [
      "exact Domain-safe package subpath",
      'import type { Value } from "pure-domain/contracts";',
      [
        {
          packageName: "pure-domain",
          classification: "domain-safe",
          allowedSubpaths: ["./contracts"],
        },
      ],
    ],
  ])("allows %s", async (_name, text, registry) => {
    const context = await fixture({ registry });
    await source(context, "export interface Model {}", "model.ts");
    await source(context, text);
    expect(await validateDomainLayerBoundaries({ root: context.root })).toMatchObject({
      valid: true,
      exitCode: 0,
      diagnostics: [],
    });
  });

  it("allows one exact package imports alias into Domain", async () => {
    const context = await fixture({
      module: { packageImports: { "#domain-model": "./src/domain/model.ts" } },
    });
    await source(context, "export interface Model {}", "model.ts");
    await source(context, 'import type { Model } from "#domain-model";');
    expect(await codes(context.root)).toEqual([]);
  });

  it("allows one exact TypeScript paths alias into Domain", async () => {
    const context = await fixture({
      module: { paths: { "domain-model": ["src/domain/model.ts"] } },
    });
    await source(context, "export interface Model {}", "model.ts");
    await source(context, 'import type { Model } from "domain-model";');
    expect(await codes(context.root)).toEqual([]);
  });

  it("allows a Domain-safe Canonical workspace public export", async () => {
    const dependency = identity("BOP", "synthetic-kernel");
    const context = await fixture({
      registry: [
        {
          packageName: dependency.packageName,
          classification: "domain-safe",
          allowedSubpaths: ["."],
        },
      ],
      module: { dependencies: [dependency] },
    });
    await writeModule(context.root, { name: dependency.moduleName });
    await source(context, 'import type { Value } from "@bop/synthetic-kernel";');
    expect(await codes(context.root)).toEqual([]);
  });

  it("allows a Canonical Module with no Domain root", async () => {
    const context = await fixture({ module: { domain: false } });
    expect(await codes(context.root)).toEqual([]);
  });

  it.each([
    ["static import", 'import "orm-lib";'],
    ["re-export", 'export * from "orm-lib";'],
    ["import type", 'import type { Row } from "orm-lib";'],
    ["import-type expression", 'type Row = import("orm-lib").Row;'],
    ["import-equals", 'import row = require("orm-lib");'],
    ["dynamic import", 'const row = import("orm-lib");'],
    ["require", 'const row = require("orm-lib");'],
  ])("rejects ORM through %s", async (_name, text) => {
    const context = await fixture({
      registry: [{ packageName: "orm-lib", classification: "orm-database", allowedSubpaths: [] }],
    });
    await source(context, text);
    expect(await codes(context.root)).toContain("DOMAIN_ORM_DATABASE_DEPENDENCY");
  });

  it.each([
    "consumer.ts",
    "consumer.tsx",
    "consumer.mts",
    "consumer.cts",
    "consumer.js",
    "consumer.jsx",
    "consumer.mjs",
    "consumer.cjs",
    "consumer.d.ts",
  ])("scans forbidden type edges in %s", async (name) => {
    const context = await fixture({
      registry: [
        { packageName: "http-lib", classification: "http-transport", allowedSubpaths: [] },
      ],
    });
    await source(context, 'import type { Client } from "http-lib";', name);
    expect(await codes(context.root)).toContain("DOMAIN_HTTP_DEPENDENCY");
  });

  it.each([
    ["application", "DOMAIN_TO_APPLICATION"],
    ["infrastructure", "DOMAIN_TO_INFRASTRUCTURE"],
    ["interfaces", "DOMAIN_TO_INTERFACE"],
  ])("rejects Domain to %s", async (layer, code) => {
    const context = await fixture();
    const target = join(context.moduleRoot, "src", layer, "target.ts");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export const target = true;\n");
    await source(context, `import "../${layer}/target.js";`);
    expect(await codes(context.root)).toContain(code);
  });

  it.each([
    ["orm-package", "orm-database", "DOMAIN_ORM_DATABASE_DEPENDENCY"],
    ["http-package", "http-transport", "DOMAIN_HTTP_DEPENDENCY"],
    ["provider-package", "provider-sdk", "DOMAIN_PROVIDER_SDK_DEPENDENCY"],
    ["runtime-package", "runtime-io", "DOMAIN_RUNTIME_IO_DEPENDENCY"],
  ])("rejects %s classification", async (packageName, classification, code) => {
    const context = await fixture({
      registry: [{ packageName, classification, allowedSubpaths: [] }],
    });
    await source(context, `import "${packageName}";`);
    expect(await codes(context.root)).toContain(code);
  });

  it("rejects pinned Node built-ins without registry evidence", async () => {
    const context = await fixture();
    await source(context, 'import "node:fs/promises";\nimport "path";');
    expect(await codes(context.root)).toEqual([
      "DOMAIN_RUNTIME_IO_DEPENDENCY",
      "DOMAIN_RUNTIME_IO_DEPENDENCY",
    ]);
  });

  it("rejects an unknown bare package", async () => {
    const context = await fixture();
    await source(context, 'import "unknown-package";');
    expect(await codes(context.root)).toContain("DOMAIN_UNCLASSIFIED_DEPENDENCY");
  });

  it("rejects a computed dynamic import", async () => {
    const context = await fixture();
    await source(context, 'const name = "unknown-package"; import(name);');
    expect(await codes(context.root)).toContain("DOMAIN_DYNAMIC_REFERENCE");
  });

  it("rejects an unresolved relative target", async () => {
    const context = await fixture();
    await source(context, 'import "./missing.js";');
    expect(await codes(context.root)).toContain("DOMAIN_UNRESOLVED_REFERENCE");
  });

  it("rejects an absolute target", async () => {
    const context = await fixture();
    await source(context, 'import "/tmp/outside.js";');
    expect(await codes(context.root)).toContain("PATH_ESCAPE");
  });

  it("rejects a relative path escape", async () => {
    const context = await fixture();
    await writeFile(join(context.root, "outside.ts"), "export {};\n");
    await source(context, 'import "../../../../../outside.js";');
    expect(await codes(context.root)).toContain("PATH_ESCAPE");
  });

  it("rejects a case-mismatched Domain target", async () => {
    const context = await fixture();
    await source(context, "export interface Model {}", "Model.ts");
    await source(context, 'import type { Model } from "./model.js";');
    expect(await codes(context.root)).toContain("CASE_CONFLICT");
  });

  it("rejects a symlinked Domain target", async () => {
    const context = await fixture();
    const target = join(context.moduleRoot, "src/domain/real.ts");
    await writeFile(target, "export const real = true;\n");
    await symlink(target, join(context.moduleRoot, "src/domain/link.ts"));
    await source(context, 'import "./link.js";');
    expect(await codes(context.root)).toContain("SYMLINK_PATH");
  });

  it("rejects a symlinked Domain root", async () => {
    const context = await fixture({ module: { domain: false } });
    const outside = join(context.root, "synthetic-domain-outside");
    await mkdir(outside);
    await symlink(outside, join(context.moduleRoot, "src/domain"));
    expect(await codes(context.root)).toContain("SYMLINK_PATH");
  });

  it("rejects a wildcard package imports alias", async () => {
    const context = await fixture({
      module: { packageImports: { "#domain/*": "./src/domain/*.ts" } },
    });
    await source(context, 'import "#domain/model";');
    expect(await codes(context.root)).toContain("DOMAIN_UNRESOLVED_REFERENCE");
  });

  it.each([
    [
      "conditional package import",
      { packageImports: { "#domain-model": { import: "./src/domain/model.ts" } } },
      "#domain-model",
      "DOMAIN_UNRESOLVED_REFERENCE",
    ],
    [
      "external package import",
      { packageImports: { "#domain-model": "external-package" } },
      "#domain-model",
      "DOMAIN_UNRESOLVED_REFERENCE",
    ],
    [
      "escaping package import",
      { packageImports: { "#domain-model": "./../../outside.ts" } },
      "#domain-model",
      "PATH_ESCAPE",
    ],
    [
      "missing package import target",
      { packageImports: { "#domain-model": "./src/domain/missing.ts" } },
      "#domain-model",
      "DOMAIN_UNRESOLVED_REFERENCE",
    ],
    [
      "wildcard TypeScript path",
      { paths: { "domain/*": ["src/domain/*.ts"] } },
      "domain/model",
      "DOMAIN_UNRESOLVED_REFERENCE",
    ],
    [
      "escaping TypeScript path",
      { paths: { "domain-model": ["../../outside.ts"] } },
      "domain-model",
      "PATH_ESCAPE",
    ],
  ])("rejects %s", async (_name, module, specifier, code) => {
    const context = await fixture({ module });
    await source(context, `import "${specifier}";`);
    expect(await codes(context.root)).toContain(code);
  });

  it("rejects a multiple-candidate TypeScript alias", async () => {
    const context = await fixture({
      module: { paths: { "domain-model": ["src/domain/one.ts", "src/domain/two.ts"] } },
    });
    await source(context, 'import "domain-model";');
    expect(await codes(context.root)).toContain("DOMAIN_UNRESOLVED_REFERENCE");
  });

  it("rejects an unlisted Domain-safe subpath", async () => {
    const context = await fixture({
      registry: [
        { packageName: "pure-domain", classification: "domain-safe", allowedSubpaths: ["."] },
      ],
    });
    await source(context, 'import "pure-domain/private";');
    expect(await codes(context.root)).toContain("DOMAIN_UNCLASSIFIED_DEPENDENCY");
  });

  it("preserves WP-0012 private Canonical package diagnostics", async () => {
    const dependency = identity("BOP", "synthetic-kernel");
    const context = await fixture({
      registry: [
        {
          packageName: dependency.packageName,
          classification: "domain-safe",
          allowedSubpaths: ["./domain/private"],
        },
      ],
      module: { dependencies: [dependency] },
    });
    await writeModule(context.root, { name: dependency.moduleName });
    await source(context, 'import "@bop/synthetic-kernel/domain/private";');
    expect(await codes(context.root)).toContain("PRIVATE_MODULE_IMPORT");
  });

  it.each([
    [
      "Domain-safe record without subpaths",
      { packageName: "pure-domain", classification: "domain-safe", allowedSubpaths: [] },
      "DOMAIN_UNCLASSIFIED_DEPENDENCY",
    ],
    [
      "prohibited record with allowed subpath",
      { packageName: "orm-lib", classification: "orm-database", allowedSubpaths: ["."] },
      "DOMAIN_UNCLASSIFIED_DEPENDENCY",
    ],
    [
      "unknown classification",
      { packageName: "unknown-lib", classification: "unknown", allowedSubpaths: [] },
      "DOMAIN_UNCLASSIFIED_DEPENDENCY",
    ],
  ])("rejects invalid registry: %s", async (_name, record, code) => {
    const context = await fixture({ registry: [record] });
    expect(await codes(context.root)).toContain(code);
  });

  it("rejects case-conflicting registry identities", async () => {
    const context = await fixture({
      registry: [
        { packageName: "pure-domain", classification: "domain-safe", allowedSubpaths: ["."] },
        { packageName: "Pure-Domain", classification: "domain-safe", allowedSubpaths: ["."] },
      ],
    });
    expect(await codes(context.root)).toContain("CASE_CONFLICT");
  });

  it("uses exit code 2 and a formatted diagnostic for unreadable Domain source", async () => {
    const context = await fixture();
    const file = await source(context, 'import "unknown-package";');
    const result = await validateDomainLayerBoundaries({
      root: context.root,
      readSource: async (path, encoding) => {
        if (path === file)
          throw Object.assign(new Error("synthetic unreadable"), { code: "EACCES" });
        return readFile(path, encoding);
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(":1 [UNREADABLE_DOMAIN_SOURCE]");
  });

  it("sorts by path, numeric line, code, message and repeats byte-identical output", async () => {
    const context = await fixture();
    await source(
      context,
      `${Array.from({ length: 8 }, () => "export {}; ").join("\n")}\nimport "unknown-ten";\nimport "unknown-eleven";`,
    );
    const first = await validateDomainLayerBoundaries({ root: context.root });
    const second = await validateDomainLayerBoundaries({ root: context.root });
    expect(second).toEqual(first);
    expect(first.diagnostics.map((item) => item.line)).toEqual([9, 10]);
  });

  it("publishes help and stable 0, 1, and 2 CLI exits", async () => {
    const valid = await fixture();
    const invalid = await fixture();
    await source(invalid, 'import "unknown-package";');
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    const zero = spawnSync(process.execPath, [cli, "--root", valid.root], { encoding: "utf8" });
    const one = spawnSync(process.execPath, [cli, "--root", invalid.root], { encoding: "utf8" });
    const two = spawnSync(process.execPath, [cli, "--unknown"], { encoding: "utf8" });
    const missing = spawnSync(process.execPath, [cli, "--root", join(valid.root, "missing")], {
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("domain-layer-boundary:check");
    expect(zero.status).toBe(0);
    expect(one.status).toBe(1);
    expect(two.status).toBe(2);
    expect(two.stderr).toContain("Domain Layer Boundary error:");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Domain Layer Boundary error:");
  });
});
