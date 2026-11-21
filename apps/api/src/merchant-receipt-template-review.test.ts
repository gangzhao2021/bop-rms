import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
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
} from "@rms/printing-device";
import { BrowserSessionError } from "@bop/identity";
import { createMerchantReceiptTemplateReview } from "./merchant-receipt-template-review.js";
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
    clockStepMs: number;
    currentDraftRow: Record<string, unknown> | null;
  } = {
    now: at,
    draftMissing: false,
    allowed: true,
    lateDenied: false,
    step: 0,
    lease: until,
    denied: false,
    absent: false,
    head: mutation,
    row: submissionRow,
    broken: false,
    clockStepMs: 0,
    currentDraftRow: null,
  };
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
    store: { storeReference: id(3) },
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
  const service = createMerchantReceiptTemplateReview(
    options as unknown as Parameters<typeof createMerchantReceiptTemplateReview>[0],
  );
  const read = () =>
    service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      expectedStoreReference: id(3),
      expectedScope: scope,
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
  };
}
it("reads actual current Draft and historical submission with current recorded head using Org permission only", async () => {
  const f = fixture(),
    result = await f.read();
  expect(result.currentDraft).toEqual({
    versionReference: id(7),
    revision: 1,
    contentDigest: f.submission.contentDigest,
  });
  expect(result.submission).toEqual(f.submission);
  expect(result.lifecycle).toMatchObject({
    lifecycleReference: id(21),
    version: 2,
    state: "InReview",
    latestMutationOperationReference: id(20),
  });
  expect(result.actorReference).toBe(id(90));
  expect(result.submission?.submittedByReference).toBe(id(4));
  expect(result.submission?.validationValidUntil).toBe(expiry);
  expect(result.sourceQualification).toBe("NotEvaluated");
  expect(mocks.scope.mock.calls.every((c) => c[2] === "organization.manage")).toBe(true);
  expect(f.query.mock.calls.some((c) => c[0].startsWith("INSERT"))).toBe(false);
  expect(f.options.authentication.authorize).not.toHaveBeenCalled();
});
it("reports actual unsubmitted Draft without inventing Publishing lifecycle", async () => {
  const f = fixture();
  f.state.absent = true;
  const r = await f.read();
  expect(r.submission).toBeNull();
  expect(r.lifecycle).toBeNull();
  expect(f.query.mock.calls.some((c) => c[0].includes("bop_publishing"))).toBe(false);
});
it("refuses nonexistent selected Draft instead of fabricating an empty tuple", async () => {
  const f = fixture();
  f.state.draftMissing = true;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
});
it("requires exact actual selected Store and full current-reader scope before owning reads", async () => {
  const f = fixture();
  await expect(
    f.service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      expectedStoreReference: id(100),
    }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.query).not.toHaveBeenCalled();
  const g = fixture();
  await expect(
    g.service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      expectedScope: { ...scope, actorReference: id(4) },
    }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
});
it("denies current Org and malformed/expired encrypted Session", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  const g = fixture();
  mocks.scope.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(g.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
});
it("normalizes invalid selection inputs before Scope/SQL", async () => {
  const f = fixture();
  await expect(
    f.service.read({ sessionCookie: "synthetic-session", templateReference: null }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(f.query).not.toHaveBeenCalled();
});
it("preserves true shorter held lease and supports genuinely advancing per-call clock", async () => {
  const f = fixture();
  f.state.lease = "2026-10-05T14:00:02.000Z";
  f.state.step = 2;
  const r = await f.read();
  expect(r.validUntil).toBe(f.state.lease);
  expect(f.state.now < r.validUntil).toBe(true);
});
it("refuses original deadline expiry during genuine guard rechecks", async () => {
  const f = fixture();
  f.state.step = 1000;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses captured runtime clock replacement", async () => {
  const f = fixture();
  f.options.persistence.now = () => at;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.query).not.toHaveBeenCalled();
});
it("refuses tampered immutable submission instead of producing a qualified current view", async () => {
  const f = fixture();
  f.state.row = { ...f.state.row, record_digest: hash("tamper") };
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});

it("retains late Org withdrawal during owning final rechecks", async () => {
  const f = fixture();
  let calls = 0;
  f.selected.allowed.mockImplementation(async () => ++calls < 5);
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.query.mock.calls.some((c) => c[0].startsWith("INSERT"))).toBe(false);
});
it("refuses a missing actual recorded Publishing head", async () => {
  const f = fixture();
  f.state.head = null;
  await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});

it("joins an older immutable submitted version to a newer actual current Draft without retargeting original Review", async () => {
  const f = fixture(),
    snapshot = parseDigitalReceiptTemplateDraft({
      ...f.draft,
      revision: 2,
      previousVersionReference: id(7),
      authoredByReference: id(50),
      content: { ...f.draft.content, versionReference: id(51) },
      contentDigest: hash({ ...f.draft.content, versionReference: id(51) }),
      updatedAt: "2026-10-05T13:00:01.000Z",
    });
  f.state.currentDraftRow = {
    ...f.actualDraftRow,
    version_id: id(51),
    revision: "2",
    operation_id: id(52),
    actor_id: id(50),
    previous_version_id: id(7),
    content_digest: snapshot.contentDigest,
    snapshot_json: snapshot,
    snapshot_digest: hash(snapshot),
    updated_at: snapshot.updatedAt,
  };
  const r = await f.read();
  expect(r.currentDraft).toEqual({
    versionReference: id(51),
    revision: 2,
    contentDigest: snapshot.contentDigest,
  });
  expect(r.submission?.versionReference).toBe(id(7));
  expect(r.submission?.contentDigest).toBe(f.submission.contentDigest);
  expect(r.lifecycle?.latestMutationOperationReference).toBe(id(20));
});
it("rejects getter and caller authority injection at the closed read boundary", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(6)),
    input = { sessionCookie: "synthetic-session", templateReference: id(6) };
  Object.defineProperty(input, "templateReference", { get: getter, enumerable: true });
  await expect(f.service.read(input)).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(getter).not.toHaveBeenCalled();
  const g = fixture(),
    injected = {
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      permission: "publishing.review.submit",
    };
  await expect(g.service.read(injected)).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(g.query).not.toHaveBeenCalled();
});

it.each(["Store", "Actor", "Session", "Context"])(
  "refuses %s drift at the last genuine asynchronous Org recheck, even when it returns Allow",
  async (field) => {
    const baseline = fixture();
    await baseline.read();
    const finalAllowedCall = baseline.selected.allowed.mock.calls.length;
    const f = fixture();
    let calls = 0;
    f.selected.allowed.mockImplementation(async () => {
      await Promise.resolve();
      if (++calls === finalAllowedCall) {
        if (field === "Store") f.selected.store = { storeReference: id(92) };
        if (field === "Actor") f.selected.actorReference = id(92);
        if (field === "Session") f.selected.sessionReference = id(92);
        if (field === "Context") f.selected.context = { brand: { brandReference: id(92) } };
      }
      return f.state.allowed;
    });
    await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(calls).toBe(finalAllowedCall);
    expect(f.query.mock.calls.some((call) => call[0].startsWith("INSERT"))).toBe(false);
  },
);

it.each(["Store", "Actor"])(
  "refuses %s mutation inside the last actual scope lease getter",
  async (field) => {
    const baseline = fixture();
    let total = 0;
    baseline.selected.authorizationValidUntil = () => {
      total += 1;
      return baseline.state.lease;
    };
    await baseline.read();
    const f = fixture();
    let calls = 0;
    f.selected.authorizationValidUntil = () => {
      if (++calls === total) {
        if (field === "Store") f.selected.store.storeReference = id(93);
        else f.selected.actorReference = id(93);
      }
      return f.state.lease;
    };
    await expect(f.read()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(calls).toBe(total);
    expect(f.query.mock.calls.some((call) => call[0].startsWith("INSERT"))).toBe(false);
  },
);

it("checks captured scope again after the final post-COMMIT owner assertion clock port", async () => {
  const baseline = fixture();
  const originalNow = baseline.options.persistence.now;
  let total = 0;
  baseline.options.persistence.now = () => {
    total += 1;
    return originalNow();
  };
  // Capture ports at actual construction, rather than replacing a running source port.
  const first = createMerchantReceiptTemplateReview(
    baseline.options as unknown as Parameters<typeof createMerchantReceiptTemplateReview>[0],
  );
  await first.read({
    sessionCookie: "synthetic-session",
    templateReference: id(6),
    expectedScope: scope,
  });
  const f = fixture();
  const actualNow = f.options.persistence.now;
  let calls = 0;
  f.options.persistence.now = () => {
    if (++calls === total) f.selected.actorReference = id(94);
    return actualNow();
  };
  const service = createMerchantReceiptTemplateReview(
    f.options as unknown as Parameters<typeof createMerchantReceiptTemplateReview>[0],
  );
  await expect(
    service.read({
      sessionCookie: "synthetic-session",
      templateReference: id(6),
      expectedScope: scope,
    }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(calls).toBe(total);
});
