import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parseRecordedPublishingMutation,
  type RecordedReleasedIndependentPublishingApproval,
} from "../index.js";

// Real owning parser/resolver, controlled SQL transport; not current IAM evidence.
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
const publishedAt = "2026-09-11T10:00:01.000Z";
const until = "2026-09-11T10:00:02.000Z";
const observedAt = "2026-09-12T10:00:00.000Z";
const fp = "sha256:" + "a".repeat(64);
const scope = createPublishingScope({
  kind: "Store",
  brandReference: id(2),
  storeReference: id(3),
});
const request = () => ({
  familyReference: id(4),
  lifecycleReference: id(5),
  configurationType: "STORE_CONFIGURATION",
  purposeCode: "STORE_CONFIGURATION",
  snapshotReference: id(6),
  snapshotDigest: fp,
  requiredCheckCodes: ["CURRENT_REFERENCES", "RULE_SATISFIABILITY"],
  observedAt,
});
function fixture() {
  const draft = {
    lifecycleId: id(5),
    familyReference: id(4),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    snapshotReference: id(6),
    snapshotDigest: fp,
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null as string | null,
    approvalEvidenceReference: null as string | null,
    createdAt: at,
    changedAt: at,
  };
  const review = { ...draft, version: 2, state: "InReview", validationEvidenceReference: id(20) };
  const approved = { ...review, version: 3, state: "Approved", approvalEvidenceReference: id(21) };
  const published = { ...approved, version: 4, state: "Published", changedAt: publishedAt };
  const validation = {
    evidenceReference: id(20),
    snapshotReference: id(6),
    snapshotDigest: fp,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: until,
    checkCodes: ["RULE_SATISFIABILITY", "CURRENT_REFERENCES"],
  };
  const approval = {
    evidenceReference: id(21),
    reviewLifecycleId: id(5),
    reviewVersion: 2,
    snapshotReference: id(6),
    snapshotDigest: fp,
    scope,
    decision: "Accepted",
    approvedActorReference: id(8),
    approvedAt: at,
    validUntil: until,
  };
  const release = {
    releaseId: id(30),
    familyReference: id(4),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    snapshotReference: id(6),
    snapshotDigest: fp,
    scope,
    sequence: 1,
    sourceLifecycleId: id(5),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: publishedAt,
  };
  return [draft, review, approved, published].map((next, index) => ({
    operation: ["CreateDraft", "SubmitReview", "Approve", "Publish"][index],
    expectedVersion: index === 0 ? 1 : index,
    idempotencyKey: id(100 + index),
    current: index === 0 ? null : [draft, review, approved][index - 1],
    next,
    release: index === 3 ? release : null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: index === 1 || index === 3 ? validation : null,
    approvalEvidence: index === 2 || index === 3 ? approval : null,
    audit: {
      auditId: id(110 + index),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: index === 2 ? id(8) : id(7) },
      actionCode: [
        "PUBLISHING_DRAFT_CREATED",
        "PUBLISHING_REVIEW_SUBMITTED",
        "PUBLISHING_REVIEW_APPROVED",
        "PUBLISHING_RELEASE_PUBLISHED",
      ][index],
      targetType: "PublishingLifecycle",
      targetId: id(5),
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(120 + index),
      occurredAt: index === 3 ? publishedAt : at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
  }));
}
function row(records: ReturnType<typeof fixture>, index: number) {
  const value = records[index];
  if (!value) throw new Error("missing controlled owning record");
  return value;
}
function hash(value: unknown) {
  const parsed = parseRecordedPublishingMutation(value);
  return (
    "sha256:" +
    sha256Hex(canonicalizeRfc8785({ ...parsed, audit: { ...parsed.audit, auditId: null } }))
  );
}
function setup(
  change?: (records: ReturnType<typeof fixture>) => void,
  fault?: "missing" | "corrupt" | "audit" | "sql",
) {
  const records = fixture();
  change?.(records);
  const query = vi.fn(async (sql: string) => {
    if (fault === "sql") throw new Error("controlled transport refusal");
    if (sql.includes("lifecycle_version ASC LIMIT 5"))
      return {
        rows: (fault === "missing" ? records.slice(1) : records).map((record) => ({
          mutation_json: record,
          intent_hash: fault === "corrupt" ? "sha256:" + "0".repeat(64) : hash(record),
          audit_id: fault === "audit" ? id(999) : record.audit.auditId,
        })),
      };
    if (
      sql.includes("ORDER BY release_sequence DESC LIMIT 1") ||
      sql.includes("ORDER BY lifecycle_version DESC LIMIT 1")
    ) {
      const head = row(records, 3);
      return { rows: [{ mutation_json: head, intent_hash: hash(head) }] };
    }
    return { rows: [] };
  });
  const tx = { query };
  const run = vi.fn();
  async function runner<T>(work: (value: typeof tx) => Promise<T>): Promise<T> {
    run();
    return work(tx);
  }
  return {
    records,
    query,
    run,
    store: createPostgresPublishingMutationStore({ run: runner }, id(1), scope),
  };
}

describe("recorded independent approval behind actual current release", () => {
  it("joins actual Published release with independent immutable history after natural expiry", async () => {
    const { store, query, run, records } = setup();
    const result: RecordedReleasedIndependentPublishingApproval =
      await store.resolveCurrentReleaseIndependentApproval(request());
    expect(result.profile).toBe("RecordedReleasedIndependentPublishingApprovalV1");
    expect(result.currentRelease.release.releaseId).toBe(id(30));
    expect(result.currentRelease.lifecycle.state).toBe("Published");
    expect(result.currentRelease.approvalEvidence.validUntil).toBe(until);
    expect(result.approvedLifecycleVersion).toBe(3);
    expect(result.reviewVersion).toBe(2);
    expect(result.authoredByActorReference).toBe(id(7));
    expect(result.requestedByActorReference).toBe(id(7));
    expect(result.approvedByActorReference).toBe(id(8));
    expect(result.recordedIndependence).toBe("Verified");
    expect([result.currentValidation, result.referenceEligibility, result.eligibility]).toEqual(
      Array(3).fill("NotEvaluated"),
    );
    expect(result).not.toHaveProperty("validUntil");
    const { digest, ...body } = result;
    expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
    expect(run).toHaveBeenCalledTimes(1);
    const lock = query.mock.calls.findIndex(([sql]) => sql.includes("IN SHARE MODE"));
    const history = query.mock.calls.findIndex(([sql]) =>
      sql.includes("lifecycle_version ASC LIMIT 5"),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(history).toBeGreaterThan(lock);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.currentRelease.approvalEvidence)).toBe(true);
    row(records, 1).validationEvidence?.checkCodes.reverse();
    expect(result.validationCheckCodes).toEqual(["CURRENT_REFERENCES", "RULE_SATISFIABILITY"]);
    // Existing Approved-head reader retains its original semantics.
    await expect(store.resolveCurrentIndependentApproval(request())).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
  });
  it("allows a distinct submitter without losing the actual original author", async () => {
    const { store } = setup((records) => {
      row(records, 1).audit.actor.reference = id(9);
    });
    const result = await store.resolveCurrentReleaseIndependentApproval(request());
    expect(result.authoredByActorReference).toBe(id(7));
    expect(result.requestedByActorReference).toBe(id(9));
  });
  it.each<[string, (records: ReturnType<typeof fixture>) => void]>([
    [
      "author approves after different actor submits",
      (records: ReturnType<typeof fixture>) => {
        row(records, 0).audit.actor.reference = id(8);
        row(records, 1).audit.actor.reference = id(9);
      },
    ],
    [
      "submitter approves",
      (records: ReturnType<typeof fixture>) => {
        row(records, 1).audit.actor.reference = id(8);
      },
    ],
    [
      "validation expired before Publish",
      (records: ReturnType<typeof fixture>) => {
        const validation = row(records, 1).validationEvidence;
        if (!validation) throw new Error("missing validation");
        validation.validUntil = publishedAt;
      },
    ],
    [
      "approval expired before Publish",
      (records: ReturnType<typeof fixture>) => {
        const approval = row(records, 2).approvalEvidence;
        if (!approval) throw new Error("missing approval");
        approval.validUntil = publishedAt;
      },
    ],
    [
      "discontinuous original Draft",
      (records: ReturnType<typeof fixture>) => {
        const current = row(records, 1).current;
        if (!current) throw new Error("missing original current");
        row(records, 1).current = { ...current, changedAt: "2026-09-11T10:00:00.001Z" };
      },
    ],
    [
      "foreign initial snapshot",
      (records: ReturnType<typeof fixture>) => {
        row(records, 0).next.snapshotDigest = "sha256:" + "b".repeat(64);
      },
    ],
    [
      "wrong original Audit actor",
      (records: ReturnType<typeof fixture>) => {
        const approval = row(records, 2).approvalEvidence;
        if (!approval) throw new Error("missing approval");
        approval.approvedActorReference = id(9);
      },
    ],
    [
      "latest head is Archived",
      (records: ReturnType<typeof fixture>) => {
        row(records, 3).next.state = "Archived";
      },
    ],
    [
      "release is foreign lifecycle",
      (records: ReturnType<typeof fixture>) => {
        const release = row(records, 3).release;
        if (!release) throw new Error("missing release");
        release.sourceLifecycleId = id(99);
      },
    ],
    [
      "missing actual published validation",
      (records: ReturnType<typeof fixture>) => {
        row(records, 3).validationEvidence = null;
      },
    ],
  ])("fails closed on hash-consistent %s", async (_label, change) => {
    await expect(
      setup(change).store.resolveCurrentReleaseIndependentApproval(request()),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  });
  it.each(["missing", "corrupt", "audit", "sql"] as const)(
    "refuses %s immutable source",
    async (fault) => {
      await expect(
        setup(undefined, fault).store.resolveCurrentReleaseIndependentApproval(request()),
      ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    },
  );
  it.each([
    { ...request(), snapshotReference: id(99) },
    { ...request(), lifecycleReference: id(99) },
    { ...request(), requiredCheckCodes: ["OTHER_CHECK"] },
    { ...request(), snapshotDigest: "sha256:" + "b".repeat(64) },
  ])("refuses caller pins that do not match the actual release/history", async (input) => {
    await expect(
      setup().store.resolveCurrentReleaseIndependentApproval(input),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  });
  it("rejects open/getter requests without invoking the runner or getter", async () => {
    const { store, run } = setup();
    const getter = vi.fn(() => id(4));
    const input = request();
    Object.defineProperty(input, "familyReference", { enumerable: true, get: getter });
    await expect(store.resolveCurrentReleaseIndependentApproval(input)).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
    await expect(
      store.resolveCurrentReleaseIndependentApproval({ ...request(), currentAllow: true }),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});
