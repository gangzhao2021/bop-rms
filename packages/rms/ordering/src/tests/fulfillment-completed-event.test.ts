import { createPostgresPickupOrderCompletionLookup } from "../infrastructure/persistence/order-termination-store.js";
import {
  encodeOrderStatusSnapshot,
  decodeOrderStatusSnapshot,
} from "../application/order-status-snapshot-codec.js";
import { createHash } from "node:crypto";
import {
  createOrderFulfillmentCompletionRecord,
  parseOrderFulfillmentCompletionRecord,
  encodeOrderFulfillmentCompletionRecord,
  decodeOrderFulfillmentCompletionRecord,
  OrderFulfillmentCompletionError,
} from "../application/order-fulfillment-completion-record.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it, vi } from "vitest";
import { createPostgresOrderFulfillmentCompletionStore } from "../infrastructure/persistence/order-fulfillment-completion-store.js";
vi.mock("@bop/audit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@bop/audit")>();
  return {
    ...original,
    appendAuditRecordInTransaction: async (tx: ConsumerTransaction) => {
      await tx.query("SYNTHETIC_AUDIT_APPEND", []);
    },
  };
});
import {
  createFulfillmentCompletedEventConsumerService,
  parseFulfillmentCompletedEnvelope,
  parseOrderStatusProjection,
  type FulfillmentCompletedEventConsumerPorts,
  type OrderStatusProjection,
} from "../index.js";

const id = (n: number) => `018f6800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-11T15:00:00.000Z";
const refs = {
  event: id(1),
  brand: id(2),
  store: id(3),
  fulfillment: id(4),
  order: id(5),
  handoff: id(6),
  correlation: id(7),
  causation: id(8),
  generation: id(9),
  checkpoint: id(10),
  guest: id(11),
  submission: id(12),
  batch: id(13),
  item: id(14),
};

function event(overrides: Record<string, unknown> = {}) {
  return parseFulfillmentCompletedEnvelope({
    eventId: refs.event,
    eventType: "FulfillmentCompleted",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/fulfillment",
    tenantId: refs.brand,
    storeId: refs.store,
    aggregateType: "Fulfillment",
    aggregateId: refs.fulfillment,
    aggregateVersion: 5n,
    correlationId: refs.correlation,
    causationId: refs.causation,
    actor: { type: "System" },
    payload: {
      fulfillmentReference: refs.fulfillment,
      orderReference: refs.order,
      handoffRecordReference: refs.handoff,
      storeReference: refs.store,
      verificationMethod: "Opaque",
      completedAt: at,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
    ...overrides,
  });
}
function projection(overrides: Record<string, unknown> = {}) {
  return parseOrderStatusProjection({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    generationReference: refs.generation,
    projectedAt: "2026-08-11T14:00:00.000Z",
    freshnessStatus: "Fresh",
    snapshot: {
      sourceVersion: 1,
      sourceCheckpoint: refs.checkpoint,
      sourceDigest: `sha256:${"a".repeat(64)}`,
      orderReference: refs.order,
      brandReference: refs.brand,
      storeReference: refs.store,
      guestSessionReference: refs.guest,
      submissionReference: refs.submission,
      businessDate: "2026-08-11",
      orderNumber: "42",
      orderType: "Pickup",
      sourceChannel: "Qr",
      canonicalPhase: "Submitted",
      closureStatus: "Open",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
      fulfillmentReference: null,
      fulfillmentCompletionEventReference: null,
      fulfillmentCompletedAt: null,
      eta: null,
      submittedAt: "2026-08-11T14:00:00.000Z",
      batches: [
        {
          orderBatchReference: refs.batch,
          submittedAt: "2026-08-11T14:00:00.000Z",
          items: [
            {
              orderItemReference: refs.item,
              displayName: "Synthetic item",
              quantity: 1,
              lineTotal: { amountMinor: 1200n, currencyCode: "CAD" },
            },
          ],
        },
      ],
      ...overrides,
    },
  });
}
function transaction(): ConsumerTransaction {
  const completed = new Set<string>();
  return {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]) {
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        const key = `${values[0]}:${values[1]}`;
        if (completed.has(key)) return { rowCount: 0, rows: [] as Row[] };
        return { rowCount: 1, rows: [{} as Row] };
      }
      if (text.startsWith("SELECT event_type"))
        return {
          rowCount: 1,
          rows: [
            {
              event_type: "FulfillmentCompleted",
              schema_version: 1,
              brand_id: refs.brand,
              store_id: refs.store,
              status: "completed",
            } as Row,
          ],
        };
      if (text.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        completed.add(`${values[0]}:${values[1]}`);
        return { rowCount: 1, rows: [] as Row[] };
      }
      if (/^(SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(text))
        return { rowCount: 0, rows: [] as Row[] };
      throw new Error("unexpected query");
    },
  };
}
function fixture(current: OrderStatusProjection | null = projection()) {
  const sha = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
  let allowed = true,
    failCompletion = false;
  let completionTransaction: ConsumerTransaction | undefined;
  let projectionTransaction: ConsumerTransaction | undefined;
  let completionCalls = 0;
  const completion = createOrderFulfillmentCompletionRecord(
    {
      completionReference: id(30),
      operationReference: id(31),
      auditReference: id(32),
      brandReference: refs.brand,
      storeReference: refs.store,
      orderReference: refs.order,
      orderBatchReference: refs.batch,
      orderType: "Pickup",
      phaseBefore: "Accepted",
      expectedOrderVersion: 2,
      expectedSourceCheckpoint: id(35),
      fulfilledOrderVersion: 3,
      phase: "Fulfilled",
      closureStatus: "Open",
      actorType: "System",
      actorReference: null,
      purposeCode: "OrderFulfillment",
      permissionCode: "order.fulfill",
      workflowVersionReference: id(33),
      transitionReference: id(34),
      completedAt: at,
      recordedAt: at,
      sourceEvent: event(),
    },
    sha,
  );
  let value = current;
  let replacements = 0;
  let corruptSaved = false;
  let projectedAt = at;
  const ports: FulfillmentCompletedEventConsumerPorts = {
    authorization: { authorize: async () => allowed },
    completions: {
      commit: async (transaction) => {
        completionTransaction = transaction;
        completionCalls++;
        if (failCompletion) throw new Error("synthetic owner failure");
        return completion;
      },
    },
    projections: {
      load: async (input) => {
        projectionTransaction = input.transaction;
        return value;
      },
      replace: async (input) => {
        replacements += 1;
        value = input.projection;
        return corruptSaved
          ? parseOrderStatusProjection({
              ...input.projection,
              snapshot: { ...input.projection.snapshot, guestSessionReference: id(62) },
            })
          : input.projection;
      },
    },
    references: { generateGeneration: () => id(20) as never, now: () => projectedAt as never },
    digests: { sha256: sha },
  };
  return {
    service: createFulfillmentCompletedEventConsumerService(ports),
    current: () => value,
    replacements: () => replacements,
    revoke: () => {
      allowed = false;
    },
    failCompletion: () => {
      failCompletion = true;
    },
    completionCalls: () => completionCalls,
    transactions: () => [completionTransaction, projectionTransaction],
    completion,
    corruptSaved: () => {
      corruptSaved = true;
    },
    oldClock: () => {
      projectedAt = "2026-08-11T14:59:59.000Z";
    },
  };
}

describe("WP-1605 FulfillmentCompleted projection", () => {
  it("advances Pickup to Fulfilled + Open exactly once", async () => {
    const state = fixture();
    const tx = transaction();
    expect(state.service.registration.consumerName).toBe("ordering.fulfillment-completed:v2");
    expect(state.service.registration.consumerVersion).toBe(2);
    await expect(state.service.consume(tx, event())).resolves.toEqual({ status: "processed" });
    await expect(state.service.consume(tx, event())).resolves.toEqual({
      status: "duplicate_completed",
    });
    expect(state.replacements()).toBe(1);
    expect(state.transactions()).toEqual([tx, tx]);
    expect(state.completionCalls()).toBe(1);
    expect(state.current()?.snapshot.sourceVersion).toBe(3);
    expect(state.current()?.snapshot.sourceCheckpoint).toBe(state.completion.completionReference);
    expect(state.current()).toMatchObject({
      snapshot: {
        canonicalPhase: "Fulfilled",
        closureStatus: "Open",
        fulfillmentStatus: "Completed",
        fulfillmentReference: refs.fulfillment,
        fulfillmentCompletionEventReference: refs.event,
        fulfillmentCompletedAt: at,
      },
    });
  });
  it("requires current authorization even after Inbox completion", async () => {
    const state = fixture(),
      tx = transaction();
    await state.service.consume(tx, event());
    state.revoke();
    await expect(state.service.consume(tx, event())).rejects.toMatchObject({
      code: "ORDER_STATUS_PERMISSION_DENIED",
    });
    expect(state.completionCalls()).toBe(1);
  });
  it("does not advance projection when owner completion fails and rolls back its savepoint", async () => {
    const state = fixture(),
      inner = transaction(),
      queries: string[] = [];
    state.failCompletion();
    const tx: ConsumerTransaction = {
      query: async (sql, values) => {
        queries.push(sql);
        return inner.query(sql, values);
      },
    };
    await expect(state.service.consume(tx, event())).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
    expect(state.replacements()).toBe(0);
    expect(queries.slice(-2)).toEqual([
      "ROLLBACK TO SAVEPOINT ordering_fulfillment_consumer",
      "RELEASE SAVEPOINT ordering_fulfillment_consumer",
    ]);
  });
  it("rejects a different event instead of accepting an unrelated owner completion", async () => {
    const state = fixture();
    await expect(
      state.service.consume(transaction(), event({ eventId: id(61) })),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE" });
    expect(state.replacements()).toBe(0);
  });
  it("rejects a mismatched saved audience and a projection clock before owner completion", async () => {
    const wrongAudience = fixture();
    wrongAudience.corruptSaved();
    await expect(wrongAudience.service.consume(transaction(), event())).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
    const staleClock = fixture();
    staleClock.oldClock();
    await expect(staleClock.service.consume(transaction(), event())).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
    expect(staleClock.replacements()).toBe(0);
  });
  it("requests retry before the Order projection exists", async () => {
    await expect(fixture(null).service.consume(transaction(), event())).rejects.toMatchObject({
      name: "ConsumerTransactionRollback",
      outcome: { status: "retry_required" },
    });
  });
  it("rejects cross-Store, non-Pickup and conflicting completion facts", async () => {
    await expect(
      fixture(projection({ storeReference: id(30) })).service.consume(transaction(), event()),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_VERSION_CONFLICT" });
    await expect(
      fixture(projection({ orderType: "DineIn" })).service.consume(transaction(), event()),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_VERSION_CONFLICT" });
    const completed = projection({
      canonicalPhase: "Fulfilled",
      fulfillmentStatus: "Completed",
      fulfillmentReference: id(40),
      fulfillmentCompletionEventReference: id(41),
      fulfillmentCompletedAt: at,
    });
    await expect(fixture(completed).service.consume(transaction(), event())).rejects.toMatchObject({
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
  });
  it("rejects extra payload data and mismatched Event scope", () => {
    expect(() => event({ payload: { ...event().payload, customerName: "forbidden" } })).toThrow();
    expect(() => event({ storeId: id(50) })).toThrow();
  });
});

describe("WP-2402 authoritative Order fulfillment record", () => {
  const sha = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const input = () => ({
    completionReference: id(30),
    operationReference: id(31),
    auditReference: id(32),
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    orderType: "Pickup",
    phaseBefore: "Accepted",
    expectedOrderVersion: 2,
    expectedSourceCheckpoint: id(35),
    fulfilledOrderVersion: 3,
    phase: "Fulfilled",
    closureStatus: "Open",
    actorType: "System",
    actorReference: null,
    purposeCode: "OrderFulfillment",
    permissionCode: "order.fulfill",
    workflowVersionReference: id(33),
    transitionReference: id(34),
    completedAt: at,
    recordedAt: "2026-08-11T15:00:01.000Z",
    sourceEvent: event(),
  });
  it("binds the actual completion event and Workflow references without claiming Closed", () => {
    const record = createOrderFulfillmentCompletionRecord(input(), sha);
    expect(record.phase).toBe("Fulfilled");
    expect(record.closureStatus).toBe("Open");
    expect(record.fulfilledOrderVersion).toBe(3);
    const recovered = decodeOrderFulfillmentCompletionRecord(
      encodeOrderFulfillmentCompletionRecord(record, sha),
      sha,
    );
    expect(recovered).toEqual(record);
    expect(Object.isFrozen(recovered.sourceEvent.payload)).toBe(true);
    for (const phaseBefore of ["InProgress", "Ready"])
      expect(
        createOrderFulfillmentCompletionRecord({ ...input(), phaseBefore }, sha).phaseBefore,
      ).toBe(phaseBefore);
  });
  it("rejects terminal/unaccepted sources, automatic closure and mismatched event or clock", () => {
    for (const change of [
      { phaseBefore: "Submitted" },
      { phaseBefore: "Cancelled" },
      { phaseBefore: "Fulfilled" },
      { closureStatus: "Closed" },
      { orderType: "DineIn" },
      { actorReference: refs.guest },
      { storeReference: refs.brand },
      { orderReference: id(39) },
      { completedAt: "2026-08-11T15:00:01.000Z" },
      { recordedAt: "2026-08-11T14:59:59.000Z" },
      { auditReference: id(30) },
      { expectedSourceCheckpoint: undefined },
      { expectedSourceCheckpoint: refs.order },
      { expectedSourceCheckpoint: id(30) },
      { expectedOrderVersion: 1, fulfilledOrderVersion: 2 },
      { expectedOrderVersion: 2147483647, fulfilledOrderVersion: 2147483648 },
      { expectedOrderVersion: 2.5, fulfilledOrderVersion: 3.5 },
    ])
      expect(() => createOrderFulfillmentCompletionRecord({ ...input(), ...change }, sha)).toThrow(
        OrderFulfillmentCompletionError,
      );
  });
  it("rejects extra/accessor fields and tampered owner versions or Workflow decisions", () => {
    expect(() =>
      createOrderFulfillmentCompletionRecord(
        { ...input(), paymentSecret: "synthetic-forbidden" },
        sha,
      ),
    ).toThrow(OrderFulfillmentCompletionError);
    const accessor = input();
    let evaluated = false;
    Object.defineProperty(accessor, "sourceEvent", {
      enumerable: true,
      get: () => {
        evaluated = true;
        return event();
      },
    });
    expect(() => createOrderFulfillmentCompletionRecord(accessor, sha)).toThrow(
      OrderFulfillmentCompletionError,
    );
    expect(evaluated).toBe(false);
    const record = createOrderFulfillmentCompletionRecord(input(), sha);
    for (const change of [
      { expectedSourceCheckpoint: id(42) },
      { workflowVersionReference: id(40) },
      { transitionReference: id(41) },
      { permissionCode: "order.read" },
      { expectedOrderVersion: 3, fulfilledOrderVersion: 4 },
    ])
      expect(() => encodeOrderFulfillmentCompletionRecord({ ...record, ...change }, sha)).toThrow(
        OrderFulfillmentCompletionError,
      );
    expect(() =>
      parseOrderFulfillmentCompletionRecord({ ...record, note: "synthetic-forbidden" }),
    ).toThrow(OrderFulfillmentCompletionError);
  });
  it("rejects unsupported envelopes, lossy event versions and damaged digests", () => {
    const record = createOrderFulfillmentCompletionRecord(input(), sha);
    const encoded = JSON.parse(encodeOrderFulfillmentCompletionRecord(record, sha));
    for (const version of [5, "05", "0", "-1", "5e0", "9223372036854775808", null]) {
      expect(() =>
        decodeOrderFulfillmentCompletionRecord(
          JSON.stringify({
            ...encoded,
            record: {
              ...encoded.record,
              sourceEvent: { ...encoded.record.sourceEvent, aggregateVersion: version },
            },
          }),
          sha,
        ),
      ).toThrow(OrderFulfillmentCompletionError);
    }
    for (const raw of [
      "{}",
      "invalid",
      JSON.stringify({ record: encoded.record }),
      JSON.stringify({ ...encoded, recordVersion: 2 }),
      JSON.stringify({ ...encoded, extra: true }),
      JSON.stringify({
        ...encoded,
        record: { ...encoded.record, sourceDigest: "sha256:" + "f".repeat(64) },
      }),
    ])
      expect(() => decodeOrderFulfillmentCompletionRecord(raw, sha)).toThrow(
        OrderFulfillmentCompletionError,
      );
  });
  it("preserves semantic identity after JSONB reorders nested object keys", () => {
    const record = createOrderFulfillmentCompletionRecord(input(), sha);
    const encoded = encodeOrderFulfillmentCompletionRecord(record, sha);
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(object)
            .reverse()
            .map((key) => [key, reorder(object[key])]),
        );
      }
      return value;
    };
    const recovered = decodeOrderFulfillmentCompletionRecord(
      JSON.stringify(reorder(JSON.parse(encoded))),
      sha,
    );
    expect(recovered).toEqual(record);
    expect(encodeOrderFulfillmentCompletionRecord(recovered, sha)).toBe(encoded);
  });
  function writerFixture(
    overrides: {
      prior?: string;
      allowed?: boolean;
      workflow?: boolean;
      checkpoint?: string;
      failAt?: "insert" | "audit" | "revision";
      orderType?: string;
    } = {},
  ) {
    const calls: string[] = [];
    let workflowCalls = 0;
    const tx: ConsumerTransaction = {
      async query<Row = Record<string, unknown>>(sql: string) {
        calls.push(sql);
        let rows: Record<string, unknown>[] = [];
        if (sql.includes("completion_record_json::text"))
          rows = overrides.prior ? [{ record: overrides.prior }] : [];
        else if (sql.startsWith("SELECT completion_id")) rows = [];
        else if (sql.startsWith("SELECT h.aggregate_version"))
          rows = [
            {
              aggregate_version: 1,
              canonical_phase: "Submitted",
              submission_id: id(60),
              submitted_at: "2026-08-11T14:00:00.000Z",
            },
          ];
        else if (sql.startsWith("SELECT acceptance_id"))
          rows = [
            {
              acceptance_id: overrides.checkpoint ?? id(35),
              order_batch_id: refs.batch,
              expected_order_version: 1,
              accepted_order_version: 2,
              accepted_at: "2026-08-11T14:01:00.000Z",
            },
          ];
        else if (sql.includes("FROM rms_ordering.order_termination_record")) rows = [];
        else if (sql.startsWith("SELECT order_type"))
          rows = [{ order_type: overrides.orderType ?? "Pickup" }];
        else if (sql.startsWith("INSERT INTO rms_ordering.order_fulfillment_completion_record")) {
          if (overrides.failAt === "insert") throw new Error("synthetic database failure");
        } else if (sql.startsWith("INSERT INTO rms_ordering.order_revision")) {
          if (overrides.failAt === "revision") throw new Error("synthetic revision failure");
        } else if (sql === "SYNTHETIC_AUDIT_APPEND") {
          if (overrides.failAt === "audit") throw new Error("synthetic audit failure");
        } else if (
          !/^(SELECT set_config|SELECT pg_advisory|SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(
            sql,
          )
        ) {
          throw new Error("unexpected query");
        }
        return { rowCount: 1, rows: rows as Row[] };
      },
    };
    const store = createPostgresOrderFulfillmentCompletionStore({
      brandReference: refs.brand,
      storeReference: refs.store,
      sha256: sha,
      authorize: async () => overrides.allowed !== false,
      validateCurrentWorkflow: async () => {
        workflowCalls++;
        return overrides.workflow !== false;
      },
      audit: async (r) => ({
        auditId: r.auditReference,
        brandId: r.brandReference,
        storeId: r.storeReference,
        actor: { type: "System" },
        actionCode: "ORDER_FULFILLED",
        targetType: "Order",
        targetId: r.orderReference,
        correlationId: r.operationReference,
        occurredAt: r.recordedAt,
        afterSummary: { phase: "Fulfilled", closureStatus: "Open" },
        reasonCode: "SYNTHETIC_COMPLETION",
        sourceChannel: "SYSTEM",
        dataClassification: "Restricted",
        retentionPolicyCode: "TRANSACTIONAL",
        retentionPolicyVersion: 1,
      }),
    });
    return { tx, store, calls, workflowCalls: () => workflowCalls };
  }
  it("writes completion and Audit in the caller transaction after current source and Workflow", async () => {
    const f = writerFixture(),
      record = createOrderFulfillmentCompletionRecord(input(), sha);
    await expect(f.store.commit({ transaction: f.tx, record })).resolves.toEqual({
      status: "Created",
      record,
    });
    expect(f.workflowCalls()).toBe(1);
    expect(f.calls.findIndex((s) => s.startsWith("SAVEPOINT "))).toBeLessThan(
      f.calls.findIndex((s) =>
        s.startsWith("INSERT INTO rms_ordering.order_fulfillment_completion_record"),
      ),
    );
    expect(f.calls.at(-3)).toBe("SYNTHETIC_AUDIT_APPEND");
    expect(f.calls.at(-2)).toMatch(/^INSERT INTO rms_ordering.order_revision/);
    expect(f.calls.at(-1)).toBe("RELEASE SAVEPOINT ordering_fulfillment_completion");
  });
  it("recovers the exact original before current Workflow, while requiring current permission", async () => {
    const record = createOrderFulfillmentCompletionRecord(input(), sha);
    const prior = encodeOrderFulfillmentCompletionRecord(record, sha);
    const f = writerFixture({ prior, workflow: false, checkpoint: id(61) });
    await expect(f.store.commit({ transaction: f.tx, record })).resolves.toEqual({
      status: "AlreadyCommitted",
      record,
    });
    expect(f.workflowCalls()).toBe(0);
    expect(f.calls.some((s) => s.startsWith("INSERT") || s.includes("order_header"))).toBe(false);
    const denied = writerFixture({ prior, allowed: false });
    await expect(denied.store.commit({ transaction: denied.tx, record })).rejects.toThrow(
      OrderFulfillmentCompletionError,
    );
    expect(denied.calls.some((s) => s.includes("completion_record_json"))).toBe(false);
  });
  it("rejects changed retry provenance instead of treating it as a new completion", async () => {
    const record = createOrderFulfillmentCompletionRecord(input(), sha);
    const f = writerFixture({ prior: encodeOrderFulfillmentCompletionRecord(record, sha) });
    const changed = createOrderFulfillmentCompletionRecord(
      { ...input(), transitionReference: id(62) },
      sha,
    );
    await expect(f.store.commit({ transaction: f.tx, record: changed })).rejects.toMatchObject({
      code: "ORDER_FULFILLMENT_COMPLETION_CONFLICT",
    });
    expect(f.workflowCalls()).toBe(0);
  });
  it("rejects stale checkpoints, non-Pickup and denied Workflow before writing", async () => {
    for (const options of [{ checkpoint: id(63) }, { orderType: "DineIn" }, { workflow: false }]) {
      const f = writerFixture(options);
      await expect(
        f.store.commit({
          transaction: f.tx,
          record: createOrderFulfillmentCompletionRecord(input(), sha),
        }),
      ).rejects.toThrow(OrderFulfillmentCompletionError);
      expect(f.calls.some((s) => s.startsWith("INSERT"))).toBe(false);
    }
  });
  it("rolls back the savepoint on record or Audit failure without exposing database errors", async () => {
    for (const failAt of ["insert", "audit", "revision"] as const) {
      const f = writerFixture({ failAt });
      await expect(
        f.store.commit({
          transaction: f.tx,
          record: createOrderFulfillmentCompletionRecord(input(), sha),
        }),
      ).rejects.toMatchObject({
        code: "ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE",
        message: "order fulfillment completion is unavailable",
      });
      expect(f.calls.slice(-2)).toEqual([
        "ROLLBACK TO SAVEPOINT ordering_fulfillment_completion",
        "RELEASE SAVEPOINT ordering_fulfillment_completion",
      ]);
    }
  });
});

describe("persisted Order status snapshot money", () => {
  it("roundtrips JSONB key order and signed bigint boundaries without losing minor units", () => {
    for (const amount of [0n, 9223372036854775807n, -9223372036854775808n]) {
      const source = projection().snapshot;
      const snapshot = {
        ...source,
        batches: source.batches.map((batch) => ({
          ...batch,
          items: batch.items.map((item) => ({
            ...item,
            lineTotal: { ...item.lineTotal, amountMinor: amount },
          })),
        })),
      };
      const encoded = JSON.parse(encodeOrderStatusSnapshot(snapshot));
      const reordered = Object.fromEntries(Object.entries(encoded).reverse());
      expect(decodeOrderStatusSnapshot(JSON.stringify(reordered))).toEqual(snapshot);
    }
  });
  it("rejects numeric, noncanonical, overflow and missing minor units", () => {
    for (const amount of [
      1200,
      "01",
      "-0",
      "1e3",
      "1.5",
      "9223372036854775808",
      "-9223372036854775809",
      null,
    ]) {
      const encoded = JSON.parse(encodeOrderStatusSnapshot(projection().snapshot));
      encoded.batches[0].items[0].lineTotal.amountMinor = amount;
      expect(() => decodeOrderStatusSnapshot(JSON.stringify(encoded))).toThrow();
    }
  });
});

describe("Pickup completion Order association lookup", () => {
  function lookup(rows: Record<string, unknown>[], allowed = true) {
    const queries: string[] = [];
    const tx: ConsumerTransaction = {
      async query<Row = Record<string, unknown>>(sql: string) {
        queries.push(sql);
        const result = sql.startsWith("SELECT h.order_type,b.order_batch_id") ? rows : [];
        return { rows: result as Row[], rowCount: result.length };
      },
    };
    const reader = createPostgresPickupOrderCompletionLookup({
      brandReference: refs.brand,
      storeReference: refs.store,
      authorize: async () => allowed,
    });
    return {
      queries,
      read: () => reader.loadByOrder({ transaction: tx, orderReference: refs.order }),
    };
  }
  const row = { order_type: "Pickup", order_batch_id: id(70), submission_id: id(71) };
  it("resolves the unique owner association and returns null for absent Order", async () => {
    await expect(lookup([row]).read()).resolves.toEqual({
      brandReference: refs.brand,
      storeReference: refs.store,
      orderReference: refs.order,
      orderBatchReference: id(70),
      submissionReference: id(71),
    });
    await expect(lookup([]).read()).resolves.toBeNull();
  });
  it("rejects Dining and ambiguous Batch associations rather than selecting one", async () => {
    for (const rows of [
      [{ ...row, order_type: "DineIn" }],
      [row, { ...row, order_batch_id: id(72) }],
    ]) {
      await expect(lookup(rows).read()).rejects.toMatchObject({
        code: "ORDER_TERMINATION_CONFLICT",
      });
    }
  });
  it("requires current authority before reading Order associations", async () => {
    const denied = lookup([row], false);
    await expect(denied.read()).rejects.toMatchObject({ code: "ORDER_TERMINATION_UNAVAILABLE" });
    expect(denied.queries.some((sql) => sql.includes("rms_ordering"))).toBe(false);
  });
});
