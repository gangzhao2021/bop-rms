import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";

const policyUrl = new URL("../../docs/security/statutory-archive-policy.json", import.meta.url);
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const opaquePattern = /^[a-z0-9][a-z0-9._:-]{7,127}$/u;

export async function loadStatutoryArchivePolicy() {
  return JSON.parse(await readFile(policyUrl, "utf8"));
}

const exactKeys = (value, fields) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");

const sameSet = (value, expected) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item) => typeof item === "string") &&
  [...value].sort().join("\n") === [...expected].sort().join("\n");

const pushIf = (errors, condition, code) => {
  if (condition) errors.push(code);
};

function anniversaryUtc(fiscalYearEnd, years) {
  if (!datePattern.test(fiscalYearEnd)) return null;
  const [year, month, day] = fiscalYearEnd.split("-").map(Number);
  const value = new Date(Date.UTC(year + years, month - 1, day));
  if (
    value.getUTCFullYear() !== year + years ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    return null;
  return value.toISOString().slice(0, 10);
}

export function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function validateStatutoryArchiveEvidence(evidence) {
  const policy = await loadStatutoryArchivePolicy();
  const errors = [];
  pushIf(
    errors,
    !exactKeys(evidence, [
      "schemaVersion",
      "archive",
      "manifest",
      "retention",
      "access",
      "verification",
      "restore",
      "destruction",
    ]),
    "EVIDENCE_SHAPE",
  );
  pushIf(errors, evidence?.schemaVersion !== policy.schemaVersion, "SCHEMA_VERSION");

  const archive = evidence?.archive;
  pushIf(
    errors,
    !exactKeys(archive, [
      "recordClasses",
      "snapshotFormats",
      "excludedFields",
      "linkedCorrectionsOnly",
      "operationalQuerySource",
      "analyticsFeed",
      "versioned",
      "sseKms",
      "objectLockGovernance",
      "ordinaryBypassAllowed",
    ]) ||
      !sameSet(archive?.recordClasses, policy.recordClasses) ||
      !sameSet(archive?.snapshotFormats, policy.snapshotFormats) ||
      !sameSet(archive?.excludedFields, policy.excludedFields) ||
      archive?.linkedCorrectionsOnly !== true ||
      archive?.operationalQuerySource !== false ||
      archive?.analyticsFeed !== false ||
      archive?.versioned !== true ||
      archive?.sseKms !== true ||
      archive?.objectLockGovernance !== true ||
      archive?.ordinaryBypassAllowed !== false,
    "ARCHIVE_PROFILE",
  );

  const manifest = evidence?.manifest;
  pushIf(
    errors,
    !exactKeys(manifest, policy.manifestFields) ||
      manifest?.schemaVersion !== 1 ||
      !Number.isSafeInteger(manifest?.policyVersion) ||
      manifest?.policyVersion < 1 ||
      !Number.isSafeInteger(manifest?.templateVersion) ||
      manifest?.templateVersion < 1 ||
      !datePattern.test(manifest?.businessDateFrom ?? "") ||
      !datePattern.test(manifest?.businessDateThrough ?? "") ||
      manifest?.businessDateFrom > manifest?.businessDateThrough ||
      !datePattern.test(manifest?.fiscalYearEnd ?? "") ||
      !Number.isSafeInteger(manifest?.objectCount) ||
      manifest?.objectCount < 1 ||
      !digestPattern.test(manifest?.sourceHash ?? "") ||
      !digestPattern.test(manifest?.archiveHash ?? ""),
    "MANIFEST",
  );

  const expectedMinimum = anniversaryUtc(
    manifest?.fiscalYearEnd ?? "",
    policy.retentionYearsFromFiscalYearEnd,
  );
  const retention = evidence?.retention;
  pushIf(
    errors,
    !exactKeys(retention, [
      "retainUntil",
      "legalHoldActive",
      "legalHoldReleaseApproved",
      "applicationCanShorten",
      "complianceModeCounselApproved",
    ]) ||
      expectedMinimum === null ||
      !datePattern.test(retention?.retainUntil ?? "") ||
      retention?.retainUntil < expectedMinimum ||
      retention?.applicationCanShorten !== false ||
      (retention?.legalHoldActive === true && retention?.legalHoldReleaseApproved === true) ||
      (retention?.complianceModeCounselApproved !== true &&
        retention?.complianceModeCounselApproved !== false),
    "RETENTION_LEGAL_HOLD",
  );

  pushIf(
    errors,
    !exactKeys(evidence?.access, ["controls", "crossTenantAccess", "rawPiiSearch"]) ||
      !sameSet(evidence?.access?.controls, policy.requiredAccessControls) ||
      evidence?.access?.crossTenantAccess !== false ||
      evidence?.access?.rawPiiSearch !== false,
    "ACCESS_CONTROL",
  );

  pushIf(
    errors,
    !exactKeys(evidence?.verification, [
      "sourceCountMatches",
      "sourceHashMatches",
      "archivePresent",
      "manifestSignatureValid",
      "verifiedAt",
    ]) ||
      evidence?.verification?.sourceCountMatches !== true ||
      evidence?.verification?.sourceHashMatches !== true ||
      evidence?.verification?.archivePresent !== true ||
      evidence?.verification?.manifestSignatureValid !== true ||
      !instantPattern.test(evidence?.verification?.verifiedAt ?? ""),
    "DAILY_VERIFICATION",
  );

  const restore = evidence?.restore;
  pushIf(
    errors,
    !exactKeys(restore, [
      "quarterlySampleCompletedAt",
      "legalReceiptReconstructed",
      "transactionHistoryReconstructed",
      "otherTenantExposed",
      "trafficFencedUntilTombstones",
      "tombstone",
    ]) ||
      !instantPattern.test(restore?.quarterlySampleCompletedAt ?? "") ||
      restore?.legalReceiptReconstructed !== true ||
      restore?.transactionHistoryReconstructed !== true ||
      restore?.otherTenantExposed !== false ||
      restore?.trafficFencedUntilTombstones !== true ||
      !exactKeys(restore?.tombstone, policy.privacyTombstoneFields) ||
      !opaquePattern.test(restore?.tombstone?.opaqueSubjectId ?? "") ||
      !opaquePattern.test(restore?.tombstone?.fieldReference ?? "") ||
      !Number.isSafeInteger(restore?.tombstone?.policyVersion) ||
      restore?.tombstone?.policyVersion < 1 ||
      !instantPattern.test(restore?.tombstone?.completedAt ?? "") ||
      restore?.tombstone?.replayStatus !== "Applied",
    "RESTORE_TOMBSTONE",
  );

  const destruction = evidence?.destruction;
  pushIf(
    errors,
    !exactKeys(destruction, [
      "requested",
      "afterRetention",
      "legalHoldReleased",
      "manifestEvidenceDigest",
      "objectVersionEvidenceDigest",
    ]) ||
      destruction?.requested !== true ||
      destruction?.afterRetention !== true ||
      destruction?.legalHoldReleased !== true ||
      retention?.legalHoldActive === true ||
      !digestPattern.test(destruction?.manifestEvidenceDigest ?? "") ||
      !digestPattern.test(destruction?.objectVersionEvidenceDigest ?? ""),
    "DESTRUCTION_GATE",
  );

  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    process.stderr.write(
      "EXTERNAL_EVIDENCE_REQUIRED: pass a statutory archive evidence JSON file\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = await validateStatutoryArchiveEvidence(
    JSON.parse(await readFile(evidencePath, "utf8")),
  );
  if (!result.ok) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
