import { it, expect, vi } from "vitest";
import { validateAuditRecord } from "@bop/audit";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingVersion,
  parsePublishingDigest,
  parsePublishingInstant,
} from "../contracts/publishing.js";
import {
  publishingRecordedMutationDigest,
  type PublishingTransaction,
} from "../infrastructure/persistence/publishing-mutation-store.js";
import {
  createPostgresOptionSetPublicationHistoryStore,
  type OptionSetPublicationHistoryStoreOptions,
} from "../infrastructure/persistence/option-set-publication-history-store.js";
const id = (n: number) => `018f9f35-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = parsePublishingInstant("2026-10-05T00:00:00.000Z"),
  until = parsePublishingInstant("2026-10-05T00:00:05.000Z");
function fixture() {
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: id(2),
    storeReference: null,
  });
  const mutation = {
    operation: "CreateDraft" as const,
    expectedVersion: parsePublishingVersion(1),
    idempotencyKey: parsePublishingReference(id(7)),
    current: null,
    next: createPublishingLifecycleRecord({
      lifecycleId: parsePublishingReference(id(5)),
      familyReference: parsePublishingReference(id(6)),
      configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
      purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
      snapshotReference: parsePublishingReference(id(8)),
      snapshotDigest: parsePublishingDigest(`sha256:${"a".repeat(64)}`),
      scope,
      version: parsePublishingVersion(1),
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    }),
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: null,
    approvalEvidence: null,
    audit: validateAuditRecord({
      auditId: id(9),
      brandId: id(2),
      actor: { type: "User", reference: id(4) },
      actionCode: "PUBLISHING_DRAFT_CREATED",
      targetType: "PublishingLifecycle",
      targetId: id(5),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(7),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    }),
  };
  const row = {
    tenant_id: id(1),
    brand_id: id(2),
    store_id: null,
    family_id: id(6),
    lifecycle_id: id(5),
    lifecycle_version: "1",
    operation_id: id(7),
    operation_code: "CreateDraft",
    actor_id: id(4),
    audit_id: id(9),
    intent_hash: publishingRecordedMutationDigest(mutation),
    release_id: null,
    release_sequence: null,
    changed_at: at,
    mutation_json: mutation,
  };
  let now: string = at,
    lease: string = until,
    denied = false;
  let data: unknown[] = [row];
  const guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const query = vi.fn(async (sql: string, _values: readonly unknown[]) => {
    void _values;
    if (sql.includes("transaction_isolation"))
      return { rows: [{ isolation: "read committed", read_only: "off" }] };
    if (sql.startsWith("SELECT tenant_id")) return { rows: data };
    return { rows: [] };
  });
  const tx: PublishingTransaction = { query };
  const authority = vi.fn(async () => {
    if (denied) throw Error("controlled current refusal");
    return Object.freeze({ validUntil: lease });
  });
  const options: OptionSetPublicationHistoryStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: id(4),
    clock: { now: () => now },
    originalValidUntil: until,
    authority: { holdUntilTransactionCompletes: authority },
    registerBeforeCommit: (_tx, guard, final) => {
      guards.push({ guard, final });
    },
  };
  const source = createPostgresOptionSetPublicationHistoryStore(options);
  const request = { familyReference: id(6), before: null, limit: 25 };
  const finish = async () => {
    for (const g of guards) await g.guard();
    for (const g of guards) g.final();
    source.assertFinalized(tx);
  };
  return {
    tx,
    source,
    options,
    request,
    row,
    query,
    authority,
    guards,
    finish,
    setRows: (rows: unknown[]) => {
      data = rows;
    },
    time: (value: string) => {
      now = value;
    },
    lease: (value: string) => {
      lease = value;
    },
    deny: () => {
      denied = true;
    },
  };
}
it("returns actual minimal original headers and requires genuine final guards", async () => {
  const f = fixture();
  const result = await f.source.list(f.tx, f.request);
  expect(result.entries[0]).toMatchObject({
    operationReference: id(7),
    actorReference: id(4),
    fromState: null,
    toState: "Draft",
    occurredAt: at,
    releaseReference: null,
  });
  expect(result.entries[0]).not.toHaveProperty("audit");
  expect(result.entries[0]).not.toHaveProperty("validationEvidence");
  await f.finish();
  expect(f.authority).toHaveBeenCalledTimes(3);
  expect(f.query.mock.calls.some(([sql]) => sql.includes("IN SHARE MODE"))).toBe(true);
});
it("cannot claim finalized before host COMMIT guards", async () => {
  const f = fixture();
  await f.source.list(f.tx, f.request);
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
  await expect(f.finish()).rejects.toThrow();
});
it.each([
  "brand_id",
  "family_id",
  "actor_id",
  "audit_id",
  "intent_hash",
  "lifecycle_version",
  "changed_at",
])("rejects actual SQL tuple corruption %s", (field) => {
  const f = fixture();
  f.setRows([{ ...f.row, [field]: "corrupt" }]);
  return expect(f.source.list(f.tx, f.request)).rejects.toThrow();
});
it("validates actual before anchor and emits precise nextBefore", async () => {
  const f = fixture();
  const older = {
    ...f.row,
    operation_id: id(10),
    mutation_json: { ...f.row.mutation_json, idempotencyKey: parsePublishingReference(id(10)) },
  };
  older.intent_hash = publishingRecordedMutationDigest(older.mutation_json);
  f.setRows([older, f.row]);
  const result = await f.source.list(f.tx, { ...f.request, limit: 1 });
  expect(result.nextBefore).toEqual({ occurredAt: at, operationReference: id(10) });
  await f.finish();
  const wrong = fixture();
  await expect(
    wrong.source.list(wrong.tx, {
      ...wrong.request,
      before: { occurredAt: "2026-10-04T00:00:00.000Z", operationReference: id(7) },
    }),
  ).rejects.toThrow();
});
it("refuses sparse/getter owner rows without invoking getters", async () => {
  const f = fixture();
  let read = 0;
  const rows: unknown[] = [];
  rows.length = 1;
  Object.defineProperty(rows, "0", {
    enumerable: true,
    get() {
      read++;
      return f.row;
    },
  });
  f.setRows(rows);
  await expect(f.source.list(f.tx, f.request)).rejects.toThrow();
  expect(read).toBe(0);
});
it.each(["denied", "expiry", "query", "authority", "shortLease"])(
  "retains current authority and original shortest lease at final %s",
  async (failure) => {
    const f = fixture();
    await f.source.list(f.tx, f.request);
    if (failure === "denied") f.deny();
    if (failure === "expiry") f.time(until);
    if (failure === "query") f.tx.query = async () => ({ rows: [] });
    if (failure === "authority")
      f.options.authority.holdUntilTransactionCompletes = async () => ({ validUntil: until });
    if (failure === "shortLease") {
      f.lease("2026-10-05T00:00:01.000Z");
      await f.guards[0]?.guard();
      f.time("2026-10-05T00:00:01.000Z");
    }
    await expect(f.finish()).rejects.toThrow();
  },
);
it("refuses a second invocation and poisons the first original guard", async () => {
  const f = fixture();
  await f.source.list(f.tx, f.request);
  await expect(f.source.list(f.tx, f.request)).rejects.toThrow();
  await expect(f.finish()).rejects.toThrow();
});
it("rejects an unknown foreign anchor even when the page would be empty", async () => {
  const f = fixture();
  f.setRows([]);
  await expect(
    f.source.list(f.tx, { ...f.request, before: { occurredAt: at, operationReference: id(100) } }),
  ).rejects.toThrow();
});
it("requires the anchor response to match the original requested operation", async () => {
  const f = fixture();
  await expect(
    f.source.list(f.tx, { ...f.request, before: { occurredAt: at, operationReference: id(100) } }),
  ).rejects.toThrow();
});
it("poisons unexpected guard registration results without silently claiming completion", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "registerBeforeCommit", { value: () => true });
  const source = createPostgresOptionSetPublicationHistoryStore(f.options);
  await expect(source.list(f.tx, f.request)).rejects.toThrow();
});
it("rejects an overflowing owning response and incorrect SQL ordering", async () => {
  const excess = fixture();
  excess.setRows([excess.row, excess.row]);
  await expect(excess.source.list(excess.tx, { ...excess.request, limit: 1 })).rejects.toThrow();
  const overflowing = fixture();
  overflowing.setRows(Array.from({ length: 27 }, () => overflowing.row));
  await expect(overflowing.source.list(overflowing.tx, overflowing.request)).rejects.toThrow();
});
it("refuses unknown transaction modes and failed guard registration", async () => {
  const modes = fixture();
  modes.tx.query = async () => ({ rows: [{ isolation: "repeatable read", read_only: "off" }] });
  await expect(modes.source.list(modes.tx, modes.request)).rejects.toThrow();
  const f = fixture();
  const source = createPostgresOptionSetPublicationHistoryStore({
    ...f.options,
    registerBeforeCommit: () => {
      throw Error("controlled guard registration refusal");
    },
  });
  await expect(source.list(f.tx, f.request)).rejects.toThrow();
});
it("preserves an original Service actor distinct from the currently authorized User", async () => {
  const f = fixture();
  const original = {
    ...f.row.mutation_json,
    audit: validateAuditRecord({
      ...f.row.mutation_json.audit,
      actor: { type: "Service", reference: id(99) },
    }),
  };
  f.setRows([
    {
      ...f.row,
      actor_id: id(99),
      mutation_json: original,
      intent_hash: publishingRecordedMutationDigest(original),
    },
  ]);
  const result = await f.source.list(f.tx, f.request);
  expect(result.scope.actorReference).toBe(id(4));
  expect(result.entries[0]).toMatchObject({ actorKind: "Service", actorReference: id(99) });
  await f.finish();
});
it("exposes the actual final shortened owner lease after genuine host guards", async () => {
  const f = fixture();
  const tentative = await f.source.list(f.tx, f.request);
  const finalLease = "2026-10-05T00:00:02.000Z";
  f.lease(finalLease);
  await f.finish();
  expect(tentative.validUntil).toBe(until);
  expect(f.source.assertFinalized(f.tx)).toBe(finalLease);
});
