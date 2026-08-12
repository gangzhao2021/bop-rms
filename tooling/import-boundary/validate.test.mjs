import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateImportBoundaries } from "./validate.mjs";

const roots = [];
const identity = (layer, name) => ({
  moduleName: name,
  packageName: `@${layer.toLowerCase()}/${name}`,
  layer,
});
async function writeModule(
  root,
  layer,
  name,
  dependencies = [],
  exports = { ".": "./src/index.ts" },
) {
  const moduleRoot = join(root, "packages", layer.toLowerCase(), name);
  const manifest = {
    ...identity(layer, name),
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
  await writeFile(
    join(moduleRoot, "src/module.manifest.ts"),
    `const moduleManifestInput = ${JSON.stringify(manifest, null, 2)} as const;\nexport default moduleManifestInput;\n`,
  );
  await writeFile(
    join(moduleRoot, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.packageName,
        type: "module",
        exports,
        dependencies: Object.fromEntries(
          dependencies.map((dependency) => [dependency.packageName, "workspace:*"]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  for (const target of Object.values(exports)) {
    const targetPath = join(moduleRoot, target);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "export const synthetic = true;\n");
  }
  return moduleRoot;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bop-import-boundary-"));
  roots.push(root);
  const kernel = identity("BOP", "synthetic-kernel");
  const peer = identity("RMS", "synthetic-peer");
  const bop = await writeModule(root, "BOP", "synthetic-caller", [kernel]);
  await writeModule(root, "BOP", "synthetic-kernel", [], {
    ".": "./src/index.ts",
    "./contracts": "./src/contracts.ts",
  });
  const rms = await writeModule(root, "RMS", "synthetic-caller", [kernel, peer]);
  await writeModule(root, "RMS", "synthetic-peer");
  return { root, bop, rms };
}
const source = (moduleRoot, text) => writeFile(join(moduleRoot, "src/consumer.ts"), `${text}\n`);
const codes = async (root) =>
  (await validateImportBoundaries({ root })).diagnostics.map((item) => item.code);
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Import Boundary Architecture Test", () => {
  it.each([
    ["BOP to BOP", "BOP", 'import "@bop/synthetic-kernel";'],
    [
      "RMS to BOP type-only",
      "RMS",
      'import type { Synthetic } from "@bop/synthetic-kernel/contracts";',
    ],
    ["RMS to RMS re-export", "RMS", 'export * from "@rms/synthetic-peer";'],
    ["dynamic import", "RMS", 'const value = import("@bop/synthetic-kernel");'],
    [
      "import type expression",
      "RMS",
      'type Value = import("@bop/synthetic-kernel/contracts").Synthetic;',
    ],
  ])("allows %s through a public export", async (_name, layer, text) => {
    const context = await fixture();
    await source(layer === "BOP" ? context.bop : context.rms, text);
    expect(await validateImportBoundaries({ root: context.root })).toMatchObject({
      valid: true,
      diagnostics: [],
    });
  });

  it.each([
    ["BOP_TO_RMS_IMPORT", 'import "@rms/synthetic-peer";'],
    ["PRIVATE_MODULE_IMPORT", 'import "@bop/synthetic-kernel/src/private";'],
    ["PRIVATE_MODULE_IMPORT", 'import "@bop/synthetic-kernel/domain/model";'],
    ["UNEXPORTED_MODULE_SUBPATH", 'import "@bop/synthetic-kernel/not-exported";'],
    ["UNRESOLVED_DYNAMIC_IMPORT", "const name = '@bop/synthetic-kernel'; import(name);"],
    ["PATH_ESCAPE", 'import "../../../../../outside.js";'],
    ["INVALID_MODULE_PACKAGE", 'import "@BOP/synthetic-kernel";'],
    ["PACKAGE_PATH_ESCAPE", 'import "@bop/synthetic-kernel/../private";'],
  ])("rejects %s", async (code, text) => {
    const context = await fixture();
    await source(context.bop, text);
    expect(await codes(context.root)).toContain(code);
  });

  it("rejects cross-Module relative imports", async () => {
    const context = await fixture();
    let specifier = relative(
      join(context.bop, "src"),
      join(context.root, "packages/bop/synthetic-kernel/src/index.js"),
    ).replaceAll("\\", "/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    await source(context.bop, `import "${specifier}";`);
    expect(await codes(context.root)).toContain("CROSS_MODULE_RELATIVE_IMPORT");
  });
  it("rejects Manifest/package identity mismatch", async () => {
    const context = await fixture();
    const file = join(context.bop, "package.json");
    const value = JSON.parse(await readFile(file));
    value.name = "@bop/wrong";
    await writeFile(file, JSON.stringify(value));
    expect(await codes(context.root)).toContain("MODULE_IDENTITY_MISMATCH");
  });
  it("rejects Layer/namespace mismatch", async () => {
    const context = await fixture();
    const file = join(context.bop, "src/module.manifest.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace('"layer": "BOP"', '"layer": "RMS"'),
    );
    expect(await codes(context.root)).toContain("INVALID_MANIFEST");
  });
  it("rejects Manifest/export-map mismatch", async () => {
    const context = await fixture();
    const file = join(context.bop, "package.json");
    const value = JSON.parse(await readFile(file));
    value.exports["./private"] = "./src/private.ts";
    await writeFile(join(context.bop, "src/private.ts"), "export {};\n");
    await writeFile(file, JSON.stringify(value));
    expect(await codes(context.root)).toContain("EXPORT_MAP_MISMATCH");
  });
  it("rejects case-conflicting package identity", async () => {
    const context = await fixture();
    await source(context.bop, 'import "@bop/Synthetic-Kernel";');
    expect(await codes(context.root)).toContain("PACKAGE_CASE_CONFLICT");
  });
  it("rejects a declared dependency that is not a discovered Module", async () => {
    const context = await fixture();
    await writeModule(context.root, "BOP", "synthetic-unknown-caller", [
      identity("BOP", "missing-module"),
    ]);
    expect(await codes(context.root)).toContain("UNKNOWN_DECLARED_MODULE_DEPENDENCY");
  });
  it("requires package and Manifest runtime dependencies to match in both directions", async () => {
    const context = await fixture();
    const file = join(context.bop, "package.json");
    const value = JSON.parse(await readFile(file));
    delete value.dependencies["@bop/synthetic-kernel"];
    value.dependencies["@bop/undeclared-runtime"] = "workspace:*";
    await writeFile(file, JSON.stringify(value));
    const result = await codes(context.root);
    expect(result).toContain("MANIFEST_DEPENDENCY_MISSING_FROM_PACKAGE");
    expect(result).toContain("PACKAGE_DEPENDENCY_UNDECLARED");
  });
  it("rejects synchronous Module dependency cycles", async () => {
    const context = await fixture();
    await writeModule(context.root, "RMS", "synthetic-peer", [identity("RMS", "synthetic-caller")]);
    expect(await codes(context.root)).toContain("MODULE_DEPENDENCY_CYCLE");
  });
  it("sorts violations and repeats identical output", async () => {
    const context = await fixture();
    await source(
      context.bop,
      'import "@rms/synthetic-peer";\nimport "@bop/synthetic-kernel/private";',
    );
    const first = await validateImportBoundaries({ root: context.root });
    const second = await validateImportBoundaries({ root: context.root });
    expect(first.valid).toBe(false);
    expect(second).toEqual(first);
    expect(first.output.split("\n")).toEqual(
      [...first.output.split("\n")].sort((a, b) => a.localeCompare(b, "en")),
    );
  });
});
