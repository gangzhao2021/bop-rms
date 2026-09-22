import { appendAuditRecordInTransaction } from "@bop/audit";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresAdditionalDiningBatchStore } from "../infrastructure/persistence/additional-dining-batch-store.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import { parseAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch.js";
import { orderWriteFixture, orderCapacityLinkFixture } from "./order-creation-store.fixture.js";
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(async () => ({})),
}));
beforeEach(() => vi.mocked(appendAuditRecordInTransaction).mockReset());
function fixture() {
  const original = orderWriteFixture({ at: "2026-09-13T12:01:00.000Z", dineIn: true });
  const { record } = original.request;
  const snapshot = parseAdditionalDiningBatchSnapshot({
    orderReference: record.order.orderReference,
    brandReference: record.order.brandReference,
    storeReference: record.order.storeReference,
    diningSessionReference: record.order.diningSessionReference,
    guestSessionReference: record.guestSessionReference,
    originalOrderCreatedAt: "2026-09-13T12:00:00.000Z",
    expectedOrderVersion: 2,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: record.order.batches[0],
    items: record.items,
  });
  const parent: Record<string, unknown> = {
    order_type: "DineIn",
    dining_session_id: snapshot.diningSessionReference,
    created_at: snapshot.originalOrderCreatedAt,
    closure_status: "Open",
    revision_id: "0190ed31-0000-7000-8000-000000000001",
    version: 2,
    kind: "Acceptance",
    occurred_at: snapshot.originalOrderCreatedAt,
    batch_count: 1,
  };
  const state = {
    audit: {
      ...original.request.audit,
      actionCode: "ORDERING_ADDITIONAL_BATCH_SUBMIT",
      targetType: "OrderingOrderBatch",
      targetId: snapshot.batch.orderBatchReference,
      reasonCode: "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT",
    } as Record<string, unknown>,

    requiredPolicies: [] as unknown[],
    policyValidUntil: original.request.checkoutValidationEvidence.validUntil as string,

    details: {
      schemaVersion: 1,
      detailsReference: "0190ed31-0000-7000-8000-000000000083",
      detailsVersion: 1,
      brandReference: snapshot.brandReference,
      storeReference: snapshot.storeReference,
      guestSessionReference: snapshot.guestSessionReference,
      cartReference: snapshot.batch.sourceCartReference,
      cartVersion: snapshot.batch.sourceCartVersion,
      quoteReference: snapshot.batch.quoteReference,
      quoteVersion: 1,
      orderType: "DineIn",
      pickupContact: null,
      receipt: { choice: "InSession", email: null },
      policies: [],
      recordedAt: snapshot.batch.submittedAt,
    } as Record<string, unknown> | null,

    checkout: {
      schemaVersion: 1,
      checkoutSessionReference: "0190ed31-0000-7000-8000-000000000081",
      createOperationReference: "0190ed31-0000-7000-8000-000000000082",
      submissionReference: snapshot.batch.submissionReference,
      paymentOperationReference: orderCapacityLinkFixture(original).paymentOperationReference,
      validation: original.request.checkoutValidationEvidence,
      createdAt: snapshot.batch.submittedAt,
    } as unknown,
    evidence: original.request.checkoutValidationEvidence as unknown,
    capacityLink: orderCapacityLinkFixture(original) as unknown,
    observedAt: snapshot.batch.submittedAt as string,
    expireDuringFinalize: false,
    finalizeObservedAt: "" as string,
    prior: "",
    denyAt: 0,
    authorityCalls: 0,
    finalizeCalls: 0,
    failAt: "",
    zeroAt: "",
    failFinalize: false,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      if (state.failAt && sql.includes(state.failAt))
        throw new Error("synthetic private database error");
      let rows: Record<string, unknown>[] = [];
      if (sql.startsWith("SELECT snapshot_json") && sql.includes("additional_dining_batch_record"))
        rows = state.prior ? [{ snapshot: state.prior }] : [];
      else if (sql.startsWith("SELECT h.order_type")) rows = [parent];
      else if (sql.startsWith("SELECT snapshot_json FROM rms_ordering.checkout_session_record"))
        rows = state.checkout ? [{ snapshot_json: state.checkout }] : [];
      else if (sql.includes("FROM rms_ordering.checkout_details_record"))
        rows = state.details ? [{ snapshot: state.details }] : [];
      else if (sql.startsWith("SELECT cart_id")) rows = [{ cart_id: original.cart.cartReference }];
      else if (sql.startsWith("SELECT jsonb_build_object")) rows = [{ cart: original.cart }];
      else if (sql.startsWith("SELECT clock_timestamp")) rows = [{ observed_at: state.observedAt }];
      else if (
        !/^(INSERT INTO |UPDATE rms_ordering.cart |DELETE FROM rms_ordering.cart_line |SELECT set_config|SELECT pg_advisory|SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(
          sql,
        )
      )
        throw new Error("unexpected query");
      return {
        rowCount:
          state.zeroAt && sql.includes(state.zeroAt)
            ? 0
            : sql.startsWith("DELETE FROM")
              ? original.cart.items.length
              : 1,
        rows: rows as Row[],
      };
    },
  };
  const store = createPostgresAdditionalDiningBatchStore({
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    audit: async () => state.audit,
    eventReference: () => "0190ed31-0000-7000-8000-000000000098",
    currentPolicies: async (transaction, request) => {
      expect(transaction).toBe(tx);
      return {
        brandReference: request.brandReference,
        storeReference: request.storeReference,
        orderType: request.orderType,
        checkedAt: request.observedAt,
        validUntil: state.policyValidUntil,
        required: state.requiredPolicies,
      };
    },
    authorize: async () => ++state.authorityCalls !== state.denyAt,
    finalize: async (transaction, candidate) => {
      expect(transaction).toBe(tx);
      expect(candidate).toEqual(snapshot);
      state.finalizeCalls++;
      if (state.finalizeObservedAt) state.observedAt = state.finalizeObservedAt;
      if (state.expireDuringFinalize)
        state.observedAt = original.request.checkoutValidationEvidence.validUntil;
      if (state.failFinalize) throw new Error("synthetic finalization failure");
    },
  });
  return {
    tx,
    snapshot,
    parent,
    state,
    calls,
    append: (value: unknown = snapshot) =>
      store.append({
        transaction: tx,
        snapshot: value,
        checkoutValidationEvidence: state.evidence,
        capacityLink: state.capacityLink,
      }),
  };
}
it("writes additional facts and exact predecessor without reallocating Order identity", async () => {
  const f = fixture();
  expect((await f.append()).status).toBe("Created");
  const writes = f.calls.filter(({ sql }) => sql.startsWith("INSERT"));
  expect(writes).toHaveLength(7 + f.snapshot.items.length);
  expect(writes.some(({ sql }) => /order_number|order_header/.test(sql))).toBe(false);
  expect(writes.find(({ sql }) => sql.includes("order_revision"))?.values).toEqual([
    f.snapshot.batch.submissionReference,
    f.snapshot.brandReference,
    f.snapshot.storeReference,
    f.snapshot.orderReference,
    3,
    2,
    f.parent.revision_id,
    f.snapshot.batch.submittedAt,
  ]);
  expect(f.state.finalizeCalls).toBe(1);
  expect(f.calls.at(-1)?.sql).toBe("RELEASE SAVEPOINT ordering_additional_batch");
  const locks = f.calls.filter(({ sql }) => sql.includes("pg_advisory"));
  expect(locks[0]?.values[0]).toMatch(/^OrderingOrderDisposition:/);
  expect(locks[1]?.values[0]).toMatch(/^OrderingAdditionalSubmission:/);
});
it("recovers exact original before parent/finalization work", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  f.parent.version = 99;
  f.state.failFinalize = true;
  expect((await f.append()).status).toBe("Existing");
  expect(f.state.finalizeCalls).toBe(0);
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT") || sql.startsWith("SELECT h."))).toBe(
    false,
  );
});
it("rejects changed replay intent", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  await expect(f.append({ ...f.snapshot, expectedOrderVersion: 3 })).rejects.toThrow();
  expect(f.state.finalizeCalls).toBe(0);
});
it.each([
  ["version", 1],
  ["batch_count", 2],
  ["kind", "Termination"],
  ["order_type", "Pickup"],
  ["closure_status", "Closed"],
  ["dining_session_id", "0190ed31-0000-7000-8000-000000000099"],
  ["occurred_at", "2026-09-13T12:02:00.000Z"],
])("rejects ineligible parent %s before mutation", async (field, value) => {
  const f = fixture();
  f.parent[field as string] = value;
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it.each([
  "order_submission_record",
  "order_batch ",
  "order_item ",
  "order_revision ",
  "additional_dining_batch_record ",
])("rolls back SQL failure at %s", async (table) => {
  const f = fixture();
  f.state.failAt = "INSERT INTO rms_ordering." + table;
  await expect(f.append()).rejects.toThrow("additional Dining batch persistence is unavailable");
  expect(f.calls.slice(-2).map(({ sql }) => sql)).toEqual([
    "ROLLBACK TO SAVEPOINT ordering_additional_batch",
    "RELEASE SAVEPOINT ordering_additional_batch",
  ]);
});
it("rolls back finalization failure after owner writes", async () => {
  const f = fixture();
  f.state.failFinalize = true;
  await expect(f.append()).rejects.toThrow("additional Dining batch persistence is unavailable");
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});
it.each([1, 2, 3])("rejects authorization revocation on check %i", async (denyAt) => {
  const f = fixture();
  f.state.denyAt = denyAt;
  await expect(f.append()).rejects.toThrow();
  if (denyAt === 1) expect(f.calls).toHaveLength(1);
  else expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});
it("rejects missing write result and rolls back", async () => {
  const f = fixture();
  f.state.zeroAt = "INSERT INTO rms_ordering.order_revision ";
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});

it.each(["DELETE FROM rms_ordering.cart_line", "UPDATE rms_ordering.cart"])(
  "rolls back Batch when shared Cart mutation fails at %s",
  async (sql) => {
    const f = fixture();
    f.state.failAt = sql;
    await expect(f.append()).rejects.toThrow();
    expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
  },
);
it("advances only the submitted Cart version after finalization", async () => {
  const f = fixture();
  await f.append();
  expect(f.calls.find(({ sql }) => sql.startsWith("UPDATE rms_ordering.cart"))?.values).toEqual([
    f.snapshot.brandReference,
    f.snapshot.storeReference,
    f.snapshot.batch.sourceCartReference,
    f.snapshot.batch.sourceCartVersion + 1,
    f.snapshot.batch.submittedAt,
    expect.any(String),
    f.snapshot.batch.sourceCartVersion,
  ]);
});

it("rejects missing checkout evidence before any mutation", async () => {
  const f = fixture();
  f.state.evidence = null;
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("rejects future submission time before mutation", async () => {
  const f = fixture();
  f.state.observedAt = "2026-09-13T12:00:59.999Z";
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("rolls back when checkout evidence expires during finalization", async () => {
  const f = fixture();
  f.state.expireDuringFinalize = true;
  await expect(f.append()).rejects.toThrow();
  expect(f.state.finalizeCalls).toBe(1);
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});
it("recovers original submission even when new checkout evidence is unavailable", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  f.state.evidence = null;
  expect((await f.append()).status).toBe("Existing");
  expect(f.state.finalizeCalls).toBe(0);
});

it("rejects missing Dining settlement commitment before writes", async () => {
  const f = fixture();
  f.state.capacityLink = null;
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("rejects a commitment from another Dining Session", async () => {
  const f = fixture();
  f.state.capacityLink = {
    ...(f.state.capacityLink as Record<string, unknown>),
    ownerContextReference: "0190ed31-0000-7000-8000-000000000099",
  };
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("rolls back when persistence of the payment commitment link fails", async () => {
  const f = fixture();
  f.state.failAt = "INSERT INTO rms_ordering.order_capacity_link";
  await expect(f.append()).rejects.toThrow();
  expect(f.state.finalizeCalls).toBe(0);
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});

it("rejects absent persisted checkout before any additional writes", async () => {
  const f = fixture();
  f.state.checkout = null;
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("rejects a persisted checkout for a different payment operation", async () => {
  const f = fixture();
  f.state.checkout = {
    ...(f.state.checkout as Record<string, unknown>),
    paymentOperationReference: "0190ed31-0000-7000-8000-000000000099",
  };
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("does not require fresh checkout history to replay an already stored submission", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  f.state.checkout = null;
  expect((await f.append()).status).toBe("Existing");
  expect(f.calls.some(({ sql }) => sql.includes("FROM rms_ordering.checkout_session_record"))).toBe(
    false,
  );
});

it("binds original checkout details to the additional submission", async () => {
  const f = fixture();
  await f.append();
  expect(
    f.calls.find(({ sql }) =>
      sql.startsWith("INSERT INTO rms_ordering.order_checkout_details_link"),
    )?.values,
  ).toEqual([
    f.snapshot.brandReference,
    f.snapshot.storeReference,
    f.snapshot.batch.submissionReference,
    f.snapshot.orderReference,
    f.state.details?.detailsReference,
    f.state.details?.detailsVersion,
  ]);
});
it.each(["missing", "staleCart", "foreignQuote"])(
  "rejects %s checkout details before mutation",
  async (kind) => {
    const f = fixture();
    if (kind === "missing") f.state.details = null;
    else if (f.state.details) {
      if (kind === "staleCart") f.state.details.cartVersion = 99;
      else f.state.details.quoteReference = "0190ed31-0000-7000-8000-000000000099";
    }
    await expect(f.append()).rejects.toThrow();
    expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
  },
);
it("rolls back if additional checkout detail linkage fails", async () => {
  const f = fixture();
  f.state.failAt = "INSERT INTO rms_ordering.order_checkout_details_link";
  await expect(f.append()).rejects.toThrow();
  expect(f.state.finalizeCalls).toBe(0);
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});
it("replays the saved additional submission without selecting newer checkout details", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  f.state.details = null;
  expect((await f.append()).status).toBe("Existing");
  expect(f.calls.some(({ sql }) => sql.includes("checkout_details"))).toBe(false);
});

it("rejects newly required policy acknowledgments before mutation", async () => {
  const f = fixture();
  f.state.requiredPolicies = [
    {
      documentReference: "0190ed31-0000-7000-8000-000000000094",
      documentVersion: 1,
      documentDigest: "sha256:" + "a".repeat(64),
      purposeCode: "ORDER_TERMS",
    },
  ];
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});
it("rejects expired current policy evidence before mutation", async () => {
  const f = fixture();
  f.state.policyValidUntil = f.state.observedAt;
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
});

it("rolls back when policy expires during finalization while checkout remains valid", async () => {
  const f = fixture();
  f.state.policyValidUntil = new Date(Date.parse(f.state.observedAt) + 1).toISOString();
  f.state.finalizeObservedAt = f.state.policyValidUntil;
  await expect(f.append()).rejects.toThrow();
  expect(f.state.finalizeCalls).toBe(1);
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});

it("appends validated Batch audit on the same transaction", async () => {
  const f = fixture();
  await f.append();
  expect(appendAuditRecordInTransaction).toHaveBeenCalledWith(f.tx, f.state.audit);
  expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(1);
});
it.each(["brandId", "storeId", "targetId"])(
  "rejects foreign audit %s and rolls back",
  async (field) => {
    const f = fixture();
    f.state.audit[field] = "0190ed31-0000-7000-8000-000000000099";
    await expect(f.append()).rejects.toThrow();
    expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
    expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
  },
);
it("rolls back owner writes if audit append fails", async () => {
  const f = fixture();
  vi.mocked(appendAuditRecordInTransaction).mockRejectedValueOnce(
    new Error("synthetic audit failure"),
  );
  await expect(f.append()).rejects.toThrow();
  expect(f.state.finalizeCalls).toBe(0);
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});
it("does not append another audit on exact replay", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  expect((await f.append()).status).toBe("Existing");
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
});

it("writes the registered submission envelope using the actual Outbox adapter", async () => {
  const f = fixture();
  await f.append();
  const values = f.calls.find(({ sql }) =>
    sql.startsWith("INSERT INTO platform_eventing.outbox_event"),
  )?.values;
  expect(values?.slice(1, 9)).toEqual([
    "OrderSubmitted",
    1,
    "@rms/ordering",
    f.snapshot.brandReference,
    f.snapshot.storeReference,
    "Order",
    f.snapshot.orderReference,
    "3",
  ]);
  expect(values?.[9]).toBe(f.state.audit.correlationId);
  expect(values?.[10]).toBe(f.snapshot.batch.submissionReference);
  expect(JSON.parse(String(values?.[13]))).toMatchObject({
    orderReference: f.snapshot.orderReference,
    orderBatchReference: f.snapshot.batch.orderBatchReference,
    submissionReference: f.snapshot.batch.submissionReference,
    itemCount: f.snapshot.items.length,
    batchSequence: 2,
  });
});
it.each(["failure", "unconfirmed"])("rolls back %s Outbox write", async (kind) => {
  const f = fixture();
  if (kind === "failure") f.state.failAt = "INSERT INTO platform_eventing.outbox_event";
  else f.state.zeroAt = "INSERT INTO platform_eventing.outbox_event";
  await expect(f.append()).rejects.toThrow();
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_additional_batch");
});
it("does not emit another Outbox event on exact replay", async () => {
  const f = fixture();
  f.state.prior = encodeAdditionalDiningBatchSnapshot(f.snapshot);
  expect((await f.append()).status).toBe("Existing");
  expect(f.calls.some(({ sql }) => sql.includes("platform_eventing.outbox_event"))).toBe(false);
});
