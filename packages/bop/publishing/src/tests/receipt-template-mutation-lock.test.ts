import { expect, it, vi } from "vitest";
import {
  createPostgresPublishingMutationStore,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type PublishingTransaction,
} from "../infrastructure/persistence/publishing-mutation-store.js";
import { createPublishingScope } from "../contracts/publishing.js";
import type { CommitPublishingMutationInput } from "../application/ports/publishing-ports.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T10:00:00.000Z";
// Real owner service and audit SQL with controlled database transport; this is not PostgreSQL contention proof.
function fixture(
  configurationType = "RECEIPT_TEMPLATE",
  purposeCode = "RECEIPT_ISSUANCE",
  storeScoped = true,
) {
  const scope = createPublishingScope({
    kind: storeScoped ? "Store" : "Brand",
    brandReference: id(2),
    storeReference: storeScoped ? id(3) : null,
  });
  const current = {
    lifecycleId: id(4),
    familyReference: id(5),
    configurationType,
    purposeCode,
    snapshotReference: id(6),
    snapshotDigest: "sha256:" + "a".repeat(64),
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  const audit = (action: string, n: number) => ({
    auditId: id(n),
    brandId: id(2),
    ...(storeScoped ? { storeId: id(3) } : {}),
    actor: { type: "User", reference: id(7) },
    actionCode: action,
    targetType: "PublishingLifecycle",
    targetId: id(4),
    reasonCode: action,
    correlationId: id(n + 100),
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Confidential",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
  const base = {
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    approvalEvidence: null,
  };
  const create = parseRecordedPublishingMutation({
    ...base,
    operation: "CreateDraft",
    expectedVersion: 1,
    idempotencyKey: id(8),
    current: null,
    next: current,
    validationEvidence: null,
    audit: audit("PUBLISHING_DRAFT_CREATED", 10),
  });
  const submit = parseRecordedPublishingMutation({
    ...base,
    operation: "SubmitReview",
    expectedVersion: 1,
    idempotencyKey: id(9),
    current,
    next: { ...current, state: "InReview", version: 2, validationEvidenceReference: id(12) },
    validationEvidence: {
      evidenceReference: id(12),
      snapshotReference: id(6),
      snapshotDigest: current.snapshotDigest,
      scope,
      result: "Pass",
      checkedAt: at,
      validUntil: "2026-10-04T11:00:00.000Z",
      checkCodes: ["CURRENT_REFERENCES"],
    },
    audit: audit("PUBLISHING_REVIEW_SUBMITTED", 11),
  });
  const records: CommitPublishingMutationInput[] = [],
    calls: string[] = [];
  let sequence = 1;
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("SELECT mutation_json,intent_hash,audit_id"))
      return {
        rows: records
          .filter((m) => m.idempotencyKey === values[3])
          .map((m) => ({
            mutation_json: m,
            intent_hash: publishingRecordedMutationDigest(m),
            audit_id: m.audit.auditId,
          })),
      };
    if (sql.startsWith("SELECT mutation_json,intent_hash"))
      return {
        rows: records
          .slice(-1)
          .map((m) => ({ mutation_json: m, intent_hash: publishingRecordedMutationDigest(m) })),
      };
    if (sql.startsWith("SELECT mutation_json FROM"))
      return { rows: [...records].reverse().map((m) => ({ mutation_json: m })) };
    if (sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")) {
      records.push(parseRecordedPublishingMutation(values[14]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(sequence),
            previous_hash: sequence === 1 ? null : "b".repeat(64),
            recorded_at: at,
          },
        ],
      };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: String(++sequence) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const tx: PublishingTransaction = { query },
    store = createPostgresPublishingMutationStore({ run: (work) => work(tx) }, id(1), scope);
  return {
    store,
    create,
    submit,
    calls,
    records,
    query,
    read: () =>
      store.resolveCurrentLifecycleMutation({
        familyReference: id(5),
        lifecycleReference: id(4),
        configurationType,
        purposeCode,
        observedAt: at,
      }),
  };
}
it("Store Receipt CreateDraft and SubmitReview acquire SHARE ROW EXCLUSIVE before insert and support actual subsequent SHARE head reads", async () => {
  const f = fixture();
  for (const m of [f.create, f.submit]) {
    const start = f.calls.length;
    await expect(f.store.commit(m)).resolves.toEqual({ auditReference: m.audit.auditId });
    const writeCalls = f.calls.slice(start);
    const lock = writeCalls.findIndex(
        (s) =>
          s === "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
      ),
      insert = writeCalls.findIndex((s) =>
        s.startsWith("INSERT INTO bop_publishing.publishing_mutation_record"),
      );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(lock);
    expect(writeCalls).not.toContain(
      "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE",
    );
    await expect(f.read()).resolves.toEqual(m);
    expect(f.calls.at(-2)).toBe(
      "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE",
    );
  }
  expect(f.records).toHaveLength(2);
});
for (const [configuration, purpose, storeScoped] of [
  ["CATALOG_OPTION_SET", "CATALOG_OPTION_SET_PUBLICATION", true],
  ["RECEIPT_TEMPLATE", "INTERNAL_TEST", true],
  ["RECEIPT_TEMPLATE", "RECEIPT_ISSUANCE", false],
] as const)
  it(`retains original ROW EXCLUSIVE for ${configuration}/${purpose}/${storeScoped ? "Store" : "Brand"}`, async () => {
    const f = fixture(configuration, purpose, storeScoped);
    await f.store.commit(f.create);
    expect(f.calls).toContain(
      "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE",
    );
    expect(f.calls).not.toContain(
      "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
    );
    expect(f.records).toHaveLength(1);
  });
it("exact Receipt mutation replay remains an original lookup without new table lock, mutation or Audit append", async () => {
  const f = fixture();
  const receipt = await f.store.commit(f.create);
  const start = f.calls.length;
  await expect(f.store.commit(f.create)).resolves.toEqual(receipt);
  const replay = f.calls.slice(start);
  expect(replay.some((s) => s.startsWith("LOCK TABLE") || s.startsWith("INSERT INTO"))).toBe(false);
  expect(f.records).toHaveLength(1);
});
it("changed Receipt mutation intent remains rejected by original receipt comparison before new locking or writes", async () => {
  const f = fixture();
  await f.store.commit(f.create);
  const start = f.calls.length;
  await expect(
    f.store.commit(
      parseRecordedPublishingMutation({
        ...f.create,
        next: { ...f.create.next, snapshotDigest: "sha256:" + "b".repeat(64) },
      }),
    ),
  ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  expect(
    f.calls.slice(start).some((s) => s.startsWith("LOCK TABLE") || s.startsWith("INSERT INTO")),
  ).toBe(false);
  expect(f.records).toHaveLength(1);
});
