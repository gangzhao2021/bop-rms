import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import {
  productPublicationCheckCodes,
  parseProductPublicationVersion,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import { buildCatalogProductPublicationValidationReport } from "../contracts/product-publication-validation-report.js";
import {
  appendProductPublicationValidationReport,
  recoverProductPublicationValidationReport,
} from "../infrastructure/persistence/product-publication-validation-report-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";

// Controlled storage boundary facts; real SQL, authority and rollback are covered
// by the selected isolated owning-writer acceptance, not by this fake query port.
const id = (n: number) => `01902421-0133-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-03T12:00:00.000Z",
  recordedAt = "2026-10-03T12:00:00.001Z";
const until = "2026-10-03T12:00:05.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
function fixture(outcome: "Pass" | "Warning" | "HardError" = "Pass", complete = false) {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const replacementIntent = { ...body, digest: hash(body) };
  const command = parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash("content"),
    configurationDigest: hash("configuration"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_REPORT",
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  });
  const validation = parseProductPublicationValidationV2({
    profile: "CatalogProductPublicationValidationV2",
    evidenceReference: id(7),
    replacementIntentDigest: command.replacementIntentDigest,
    productAggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: hash(command.scopeSet),
    periodDigest: hash(command.effectivePeriod),
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "NotRequired",
    checks: productPublicationCheckCodes.map((code) => ({
      code,
      outcome:
        code === "ChangeImpact"
          ? outcome
          : code === "HardErrorsCleared" && outcome === "HardError"
            ? "HardError"
            : "Pass",
    })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: until,
  });
  const publication = planCatalogProductPublicationV2(command, null, {
    now: at,
    productAggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: validation.scopeDigest,
    periodDigest: validation.periodDigest,
    validation,
    approval: null,
    reviewReference: null,
    replacement: null,
  });
  const report = buildCatalogProductPublicationValidationReport({
    command,
    publication,
    validation,
    recordedAt,
    details: complete
      ? {
          coverage: "Complete",
          impact: "Recorded",
          findings:
            outcome === "Pass"
              ? []
              : [
                  {
                    checkCode: "ChangeImpact",
                    ruleCode: "SYNTHETIC_REFERENCE",
                    outcome,
                    subjectReference: id(5),
                    reasonCode: "SYNTHETIC_MISSING",
                    references: [],
                  },
                ],
          sources: [
            {
              sourceCode: "SYNTHETIC_SOURCE",
              sourceDigest: hash("source"),
              generation: "0",
              relevantReferenceDigest: hash("reference facts"),
              observedAt: at,
              validUntil: until,
            },
          ],
        }
      : null,
  });
  const metadata = {
    operationReference: report.operationReference,
    tenantReference: report.binding.tenantReference,
    brandReference: report.binding.brandReference,
    productReference: report.binding.productReference,
    versionReference: report.binding.versionReference,
    publicationVersion: report.publicationVersion,
    sourceAggregateVersion: report.sourceAggregateVersion,
    resultAggregateVersion: report.resultAggregateVersion,
    publicationAction: report.publicationAction,
    originalIntentDigest: report.originalIntentDigest,
    publicationSnapshotDigest: report.publicationSnapshotDigest,
    validationEvidenceReference: report.validationEvidenceReference,
    digest: report.digest,
    recordedAt: report.recordedAt,
    dataClassification: "ConfigurationMetadata",
  };
  return {
    command,
    publication,
    report,
    row: { publication, required: true, report, metadata, bounded: true },
  };
}
function port(rows: readonly unknown[], rowCount = 1) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      return { rows: rows as readonly Row[], rowCount };
    },
  };
  return { tx, calls };
}

describe("transaction-local immutable publication report storage", () => {
  it.each(["Pass", "Warning", "HardError"] as const)(
    "persists actual %s checks and explicit ChecksOnly without fabricating detailed impact",
    async (outcome) => {
      const x = fixture(outcome),
        p = port([]);
      const result = await appendProductPublicationValidationReport(p.tx, x.report);
      expect(result).toEqual(x.report);
      expect(result.details).toEqual({ coverage: "ChecksOnly", impact: "NotRecorded" });
      expect(p.calls).toHaveLength(1);
      const call = p.calls[0];
      if (!call) throw new Error("Expected one append");
      expect(call.sql).toContain("INSERT INTO rms_catalog.product_publication_validation_report");
      expect(call.values).toEqual([
        id(4),
        id(1),
        id(2),
        id(5),
        id(6),
        1,
        1,
        2,
        "Validate",
        x.report.originalIntentDigest,
        x.report.publicationSnapshotDigest,
        id(7),
        x.report.digest,
        recordedAt,
        canonicalizeRfc8785(x.report),
      ]);
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it("recovers exact original detailed findings and their expired historical lease without a fresh clock or source", async () => {
    const x = fixture("Warning", true),
      p = port([x.row]);
    const result = await recoverProductPublicationValidationReport(p.tx, x.publication);
    expect(result).toEqual({ status: "Recorded", report: x.report });
    expect(result.report?.validation.validUntil).toBe(until);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]?.values).toEqual([id(1), id(2), id(5), id(6), id(4)]);
    expect(p.calls[0]?.sql).toContain("r.validation_report_required required");
    expect(p.calls[0]?.sql).not.toContain("rms_catalog.product ");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("distinguishes actual pre-migration V2 absence from new required-report corruption", async () => {
    const x = fixture();
    const old = port([{ ...x.row, required: false, report: null, metadata: null }]);
    await expect(recoverProductPublicationValidationReport(old.tx, x.publication)).resolves.toEqual(
      { status: "NotRecorded", report: null },
    );
    const missing = port([{ ...x.row, report: null, metadata: null }]);
    await expect(
      recoverProductPublicationValidationReport(missing.tx, x.publication),
    ).rejects.toEqual(unavailable);
  });

  it("recovers legacy V1 absence only from the exact owning snapshot and explicit false marker", async () => {
    const x = fixture();
    const raw: Record<string, unknown> = { ...x.publication };
    delete raw.profile;
    delete raw.replacementIntent;
    delete raw.replacementIntentDigest;
    const legacy = parseProductPublicationVersion(raw);
    const row = {
      publication: legacy,
      required: false,
      report: null,
      metadata: null,
      bounded: true,
    };
    await expect(
      recoverProductPublicationValidationReport(port([row]).tx, legacy),
    ).resolves.toEqual({ status: "NotRecorded", report: null });
    await expect(
      recoverProductPublicationValidationReport(port([{ ...row, required: true }]).tx, legacy),
    ).rejects.toEqual(unavailable);
    await expect(
      recoverProductPublicationValidationReport(
        port([{ ...row, publication: { ...legacy, reasonCode: "OTHER_REASON" } }]).tx,
        legacy,
      ),
    ).rejects.toEqual(unavailable);
    await expect(
      recoverProductPublicationValidationReport(port([row]).tx, x.publication),
    ).rejects.toEqual(unavailable);
  });

  it.each([undefined, null, "false", 0])(
    "rejects an unproven historical marker %s",
    async (required) => {
      const x = fixture(),
        p = port([{ ...x.row, required, report: null, metadata: null }]);
      await expect(recoverProductPublicationValidationReport(p.tx, x.publication)).rejects.toEqual(
        unavailable,
      );
    },
  );

  it("refuses to backfill historical report absence silently", async () => {
    const x = fixture(),
      p = port([{ ...x.row, required: false }]);
    await expect(recoverProductPublicationValidationReport(p.tx, x.publication)).rejects.toEqual(
      unavailable,
    );
  });

  it.each(["digest", "evidence", "publication", "metadata", "budget"] as const)(
    "rejects a corrupt %s independently of returned row count",
    async (kind) => {
      const x = fixture(),
        raw = structuredClone(x.row) as unknown as {
          publication: Record<string, unknown>;
          report: Record<string, unknown>;
          metadata: Record<string, unknown>;
          required: boolean;
          bounded: boolean;
        };
      if (kind === "digest") raw.report.digest = hash("changed");
      if (kind === "evidence") raw.report.validationEvidenceReference = id(99);
      if (kind === "publication") raw.publication.reasonCode = "TRANSPLANTED_REASON";
      if (kind === "metadata") raw.metadata.tenantReference = id(99);
      if (kind === "budget") raw.bounded = false;
      const p = port([raw]);
      await expect(recoverProductPublicationValidationReport(p.tx, x.publication)).rejects.toEqual(
        unavailable,
      );
    },
  );

  it("rejects a self-consistent report for a different original operation", async () => {
    const x = fixture(),
      foreign = { ...x.publication, operationReference: id(99) };
    const p = port([{ ...x.row, publication: foreign }]);
    await expect(recoverProductPublicationValidationReport(p.tx, foreign)).rejects.toEqual(
      unavailable,
    );
  });

  it.each([0, 2])("rejects %i owning revision rows", async (count) => {
    const x = fixture(),
      p = port(Array.from({ length: count }, () => x.row));
    await expect(recoverProductPublicationValidationReport(p.tx, x.publication)).rejects.toEqual(
      unavailable,
    );
  });

  it("never invokes a SQL wrapper accessor", async () => {
    const x = fixture(),
      getter = vi.fn(() => x.report),
      raw = { ...x.row };
    Object.defineProperty(raw, "report", { enumerable: true, get: getter });
    const p = port([raw]);
    await expect(recoverProductPublicationValidationReport(p.tx, x.publication)).rejects.toEqual(
      unavailable,
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("never invokes metadata accessors", async () => {
    const x = fixture(),
      getter = vi.fn(() => x.report.digest),
      raw = { ...x.row, metadata: { ...x.row.metadata } };
    Object.defineProperty(raw.metadata, "digest", { enumerable: true, get: getter });
    await expect(
      recoverProductPublicationValidationReport(port([raw]).tx, x.publication),
    ).rejects.toEqual(unavailable);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["append", "recover"] as const)("rejects a changed query port after %s", async (mode) => {
    const x = fixture();
    const tx: ProductLifecycleTransaction = {
      async query<Row>() {
        tx.query = async () => ({ rows: [], rowCount: 1 });
        return { rows: [x.row] as unknown as readonly Row[], rowCount: 1 };
      },
    };
    await expect(
      mode === "append"
        ? appendProductPublicationValidationReport(tx, x.report)
        : recoverProductPublicationValidationReport(tx, x.publication),
    ).rejects.toEqual(unavailable);
  });

  it.each([0, 2])("requires exactly one inserted report, got %i", async (count) => {
    const x = fixture();
    await expect(
      appendProductPublicationValidationReport(port([], count).tx, x.report),
    ).rejects.toEqual(unavailable);
  });

  it("rejects malformed reports before SQL", async () => {
    const x = fixture(),
      p = port([]);
    await expect(
      appendProductPublicationValidationReport(p.tx, { ...x.report, unknown: true }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(p.calls).toHaveLength(0);
  });
});
