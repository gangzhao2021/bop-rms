import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parseReleaseSequence,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingDigest,
  parsePublishingCode,
  parsePublishingInstant,
} from "@bop/publishing";
import {
  createDigitalReceiptTemplateDraftContent,
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateSubmission,
  materializeDigitalReceiptTemplateContent,
} from "@rms/printing-device";
import { createMerchantReceiptTemplatePublished } from "./merchant-receipt-template-published.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
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
function fixture(mode: "Immediate" | "Scheduled" | "Expired" = "Immediate") {
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
      activation:
        mode === "Scheduled"
          ? { mode: "Scheduled", effectiveFrom: "2026-10-05T15:00:00.000Z" }
          : { mode: "Immediate" },
      effectiveUntil: mode === "Expired" ? "2026-10-05T13:30:00.000Z" : null,
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
  const publishedAt = "2026-10-05T13:00:30.000Z";
  const approval = createPublishingApprovalEvidence({
    evidenceReference: parsePublishingReference(id(40)),
    reviewLifecycleId: parsePublishingReference(id(21)),
    reviewVersion: parsePublishingVersion(2),
    snapshotReference: parsePublishingReference(id(7)),
    snapshotDigest: parsePublishingDigest(draft.contentDigest),
    scope: pubScope,
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(id(41)),
    approvedAt: parsePublishingInstant("2026-10-05T13:00:10.000Z"),
    validUntil: parsePublishingInstant(expiry),
  });
  const approvedHead = createPublishingLifecycleRecord({
    ...mutation.next,
    state: "Approved",
    version: parsePublishingVersion(3),
    approvalEvidenceReference: approval.evidenceReference,
    changedAt: approval.approvedAt,
  });
  const release = createPublishingReleaseRecord({
    releaseId: parsePublishingReference(id(42)),
    familyReference: parsePublishingReference(id(10)),
    configurationType: parsePublishingCode("RECEIPT_TEMPLATE"),
    purposeCode: parsePublishingCode("RECEIPT_ISSUANCE"),
    scope: pubScope,
    snapshotReference: parsePublishingReference(id(7)),
    snapshotDigest: parsePublishingDigest(draft.contentDigest),
    sequence: parseReleaseSequence(1),
    sourceLifecycleId: parsePublishingReference(id(21)),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: parsePublishingInstant(publishedAt),
  });
  const publishedMutation = parseRecordedPublishingMutation({
    operation: "Publish",
    expectedVersion: 3,
    idempotencyKey: id(43),
    current: approvedHead,
    next: createPublishingLifecycleRecord({
      ...approvedHead,
      state: "Published",
      version: parsePublishingVersion(4),
      changedAt: parsePublishingInstant(publishedAt),
    }),
    release,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: mutation.validationEvidence,
    approvalEvidence: approval,
    audit: validateAuditRecord({
      ...mutation.audit,
      auditId: id(44),
      actor: { type: "User", reference: id(45) },
      actionCode: "PUBLISHING_RELEASE_PUBLISHED",
      correlationId: id(43),
      occurredAt: publishedAt,
    }),
  });
  const publishedVersion = materializeDigitalReceiptTemplateContent({
    content,
    publicationReference: id(42),
    publishedAt,
  });
  const publishedRow = {
    version_id: id(7),
    template_id: id(6),
    version_number: "1",
    version_code: content.versionCode,
    publication_id: id(42),
    published_at: publishedAt,
    version_json: publishedVersion,
  };
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
    draftMissing: boolean;
    allowed: boolean;
    lateDenied: boolean;
    step: number;
    now: string;
    lease: string;
    denied: boolean;
    absent: boolean;
    head: typeof mutation | null;
    row: typeof submissionRow;
    broken: boolean;
    currentDraftRow: Record<string, unknown> | null;
    publishedRow: Record<string, unknown>;
    publishedMissing: boolean;
    finalChange: (() => void) | null;
  } = {
    now: at,
    draftMissing: false,
    allowed: true,
    lateDenied: false,
    step: 0,
    lease: until,
    denied: false,
    absent: false,
    head: publishedMutation,
    row: submissionRow,
    broken: false,
    currentDraftRow: null,
    publishedRow,
    publishedMissing: false,
    finalChange: null,
  };
  let publishedReads = 0;
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
      return {
        rows: state.draftMissing
          ? []
          : [values.length === 4 && state.currentDraftRow ? state.currentDraftRow : actualDraftRow],
      };
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM rms_device.digital_receipt_template_version")
    ) {
      if (++publishedReads === 2) state.finalChange?.();
      return { rows: state.publishedMissing ? [] : [state.publishedRow] };
    }
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
  const selected = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3), locale: "en-CA" },
    actorReference: id(90),
    sessionReference: id(91),
    allowed: vi.fn(async () => state.allowed),
    authorizationValidUntil: () => state.lease,
  };
  mocks.scope.mockImplementation(async (actual, cookie, action) => {
    expect(actual.query).toBeTypeOf("function");
    expect(cookie).toBe("synthetic-session");
    expect(action).toBe("organization.manage");
    return selected;
  });
  const run = async <T>(work: (actual: typeof tx) => Promise<T>): Promise<T> => {
    const result = await work(tx);
    if (state.lateDenied) state.allowed = false;
    return result;
  };
  const options = {
    persistence: {
      now: () => {
        const observed = state.now;
        state.now = new Date(Date.parse(observed) + state.step).toISOString();
        return observed;
      },
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => undefined,
      validateAssociation: async () => true,
    },
    authentication: {
      authorize: vi.fn(async () => {
        throw new Error("Read uses genuine encrypted Session scope source");
      }),
    },
  };
  // Normal scope/SQL transport fixture only; all Draft/Submission/Publishing factories are actual owners.
  const service = createMerchantReceiptTemplatePublished(
    options as unknown as Parameters<typeof createMerchantReceiptTemplatePublished>[0],
  );
  const read = () =>
    service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      expectedStoreReference: id(3),
      expectedScope: scope,
      locale: "en-CA",
    });
  return {
    service,
    read,
    state,
    selected,
    query,
    options,
    submission,
    mutation,
    draft,
    actualDraftRow,
    publishedVersion,
    publishedMutation,
  };
}
it("reads the actual current release and V2 authored content with current Org read authority", async () => {
  const f = fixture(),
    r = await f.read();
  expect(r.currentVersion).toEqual(f.publishedVersion);
  expect(r.actorReference).toBe(scope.actorReference);
  expect(r.professionalReviewStatus).toBe("NotEvaluated");
  expect(r.legalConclusion).toBe("NotEvaluated");
  expect(r.validUntil).toBe(until);
  expect(f.submission.submittedByReference).not.toBe(r.actorReference);
  // Approval/validation were valid at actual publication, and are now expired.
  expect(f.publishedMutation.approvalEvidence?.validUntil).toBe(expiry);
  expect(expiry < r.observedAt).toBe(true);
  expect(
    f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT") || sql.includes("SAVEPOINT")),
  ).toBe(false);
  expect(mocks.scope.mock.calls.every((c) => c[2] === "organization.manage")).toBe(true);
  expect(f.options.authentication.authorize).not.toHaveBeenCalled();
});
it.each(["Scheduled", "Expired"] as const)(
  "reports a qualified but %s current selection as Conflict",
  async (mode) => {
    const f = fixture(mode);
    await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
  },
);
it("does not turn a different actual current release into a qualified old version", async () => {
  const f = fixture();
  f.state.head = parseRecordedPublishingMutation({
    ...f.publishedMutation,
    release: { ...f.publishedMutation.release, releaseId: id(95) },
  });
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses legacy publication without an immutable authored submission", async () => {
  const f = fixture();
  f.state.absent = true;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses a malformed current owner packet instead of guessing absence", async () => {
  const f = fixture();
  f.state.broken = true;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses foreign scope before any template reads", async () => {
  const f = fixture();
  await expect(
    f.service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      locale: "en-CA",
      expectedScope: { ...scope, actorReference: id(91) },
    }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.query).not.toHaveBeenCalled();
});
it("binds explicit locale to actual Store locale", async () => {
  const f = fixture();
  await expect(
    f.service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      locale: "fr-CA",
      expectedScope: scope,
    }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects missing full expected scope and unknown authority keys", async () => {
  const f = fixture();
  await expect(
    f.service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      locale: "en-CA",
      expectedScope: undefined,
    }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  const input = {
    sessionCookie: "synthetic-session",
    templateReference: id(6),
    locale: "en-CA",
    expectedScope: scope,
    authority: true,
  };
  await expect(f.service.read(input)).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
});
it("refuses current Org withdrawal at the final actual source reread", async () => {
  const f = fixture();
  f.state.finalChange = () => {
    f.state.allowed = false;
  };
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
});
it("refuses late same-transaction authored snapshot substitution", async () => {
  const f = fixture();
  f.state.finalChange = () => {
    f.state.row = { ...f.state.row, record_digest: hash("wrong") };
  };
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses a changed actual release at the final read", async () => {
  const f = fixture();
  f.state.finalChange = () => {
    f.state.head = parseRecordedPublishingMutation({
      ...f.publishedMutation,
      release: { ...f.publishedMutation.release, releaseId: id(95) },
    });
  };
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("returns the shortest actual held Org lease", async () => {
  const f = fixture();
  f.state.lease = "2026-10-05T14:00:03.000Z";
  expect((await f.read()).validUntil).toBe(f.state.lease);
});
it("refuses expired permission and advancing clocks reaching the original deadline", async () => {
  const f = fixture();
  f.state.lease = at;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const advancing = fixture();
  advancing.state.step = 200;
  await expect(advancing.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("accepts a real advancing clock within the original five-second window", async () => {
  const f = fixture();
  f.state.step = 1;
  const r = await f.read();
  expect(r.observedAt > at).toBe(true);
  expect(r.validUntil).toBe(until);
});
it("refuses current scope port drift and excludes arbitrary locale substitution", async () => {
  const f = fixture();
  f.selected.allowed.mockImplementation(async () => {
    f.selected.authorizationValidUntil = () => until;
    return true;
  });
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses a captured clock replacement before opening a transaction", async () => {
  const f = fixture();
  f.options.persistence.now = () => at;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.query).not.toHaveBeenCalled();
});
