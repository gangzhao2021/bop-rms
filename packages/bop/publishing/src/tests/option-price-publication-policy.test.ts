import { describe, expect, it, vi } from "vitest";
import { validateAuditRecord } from "@bop/audit";
import {
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingOptionPricePublicationPolicy,
  publishingOptionPricePublicationPolicyDigest,
  optionPricePolicyConfigurationType,
  createPostgresPublishingMutationStore,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingInstant,
  parseReleaseSequence,
  type CommitPublishingMutationInput,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z",
  until = "2026-09-11T11:00:00.000Z";
const body = () => ({
  profile: "PublishingOptionPricePublicationPolicyV1",
  tenantReference: id(1),
  brandReference: id(2),
  familyReference: id(3),
  policyReference: id(4),
  policyVersion: 1,
  approvalPolicy: "NotRequired",
  effectiveFrom: at,
  effectiveUntil: null,
});
const scope = createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null });
// Controlled history packets use real public owner parsers; this is not native SQL/IAM evidence.
function fixture(change: Record<string, unknown> = {}) {
  const policy = parsePublishingOptionPricePublicationPolicy({ ...body(), ...change });
  const hash = publishingOptionPricePublicationPolicyDigest(policy);
  const life = (state: "Draft" | "InReview" | "Approved" | "Published", version: number) =>
    createPublishingLifecycleRecord({
      lifecycleId: parsePublishingReference(id(5)),
      familyReference: policy.familyReference,
      configurationType: parsePublishingCode(optionPricePolicyConfigurationType),
      purposeCode: parsePublishingCode(optionPricePolicyConfigurationType),
      snapshotReference: policy.policyReference,
      snapshotDigest: parsePublishingDigest(hash),
      scope,
      version: parsePublishingVersion(version),
      state,
      validationEvidenceReference: state === "Draft" ? null : parsePublishingReference(id(6)),
      approvalEvidenceReference:
        state === "Approved" || state === "Published" ? parsePublishingReference(id(7)) : null,
      createdAt: parsePublishingInstant(at),
      changedAt: parsePublishingInstant(at),
    });
  const d = life("Draft", 1),
    r = life("InReview", 2),
    a = life("Approved", 3),
    p = life("Published", 4);
  const validation = createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(id(6)),
    snapshotReference: policy.policyReference,
    snapshotDigest: parsePublishingDigest(hash),
    scope,
    result: "Pass",
    checkedAt: parsePublishingInstant(at),
    validUntil: parsePublishingInstant(until),
    checkCodes: [parsePublishingCode("POLICY_CONTENT")],
  });
  const approval = createPublishingApprovalEvidence({
    evidenceReference: parsePublishingReference(id(7)),
    reviewLifecycleId: parsePublishingReference(id(5)),
    reviewVersion: parsePublishingVersion(2),
    snapshotReference: policy.policyReference,
    snapshotDigest: parsePublishingDigest(hash),
    scope,
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(id(9)),
    approvedAt: parsePublishingInstant(at),
    validUntil: parsePublishingInstant(until),
  });
  const release = createPublishingReleaseRecord({
    releaseId: parsePublishingReference(id(10)),
    familyReference: policy.familyReference,
    configurationType: parsePublishingCode(optionPricePolicyConfigurationType),
    purposeCode: parsePublishingCode(optionPricePolicyConfigurationType),
    snapshotReference: policy.policyReference,
    snapshotDigest: parsePublishingDigest(hash),
    scope,
    sequence: parseReleaseSequence(1),
    sourceLifecycleId: parsePublishingReference(id(5)),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: parsePublishingInstant(at),
  });
  const make = (
    operation: CommitPublishingMutationInput["operation"],
    current: typeof d | null,
    next: typeof d,
    n: number,
  ): CommitPublishingMutationInput =>
    parseRecordedPublishingMutation({
      operation,
      current,
      next,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(20 + n),
      release: operation === "Publish" ? release : null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence:
        operation === "SubmitReview" || operation === "Publish" ? validation : null,
      approvalEvidence: operation === "Approve" || operation === "Publish" ? approval : null,
      ...(operation === "CreateDraft" ? { optionPricePolicyContent: policy } : {}),
      audit: validateAuditRecord(
        {
          auditId: id(30 + n),
          brandId: id(2),
          actor: { type: "User", reference: operation === "Approve" ? id(9) : id(8) },
          actionCode: {
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
            Archive: "PUBLISHING_ARCHIVED",
            Rollback: "PUBLISHING_ROLLBACK_PUBLISHED",
          }[operation],
          targetType: "PublishingLifecycle",
          targetId: id(5),
          reasonCode: "SYNTHETIC_POLICY_GOVERNANCE",
          correlationId: id(40),
          occurredAt: at,
          sourceChannel: "INTERNAL_TEST",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        Date.parse(at),
      ),
    });
  const history = [
    make("CreateDraft", null, d, 0),
    make("SubmitReview", d, r, 1),
    make("Approve", r, a, 2),
    make("Publish", a, p, 3),
  ];
  let missingBody = false,
    missingApproval = false,
    corrupt = false;
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.startsWith("SELECT set_config") || sql.startsWith("LOCK TABLE")) return { rows: [] };
    let selected: readonly CommitPublishingMutationInput[];
    if (sql.includes("release_id IS NOT NULL"))
      selected = history.filter((m) => m.release && m.next.familyReference === values[3]);
    else if (sql.includes("ORDER BY lifecycle_version DESC")) selected = history.slice(-1);
    else if (sql.includes("operation_code='CreateDraft'"))
      selected = missingBody ? [] : history.slice(0, 1);
    else if (sql.includes("operation_code IN ('CreateDraft','SubmitReview','Approve')"))
      selected = missingApproval ? history.slice(0, 2) : history.slice(0, 3);
    else throw Error("Unexpected synthetic owner query");
    return {
      rows: selected.map((m) => ({
        mutation_json: m,
        intent_hash: corrupt ? "sha256:" + "a".repeat(64) : publishingRecordedMutationDigest(m),
      })),
    };
  });
  const store = createPostgresPublishingMutationStore(
    { run: async (work) => work({ query }) },
    id(1),
    scope,
  );
  return {
    policy,
    history,
    query,
    store,
    missingBody: () => {
      missingBody = true;
    },
    missingApproval: () => {
      missingApproval = true;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
}
describe("OptionPrice publication policy", () => {
  it("freezes exact own nine-field content and hashes actual approval requirement", () => {
    const value = body(),
      p = parsePublishingOptionPricePublicationPolicy(value);
    value.approvalPolicy = "Required";
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.approvalPolicy).toBe("NotRequired");
    expect(publishingOptionPricePublicationPolicyDigest(value)).not.toBe(
      publishingOptionPricePublicationPolicyDigest(p),
    );
  });
  it.each([
    { profile: "PublishingProductPublicationPolicyV1" },
    { profile: "PublishingOptionSetPublicationPolicyV1" },
    { approvalPolicy: "Allow" },
    { policyVersion: 0 },
    { brandReference: "bad" },
    { effectiveUntil: at },
    { requireApproval: true },
    { mediaRequirement: "Optional" },
  ])("rejects foreign or invalid body %#", (change) =>
    expect(() => parsePublishingOptionPricePublicationPolicy({ ...body(), ...change })).toThrow(),
  );
  it("refuses accessor without invoking it", () => {
    const value = body(),
      get = vi.fn(() => "Required");
    Object.defineProperty(value, "approvalPolicy", { get, enumerable: true });
    expect(() => parsePublishingOptionPricePublicationPolicy(value)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["Required", "NotRequired"])(
    "resolves actual independently approved current governance %s",
    async (approvalPolicy) => {
      const f = fixture({ approvalPolicy });
      const result = await f.store.resolveCurrentOptionPricePublicationPolicy({
        familyReference: id(3),
        observedAt: at,
      });
      expect(result.content).toEqual(f.policy);
      expect(result.current.approvalEvidence.approvedActorReference).toBe(id(9));
      expect(result.current.release.snapshotDigest).toBe(
        publishingOptionPricePublicationPolicyDigest(f.policy),
      );
      expect(f.query.mock.calls.some(([sql]) => sql.includes("IN SHARE MODE"))).toBe(true);
    },
  );
  it("retains historical governance approval after natural approval expiry while policy remains effective", async () => {
    const f = fixture();
    const result = await f.store.resolveCurrentOptionPricePublicationPolicy({
      familyReference: id(3),
      observedAt: "2026-09-12T10:00:00.000Z",
    });
    expect(result.current.approvalEvidence.validUntil).toBe(until);
  });
  it.each(["missingBody", "missingApproval", "corrupt"] as const)(
    "fails closed for %s instead of inventing a requirement",
    async (mode) => {
      const f = fixture();
      f[mode]();
      await expect(
        f.store.resolveCurrentOptionPricePublicationPolicy({
          familyReference: id(3),
          observedAt: at,
        }),
      ).rejects.toThrow();
    },
  );
  it("rejects expired policy and absent configured family", async () => {
    const f = fixture({ effectiveUntil: until });
    await expect(
      f.store.resolveCurrentOptionPricePublicationPolicy({
        familyReference: id(3),
        observedAt: until,
      }),
    ).rejects.toThrow();
    await expect(
      f.store.resolveCurrentOptionPricePublicationPolicy({
        familyReference: id(77),
        observedAt: at,
      }),
    ).rejects.toThrow();
  });
  it("refuses caller-selected policy/version and source getters before SQL", async () => {
    const f = fixture(),
      request = { familyReference: id(3), observedAt: at, policyVersion: 1 };
    await expect(f.store.resolveCurrentOptionPricePublicationPolicy(request)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
    const get = vi.fn(() => id(3));
    Object.defineProperty(request, "familyReference", { get, enumerable: true });
    await expect(f.store.resolveCurrentOptionPricePublicationPolicy(request)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it("retains typed original body in immutable recorded mutation and rejects mixed body", () => {
    const f = fixture(),
      m = f.history[0];
    if (!m) throw Error("Missing synthetic original");
    expect(parseRecordedPublishingMutation(m).optionPricePolicyContent).toEqual(f.policy);
    expect(() =>
      parseRecordedPublishingMutation({ ...m, productPolicyContent: f.policy }),
    ).toThrow();
    expect(() => parseRecordedPublishingMutation({ ...m, operation: "SubmitReview" })).toThrow();
  });
  it("rejects self-approval even when the recorded mutation hash is consistent", async () => {
    const f = fixture(),
      approved = f.history[2];
    if (!approved) throw Error("Missing synthetic approval");
    f.history[2] = parseRecordedPublishingMutation({
      ...approved,
      audit: { ...approved.audit, actor: { type: "User", reference: id(8) } },
    });
    await expect(
      f.store.resolveCurrentOptionPricePublicationPolicy({
        familyReference: id(3),
        observedAt: at,
      }),
    ).rejects.toThrow();
  });
  it("persists new governance body through owning commit with real audit append and exact replay", async () => {
    const f = fixture(),
      draft = f.history[0];
    if (!draft) throw Error("Missing synthetic Draft");
    let recorded: CommitPublishingMutationInput | null = null;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("operation_id=$4"))
        return {
          rows: recorded
            ? [
                {
                  mutation_json: recorded,
                  intent_hash: publishingRecordedMutationDigest(recorded),
                  audit_id: recorded.audit.auditId,
                },
              ]
            : [],
        };
      if (sql.includes("FROM platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: at }] };
      if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "2" }] };
      return { rows: [] };
    });
    const store = createPostgresPublishingMutationStore(
      { run: async (work) => work({ query }) },
      id(1),
      scope,
    );
    expect(await store.commit(draft)).toEqual({ auditReference: draft.audit.auditId });
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record"),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO platform_audit.audit_record")),
    ).toHaveLength(1);
    recorded = draft;
    expect(await store.commit(draft)).toEqual({ auditReference: draft.audit.auditId });
    expect(
      query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO platform_audit.audit_record")),
    ).toHaveLength(1);
  });
  it("refuses skipping policy version or omitting unregistered body before appendAudit", async () => {
    const f = fixture(),
      draft = f.history[0];
    if (!draft) throw Error("Missing synthetic Draft");
    const policy = parsePublishingOptionPricePublicationPolicy({ ...f.policy, policyVersion: 2 });
    const query = vi.fn(async (sql: string) => {
      void sql;
      return { rows: [] };
    });
    const store = createPostgresPublishingMutationStore(
      { run: async (work) => work({ query }) },
      id(1),
      scope,
    );
    await expect(
      store.commit({
        ...draft,
        optionPricePolicyContent: policy,
        next: createPublishingLifecycleRecord({
          ...draft.next,
          snapshotDigest: parsePublishingDigest(
            publishingOptionPricePublicationPolicyDigest(policy),
          ),
        }),
      }),
    ).rejects.toThrow();
    const { optionPricePolicyContent, ...withoutBody } = draft;
    void optionPricePolicyContent;
    await expect(store.commit(withoutBody)).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => sql.includes("platform_audit"))).toBe(false);
  });

  it("reuses the immutable original body for another governance Draft lifecycle", async () => {
    const f = fixture(),
      original = f.history[0];
    if (!original) throw Error("Missing synthetic original");
    const { optionPricePolicyContent, ...rest } = original;
    void optionPricePolicyContent;
    const reused = parseRecordedPublishingMutation({
      ...rest,
      idempotencyKey: id(51),
      next: createPublishingLifecycleRecord({
        ...original.next,
        lifecycleId: parsePublishingReference(id(50)),
      }),
      audit: validateAuditRecord(
        { ...original.audit, auditId: id(52), targetId: id(50) },
        Date.parse(at),
      ),
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("operation_code='CreateDraft'"))
        return {
          rows: [
            { mutation_json: original, intent_hash: publishingRecordedMutationDigest(original) },
          ],
        };
      if (sql.includes("FROM platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: at }] };
      if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "2" }] };
      return { rows: [] };
    });
    const store = createPostgresPublishingMutationStore(
      { run: async (work) => work({ query }) },
      id(1),
      scope,
    );
    await expect(store.commit(reused)).resolves.toEqual({ auditReference: reused.audit.auditId });
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record"),
      ),
    ).toHaveLength(1);
  });

  it("rejects Draft author A / submitter B / approver A despite valid hashes and different submitter", async () => {
    const f = fixture(),
      draft = f.history[0],
      review = f.history[1];
    if (!draft || !review) throw Error("Missing synthetic governance history");
    f.history[0] = parseRecordedPublishingMutation({
      ...draft,
      audit: { ...draft.audit, actor: { type: "User", reference: id(9) } },
    });
    f.history[1] = parseRecordedPublishingMutation({
      ...review,
      audit: { ...review.audit, actor: { type: "User", reference: id(8) } },
    });
    await expect(
      f.store.resolveCurrentOptionPricePublicationPolicy({
        familyReference: id(3),
        observedAt: at,
      }),
    ).rejects.toThrow();
  });
  it("rejects detached Create-to-Submit history even when source tuples and hashes agree", async () => {
    const f = fixture(),
      review = f.history[1];
    if (!review || !review.current) throw Error("Missing synthetic review");
    f.history[1] = parseRecordedPublishingMutation({
      ...review,
      current: createPublishingLifecycleRecord({
        ...review.current,
        lifecycleId: parsePublishingReference(id(99)),
      }),
    });
    await expect(
      f.store.resolveCurrentOptionPricePublicationPolicy({
        familyReference: id(3),
        observedAt: at,
      }),
    ).rejects.toThrow();
  });
});
