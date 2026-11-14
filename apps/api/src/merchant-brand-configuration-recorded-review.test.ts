import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createBrandConfigurationRevision,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  tenantBrandConfigurationContentDigest,
  type BrandConfigurationRevision,
} from "@bop/tenant";
import {
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  readMerchantBrandConfigurationRecordedReview,
  parseMerchantBrandConfigurationCurrent,
} from "./merchant-brand-configuration-recorded-review.js";

const id = (n: number) => `01902606-2441-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  observed = "2026-10-06T10:02:00.000Z",
  lease = "2026-10-06T10:02:05.000Z",
  business = "2026-10-06T10:01:00.000Z";
/** Actual public Publishing reader/parsers over controlled SQL transport. All
 * identities, content and clocks are synthetic; this is not native DB proof. */
function fixture(state: "PendingApproval" | "Approved" | "Published" = "PendingApproval") {
  const scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(9) };
  const publishingScope = { kind: "Brand", brandReference: id(1), storeReference: null };
  const content = {
    configurationVersionReference: id(2),
    brandReference: id(1),
    configurationVersion: 1,
    lifecycle: "Draft",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(3),
    platformTemplateReference: id(4),
    overrideAllowedFieldCodes: [],
    hardRequirementFieldCodes: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesVersionReference: null,
    reasonCode: "INITIAL_CONFIGURATION",
    authoredByReference: id(5),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const digest = tenantBrandConfigurationContentDigest(content),
    draft = {
      lifecycleId: id(6),
      familyReference: id(1),
      configurationType: "BRAND_CONFIGURATION",
      purposeCode: "BRAND_CONFIGURATION",
      snapshotReference: id(2),
      snapshotDigest: digest,
      scope: publishingScope,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    };
  const validation = {
    evidenceReference: id(7),
    snapshotReference: id(2),
    snapshotDigest: digest,
    scope: publishingScope,
    result: "Pass",
    checkedAt: at,
    validUntil: business,
    checkCodes: ["CURRENT_REFERENCES"],
  };
  const audit = (actionCode: string, n: number, actor: string) => ({
    auditId: id(n),
    brandId: id(1),
    actor: { type: "User", reference: actor },
    actionCode,
    targetType: "PublishingLifecycle",
    targetId: id(6),
    reasonCode: actionCode,
    correlationId: id(n + 100),
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Confidential",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
  const reviewLife = {
    ...draft,
    state: "InReview",
    version: 2,
    validationEvidenceReference: id(7),
  };
  const submit = parseRecordedPublishingMutation({
    operation: "SubmitReview",
    expectedVersion: 1,
    idempotencyKey: id(10),
    current: draft,
    next: reviewLife,
    validationEvidence: validation,
    approvalEvidence: null,
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    audit: audit("PUBLISHING_REVIEW_SUBMITTED", 11, id(5)),
  });
  const approval = {
    evidenceReference: id(12),
    reviewLifecycleId: id(6),
    reviewVersion: 2,
    snapshotReference: id(2),
    snapshotDigest: digest,
    scope: publishingScope,
    decision: "Accepted",
    approvedActorReference: id(9),
    approvedAt: at,
    validUntil: business,
  };
  const approve = parseRecordedPublishingMutation({
    ...submit,
    operation: "Approve",
    expectedVersion: 2,
    idempotencyKey: id(13),
    current: reviewLife,
    next: { ...reviewLife, version: 3, state: "Approved", approvalEvidenceReference: id(12) },
    validationEvidence: null,
    approvalEvidence: approval,
    audit: audit("PUBLISHING_REVIEW_APPROVED", 14, id(9)),
  });
  const publish = parseRecordedPublishingMutation({
    ...approve,
    operation: "Publish",
    expectedVersion: 3,
    idempotencyKey: id(15),
    current: approve.next,
    next: { ...approve.next, version: 4, state: "Published" },
    validationEvidence: validation,
    audit: audit("PUBLISHING_RELEASE_PUBLISHED", 16, id(9)),
    release: {
      releaseId: id(17),
      familyReference: id(1),
      configurationType: "BRAND_CONFIGURATION",
      purposeCode: "BRAND_CONFIGURATION",
      snapshotReference: id(2),
      snapshotDigest: digest,
      scope: publishingScope,
      sourceLifecycleId: id(6),
      sequence: 1,
      previousReleaseId: null,
      kind: "Publish",
      createdAt: at,
    },
  });
  const revisions = [submit, approve, publish].map((mutation, index) =>
    createBrandConfigurationRevision(
      {
        profile: "TenantBrandConfigurationRevisionV1",
        ...scope,
        actorReference: index === 0 ? id(5) : id(9),
        revision: index + 2,
        brandVersion: 1,
        command: ["SubmitConfiguration", "ApproveConfiguration", "PublishConfiguration"][index],
        operationReference: mutation.idempotencyKey,
        configuration: {
          ...content,
          lifecycle: ["PendingApproval", "Approved", "Published"][index],
          approvedByReference: index === 0 ? null : id(9),
          approvalEvidenceReference: index === 0 ? null : id(12),
          publicationReference: index === 2 ? id(17) : null,
        },
        submittedByReference: id(5),
        publishing: {
          familyReference: id(1),
          lifecycleReference: id(6),
          lifecycleVersion: index + 2,
          mutationOperationReference: mutation.idempotencyKey,
          validationEvidenceReference: id(7),
          approvalEvidenceReference: index === 0 ? null : id(12),
          publicationReference: index === 2 ? id(17) : null,
        },
        auditReference: id(index + 30),
        createdAt: at,
        recordedAt: at,
        dataClassification: "ConfigurationMetadata",
      },
      { canonicalize: canonicalizeRfc8785, hashIntent: (v) => "sha256:" + sha256Hex(v) },
    ),
  );
  const index = ["PendingApproval", "Approved", "Published"].indexOf(state),
    target = revisions[index];
  if (!target) throw new Error("controlled missing revision");
  const db = {
    head: [submit, approve, publish][index] as CommitPublishingMutationInput,
    submit,
    allowed: true,
    clock: observed,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT mutation_json")) {
      const m = sql.includes("audit_id") ? db.submit : db.head;
      return {
        rows: [
          {
            mutation_json: m,
            intent_hash: publishingRecordedMutationDigest(m),
            audit_id: m.audit.auditId,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const current = parseBrandConfigurationCurrent({
    profile: "TenantBrandConfigurationCurrentV1",
    ...scope,
    current: target,
    observedAt: observed,
    validUntil: lease,
    currentPublication: "NotEvaluated",
  });
  const history = vi.fn(async () =>
    parseBrandConfigurationHistory({
      profile: "TenantBrandConfigurationHistoryV1",
      ...scope,
      beforeRevision: target.revision,
      entries: revisions.slice(0, index).reverse(),
      nextBeforeRevision: null,
      observedAt: observed,
      validUntil: lease,
      currentPublication: "NotEvaluated",
    }),
  );
  const options = {
    transaction: { query },
    scope,
    current,
    readHistory: history,
    assertCurrent: () => {
      if (!db.allowed || db.clock >= lease) throw new Error("controlled authority withdrawn");
    },
    now: () => db.clock,
  };
  return { options, db, current, history, query, revisions };
}
for (const state of ["PendingApproval", "Approved", "Published"] as const) {
  it(`reads expired original review for ${state} using actual public Core and bounded history`, async () => {
    const f = fixture(state),
      held = await readMerchantBrandConfigurationRecordedReview(f.options);
    expect(held.recordedReview).toMatchObject({
      recordedState: state,
      submittedByReference: id(5),
      submittedAt: at,
      reviewValidUntil: business,
    });
    expect(f.history).toHaveBeenCalledTimes(state === "PendingApproval" ? 0 : 1);
    await held.recheck();
    expect(f.history).toHaveBeenCalledTimes(state === "PendingApproval" ? 0 : 1);
    expect(
      f.query.mock.calls.filter(([sql]) => sql.startsWith("SELECT mutation_json")),
    ).toHaveLength(4);
    expect(
      parseMerchantBrandConfigurationCurrent(
        { ...f.current, recordedReview: held.recordedReview },
        f.options.scope,
        observed,
      ).recordedReview,
    ).toEqual(held.recordedReview);
  });
}
it("refuses a current lifecycle change, withdrawn authority and query replacement before COMMIT", async () => {
  const f = fixture(),
    held = await readMerchantBrandConfigurationRecordedReview(f.options);
  f.db.head = { ...f.db.head, idempotencyKey: id(88) as typeof f.db.head.idempotencyKey };
  await expect(held.recheck()).rejects.toThrow();
  const g = fixture(),
    authorized = await readMerchantBrandConfigurationRecordedReview(g.options);
  g.db.allowed = false;
  await expect(authorized.recheck()).rejects.toThrow();
  const h = fixture(),
    captured = await readMerchantBrandConfigurationRecordedReview(h.options);
  h.options.transaction.query = vi.fn(async () => ({ rows: [] }));
  await expect(captured.recheck()).rejects.toThrow();
  const expired = fixture(),
    timed = await readMerchantBrandConfigurationRecordedReview(expired.options);
  expired.db.clock = lease;
  await expect(timed.recheck()).rejects.toThrow();
});
it("refuses a different actual original Submit, validation digest and history scope", async () => {
  const f = fixture();
  f.db.submit = {
    ...f.db.submit,
    audit: { ...f.db.submit.audit, actor: { type: "User", reference: id(80) } },
  };
  await expect(readMerchantBrandConfigurationRecordedReview(f.options)).rejects.toThrow();
  const g = fixture();
  if (!g.db.submit.validationEvidence) throw new Error("controlled missing validation");
  g.db.submit = {
    ...g.db.submit,
    validationEvidence: {
      ...g.db.submit.validationEvidence,
      snapshotDigest: ("sha256:" +
        "a".repeat(64)) as typeof g.db.submit.validationEvidence.snapshotDigest,
    },
  };
  await expect(readMerchantBrandConfigurationRecordedReview(g.options)).rejects.toThrow();
  const h = fixture("Approved"),
    original = await h.history();
  h.history.mockResolvedValue({ ...original, actorReference: id(80) });
  await expect(readMerchantBrandConfigurationRecordedReview(h.options)).rejects.toThrow();
  const missing = fixture("Published"),
    page = await missing.history();
  missing.history.mockResolvedValue({ ...page, entries: page.entries.slice(0, 1) });
  await expect(readMerchantBrandConfigurationRecordedReview(missing.options)).rejects.toThrow();
});
it("binds the actual prior Approve governance to the Published revision and Core head", async () => {
  for (const change of ["IndependentApproval", "LifecycleVersion", "Family", "Mutation"] as const) {
    const f = fixture("Published"),
      page = await f.history(),
      prior = page.entries[0];
    if (!prior?.publishing) throw new Error("controlled missing approval");
    const revised = createBrandConfigurationRevision(
      {
        ...Object.fromEntries(
          Object.entries(prior).filter(
            ([key]) => key !== "contentDigest" && key !== "sourceDigest",
          ),
        ),
        actorReference: change === "IndependentApproval" ? id(80) : prior.actorReference,
        configuration: {
          ...prior.configuration,
          ...(change === "IndependentApproval"
            ? { approvedByReference: id(80), approvalEvidenceReference: id(81) }
            : {}),
        },
        publishing: {
          ...prior.publishing,
          ...(change === "IndependentApproval" ? { approvalEvidenceReference: id(81) } : {}),
          ...(change === "LifecycleVersion" ? { lifecycleVersion: 4 } : {}),
          ...(change === "Family" ? { familyReference: id(82) } : {}),
          ...(change === "Mutation" ? { mutationOperationReference: id(83) } : {}),
        },
      },
      { canonicalize: canonicalizeRfc8785, hashIntent: (v) => "sha256:" + sha256Hex(v) },
    );
    expect(revised.sourceDigest).not.toBe(prior.sourceDigest);
    f.history.mockResolvedValue(
      parseBrandConfigurationHistory({ ...page, entries: [revised, ...page.entries.slice(1)] }),
    );
    await expect(readMerchantBrandConfigurationRecordedReview(f.options)).rejects.toThrow();
  }
});
it("closed response pins scope, target and deadline while allowing expired recorded evidence", async () => {
  const f = fixture(),
    held = await readMerchantBrandConfigurationRecordedReview(f.options),
    response = { ...f.current, recordedReview: held.recordedReview };
  for (const changed of [
    { ...response, extra: true },
    { ...response, recordedReview: null },
    { ...response, actorReference: id(70) },
    { ...response, validUntil: "2026-10-06T10:03:00.000Z" },
    ...[
      { extra: true },
      { configurationSourceDigest: "sha256:" + "b".repeat(64) },
      { submittedByReference: id(70) },
      { reviewValidUntil: at },
      { submittedAt: observed },
      { lifecycleVersion: 8 },
    ].map((patch) => ({ ...response, recordedReview: { ...held.recordedReview, ...patch } })),
  ])
    expect(() =>
      parseMerchantBrandConfigurationCurrent(changed, f.options.scope, observed),
    ).toThrow();
  expect(() => parseMerchantBrandConfigurationCurrent(response, f.options.scope, lease)).toThrow();
});
it("returns explicit null only for no current or Draft, with no Publishing read", async () => {
  const f = fixture();
  const current = parseBrandConfigurationCurrent({ ...f.current, current: null });
  const held = await readMerchantBrandConfigurationRecordedReview({ ...f.options, current });
  expect(held.recordedReview).toBeNull();
  expect(f.query).not.toHaveBeenCalled();
  const source = f.revisions[0];
  if (!source) throw new Error("controlled missing revision");
  const draft: BrandConfigurationRevision = createBrandConfigurationRevision(
    {
      ...Object.fromEntries(
        Object.entries(source).filter(([key]) => key !== "contentDigest" && key !== "sourceDigest"),
      ),
      revision: 1,
      command: "SaveConfigurationDraft",
      configuration: { ...source.configuration, lifecycle: "Draft" },
      submittedByReference: null,
      publishing: null,
    },
    { canonicalize: canonicalizeRfc8785, hashIntent: (v) => "sha256:" + sha256Hex(v) },
  );
  const draftPacket = parseBrandConfigurationCurrent({ ...current, current: draft });
  expect(
    (await readMerchantBrandConfigurationRecordedReview({ ...f.options, current: draftPacket }))
      .recordedReview,
  ).toBeNull();
  expect(f.query).not.toHaveBeenCalled();
});
