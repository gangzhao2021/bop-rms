import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { transpileModule } from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { validateModuleManifest } from "../module-manifest/validate.mjs";
import {
  ModuleGeneratorError,
  generateModule,
  moduleGeneratorUsage,
  parseGeneratedManifestSource,
} from "./generate.mjs";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));
const scriptPath = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const temporaryRoots = [];

async function loadFixture(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

async function createRepositoryRoot() {
  const root = await mkdtemp(join(tmpdir(), "bop-module-generator-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "packages"));
  return root;
}

async function snapshotTree(root, prefix = "") {
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      entries.push(...(await snapshotTree(absolutePath, relativePath)));
    } else {
      entries.push(`file:${relativePath}:${await readFile(absolutePath, "utf8")}`);
    }
  }
  return entries.sort();
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("BOP-RMS Module Generator", () => {
  it("generates the canonical BOP skeleton and only the canonical files", async () => {
    const root = await createRepositoryRoot();
    const result = await generateModule(await loadFixture("minimal-bop.json"), {
      outputRoot: root,
    });

    expect(result.target).toBe(join(root, "packages/bop/synthetic-kernel"));
    const tree = await snapshotTree(result.target);
    expect(tree.filter((entry) => entry.startsWith("file:"))).toHaveLength(5);
    expect(tree).toEqual(
      expect.arrayContaining([
        "directory:src/domain/policies",
        "directory:src/infrastructure/messaging",
        "directory:src/infrastructure/providers",
        "directory:src/interfaces/consumers",
        "directory:src/tests",
      ]),
    );
    expect(tree.some((entry) => entry.includes("migrations"))).toBe(false);
    expect(tree.some((entry) => entry.includes("src/interface/"))).toBe(false);
  });

  it("generates a legal RMS identity with a BOP dependency", async () => {
    const root = await createRepositoryRoot();
    const result = await generateModule(await loadFixture("boundary-rms.json"), {
      outputRoot: root,
    });
    expect(result.target).toBe(join(root, "packages/rms/synthetic-order-entry"));
    const packageJson = JSON.parse(await readFile(join(result.target, "package.json"), "utf8"));
    expect(packageJson.dependencies).toEqual({ "@bop/synthetic-common-kernel": "workspace:*" });
    const readme = await readFile(join(result.target, "README.md"), "utf8");
    expect(readme).toContain("Synthetic \\u0060RMS\\u0060 Steward");
    expect(readme).not.toContain("Synthetic `RMS` Steward");
  });

  it.each([
    ["invalid Module Name", { moduleName: "Invalid_Name" }, "moduleName"],
    ["path traversal Module Name", { moduleName: "../escape" }, "moduleName"],
    ["absolute Module Name", { moduleName: "/tmp/escape" }, "moduleName"],
    ["invalid Package Name", { packageName: "@private/synthetic-kernel" }, "packageName"],
    ["Layer and namespace mismatch", { packageName: "@rms/synthetic-kernel" }, "@bop"],
    ["Module and Package slug mismatch", { packageName: "@bop/other" }, "@bop/synthetic-kernel"],
  ])("rejects %s before creating a target", async (_name, change, expected) => {
    const root = await createRepositoryRoot();
    const input = { ...(await loadFixture("minimal-bop.json")), ...change };
    await expect(generateModule(input, { outputRoot: root })).rejects.toThrow(expected);
    expect(await readdir(join(root, "packages"))).toEqual([]);
  });

  it("rejects an existing target without changing it", async () => {
    const root = await createRepositoryRoot();
    const target = join(root, "packages/bop/synthetic-kernel");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "user-file.txt"), "preserve\n");
    const before = await snapshotTree(target);
    await expect(
      generateModule(await loadFixture("minimal-bop.json"), { outputRoot: root }),
    ).rejects.toThrow("target already exists");
    expect(await snapshotTree(target)).toEqual(before);
  });

  it("rejects a partial target without overwriting any file", async () => {
    const root = await createRepositoryRoot();
    const targetFile = join(root, "packages/bop/synthetic-kernel/src/domain/user-file.ts");
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, "export const userValue = true;\n");
    const before = await snapshotTree(join(root, "packages/bop/synthetic-kernel"));
    await expect(
      generateModule(await loadFixture("minimal-bop.json"), { outputRoot: root }),
    ).rejects.toThrow("target already exists");
    expect(await snapshotTree(join(root, "packages/bop/synthetic-kernel"))).toEqual(before);
  });

  it("rejects case-colliding layer paths", async () => {
    const root = await createRepositoryRoot();
    await mkdir(join(root, "packages/BOP"));
    await expect(
      generateModule(await loadFixture("minimal-bop.json"), { outputRoot: root }),
    ).rejects.toThrow("case-insensitive path collision");
  });

  it("rejects a symlinked layer path", async () => {
    const root = await createRepositoryRoot();
    const outside = await mkdtemp(join(tmpdir(), "bop-module-generator-outside-"));
    temporaryRoots.push(outside);
    await symlink(outside, join(root, "packages/bop"));
    await expect(
      generateModule(await loadFixture("minimal-bop.json"), { outputRoot: root }),
    ).rejects.toThrow("unsafe layer path");
    expect(await readdir(outside)).toEqual([]);
  });

  it("produces byte-identical results and refuses a repeated run", async () => {
    const firstRoot = await createRepositoryRoot();
    const secondRoot = await createRepositoryRoot();
    const input = await loadFixture("boundary-rms.json");
    const first = await generateModule(input, { outputRoot: firstRoot });
    const second = await generateModule(input, { outputRoot: secondRoot });
    expect(await snapshotTree(first.target)).toEqual(await snapshotTree(second.target));
    const before = await snapshotTree(first.target);
    await expect(generateModule(input, { outputRoot: firstRoot })).rejects.toThrow(
      "target already exists",
    );
    expect(await snapshotTree(first.target)).toEqual(before);
  });

  it("writes a Manifest that passes the WP-0010 validator", async () => {
    const root = await createRepositoryRoot();
    const result = await generateModule(await loadFixture("boundary-rms.json"), {
      outputRoot: root,
    });
    const source = await readFile(join(result.target, "src/module.manifest.ts"), "utf8");
    expect(source.match(/"packageName": "@rms\/synthetic-order-entry"/gu)).toHaveLength(1);
    expect(source).toContain("defineModuleManifest(moduleManifestInput)");
    expect(transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
    expect(validateModuleManifest(parseGeneratedManifestSource(source))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("provides discoverable help and exits nonzero for invalid CLI input", () => {
    expect(moduleGeneratorUsage).toContain("pnpm module-generator --input");
    const help = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("BOP-RMS Module Generator");

    const invalid = spawnSync(
      process.execPath,
      [scriptPath, "--input", join(fixtureDirectory, "invalid-input.json")],
      { encoding: "utf8" },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Module Generator error");
  });

  it("uses a closed input contract", async () => {
    const root = await createRepositoryRoot();
    const input = { ...(await loadFixture("minimal-bop.json")), extraPath: "private" };
    await expect(generateModule(input, { outputRoot: root })).rejects.toBeInstanceOf(
      ModuleGeneratorError,
    );
    await expect(generateModule(input, { outputRoot: root })).rejects.toThrow("unknown fields");
  });
});
