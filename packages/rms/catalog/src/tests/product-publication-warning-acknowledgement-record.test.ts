import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import {
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
} from "../contracts/product-publication-validation-report.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand as parseCommand,
  buildCatalogProductPublicationWarningAcknowledgementObservation as observe,
  buildCatalogProductPublicationWarningAcknowledgementReceipt as acknowledge,
} from "../contracts/product-publication-warning-acknowledgement.js";
import { catalogProductPublicationWarningAcknowledgementEventId } from "../contracts/product-publication-warning-acknowledgement-event.js";
import {
  recoverProductPublicationWarningAcknowledgement as recover,
  readLatestProductPublicationWarningAcknowledgement as latest,
  appendProductPublicationWarningAcknowledgement as append,
} from "../infrastructure/persistence/product-publication-warning-acknowledgement-record.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";

// Synthetic receipt facts exercise the persistence boundary; the native owning
// writer case supplies SQL/rollback evidence and does not infer real policy.
const id = (n: number) => "01902491-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  humanUntil = "2026-10-03T14:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    publicationCommand = parseProductPublicationCommandV2({
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
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: publicationCommand.replacementIntentDigest,
      evidenceReference: id(7),
      productAggregateVersion: 1,
      contentDigest: publicationCommand.contentDigest,
      configurationDigest: publicationCommand.configurationDigest,
      scopeDigest: hash(publicationCommand.scopeSet),
      periodDigest: hash(publicationCommand.effectivePeriod),
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
    }),
    publication = planCatalogProductPublicationV2(publicationCommand, null, {
      now: at,
      productAggregateVersion: 1,
      contentDigest: publicationCommand.contentDigest,
      configurationDigest: publicationCommand.configurationDigest,
      scopeDigest: validation.scopeDigest,
      periodDigest: validation.periodDigest,
      validation,
      approval: null,
      reviewReference: null,
      replacement: null,
    }),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SKU-008",
          outcome: "Warning",
          subjectReference: id(20),
          reasonCode: "SYNTHETIC_REFERENCE_GAP",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_REFERENCE",
          sourceDigest: hash("held source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant refs"),
          observedAt: at,
          validUntil: until,
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: publicationCommand,
      publication,
      validation,
      details,
      recordedAt: at,
    });
  if (details.coverage !== "Complete") throw new Error("Missing synthetic details");
  const command = parseCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(30),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONFIRMED_REFERENCE_WARNING",
      occurredAt: humanAt,
    }),
    freshValidation = parseProductPublicationValidationV2({
      ...validation,
      productAggregateVersion: 7,
      evidenceReference: id(31),
      checkedAt: humanAt,
      validUntil: humanUntil,
    }),
    freshDetails = {
      ...details,
      sources: details.sources.map((s) => ({
        ...s,
        generation: "99",
        sourceDigest: hash("fresh source at new root"),
        observedAt: "2026-10-03T14:00:00.001Z",
        validUntil: humanUntil,
      })),
    },
    policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(40),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: [],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    },
    observationInput = {
      command,
      binding: report.binding,
      validation: freshValidation,
      details: freshDetails,
      policy,
      observedAt: "2026-10-03T14:00:00.002Z",
      validUntil: humanUntil,
    },
    observation = observe(observationInput),
    receiptInput = { command, report, observation, recordedAt: "2026-10-03T14:00:00.003Z" },
    receipt = acknowledge(receiptInput),
    next = parseProductPublicationCommandV2({
      ...publicationCommand,
      operationReference: id(50),
      expectedProductAggregateVersion: 8,
      expectedPublicationVersion: publication.publicationVersion,
      occurredAt: "2026-10-03T14:00:00.004Z",
    }),
    bindingInput = {
      receipt,
      command: next,
      current: publication,
      validation: { ...freshValidation, productAggregateVersion: 8 },
      details: freshDetails,
      policy,
      now: "2026-10-03T14:00:00.004Z",
    };
  return {
    command,
    publicationCommand,
    publication,
    report,
    validation,
    details,
    observationInput,
    receiptInput,
    receipt,
    bindingInput,
  };
}

function row(receipt = fixture().receipt, acknowledgementSequence = 1) {
  const c = receipt.command;
  return {
    receipt,
    bounded: true,
    metadata: {
      operationReference: c.operationReference,
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      productReference: c.productReference,
      versionReference: c.versionReference,
      actorReference: c.actorReference,
      expectedProductAggregateVersion: c.expectedProductAggregateVersion,
      acknowledgementSequence,
      reportOperationReference: c.reportOperationReference,
      reportDigest: c.reportDigest,
      warningBindingDigest: c.warningBindingDigest,
      originalIntentDigest: receipt.originalIntentDigest,
      receiptDigest: receipt.digest,
      occurredAt: c.occurredAt,
      recordedAt: receipt.recordedAt,
      eventId: catalogProductPublicationWarningAcknowledgementEventId(c),
      auditId: id(80),
      dataClassification: "ConfigurationMetadata",
    },
  };
}
function port(values: readonly unknown[], rowCount = 1) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, parameters: readonly unknown[]) {
      calls.push({ sql, values: parameters });
      return { rows: values as readonly Row[], rowCount };
    },
  };
  return { tx, calls };
}
const unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("recovers the immutable original even after current sources have advanced, without a clock or source read", async () => {
  const f = fixture(),
    p = port([row(f.receipt)]);
  expect(await recover(p.tx, f.command)).toEqual(f.receipt);
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]?.values).toEqual([id(1), id(2), id(30)]);
  expect(p.calls[0]?.sql).not.toContain("rms_catalog.product ");
});
it("returns null only for an actual empty bounded query result", async () => {
  const f = fixture();
  expect(await recover(port([]).tx, f.command)).toBeNull();
  await expect(recover(port([row(), row()]).tx, f.command)).rejects.toEqual(unavailable);
});
it("rejects a same-operation altered reason as an idempotency conflict", async () => {
  const f = fixture();
  await expect(
    recover(port([row(f.receipt)]).tx, { ...f.command, reasonCode: "OTHER_REASON" }),
  ).rejects.toEqual(expect.objectContaining({ code: "CATALOG_IDEMPOTENCY_CONFLICT" }));
});
it.each(["bounded", "digest", "owner", "sequence", "event"] as const)(
  "rejects corrupt %s metadata without accepting a receipt",
  async (kind) => {
    const f = fixture(),
      r = row(f.receipt);
    if (kind === "bounded") r.bounded = false;
    if (kind === "digest") r.metadata.receiptDigest = hash("other");
    if (kind === "owner") r.metadata.tenantReference = id(90);
    if (kind === "sequence") r.metadata.acknowledgementSequence = 0;
    if (kind === "event") r.metadata.eventId = id(90);
    await expect(recover(port([r]).tx, f.command)).rejects.toEqual(unavailable);
  },
);
it("never invokes SQL row or metadata accessors", async () => {
  const f = fixture(),
    getter = vi.fn(),
    r = row(f.receipt);
  Object.defineProperty(r, "receipt", { enumerable: true, get: getter });
  await expect(recover(port([r]).tx, f.command)).rejects.toEqual(unavailable);
  expect(getter).not.toHaveBeenCalled();
  const q = row(f.receipt);
  Object.defineProperty(q.metadata, "auditId", { enumerable: true, get: getter });
  await expect(recover(port([q]).tx, f.command)).rejects.toEqual(unavailable);
  expect(getter).not.toHaveBeenCalled();
});
it("reads latest by actual Actor sequence without filtering by an older warning digest", async () => {
  const f = fixture(),
    p = port([row(f.receipt, 7)]),
    c = f.command;
  const input = {
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    productReference: c.productReference,
    versionReference: c.versionReference,
    actorReference: c.actorReference,
  };
  expect(await latest(p.tx, input)).toEqual(f.receipt);
  expect(p.calls[0]?.sql).toContain("ORDER BY acknowledgement_sequence DESC LIMIT 1");
  expect(p.calls[0]?.sql.split("WHERE")[1]).not.toContain("warning_binding_digest");
  expect(p.calls[0]?.values).toEqual([id(1), id(2), id(5), id(6), id(3)]);
  const corrupt = row(f.receipt, 8);
  corrupt.metadata.receiptDigest = hash("corrupt");
  const bad = port([corrupt]);
  await expect(latest(bad.tx, input)).rejects.toEqual(unavailable);
  expect(bad.calls).toHaveLength(1);
  await expect(
    latest(port([row(f.receipt)]).tx, { ...input, actorReference: id(99) }),
  ).rejects.toEqual(unavailable);
});
it("appends exact receipt bytes and next sequence without Product root mutation", async () => {
  const f = fixture(),
    p = port([]),
    eventId = catalogProductPublicationWarningAcknowledgementEventId(f.command);
  await append(p.tx, { receipt: f.receipt, eventId, auditId: id(80) });
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]?.sql).toContain("COALESCE(MAX(acknowledgement_sequence),0)+1");
  expect(p.calls[0]?.sql).not.toContain("UPDATE rms_catalog.product");
  expect(p.calls[0]?.values).toEqual([
    id(30),
    id(1),
    id(2),
    id(5),
    id(6),
    id(3),
    7,
    id(4),
    f.command.reportDigest,
    f.command.warningBindingDigest,
    hash(f.command),
    f.receipt.digest,
    humanAt,
    f.receipt.recordedAt,
    canonicalizeRfc8785(f.receipt),
    eventId,
    id(80),
  ]);
});
it("rejects failed append count and event transplant", async () => {
  const f = fixture(),
    eventId = catalogProductPublicationWarningAcknowledgementEventId(f.command);
  await expect(
    append(port([], 0).tx, { receipt: f.receipt, eventId, auditId: id(80) }),
  ).rejects.toEqual(unavailable);
  const p = port([]);
  await expect(
    append(p.tx, { receipt: f.receipt, eventId: id(99), auditId: id(80) }),
  ).rejects.toEqual(unavailable);
  expect(p.calls).toHaveLength(0);
});
it("detects SQL query replacement across an await", async () => {
  const f = fixture(),
    p = port([]);
  p.tx.query = async <Row>() => {
    p.tx.query = async <Other>() => ({ rows: [] as readonly Other[], rowCount: 0 });
    return { rows: [row(f.receipt)] as unknown as readonly Row[], rowCount: 1 };
  };
  await expect(recover(p.tx, f.command)).rejects.toEqual(unavailable);
});
