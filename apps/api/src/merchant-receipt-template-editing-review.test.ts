import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingDigest,
  parsePublishingCode,
  parsePublishingInstant,
  parseReleaseSequence,
} from "@bop/publishing";
import {
  createDigitalReceiptTemplateDraftContent,
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateSubmission,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import {
  createMerchantReceiptTemplateEditingReview,
  type MerchantReceiptTemplateEditingReviewOptions,
} from "./merchant-receipt-template-editing-review.js";
const id = (n: number) => "01902421-1700-7000-8000-" + n.toString(16).padStart(12, "0"),
  historical = "2026-10-05T13:00:00.000Z",
  expiry = "2026-10-05T13:01:00.000Z",
  at = "2026-10-05T14:00:00.000Z",
  until = "2026-10-05T14:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(90),
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function fixture() {
  const content = createDigitalReceiptTemplateDraftContent({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(6),
    versionReference: id(7),
    versionNumber: 1,
    fields: {
      locale: "en-CA",
      layoutDefinitionReference: id(8),
      complianceRuleReference: id(9),
      activation: { mode: "Immediate" },
      effectiveUntil: null,
    },
  });
  const draft = parseDigitalReceiptTemplateDraft({
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(10),
    revision: 1,
    authoredByReference: id(11),
    previousVersionReference: null,
    content,
    contentDigest: hash(content),
    createdAt: historical,
    updatedAt: historical,
    dataClassification: "Internal",
  });
  const submission = parseDigitalReceiptTemplateSubmission({
    profile: "DigitalReceiptTemplateSubmissionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(6),
    familyReference: id(10),
    versionReference: id(7),
    draftRevision: 1,
    contentDigest: draft.contentDigest,
    authoredByReference: id(11),
    submittedByReference: id(4),
    operationReference: id(20),
    reviewLifecycleReference: id(21),
    reviewVersion: 2,
    validationEvidenceReference: id(22),
    checkedAt: historical,
    validationValidUntil: expiry,
    submittedAt: historical,
    auditReference: id(23),
    dataClassification: "Internal",
  });
  const pubScope = createPublishingScope({
    kind: "Store",
    brandReference: id(2),
    storeReference: id(3),
  });
  const base = {
    lifecycleId: parsePublishingReference(id(21)),
    familyReference: parsePublishingReference(id(10)),
    configurationType: parsePublishingCode("RECEIPT_TEMPLATE"),
    purposeCode: parsePublishingCode("RECEIPT_ISSUANCE"),
    snapshotReference: parsePublishingReference(id(7)),
    snapshotDigest: parsePublishingDigest(draft.contentDigest),
    scope: pubScope,
    approvalEvidenceReference: null,
    createdAt: parsePublishingInstant(historical),
    changedAt: parsePublishingInstant(historical),
  };
  const mutation = parseRecordedPublishingMutation({
    operation: "SubmitReview",
    expectedVersion: 1,
    idempotencyKey: id(20),
    current: createPublishingLifecycleRecord({
      ...base,
      state: "Draft",
      version: parsePublishingVersion(1),
      validationEvidenceReference: null,
    }),
    next: createPublishingLifecycleRecord({
      ...base,
      state: "InReview",
      version: parsePublishingVersion(2),
      validationEvidenceReference: parsePublishingReference(id(22)),
    }),
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(22)),
      snapshotReference: parsePublishingReference(id(7)),
      snapshotDigest: parsePublishingDigest(draft.contentDigest),
      scope: pubScope,
      result: "Pass",
      checkedAt: parsePublishingInstant(historical),
      validUntil: parsePublishingInstant(expiry),
      checkCodes: [parsePublishingCode("CONTENT")],
    }),
    approvalEvidence: null,
    audit: validateAuditRecord({
      auditId: id(23),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(4) },
      actionCode: "PUBLISHING_REVIEW_SUBMITTED",
      targetType: "PublishingLifecycle",
      targetId: id(21),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(20),
      occurredAt: historical,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    }),
  });
  const submissionRow = {
    tenant_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    template_id: id(6),
    family_id: id(10),
    version_id: id(7),
    draft_revision: "1",
    content_digest: draft.contentDigest,
    authored_by_id: id(11),
    submitted_by_id: id(4),
    operation_id: id(20),
    review_lifecycle_id: id(21),
    review_version: "2",
    validation_evidence_id: id(22),
    checked_at: historical,
    validation_valid_until: expiry,
    submitted_at: historical,
    audit_reference: id(23),
    data_classification: "Internal",
    record_json: submission,
    record_digest: hash(submission),
  };
  const draftRow = {
    tenant_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    template_id: id(6),
    family_id: id(10),
    version_id: id(7),
    revision: "1",
    publication_version_number: "1",
    operation_id: id(30),
    actor_id: id(11),
    previous_version_id: null,
    content_digest: draft.contentDigest,
    snapshot_json: draft,
    snapshot_digest: hash(draft),
    created_at: historical,
    updated_at: historical,
  };
  // The source selects thirteen persisted draft facts; scope/author/content are rechecked inside its JSON envelope.
  const actualDraftRow = {
    template_id: draftRow.template_id,
    family_id: draftRow.family_id,
    version_id: draftRow.version_id,
    revision: draftRow.revision,
    publication_version_number: draftRow.publication_version_number,
    operation_id: draftRow.operation_id,
    actor_id: draftRow.actor_id,
    previous_version_id: draftRow.previous_version_id,
    content_digest: draftRow.content_digest,
    snapshot_json: draftRow.snapshot_json,
    snapshot_digest: draftRow.snapshot_digest,
    created_at: draftRow.created_at,
    updated_at: draftRow.updated_at,
  };
  const state: {
    now: string;
    lease: string;
    denied: boolean;
    absent: boolean;
    head: typeof mutation | null;
    row: typeof submissionRow;
    broken: boolean;
    clockStepMs: number;
  } = {
    now: at,
    lease: until,
    denied: false,
    absent: false,
    head: mutation,
    row: submissionRow,
    broken: false,
    clockStepMs: 0,
  };
  const guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM rms_device.digital_receipt_template_submission")
    )
      return { rows: state.absent ? [] : [state.row] };
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM rms_device.digital_receipt_template_draft_revision")
    )
      return { rows: [actualDraftRow] };
    if (sql.startsWith("SELECT mutation_json,intent_hash"))
      return {
        rows: state.head
          ? [
              {
                mutation_json: state.head,
                intent_hash: state.broken
                  ? hash("broken")
                  : publishingRecordedMutationDigest(state.head),
              },
            ]
          : [],
      };
    return { rows: [] };
  });
  const tx = { query };
  const options: MerchantReceiptTemplateEditingReviewOptions = {
    ...scope,
    transaction: tx,
    clock: {
      now: () => {
        const observed = state.now;
        state.now = new Date(Date.parse(observed) + state.clockStepMs).toISOString();
        return observed;
      },
    },
    originalObservedAt: at,
    originalValidUntil: until,
    references: {
      canonicalize: canonicalizeRfc8785,
      hashIntent: (value) => "sha256:" + sha256Hex(value),
    },
    registerBeforeCommit: (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
    holdCurrentOrgAuthority: vi.fn(async (actual, input) => {
      expect(actual).toBe(tx);
      expect(input).toMatchObject({ ...scope, templateReference: id(6), familyReference: id(10) });
      if (state.denied) throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      return { validUntil: state.lease };
    }),
  };
  const source = createMerchantReceiptTemplateEditingReview(options),
    request = {
      templateReference: id(6),
      familyReference: id(10),
      observedAt: at,
      validUntil: until,
    };
  const read = () => source.read(tx, request);
  const commit = async () => {
    for (const g of guards) await g.guard();
    for (const g of guards) g.final();
    return source.assertFinalized(tx);
  };
  return { source, options, tx, state, guards, read, commit, request, submission, mutation, query };
}
it("uses actual owning readers for historical submission/current Review and permits a different reader after evidence expiry", async () => {
  const f = fixture(),
    packet = await f.read();
  expect(packet.submission).toEqual(f.submission);
  expect(packet.mutation).toEqual(f.mutation);
  expect(packet.submission?.submittedByReference).not.toBe(scope.actorReference);
  expect(packet.submission?.validationValidUntil).toBe(expiry);
  const sql = f.query.mock.calls.map((call) => call[0]);
  expect(sql.findIndex((s) => s.includes("pg_advisory_xact_lock"))).toBeLessThan(
    sql.findIndex((s) => s.includes("LOCK TABLE bop_publishing")),
  );
  expect(await f.commit()).toBe(until);
  expect(sql.some((s) => s.startsWith("INSERT"))).toBe(false);
});
it("returns honest absent submission with no Publishing read", async () => {
  const f = fixture();
  f.state.absent = true;
  expect(await f.read()).toMatchObject({ submission: null, mutation: null });
  expect(f.query.mock.calls.some((c) => c[0].includes("bop_publishing"))).toBe(false);
  await f.commit();
});
it("reuses held original submission for exact Work repeats while freshly rereading the Publishing head", async () => {
  const f = fixture(),
    first = await f.read();
  f.state.now = "2026-10-05T14:00:01.000Z";
  expect(await f.source.read(f.tx, { ...f.request, observedAt: f.state.now })).toEqual(first);
  expect(f.guards).toHaveLength(2);
  await f.commit();
});
it("allows the already registered outer Draft check to repeat before child checks", async () => {
  const f = fixture();
  await f.read();
  await f.read();
  await f.commit();
});
it("rejects a changed Template/family repeat and poisons finalization", async () => {
  const f = fixture();
  await f.read();
  await expect(f.source.read(f.tx, { ...f.request, familyReference: id(100) })).rejects.toThrow(
    "RECEIPT_TEMPLATE_UNAVAILABLE",
  );
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it.each(["headMissing", "badHash", "differentFamily"])(
  "refuses genuine source mismatch %s",
  async (reason) => {
    const f = fixture();
    if (reason === "headMissing") f.state.head = null;
    if (reason === "badHash") f.state.broken = true;
    if (reason === "differentFamily") f.state.row = { ...f.state.row, family_id: id(100) };
    await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  },
);
it("requires actual current Org authority before source reads", async () => {
  const f = fixture();
  f.state.denied = true;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.query).not.toHaveBeenCalled();
});
it("retains late Org withdrawal and shorter lease through finalization", async () => {
  const f = fixture();
  await f.read();
  f.state.denied = true;
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
  const g = fixture();
  await g.read();
  g.state.lease = "2026-10-05T14:00:02.000Z";
  expect(await g.commit()).toBe(g.state.lease);
});
it("refuses natural expiry, swapped query, and premature post-COMMIT proof", async () => {
  const f = fixture();
  await f.read();
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
  const g = fixture();
  await g.read();
  g.state.now = until;
  await expect(g.commit()).rejects.toThrow();
  const h = fixture();
  await h.read();
  h.tx.query = vi.fn(async () => ({ rows: [] }));
  await expect(h.commit()).rejects.toThrow();
});
it("denies reads after its own async guard begins and prevents stale final proofs", async () => {
  const f = fixture();
  await f.read();
  const guard = f.guards[0];
  if (!guard) throw new Error("Missing real registered guard");
  await guard.guard();
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it("rejects malformed/getter read packets without invoking accessor", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(6));
  const input = { ...f.request };
  Object.defineProperty(input, "templateReference", { get: getter, enumerable: true });
  await expect(f.source.read(f.tx, input)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("lets the independent Submission guard detect same-transaction latest-row tampering", async () => {
  const f = fixture();
  await f.read();
  f.state.row = { ...f.state.row, record_digest: hash("tampered") };
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it("poisons a same-transaction current Publishing head change on an exact repeat", async () => {
  const f = fixture();
  await f.read();
  f.state.head = null;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it("does not let an originally absent submission change before the actual child guard", async () => {
  const f = fixture();
  f.state.absent = true;
  await f.read();
  f.state.absent = false;
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
});

it.each(["Approved", "Published", "Archived"] as const)(
  "reads recorded %s head without renewing expired historical evidence",
  async (state) => {
    const f = fixture(),
      base = f.mutation.next,
      approval = createPublishingApprovalEvidence({
        evidenceReference: parsePublishingReference(id(40)),
        reviewLifecycleId: parsePublishingReference(id(21)),
        reviewVersion: parsePublishingVersion(2),
        snapshotReference: parsePublishingReference(id(7)),
        snapshotDigest: base.snapshotDigest,
        scope: base.scope,
        decision: "Accepted",
        approvedActorReference: parsePublishingReference(id(41)),
        approvedAt: parsePublishingInstant("2026-10-05T13:00:10.000Z"),
        validUntil: parsePublishingInstant(expiry),
      });
    const approved = createPublishingLifecycleRecord({
      ...base,
      version: parsePublishingVersion(3),
      state: "Approved",
      approvalEvidenceReference: parsePublishingReference(id(40)),
      changedAt: parsePublishingInstant("2026-10-05T13:00:10.000Z"),
    });
    const published = createPublishingLifecycleRecord({
      ...approved,
      version: parsePublishingVersion(4),
      state: "Published",
      changedAt: parsePublishingInstant("2026-10-05T13:00:20.000Z"),
    });
    const next =
      state === "Approved"
        ? approved
        : state === "Published"
          ? published
          : createPublishingLifecycleRecord({
              ...published,
              version: parsePublishingVersion(5),
              state: "Archived",
              changedAt: parsePublishingInstant("2026-10-05T13:00:30.000Z"),
            });
    const current = state === "Approved" ? base : state === "Published" ? approved : published,
      operation = state === "Approved" ? "Approve" : state === "Published" ? "Publish" : "Archive";
    const release =
      state === "Published"
        ? createPublishingReleaseRecord({
            releaseId: parsePublishingReference(id(42)),
            familyReference: parsePublishingReference(id(10)),
            configurationType: parsePublishingCode("RECEIPT_TEMPLATE"),
            purposeCode: parsePublishingCode("RECEIPT_ISSUANCE"),
            snapshotReference: parsePublishingReference(id(7)),
            snapshotDigest: base.snapshotDigest,
            scope: base.scope,
            sequence: parseReleaseSequence(1),
            sourceLifecycleId: parsePublishingReference(id(21)),
            kind: "Publish",
            previousReleaseId: null,
            createdAt: next.changedAt,
          })
        : null;
    f.state.head = parseRecordedPublishingMutation({
      ...f.mutation,
      operation,
      expectedVersion: current.version,
      idempotencyKey: id(43),
      current,
      next,
      release,
      approvalEvidence: state === "Archived" ? null : approval,
      validationEvidence: state === "Archived" ? null : f.mutation.validationEvidence,
      audit: validateAuditRecord({
        ...f.mutation.audit,
        auditId: id(44),
        actor: { type: "User", reference: id(41) },
        actionCode:
          state === "Approved"
            ? "PUBLISHING_REVIEW_APPROVED"
            : state === "Published"
              ? "PUBLISHING_RELEASE_PUBLISHED"
              : "PUBLISHING_RELEASE_ARCHIVED",
        correlationId: id(43),
        occurredAt: next.changedAt,
      }),
    });
    const result = await f.read();
    expect(result.mutation?.next.state).toBe(state);
    expect(result.submission?.validationValidUntil).toBe(expiry);
    await f.commit();
  },
);

it.each([false, true])(
  "retains genuine progressing owner clocks across repeated reads and all guards (absent=%s)",
  async (absent) => {
    const f = fixture();
    f.state.absent = absent;
    f.state.clockStepMs = 2;
    const initial = await f.read();
    expect(f.state.now > at).toBe(true);
    const next = await f.source.read(f.tx, { ...f.request, observedAt: f.state.now });
    expect(next.submission).toEqual(initial.submission);
    expect(next.mutation).toEqual(initial.mutation);
    expect(f.guards).toHaveLength(2);
    expect(await f.commit()).toBe(until);
    expect(f.state.now < until).toBe(true);
  },
);
