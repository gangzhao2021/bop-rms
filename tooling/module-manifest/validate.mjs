import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { boundaryManifest } from "./fixtures/boundary.module.manifest.mjs";
import { invalidManifestFixtures } from "./fixtures/invalid.module.manifests.mjs";
import { minimalManifest } from "./fixtures/minimal.module.manifest.mjs";

const schema = JSON.parse(
  readFileSync(new URL("./module-manifest.schema.json", import.meta.url), "utf8"),
);
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const privateExportSegments = new Set([
  "src",
  "private",
  "internal",
  "domain",
  "infrastructure",
  "persistence",
  "adapter",
  "adapters",
  "orm",
  "database",
]);
const sensitiveClasses = new Set(["sensitive_personal", "payment", "health", "credential"]);

function schemaError(error) {
  return `schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
}

export function validateModuleManifest(manifest) {
  const errors = [];
  if (!validateSchema(manifest)) errors.push(...(validateSchema.errors ?? []).map(schemaError));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors };
  }

  const dependencies = Array.isArray(manifest.allowedSynchronousDependencies)
    ? manifest.allowedSynchronousDependencies
    : [];
  const dependencyNames = new Set();
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== "object") continue;
    if (dependencyNames.has(dependency.moduleName)) {
      errors.push(`duplicate synchronous dependency ${String(dependency.moduleName)}`);
    }
    dependencyNames.add(dependency.moduleName);
    if (dependency.moduleName === manifest.moduleName) {
      errors.push(`${String(manifest.moduleName)} cannot depend synchronously on itself`);
    }
    if (manifest.layer === "BOP" && dependency.layer === "RMS") {
      errors.push("BOP module cannot depend synchronously on RMS module");
    }
  }

  for (const exportedPath of Array.isArray(manifest.publicExports) ? manifest.publicExports : []) {
    if (typeof exportedPath !== "string") continue;
    const privateSegment = exportedPath
      .toLowerCase()
      .split("/")
      .find((segment) => privateExportSegments.has(segment));
    if (privateSegment) {
      errors.push(`public export ${exportedPath} exposes private path segment ${privateSegment}`);
    }
  }

  const ownedDatabase = manifest.ownedDatabase;
  if (
    ownedDatabase?.schema === null &&
    Array.isArray(ownedDatabase.tables) &&
    ownedDatabase.tables.length > 0
  ) {
    errors.push("owned database tables require a declared future schema owner");
  }

  const classification = manifest.piiClassification;
  const classes = Array.isArray(classification?.classes) ? classification.classes : [];
  if (classes.includes("none") && classes.length !== 1) {
    errors.push("PII class none cannot be combined with another classification");
  }
  if (
    classes.some((value) => sensitiveClasses.has(value)) &&
    (classification?.handling?.logs !== "prohibited" ||
      classification?.handling?.analytics !== "prohibited")
  ) {
    errors.push("sensitive classifications require prohibited logs and analytics");
  }

  return { valid: errors.length === 0, errors };
}

export function verifyCommittedFixtures() {
  const failures = [];
  for (const [name, manifest] of [
    ["minimal", minimalManifest],
    ["boundary", boundaryManifest],
  ]) {
    const result = validateModuleManifest(manifest);
    if (!result.valid) failures.push(`${name} legal fixture failed: ${result.errors.join("; ")}`);
  }
  for (const fixture of invalidManifestFixtures) {
    const result = validateModuleManifest(fixture.manifest);
    if (result.valid) failures.push(`${fixture.name}: invalid fixture was accepted`);
    else if (!result.errors.join("\n").includes(fixture.expected)) {
      failures.push(
        `${fixture.name}: expected ${fixture.expected}; received ${result.errors.join("; ")}`,
      );
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = verifyCommittedFixtures();
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Module Manifest valid: 2 legal fixtures and ${invalidManifestFixtures.length} rejected boundary cases\n`,
    );
  }
}
