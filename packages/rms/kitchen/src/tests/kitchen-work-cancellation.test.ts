import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it, vi } from "vitest";

import {
  createKitchenWorkCancelledEnvelope,
  createPostgresKitchenBatchCancellation,
  KitchenBatchCancellationError,
  listStoreStartedKitchenBatches,
  parseKitchenWorkCancelledEnvelope,
  parseKitchenWorkLifecycleEnvelope,
} from "../index.js";
import { listStoreKitchenOrderItemStates } from "../index.js";
import { kitchenBatchCancellationEvidenceDigest } from "../infrastructure/persistence/kitchen-work-cancellation-store.js";

const id = (n: number) => `0198c000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const brand = id(1);
const store = id(2);
const ticket = id(3);
const order = id(4);
const batch = id(5);
const createdAt = "2026-08-11T11:00:00.000Z";
const cancelledAt = "2026-08-11T12:00:00.000Z";

interface ItemRow {
  kitchen_work_item_id: string;
  order_id: string;
  order_batch_id: string;
  order_item_id: string;
  version: string;
  status: string;
  updated_at: string;
}

function item(n: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    kitchen_work_item_id: id(100 + n),
    order_id: order,
    order_batch_id: batch,
    order_item_id: id(200 + n),
    version: "1",
    status: "Queued",
    updated_at: createdAt,
    ...overrides,
  };
}

function harness(
  state: {
    ticket?: Record<string, unknown> | null;
    items?: ItemRow[];
    started?: boolean | readonly string[];
    cancellations?: Record<string, unknown>[];
    readyLines?: readonly string[];
  } = {},
) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const ticketRow =
    state.ticket === null
      ? null
      : {
          kitchen_ticket_id: ticket,
          order_id: order,
          status: "Open",
          version: "2",
          updated_at: createdAt,
          ...state.ticket,
        };
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push({ sql, values });
    const result = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
    if (sql.includes("FROM rms_kitchen.kitchen_ticket WHERE"))
      return result(ticketRow === null ? [] : [ticketRow]);
    if (sql.includes("FROM rms_kitchen.kitchen_work_item WHERE"))
      return result(state.items ?? [item(1), item(2)]);
    if (sql.includes("FROM rms_kitchen.kitchen_work_cancellation"))
      return result(state.cancellations ?? []);
    if (sql.includes("FROM rms_kitchen.kitchen_order_item_ready_result"))
      return result((state.readyLines ?? []).map((line) => ({ order_item_id: line })));
    if (sql.includes("KITCHEN_WORK_ITEM_STARTED")) {
      const started = state.started;
      const targeted = (values[3] ?? []) as readonly string[];
      return result(
        started === true ||
          (Array.isArray(started) && started.some((value) => targeted.includes(value)))
          ? [{}]
          : [],
      );
    }
    if (sql.startsWith("SELECT") && sql.includes("platform_audit.audit_chain_head"))
      return result([{ next_sequence: "1", previous_hash: null, recorded_at: cancelledAt }]);
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return result([{ next_sequence: "2" }], 1);
    if (sql.startsWith("UPDATE")) return result([], 1);
    return result([], 1);
  });
  return { calls, transaction: { query } as unknown as ConsumerTransaction };
}

let sequence = 900;
const input = (overrides: Record<string, unknown> = {}) => ({
  orderReference: order,
  orderBatchReference: batch,
  operationReference: id(10),
  orderCancellationReference: id(11),
  actorReference: id(12),
  cancelledAt,
  auditReference: id(13),
  eventReference: id(14),
  nextReference: () => id(sequence++),
  ...overrides,
});

const cancellation = (allowed = true) =>
  createPostgresKitchenBatchCancellation({
    brandReference: brand,
    storeReference: store,
    tenantReference: id(99),
    authorize: async () => allowed,
  });

function insertedRows(calls: { sql: string; values: readonly unknown[] }[]) {
  return calls
    .filter((call) => call.sql.startsWith("INSERT INTO rms_kitchen.kitchen_work_cancellation"))
    .map((call) => ({
      kitchen_work_cancellation_id: call.values[0],
      operation_id: call.values[1],
      kitchen_ticket_id: call.values[4],
      kitchen_work_item_id: call.values[5],
      order_id: call.values[6],
      order_batch_id: call.values[7],
      order_item_id: call.values[8],
      before_status: call.values[9],
      expected_ticket_version: call.values[10],
      result_ticket_version: call.values[11],
      expected_work_item_version: call.values[12],
      result_work_item_version: call.values[13],
      actor_id: call.values[14],
      order_cancellation_id: call.values[16],
      evidence_digest: call.values[17],
      event_id: call.values[18],
      audit_id: call.values[19],
      cancelled_at: new Date(String(call.values[20])),
    }));
}

describe("Kitchen staff batch cancellation (WP-2423 Q6)", () => {
  it("round-trips one strict KitchenWorkCancelled event per batch", () => {
    const envelope = createKitchenWorkCancelledEnvelope({
      eventReference: id(14),
      operationReference: id(10),
      actorReference: id(12),
      brandReference: brand,
      storeReference: store,
      payload: {
        kitchenTicketReference: ticket,
        orderReference: order,
        orderBatchReference: batch,
        orderCancellationReference: id(11),
        ticketVersion: "4",
        reasonCode: "ORDER_CANCELLED_BEFORE_PREPARATION",
        workItems: [
          {
            kitchenWorkItemReference: id(101),
            orderItemReference: id(201),
            fromStatus: "Queued",
            toStatus: "Cancelled",
            workItemVersion: "2",
          },
        ],
        cancelledAt,
      },
    });
    expect(envelope).toMatchObject({
      eventType: "KitchenWorkCancelled",
      tenantId: brand,
      aggregateVersion: 4n,
      causationId: id(10),
      correlationId: id(11),
    });
    expect(parseKitchenWorkCancelledEnvelope({ ...envelope })).toEqual(envelope);
    // Kitchen lifecycle consumers (inventory consumption) refuse the cancellation event.
    expect(() => parseKitchenWorkLifecycleEnvelope({ ...envelope })).toThrow();
    for (const invalid of [
      { ...envelope, aggregateVersion: 3n },
      { ...envelope, eventId: id(10) },
      { ...envelope, payload: { ...envelope.payload, workItems: [] } },
      { ...envelope, payload: { ...envelope.payload, reasonCode: "SOLD_OUT" } },
    ])
      expect(() => parseKitchenWorkCancelledEnvelope(invalid)).toThrow();
  });

  it("cancels every queued or accepted item with sequential ticket versions, one Audit and one Event", async () => {
    const test = harness();
    const result = await cancellation().cancel(test.transaction, input());
    expect(result).toMatchObject({
      status: "Cancelled",
      kitchenTicketReference: ticket,
      workItemCount: 2,
    });
    const lockOrder = test.calls.map((call) => call.sql.split(" ").slice(0, 4).join(" "));
    expect(test.calls[0]?.sql).toMatch(/kitchen_ticket .*FOR NO KEY UPDATE$/u);
    expect(test.calls[1]?.sql).toMatch(
      /ORDER BY order_item_id,kitchen_work_item_id FOR NO KEY UPDATE$/u,
    );
    expect(
      lockOrder.filter((sql) => sql.startsWith("UPDATE rms_kitchen.kitchen_ticket")),
    ).toHaveLength(2);
    const inserted = test.calls.filter((call) =>
      call.sql.startsWith("INSERT INTO rms_kitchen.kitchen_work_cancellation"),
    );
    expect(inserted.map((call) => call.values.slice(10, 14))).toEqual([
      ["2", "3", "1", "2"],
      ["3", "4", "1", "2"],
    ]);
    expect(
      test.calls.filter((call) => call.sql.includes("platform_audit.audit_record")),
    ).toHaveLength(1);
    const outbox = test.calls.filter((call) => call.sql.includes("outbox_event"));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.values.slice(0, 2)).toEqual([id(14), "KitchenWorkCancelled"]);
    expect(outbox[0]?.values[8]).toBe("4");
    expect(result.evidenceDigest).toBe(
      kitchenBatchCancellationEvidenceDigest({
        orderReference: order,
        orderBatchReference: batch,
        kitchenTicketReference: ticket,
        items: [1, 2].map((n, index) => ({
          workItemReference: id(100 + n),
          orderItemReference: id(200 + n),
          beforeStatus: "Queued" as const,
          expectedTicketVersion: 2n + BigInt(index),
          resultTicketVersion: 3n + BigInt(index),
          expectedWorkItemVersion: 1n,
          resultWorkItemVersion: 2n,
        })),
      }),
    );
  });

  it("allows a paid batch whose kitchen ticket does not exist yet", async () => {
    const test = harness({ ticket: null });
    const result = await cancellation().cancel(test.transaction, input());
    expect(result.status).toBe("NoKitchenWork");
    expect(test.calls.some((call) => /^(UPDATE|INSERT)/u.test(call.sql))).toBe(false);
  });

  it.each([
    ["an item in progress", { items: [item(1), item(2, { status: "In Progress", version: "3" })] }],
    ["a completed item", { items: [item(1, { status: "Completed", version: "4" })] }],
    ["a recorded Start", { started: true }],
  ])("refuses the whole batch with %s and writes nothing", async (_name, state) => {
    const test = harness(state);
    await expect(cancellation().cancel(test.transaction, input())).rejects.toMatchObject({
      code: "KITCHEN_WORK_STARTED",
    });
    expect(test.calls.some((call) => /^(UPDATE|INSERT|SAVEPOINT)/u.test(call.sql))).toBe(false);
  });

  it("replays the same cancellation without writes and refuses a different one", async () => {
    const first = harness();
    const created = await cancellation().cancel(first.transaction, input());
    const rows = first.calls
      .filter((call) => call.sql.startsWith("INSERT INTO rms_kitchen.kitchen_work_cancellation"))
      .map((call) => ({
        kitchen_work_cancellation_id: call.values[0],
        operation_id: call.values[1],
        kitchen_ticket_id: call.values[4],
        kitchen_work_item_id: call.values[5],
        order_id: call.values[6],
        order_batch_id: call.values[7],
        order_item_id: call.values[8],
        before_status: call.values[9],
        expected_ticket_version: call.values[10],
        result_ticket_version: call.values[11],
        expected_work_item_version: call.values[12],
        result_work_item_version: call.values[13],
        actor_id: call.values[14],
        order_cancellation_id: call.values[16],
        evidence_digest: call.values[17],
        event_id: call.values[18],
        audit_id: call.values[19],
        cancelled_at: new Date(String(call.values[20])),
      }));
    const state = {
      ticket: { version: "4", updated_at: cancelledAt },
      items: [1, 2].map((n) =>
        item(n, { status: "Cancelled", version: "2", updated_at: cancelledAt }),
      ),
      cancellations: rows,
    };
    const replay = harness(state);
    expect(await cancellation().cancel(replay.transaction, input())).toEqual({
      ...created,
      status: "AlreadyCancelled",
    });
    expect(replay.calls.some((call) => /^(UPDATE|INSERT|SAVEPOINT)/u.test(call.sql))).toBe(false);
    const sameOrderCancellation = harness(state);
    expect(
      (
        await cancellation().cancel(
          sameOrderCancellation.transaction,
          input({ operationReference: id(20) }),
        )
      ).status,
    ).toBe("AlreadyCancelled");
    const different = harness(state);
    await expect(
      cancellation().cancel(
        different.transaction,
        input({ operationReference: id(20), orderCancellationReference: id(21) }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
  });

  it("fails closed on denied authority, foreign orders, clock regression and write failure", async () => {
    await expect(cancellation(false).cancel(harness().transaction, input())).rejects.toMatchObject({
      code: "KITCHEN_CANCELLATION_UNAVAILABLE",
    });
    await expect(
      cancellation().cancel(harness({ ticket: { order_id: id(77) } }).transaction, input()),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
    await expect(
      cancellation().cancel(
        harness().transaction,
        input({ cancelledAt: "2026-08-11T10:00:00.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
    const failing = harness();
    const original = failing.transaction.query;
    const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
      if (sql.startsWith("INSERT INTO rms_kitchen.kitchen_work_cancellation"))
        throw new Error("private SQL detail");
      return original(sql, values);
    });
    const error = await cancellation()
      .cancel({ query } as unknown as ConsumerTransaction, input())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KitchenBatchCancellationError);
    expect(String(error)).not.toContain("private SQL detail");
    expect(query.mock.calls.map(([sql]) => sql)).toContain(
      "ROLLBACK TO SAVEPOINT kitchen_batch_cancellation",
    );
  });

  it("lists batches whose kitchen work started, bounded to 100 batches", async () => {
    const query = vi.fn(async () => ({ rows: [{ order_batch_id: batch }], rowCount: 1 }));
    const transaction = { query } as unknown as ConsumerTransaction;
    const scope = { brandReference: brand, storeReference: store };
    expect([...(await listStoreStartedKitchenBatches(transaction, scope, [batch, id(6)]))]).toEqual(
      [batch],
    );
    expect(await listStoreStartedKitchenBatches(transaction, scope, [])).toEqual(new Set());
    await expect(
      listStoreStartedKitchenBatches(
        transaction,
        scope,
        Array.from({ length: 101 }, (_, index) => id(1000 + index)),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
    await expect(
      listStoreStartedKitchenBatches(transaction, scope, ["not-a-reference"]),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
  });
});

describe("Kitchen staff item cancellation (WP-2423 Q6 step 2)", () => {
  // Line 201 is split into work items 101 and 103; line 202 has work item 102.
  const split = () => [
    item(1),
    item(3, { order_item_id: id(201) }),
    item(2, { status: "In Progress", version: "3" }),
  ];
  const sorted = (rows: ItemRow[]) =>
    [...rows].sort((a, b) =>
      a.order_item_id === b.order_item_id
        ? a.kitchen_work_item_id.localeCompare(b.kitchen_work_item_id)
        : a.order_item_id.localeCompare(b.order_item_id),
    );
  const itemsInput = (lines: string[], overrides: Record<string, unknown> = {}) => ({
    ...input(overrides),
    orderItemReferences: lines,
  });

  it("cancels every work item of the selected line and leaves the rest of the ticket active", async () => {
    const test = harness({ items: sorted(split()) });
    const result = await cancellation().cancelItems(test.transaction, itemsInput([id(201)]));
    expect(result).toMatchObject({ status: "Cancelled", workItemCount: 2 });
    const rows = insertedRows(test.calls);
    expect(rows.map((row) => [row.kitchen_work_item_id, row.order_item_id])).toEqual([
      [id(101), id(201)],
      [id(103), id(201)],
    ]);
    expect(rows.map((row) => [row.expected_ticket_version, row.result_ticket_version])).toEqual([
      ["2", "3"],
      ["3", "4"],
    ]);
    const updated = test.calls.filter((call) =>
      call.sql.startsWith("UPDATE rms_kitchen.kitchen_work_item"),
    );
    expect(updated.map((call) => call.values[3])).toEqual([id(101), id(103)]);
    // The started check covers only the targeted work items, not the line in progress.
    const started = test.calls.find((call) => call.sql.includes("KITCHEN_WORK_ITEM_STARTED"));
    expect(started?.values[3]).toEqual([id(101), id(103)]);
    const outbox = test.calls.filter((call) => call.sql.includes("outbox_event"));
    expect(outbox.map((call) => call.values[1])).toEqual(["KitchenWorkCancelled"]);
    expect(result.evidenceDigest).toBe(
      kitchenBatchCancellationEvidenceDigest({
        orderReference: order,
        orderBatchReference: batch,
        kitchenTicketReference: ticket,
        items: [101, 103].map((n, index) => ({
          workItemReference: id(n),
          orderItemReference: id(201),
          beforeStatus: "Queued" as const,
          expectedTicketVersion: 2n + BigInt(index),
          resultTicketVersion: 3n + BigInt(index),
          expectedWorkItemVersion: 1n,
          resultWorkItemVersion: 2n,
        })),
      }),
    );
  });

  it.each([
    ["the line is in progress", { items: sorted(split()) }, [id(202)]],
    ["a work item of the line recorded a Start", { started: [id(103)] }, [id(201)]],
  ])("refuses when %s and writes nothing", async (_name, state, lines) => {
    const test = harness({ items: sorted(split()), ...state });
    await expect(
      cancellation().cancelItems(test.transaction, itemsInput(lines)),
    ).rejects.toMatchObject({ code: "KITCHEN_WORK_STARTED" });
    expect(test.calls.some((call) => /^(UPDATE|INSERT|SAVEPOINT)/u.test(call.sql))).toBe(false);
  });

  it("allows a line while another line has started", async () => {
    const test = harness({ items: sorted(split()), started: [id(102)] });
    expect((await cancellation().cancelItems(test.transaction, itemsInput([id(201)]))).status).toBe(
      "Cancelled",
    );
  });

  it.each([
    ["a line not on the ticket", [id(299)]],
    ["a duplicate line", [id(201), id(201)]],
    ["no line", []],
  ])("refuses %s", async (_name, lines) => {
    const test = harness({ items: sorted(split()) });
    await expect(
      cancellation().cancelItems(test.transaction, itemsInput(lines)),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
    expect(test.calls.some((call) => /^(UPDATE|INSERT|SAVEPOINT)/u.test(call.sql))).toBe(false);
  });

  it("publishes KitchenOrderReady when every remaining line is already ready", async () => {
    const items = [item(1), item(2, { status: "Completed", version: "5" })];
    const ready = harness({ items, readyLines: [id(202)] });
    expect(
      (await cancellation().cancelItems(ready.transaction, itemsInput([id(201)]))).status,
    ).toBe("Cancelled");
    const outbox = ready.calls.filter((call) => call.sql.includes("outbox_event"));
    expect(outbox.map((call) => call.values[1])).toEqual([
      "KitchenWorkCancelled",
      "KitchenOrderReady",
    ]);
    // Same ticket version as the cancellation event; System actor; ready at the cancellation.
    expect(outbox[1]?.values[8]).toBe("3");
    expect(outbox[1]?.values[11]).toBe("System");
    expect(JSON.parse(String(outbox[1]?.values[13]))).toEqual({
      kitchenTicketReference: ticket,
      orderReference: order,
      orderBatchReference: batch,
      readyItemCount: 1,
      itemCount: 1,
      readyAt: cancelledAt,
    });
    const notReady = harness({ items, readyLines: [] });
    await cancellation().cancelItems(notReady.transaction, itemsInput([id(201)]));
    expect(
      notReady.calls
        .filter((call) => call.sql.includes("outbox_event"))
        .map((call) => call.values[1]),
    ).toEqual(["KitchenWorkCancelled"]);
  });

  it("replays the same item cancellation and refuses a cancelled line under another operation", async () => {
    const first = harness({ items: sorted(split()) });
    const command = itemsInput([id(201)]);
    const created = await cancellation().cancelItems(first.transaction, command);
    const state = {
      ticket: { version: "4", updated_at: cancelledAt },
      items: sorted([
        item(1, { status: "Cancelled", version: "2", updated_at: cancelledAt }),
        item(3, {
          order_item_id: id(201),
          status: "Cancelled",
          version: "2",
          updated_at: cancelledAt,
        }),
        item(2, { status: "In Progress", version: "3" }),
      ]),
      cancellations: insertedRows(first.calls),
    };
    const replay = harness(state);
    expect(await cancellation().cancelItems(replay.transaction, command)).toEqual({
      ...created,
      status: "AlreadyCancelled",
    });
    expect(replay.calls.some((call) => /^(UPDATE|INSERT|SAVEPOINT)/u.test(call.sql))).toBe(false);
    // The same operation naming a different line is not a replay.
    await expect(
      cancellation().cancelItems(harness(state).transaction, {
        ...command,
        orderItemReferences: [id(202)],
      }),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
    // A new operation cannot cancel the line again.
    await expect(
      cancellation().cancelItems(
        harness(state).transaction,
        itemsInput([id(201)], { operationReference: id(30), orderCancellationReference: id(31) }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
  });

  it("cancels only the remaining work items when the whole batch is cancelled after a line", async () => {
    const first = harness({ items: [item(1), item(2)] });
    await cancellation().cancelItems(first.transaction, itemsInput([id(201)]));
    const earlier = insertedRows(first.calls);
    const state = {
      ticket: { version: "3", updated_at: cancelledAt },
      items: [item(1, { status: "Cancelled", version: "2", updated_at: cancelledAt }), item(2)],
      cancellations: earlier,
    };
    const later = "2026-08-11T12:05:00.000Z";
    const whole = harness(state);
    const command = input({
      operationReference: id(40),
      orderCancellationReference: id(41),
      auditReference: id(42),
      eventReference: id(43),
      cancelledAt: later,
    });
    const result = await cancellation().cancel(whole.transaction, command);
    expect(result).toMatchObject({ status: "Cancelled", workItemCount: 1 });
    const rows = insertedRows(whole.calls);
    expect(rows.map((row) => [row.kitchen_work_item_id, row.expected_ticket_version])).toEqual([
      [id(102), "3"],
    ]);
    // Replay of the whole cancellation sees only its own rows.
    const replay = harness({
      ticket: { version: "4", updated_at: later },
      items: [
        item(1, { status: "Cancelled", version: "2", updated_at: cancelledAt }),
        item(2, { status: "Cancelled", version: "2", updated_at: later }),
      ],
      cancellations: [...earlier, ...rows],
    });
    expect(await cancellation().cancel(replay.transaction, command)).toEqual({
      ...result,
      status: "AlreadyCancelled",
    });
    // Nothing remains for a different whole cancellation.
    await expect(
      cancellation().cancel(
        harness({
          ticket: { version: "4", updated_at: later },
          items: [
            item(1, { status: "Cancelled", version: "2", updated_at: cancelledAt }),
            item(2, { status: "Cancelled", version: "2", updated_at: later }),
          ],
          cancellations: [...earlier, ...rows],
        }).transaction,
        input({
          operationReference: id(50),
          orderCancellationReference: id(51),
          cancelledAt: later,
        }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
  });

  it("refuses a Cancelled work item without its cancellation row", async () => {
    const test = harness({
      items: [item(1, { status: "Cancelled", version: "2" }), item(2)],
    });
    await expect(cancellation().cancel(test.transaction, input())).rejects.toMatchObject({
      code: "KITCHEN_CANCELLATION_UNAVAILABLE",
    });
  });

  it("lists per line kitchen state for the merchant queue", async () => {
    const rows = [
      { order_item_id: id(201), status: "Queued", started: false },
      { order_item_id: id(202), status: "Held", started: false },
      { order_item_id: id(203), status: "Queued", started: true },
      { order_item_id: id(204), status: "Completed", started: false },
      { order_item_id: id(205), status: "Cancelled", started: false },
      { order_item_id: id(206), status: "Queued", started: false },
      { order_item_id: id(206), status: "In Progress", started: true },
    ];
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
    const transaction = { query } as unknown as ConsumerTransaction;
    const scope = { brandReference: brand, storeReference: store };
    expect(
      Object.fromEntries(await listStoreKitchenOrderItemStates(transaction, scope, [batch])),
    ).toEqual({
      [id(201)]: "NotStarted",
      [id(202)]: "NotStarted",
      [id(203)]: "Started",
      [id(204)]: "Started",
      [id(205)]: "Cancelled",
      [id(206)]: "Started",
    });
    expect(await listStoreKitchenOrderItemStates(transaction, scope, [])).toEqual(new Map());
    await expect(
      listStoreKitchenOrderItemStates(
        transaction,
        scope,
        Array.from({ length: 101 }, (_, index) => id(1000 + index)),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
    query.mockResolvedValueOnce({
      rows: [
        { order_item_id: id(201), status: "Cancelled", started: false },
        { order_item_id: id(201), status: "Queued", started: false },
      ],
      rowCount: 2,
    });
    await expect(
      listStoreKitchenOrderItemStates(transaction, scope, [batch]),
    ).rejects.toMatchObject({ code: "KITCHEN_CANCELLATION_UNAVAILABLE" });
  });
});
