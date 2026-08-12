import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";

const policyPath = new URL("../../docs/security/release-evidence-policy.json", import.meta.url);
const sha256 = /^sha256:[a-f0-9]{64}$/;
const commitSha = /^[a-f0-9]{40}$/;
const safeReference = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
  );
}

function pushIf(errors, condition, code) {
  if (condition) errors.push(code);
}

export async function loadReleaseEvidencePolicy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

export async function validateReleaseEvidence(evidence) {
  const policy = await loadReleaseEvidencePolicy();
  const errors = [];
  const topKeys = [
    "schemaVersion",
    "trust",
    "image",
    "runtime",
    "tools",
    "artifacts",
    "findings",
    "signing",
    "registry",
    "promotion",
  ];

  pushIf(errors, !exactKeys(evidence, topKeys), "EVIDENCE_SHAPE");
  pushIf(errors, evidence?.schemaVersion !== policy.schemaVersion, "SCHEMA_VERSION");

  const trust = evidence?.trust;
  pushIf(
    errors,
    !exactKeys(trust, [
      "sourceCommit",
      "workflowIdentity",
      "builderIdentity",
      "protectedRef",
      "untrustedPullRequest",
    ]),
    "TRUST_SHAPE",
  );
  pushIf(errors, !commitSha.test(trust?.sourceCommit ?? ""), "SOURCE_COMMIT");
  pushIf(errors, !safeReference.test(trust?.workflowIdentity ?? ""), "WORKFLOW_IDENTITY");
  pushIf(errors, !safeReference.test(trust?.builderIdentity ?? ""), "BUILDER_IDENTITY");
  pushIf(errors, trust?.protectedRef !== true, "UNPROTECTED_REF");
  pushIf(errors, trust?.untrustedPullRequest !== false, "UNTRUSTED_BUILD");

  const image = evidence?.image;
  pushIf(
    errors,
    !exactKeys(image, ["baseImage", "baseDigest", "resultDigest", "platform"]),
    "IMAGE_SHAPE",
  );
  pushIf(errors, image?.baseImage !== policy.requiredBaseImage, "BASE_IMAGE");
  pushIf(errors, !sha256.test(image?.baseDigest ?? ""), "BASE_DIGEST");
  pushIf(errors, !sha256.test(image?.resultDigest ?? ""), "IMAGE_DIGEST");
  pushIf(errors, image?.platform !== policy.requiredPlatform, "PLATFORM");

  const runtime = evidence?.runtime;
  pushIf(
    errors,
    !exactKeys(runtime, [
      "user",
      "sourceControlMetadata",
      "packageManagerCache",
      "developmentDependencies",
      "readOnlyRootFilesystem",
      "linuxCapabilitiesDropped",
      "boundedEphemeralTmp",
      "publicSourceMaps",
    ]),
    "RUNTIME_SHAPE",
  );
  pushIf(errors, runtime?.user !== "node", "ROOT_RUNTIME");
  for (const [field, required] of [
    ["sourceControlMetadata", false],
    ["packageManagerCache", false],
    ["developmentDependencies", false],
    ["readOnlyRootFilesystem", true],
    ["linuxCapabilitiesDropped", true],
    ["boundedEphemeralTmp", true],
    ["publicSourceMaps", false],
  ]) {
    pushIf(errors, runtime?.[field] !== required, `RUNTIME_${field.toUpperCase()}`);
  }

  const tools = Array.isArray(evidence?.tools) ? evidence.tools : [];
  pushIf(errors, !Array.isArray(evidence?.tools), "TOOLS_SHAPE");
  for (const requiredName of policy.requiredToolPins) {
    const matches = tools.filter((tool) => tool?.name === requiredName);
    pushIf(errors, matches.length !== 1, `TOOL_${requiredName.toUpperCase().replaceAll("-", "_")}`);
    const tool = matches[0];
    pushIf(
      errors,
      !exactKeys(tool, ["name", "immutablePin", "reviewReference"]) ||
        !sha256.test(tool?.immutablePin ?? "") ||
        !safeReference.test(tool?.reviewReference ?? ""),
      `TOOL_PIN_${requiredName.toUpperCase().replaceAll("-", "_")}`,
    );
  }
  pushIf(errors, tools.length !== policy.requiredToolPins.length, "UNEXPECTED_TOOL");

  const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
  pushIf(errors, !Array.isArray(evidence?.artifacts), "ARTIFACTS_SHAPE");
  for (const requiredName of policy.requiredArtifacts) {
    const matches = artifacts.filter((artifact) => artifact?.name === requiredName);
    pushIf(
      errors,
      matches.length !== 1,
      `ARTIFACT_${requiredName.toUpperCase().replaceAll("-", "_")}`,
    );
    const artifact = matches[0];
    pushIf(
      errors,
      !exactKeys(artifact, ["name", "status", "subjectDigest", "evidenceDigest"]) ||
        artifact?.status !== "PASS" ||
        artifact?.subjectDigest !== image?.resultDigest ||
        !sha256.test(artifact?.evidenceDigest ?? ""),
      `ARTIFACT_BINDING_${requiredName.toUpperCase().replaceAll("-", "_")}`,
    );
  }
  pushIf(errors, artifacts.length !== policy.requiredArtifacts.length, "UNEXPECTED_ARTIFACT");

  pushIf(
    errors,
    !exactKeys(evidence?.findings, ["exploitableCritical", "exploitableHigh"]) ||
      evidence?.findings?.exploitableCritical !== 0 ||
      evidence?.findings?.exploitableHigh !== 0,
    "EXPLOITABLE_FINDING",
  );

  const signing = evidence?.signing;
  pushIf(
    errors,
    !exactKeys(signing, [
      "status",
      "subjectDigest",
      "kmsAsymmetric",
      "keyAlgorithm",
      "signatureAlgorithm",
    ]) ||
      signing?.status !== "PASS" ||
      signing?.subjectDigest !== image?.resultDigest ||
      signing?.kmsAsymmetric !== true ||
      signing?.keyAlgorithm !== "ECC_NIST_P256" ||
      signing?.signatureAlgorithm !== "ECDSA_SHA_256",
    "SIGNATURE",
  );

  pushIf(
    errors,
    !exactKeys(evidence?.registry, ["tagImmutable", "enhancedScanning"]) ||
      evidence?.registry?.tagImmutable !== true ||
      evidence?.registry?.enhancedScanning !== true,
    "REGISTRY",
  );

  const promotion = evidence?.promotion;
  pushIf(
    errors,
    !exactKeys(promotion, ["stagingDigest", "productionDigest"]) ||
      promotion?.stagingDigest !== image?.resultDigest ||
      promotion?.productionDigest !== image?.resultDigest,
    "DIGEST_PROMOTION",
  );

  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    process.stderr.write("EXTERNAL_EVIDENCE_REQUIRED: pass a release evidence JSON file\n");
    process.exitCode = 2;
    return;
  }
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const result = await validateReleaseEvidence(evidence);
  if (!result.ok) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
