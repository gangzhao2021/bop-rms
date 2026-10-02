import { describe, it, expect, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parseIndependentPublishingApprovalRequest,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z",
  until = "2026-09-11T10:00:30.000Z",
  fp = "sha256:" + "a".repeat(64);
const scope = createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null });
const input = () => ({
  familyReference: id(4),
  lifecycleReference: id(5),
  configurationType: "CATALOG_OPTION_SET",
  purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
  snapshotReference: id(6),
  snapshotDigest: fp,
  requiredCheckCodes: ["CURRENT_REFERENCES", "RULE_SATISFIABILITY"],
  observedAt: at,
});
const hash = (m: ReturnType<typeof fixtures>[number]) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785({ ...m, audit: { ...m.audit, auditId: null } }));
function fixtures() {
  const base = {
    lifecycleId: id(5),
    familyReference: id(4),
    configurationType: "CATALOG_OPTION_SET",
    purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
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
  const review = { ...base, version: 2, state: "InReview", validationEvidenceReference: id(20) };
  const approved = { ...review, version: 3, state: "Approved", approvalEvidenceReference: id(21) };
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
  const evidence = {
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
  return [base, review, approved].map((next, i) => ({
    operation: ["CreateDraft", "SubmitReview", "Approve"][i],
    expectedVersion: i === 0 ? 1 : i,
    idempotencyKey: id(100 + i),
    current: i === 0 ? null : [base, review][i - 1],
    next,
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: i === 1 ? validation : null,
    approvalEvidence: i === 2 ? evidence : null,
    audit: {
      auditId: id(110 + i),
      brandId: id(2),
      actor: { type: "User", reference: i === 2 ? id(8) : id(7) },
      actionCode: [
        "PUBLISHING_DRAFT_CREATED",
        "PUBLISHING_REVIEW_SUBMITTED",
        "PUBLISHING_REVIEW_APPROVED",
      ][i],
      targetType: "PublishingLifecycle",
      targetId: id(5),
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(120 + i),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
  }));
}
function setup(change?: (m: ReturnType<typeof fixtures>) => void, corrupt = false) {
  const m = fixtures();
  if (change) change(m);
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("ORDER BY lifecycle_version DESC LIMIT 1")) {
      const head = m[2];
      if (!head) throw new Error("synthetic missing head");
      return { rows: [{ mutation_json: head, intent_hash: hash(head) }] };
    }
    if (sql.includes("lifecycle_version IN"))
      return {
        rows: m.map((v) => ({
          mutation_json: v,
          intent_hash: corrupt ? "sha256:" + "0".repeat(64) : hash(v),
          audit_id: v.audit.auditId,
        })),
      };
    return { rows: [] };
  });
  return {
    m,
    query,
    store: createPostgresPublishingMutationStore({ run: (work) => work({ query }) }, id(1), scope),
  };
}
function row(m: ReturnType<typeof fixtures>, n: number) {
  const r = m[n];
  if (!r) throw new Error("missing synthetic fixture");
  return r;
}
describe("owning current independent approval source", () => {
  it("proves exact recorded independence without current validation qualification", async () => {
    const { store, query, m } = setup();
    const r = await store.resolveCurrentIndependentApproval(input());
    expect(r.profile).toBe("CurrentIndependentPublishingApprovalV1");
    expect(r.requestedByActorReference).toBe(id(7));
    expect(r.approvedByActorReference).toBe(id(8));
    expect(r.validationCheckCodes).toEqual(["CURRENT_REFERENCES", "RULE_SATISFIABILITY"]);
    expect(r.currentValidation).toBe("NotEvaluated");
    expect(r.referenceEligibility).toBe("NotEvaluated");
    expect(r.eligibility).toBe("NotEvaluated");
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.validationCheckCodes)).toBe(true);
    expect(Object.isFrozen(r.scope)).toBe(true);
    expect(query.mock.calls.some((c) => c[0].includes("IN SHARE MODE"))).toBe(true);
    row(m, 1).validationEvidence?.checkCodes.reverse();
    expect(r.validationCheckCodes).toEqual(["CURRENT_REFERENCES", "RULE_SATISFIABILITY"]);
    expect(JSON.stringify(r)).not.toContain('"audit"');
  });
  it.each([
    null,
    {},
    [],
    { ...input(), Ready: true },
    { ...input(), snapshotReference: "bad" },
    { ...input(), snapshotDigest: "bad" },
    { ...input(), requiredCheckCodes: [] },
    { ...input(), requiredCheckCodes: Array(33).fill("CHECK") },
    { ...input(), requiredCheckCodes: ["CHECK", "CHECK"] },
    { ...input(), observedAt: "2026-09-11T10:00:00Z" },
    Object.create(input()),
  ])("denies malformed selectors before runner (%#)", async (v) => {
    const run = vi.fn();
    await expect(
      createPostgresPublishingMutationStore(
        { run },
        id(1),
        scope,
      ).resolveCurrentIndependentApproval(v),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses object/array accessors without invocation", () => {
    const getter = vi.fn(() => id(4)),
      v = input();
    Object.defineProperty(v, "familyReference", { get: getter, enumerable: true });
    expect(() => parseIndependentPublishingApprovalRequest(v)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const x = input();
    Object.defineProperty(x.requiredCheckCodes, "0", { get: getter, enumerable: true });
    expect(() => parseIndependentPublishingApprovalRequest(x)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    [
      "self approval",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).audit.actor.reference = id(8);
      },
    ],
    [
      "wrong draft snapshot",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 0).next.snapshotDigest = "sha256:" + "b".repeat(64);
      },
    ],
    [
      "wrong current link",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).current = null;
      },
    ],
    [
      "wrong review Actor",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).audit.actor.type = "System";
      },
    ],
    [
      "wrong review target",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).audit.targetId = id(99);
      },
    ],
    [
      "wrong review action",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).audit.actionCode = "PUBLISHING_DRAFT_CREATED";
      },
    ],
    [
      "wrong review scope",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).audit.brandId = id(99);
      },
    ],
    [
      "wrong review expected version",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).expectedVersion = 99;
      },
    ],
    [
      "wrong validation identity",
      (m: ReturnType<typeof fixtures>) => {
        const v = row(m, 1).validationEvidence;
        if (v) v.evidenceReference = id(99);
      },
    ],
    [
      "wrong validation code set",
      (m: ReturnType<typeof fixtures>) => {
        const v = row(m, 1).validationEvidence;
        if (v) v.checkCodes = ["SCHEMA_VALID"];
      },
    ],
    [
      "wrong validation scope",
      (m: ReturnType<typeof fixtures>) => {
        const v = row(m, 1).validationEvidence;
        if (v)
          v.scope = createPublishingScope({
            kind: "Brand",
            brandReference: id(99),
            storeReference: null,
          });
      },
    ],
    [
      "future review",
      (m: ReturnType<typeof fixtures>) => {
        row(m, 1).audit.occurredAt = "2026-09-11T10:00:00.001Z";
      },
    ],
    [
      "expired validation",
      (m: ReturnType<typeof fixtures>) => {
        const v = row(m, 1).validationEvidence;
        if (v) {
          v.checkedAt = "2026-09-11T09:59:59.000Z";
          v.validUntil = at;
        }
      },
    ],
    [
      "missing row",
      (m: ReturnType<typeof fixtures>) => {
        m.shift();
      },
    ],
    [
      "duplicate row",
      (m: ReturnType<typeof fixtures>) => {
        m.push(row(m, 0));
      },
    ],
  ] as const)("refuses %s even with recomputed transport intent", async (_name, change) => {
    const { store } = setup(change);
    await expect(store.resolveCurrentIndependentApproval(input())).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
  });
  it("refuses an audit ID column that differs from its normalized original", async () => {
    const m = fixtures();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("ORDER BY lifecycle_version DESC LIMIT 1")) {
        const head = row(m, 2);
        return { rows: [{ mutation_json: head, intent_hash: hash(head) }] };
      }
      if (sql.includes("lifecycle_version IN"))
        return {
          rows: m.map((v) => ({ mutation_json: v, intent_hash: hash(v), audit_id: id(999) })),
        };
      return { rows: [] };
    });
    await expect(
      createPostgresPublishingMutationStore(
        { run: (work) => work({ query }) },
        id(1),
        scope,
      ).resolveCurrentIndependentApproval(input()),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  });
  it("refuses corrupted original hash", async () => {
    await expect(
      setup(undefined, true).store.resolveCurrentIndependentApproval(input()),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  });
  it.each([
    { snapshotReference: id(99) },
    { snapshotDigest: "sha256:" + "b".repeat(64) },
    { familyReference: id(99) },
    { lifecycleReference: id(99) },
    { requiredCheckCodes: ["SCHEMA_VALID"] },
    { observedAt: until },
  ])("refuses wrong pin/set or exclusive expiration (%#)", async (patch) => {
    await expect(
      setup().store.resolveCurrentIndependentApproval({ ...input(), ...patch }),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  });
});
