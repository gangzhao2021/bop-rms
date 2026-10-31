import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPublishingScope,
  parseRecordedPublishingMutation,
  type PublishingTransaction,
} from "@bop/publishing";
import { DigitalReceiptTemplateError } from "@rms/printing-device";
import {
  createMerchantReceiptTemplateReviewSource,
  type ReceiptTemplateReviewRequest,
} from "./merchant-receipt-template-review-source.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  businessUntil = "2026-10-05T10:01:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function recorded() {
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: id(2),
    storeReference: id(3),
  });
  const current = {
    lifecycleId: id(5),
    familyReference: id(6),
    configurationType: "RECEIPT_TEMPLATE",
    purposeCode: "RECEIPT_ISSUANCE",
    snapshotReference: id(7),
    snapshotDigest: digest,
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  return parseRecordedPublishingMutation({
    operation: "SubmitReview",
    expectedVersion: 1,
    idempotencyKey: id(8),
    current,
    next: { ...current, version: 2, state: "InReview", validationEvidenceReference: id(9) },
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: {
      evidenceReference: id(9),
      snapshotReference: id(7),
      snapshotDigest: digest,
      scope,
      result: "Pass",
      checkCodes: ["RECEIPT_CONTENT_VALID"],
      checkedAt: at,
      validUntil: businessUntil,
    },
    approvalEvidence: null,
    audit: {
      auditId: id(10),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(4) },
      actionCode: "PUBLISHING_REVIEW_SUBMITTED",
      targetType: "PublishingLifecycle",
      targetId: id(5),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(8),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    },
  });
}
/** Controlled SQL transport only; actual public Publishing normalization, digest and transition readers execute. */
function fixture() {
  let now = at,
    authorityUntil = until,
    denied = false,
    missing = false,
    badHash = false;
  let packet: unknown = recorded();
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.startsWith("SELECT set_config")) {
      expect(values).toEqual([id(1), id(2), id(3)]);
      return { rows: [] };
    }
    if (sql === "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE")
      return { rows: [] };
    if (sql.includes("ORDER BY lifecycle_version DESC LIMIT 1")) {
      expect(values).toEqual([id(1), id(2), id(3), id(5)]);
      const original = parseRecordedPublishingMutation(packet);
      return {
        rows: missing
          ? []
          : [
              {
                mutation_json: original,
                intent_hash: badHash
                  ? digest
                  : "sha256:" +
                    sha256Hex(
                      canonicalizeRfc8785({
                        ...original,
                        audit: { ...original.audit, auditId: null },
                      }),
                    ),
              },
            ],
      };
    }
    throw new Error("unexpected controlled query");
  });
  const tx: PublishingTransaction = { query },
    scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
    };
  const hold = vi.fn(async (actual: PublishingTransaction, input: unknown) => {
    expect(actual).toBe(tx);
    expect(input).toEqual(
      expect.objectContaining({
        ...scope,
        permission: "publishing.review.submit",
        purposeCode: "RECEIPT_TEMPLATE_SUBMISSION",
      }),
    );
    if (denied) throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    return { validUntil: authorityUntil };
  });
  const options: Parameters<typeof createMerchantReceiptTemplateReviewSource>[0] = {
    scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: at,
    originalValidUntil: until,
    holdCurrentAuthority: hold,
  };
  const request: ReceiptTemplateReviewRequest = {
    familyReference: id(6),
    reviewLifecycleReference: id(5),
    operationReference: id(8),
    snapshotReference: id(7),
    snapshotDigest: digest,
    observedAt: at,
    validUntil: until,
  };
  return {
    tx,
    options,
    request,
    query,
    hold,
    read: createMerchantReceiptTemplateReviewSource(options),
    setNow: (v: string) => {
      now = v;
    },
    setLease: (v: string) => {
      authorityUntil = v;
    },
    deny: () => {
      denied = true;
    },
    absent: () => {
      missing = true;
    },
    corrupt: () => {
      badHash = true;
    },
    packet: (v: unknown) => {
      packet = v;
    },
  };
}
it("reads real canonical SubmitReview through the public owner and two current authority acquisitions", async () => {
  const f = fixture(),
    result = await f.read(f.tx, f.request);
  expect(result).toEqual(recorded());
  expect(result).not.toBe(recorded());
  expect(result?.validationEvidence?.validUntil).toBe(businessUntil);
  expect(f.hold).toHaveBeenCalledTimes(2);
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringContaining("SELECT set_config"),
    "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE",
    expect.stringContaining("ORDER BY lifecycle_version DESC LIMIT 1"),
  ]);
});
it("returns null only for an actual current owning absence with both authority checks", async () => {
  const f = fixture();
  f.absent();
  expect(await f.read(f.tx, f.request)).toBeNull();
  expect(f.hold).toHaveBeenCalledTimes(2);
});
it.each(["familyReference", "operationReference", "snapshotReference"] as const)(
  "refuses wrong exact %s",
  async (key) => {
    const f = fixture();
    await expect(f.read(f.tx, { ...f.request, [key]: id(30) })).rejects.toThrow(
      "RECEIPT_TEMPLATE_UNAVAILABLE",
    );
  },
);
it("refuses snapshot digest mismatch and corrupt original canonical hash", async () => {
  const f = fixture();
  await expect(
    f.read(f.tx, { ...f.request, snapshotDigest: "sha256:" + "b".repeat(64) }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  f.corrupt();
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses a current Approved head rather than reading a historical Submit", async () => {
  const f = fixture(),
    m = recorded();
  f.packet({
    ...m,
    operation: "Approve",
    expectedVersion: 2,
    current: m.next,
    next: { ...m.next, state: "Approved", version: 3, approvalEvidenceReference: id(20) },
    validationEvidence: null,
    approvalEvidence: {
      evidenceReference: id(20),
      reviewLifecycleId: id(5),
      reviewVersion: 2,
      snapshotReference: id(7),
      snapshotDigest: digest,
      scope: m.next.scope,
      decision: "Accepted",
      approvedActorReference: id(21),
      approvedAt: at,
      validUntil: businessUntil,
    },
    audit: {
      ...m.audit,
      actionCode: "PUBLISHING_REVIEW_APPROVED",
      actor: { type: "User", reference: id(21) },
    },
  });
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses another stored submitter", async () => {
  const f = fixture(),
    m = recorded();
  f.packet({ ...m, audit: { ...m.audit, actor: { type: "User", reference: id(30) } } });
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("preserves genuine current permission denial before SQL", async () => {
  const f = fixture();
  f.deny();
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.query).not.toHaveBeenCalled();
});
it("tightens to actual authority lease and rejects elapsed or backward clock", async () => {
  const f = fixture();
  f.setLease("2026-10-05T10:00:01.000Z");
  await f.read(f.tx, f.request);
  f.setNow("2026-10-05T10:00:01.000Z");
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const g = fixture();
  g.setNow("2026-10-05T09:59:59.999Z");
  await expect(g.read(g.tx, g.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("rejects expired business validation without deriving business TTL from the request lease", async () => {
  const f = fixture(),
    m = recorded();
  f.packet({
    ...m,
    validationEvidence: { ...m.validationEvidence, validUntil: "2026-10-05T10:00:00.001Z" },
  });
  f.setNow("2026-10-05T10:00:00.001Z");
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("rejects scope and captured source port replacement", async () => {
  const f = fixture();
  Object.defineProperty(f.options.scope, "actorReference", { value: id(30), enumerable: true });
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const g = fixture();
  g.tx.query = async () => ({ rows: [] });
  await expect(g.read(g.tx, g.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("rejects authority callback replacement and foreign transactions", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "holdCurrentAuthority", {
    value: async () => ({ validUntil: until }),
    enumerable: true,
  });
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const g = fixture();
  await expect(g.read({ query: g.query }, g.request)).rejects.toThrow(
    "RECEIPT_TEMPLATE_UNAVAILABLE",
  );
});
it("rejects accessors and caller source JSON without invoking getters", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(6));
  await expect(
    f.read(
      f.tx,
      Object.defineProperty({ ...f.request }, "familyReference", { enumerable: true, get: getter }),
    ),
  ).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(getter).not.toHaveBeenCalled();
  const injected = { ...f.request, source: recorded() };
  await expect(f.read(f.tx, injected)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("rejects overlapping acquisition and checks fresh permission after the actual owning read", async () => {
  const f = fixture();
  f.hold.mockImplementationOnce(async () => {
    await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    return { validUntil: until };
  });
  f.hold.mockImplementationOnce(async () => {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  });
  await expect(f.read(f.tx, f.request)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.query).toHaveBeenCalledTimes(3);
});
