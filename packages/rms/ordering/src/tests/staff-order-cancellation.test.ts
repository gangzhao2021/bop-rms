import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseStaffOrderCancellationPlan,
  parseStaffOrderCancellationRecord,
  staffOrderCancellationDisposition,
  staffOrderCancellationPolicy,
  staffOrderCancellationReasonCodes,
} from "../application/staff-order-cancellation.js";
import { parseOrderPaymentOutcomeDisposition } from "../application/order-payment-outcome.js";
import {
  createPostgresStaffOrderCancellationReader,
  createPostgresStaffOrderCancellationStore,
} from "../infrastructure/persistence/staff-order-cancellation-store.js";
import { createPostgresOrderCompensationCandidateReader } from "../infrastructure/persistence/order-payment-disposition-store.js";
import { listStoreConfirmedOrderBatches } from "../infrastructure/persistence/merchant-order-index.js";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  termination: vi.fn(),
  terminationOptions: [] as unknown[],
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
vi.mock("../infrastructure/persistence/order-termination-store.js", () => ({
  createPostgresOrderTerminationStore: (options: {
    authorize(tx: unknown, record: unknown): Promise<boolean>;
    validateCurrentSource(tx: unknown, record: unknown): Promise<boolean>;
    audit(record: unknown): Promise<unknown>;
  }) => {
    mocks.terminationOptions.push(options);
    return {
      commit: async (input: { transaction: unknown; record: unknown }) =>
        mocks.termination(options, input),
    };
  },
}));

const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const brand = id(1),
  store = id(2),
  order = id(3),
  batch = id(4),
  submission = id(5),
  actor = id(6);
const plan = {
  orderType: "Pickup" as "Pickup" | "DineIn",
  orderReference: order,
  orderBatchReference: batch,
  submissionReference: submission,
  expectedOrderVersion: 2,
  expectedSourceCheckpoint: id(7),
  orderItemReferences: [id(8), id(9)],
  payment: {
    dispositionReference: id(10),
    paymentTransactionReference: id(11),
    paymentIntentReference: id(12),
    paymentAttemptReference: id(13),
    paymentEventReference: id(14),
  },
};
const cancelledAt = "2026-10-11T10:00:00.000Z";
function record(overrides: Record<string, unknown> = {}) {
  return {
    cancellationReference: id(20),
    operationReference: id(21),
    brandReference: brand,
    storeReference: store,
    orderReference: order,
    orderBatchReference: batch,
    submissionReference: submission,
    orderType: "Pickup",
    expectedOrderVersion: 2,
    cancelledOrderVersion: 3,
    expectedSourceCheckpoint: id(7),
    actorReference: actor,
    reasonCode: "SOLD_OUT",
    paymentDispositionReference: id(10),
    paymentTransactionReference: id(11),
    paymentIntentReference: id(12),
    paymentAttemptReference: id(13),
    paymentEventReference: id(14),
    orderItemReferences: [id(8), id(9)],
    kitchenEvidenceDigest: "sha256:" + "a".repeat(64),
    sourceDigest: "sha256:" + "b".repeat(64),
    auditReference: id(22),
    cancelledAt,
    ...overrides,
  };
}

describe("staff cancellation record", () => {
  it("parses a complete record and its plan", () => {
    expect(parseStaffOrderCancellationRecord(record()).cancelledOrderVersion).toBe(3);
    expect(parseStaffOrderCancellationPlan(plan).payment.dispositionReference).toBe(id(10));
    expect(staffOrderCancellationReasonCodes).toEqual([
      "CUSTOMER_REQUEST",
      "SOLD_OUT",
      "STORE_ERROR",
      "DUPLICATE_ORDER",
    ]);
    expect(staffOrderCancellationPolicy.permissionCode).toBe("ordering.order.cancel");
  });
  it.each([
    ["reason", { reasonCode: "OTHER" }],
    ["version gap", { cancelledOrderVersion: 4 }],
    ["submitted version", { expectedOrderVersion: 1, cancelledOrderVersion: 2 }],
    ["order type", { orderType: "Delivery" }],
    ["unsorted items", { orderItemReferences: [id(9), id(8)] }],
    ["no items", { orderItemReferences: [] }],
    ["digest", { kitchenEvidenceDigest: "sha256:x" }],
    ["time", { cancelledAt: "2026-10-11T10:00:00Z" }],
    ["extra field", { phase: "Cancelled" }],
  ])("refuses an invalid record (%s)", (_name, overrides) => {
    expect(() => parseStaffOrderCancellationRecord(record(overrides))).toThrow(
      "staff order cancellation is unavailable",
    );
  });
  it("is the CancelledByStaff compensation view of the paid Batch", () => {
    const view = staffOrderCancellationDisposition(parseStaffOrderCancellationRecord(record()));
    expect(view).toEqual({
      dispositionReference: id(20),
      brandReference: brand,
      storeReference: store,
      orderReference: order,
      orderBatchReference: batch,
      submissionReference: submission,
      paymentTransactionReference: id(11),
      paymentIntentReference: id(12),
      paymentAttemptReference: id(13),
      paymentEventReference: id(14),
      sourceVersion: 3,
      sourceCheckpoint: id(20),
      sourceDigest: "sha256:" + "b".repeat(64),
      evaluatedAt: cancelledAt,
      disposition: "PaidWithoutFulfillableOrder",
      reason: "CancelledByStaff",
      kitchenReleaseDisposition: "Blocked",
    });
    expect(parseOrderPaymentOutcomeDisposition({ ...view })).toEqual(view);
    expect(() =>
      parseOrderPaymentOutcomeDisposition({ ...view, reason: "CancelledByCustomer" }),
    ).toThrow();
  });
});

interface State {
  orderType: string | null;
  batches: { batch: string; submission: string }[];
  staff: boolean;
  checkout: boolean;
  terminated: boolean;
  closure: string;
  completed: boolean;
  accepted: boolean;
  paid: boolean;
  version: number;
  prior: unknown[];
  revisionInsert: number;
  staffInsert: number;
}
function storeFixture(overrides: Partial<State> = {}) {
  const state: State = {
    orderType: "Pickup",
    batches: [{ batch, submission }],
    staff: false,
    checkout: false,
    terminated: false,
    closure: "Open",
    completed: false,
    accepted: true,
    paid: true,
    version: 2,
    prior: [],
    revisionInsert: 1,
    staffInsert: 1,
    ...overrides,
  };
  const query = vi.fn(async (...args: [sql: string, values?: readonly unknown[]]) => {
    const sql = args[0];
    const result = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
    if (sql.startsWith("SELECT order_type FROM rms_ordering.order_header"))
      return result(state.orderType === null ? [] : [{ order_type: state.orderType }]);
    if (sql.includes("order_batch_id::text AS batch")) return result(state.batches);
    if (sql.includes("AS staff,"))
      return result([
        {
          staff: state.staff,
          checkout: state.checkout,
          terminated: state.terminated,
          closure: state.closure,
          completed: state.completed,
        },
      ]);
    if (sql.includes("FROM rms_ordering.order_acceptance_record"))
      return result(state.accepted ? [{ accepted_at: new Date("2026-10-11T09:50:00.000Z") }] : []);
    if (sql.includes("disposition='Confirmed'"))
      return result(
        state.paid
          ? [
              {
                disposition: id(10),
                submission,
                transaction: id(11),
                intent: id(12),
                attempt: id(13),
                event: id(14),
                confirmed_at: new Date("2026-10-11T09:51:00.000Z"),
              },
            ]
          : [],
      );
    if (sql.includes("FROM rms_ordering.order_revision WHERE"))
      return result([
        {
          revision: id(7),
          version: state.version,
          occurred_at: new Date("2026-10-11T09:52:00.000Z"),
        },
      ]);
    if (sql.includes("FROM rms_ordering.order_item"))
      return result([{ item: id(8) }, { item: id(9) }]);
    if (sql.includes("FROM rms_ordering.order_staff_cancellation WHERE"))
      return result(state.prior);
    if (sql.startsWith("INSERT INTO rms_ordering.order_revision"))
      return result([], state.revisionInsert);
    if (sql.startsWith("INSERT INTO rms_ordering.order_staff_cancellation"))
      return result([], state.staffInsert);
    return result([]);
  });
  const tx = { query } as unknown as ConsumerTransaction;
  const authorize = vi.fn(async () => true);
  const store = createPostgresStaffOrderCancellationStore({
    brandReference: brand,
    storeReference: store_,
    authorize,
  });
  return { state, query, tx, authorize, store };
}
const store_ = store;
const commitInput = (orderType: "Pickup" | "DineIn" = "Pickup") => ({
  plan: { ...plan, orderType },
  cancellationReference: id(20),
  operationReference: id(21),
  actorReference: actor,
  reasonCode: "SOLD_OUT",
  kitchenEvidenceDigest: "sha256:" + "a".repeat(64),
  auditReference: id(22),
  terminationAuditReference: id(23),
  cancelledAt,
});

beforeEach(() => {
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.terminationOptions.length = 0;
  mocks.termination.mockReset().mockImplementation(async (options, input) => {
    const candidate = input.record as Parameters<typeof options.audit>[0];
    if (
      !(await options.authorize(input.transaction, candidate)) ||
      !(await options.validateCurrentSource(input.transaction, candidate))
    )
      throw new Error("termination unavailable");
    await options.audit(candidate);
    return { status: "Created", record: candidate };
  });
});

describe("prepare", () => {
  it("returns the Batch plan under the Order fence and row lock", async () => {
    const f = storeFixture();
    const result = await f.store.prepare(f.tx, {
      orderReference: order,
      orderBatchReference: batch,
      expectedOrderVersion: 2,
      actorReference: actor,
    });
    expect(result).toEqual({ status: "Ready", plan });
    const sql = f.query.mock.calls.map((call) => call[0]);
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(f.query.mock.calls[1]?.[1]).toEqual([
      "OrderingOrderDisposition:" + brand + ":" + store + ":" + order,
    ]);
    expect(sql[2]).toContain("FOR UPDATE");
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["NotFound", { orderType: null }],
    ["NotFound", { batches: [{ batch: id(99), submission }] }],
    ["AlreadyCancelled", { staff: true }],
    ["AlreadyCancelled", { checkout: true }],
    ["AlreadyCancelled", { terminated: true }],
    ["Closed", { closure: "Closed" }],
    ["Completed", { completed: true }],
    ["NotConfirmed", { accepted: false }],
    ["NotConfirmed", { paid: false }],
    ["VersionConflict", { version: 3 }],
  ] as const)("is NotEligible %s", async (reason, overrides) => {
    const f = storeFixture(overrides as Partial<State>);
    expect(
      await f.store.prepare(f.tx, {
        orderReference: order,
        orderBatchReference: batch,
        expectedOrderVersion: 2,
        actorReference: actor,
      }),
    ).toEqual({ status: "NotEligible", reason });
  });
  it("fails closed when authorization is withdrawn", async () => {
    const f = storeFixture();
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      f.store.prepare(f.tx, {
        orderReference: order,
        orderBatchReference: batch,
        expectedOrderVersion: 2,
        actorReference: actor,
      }),
    ).rejects.toThrow("staff order cancellation is unavailable");
  });
});

describe("commit", () => {
  it("terminates a pickup Order as the User, then records the staff cancellation and Audit", async () => {
    const f = storeFixture();
    const result = await f.store.commit(f.tx, commitInput("Pickup"));
    expect(result.status).toBe("Created");
    expect(result.record.cancelledOrderVersion).toBe(3);
    const [, termination] = mocks.termination.mock.calls[0] as [
      unknown,
      { record: Record<string, unknown> },
    ];
    expect(termination.record).toMatchObject({
      terminationReference: id(20),
      operationReference: id(21),
      previousPhase: "Accepted",
      phase: "Cancelled",
      actorType: "User",
      actorReference: actor,
      purposeCode: "StaffOrderCancellation",
      permissionCode: "ordering.order.cancel",
      reasonCode: "SOLD_OUT",
      workflowVersionReference: staffOrderCancellationPolicy.workflowVersionReference,
      transitionReference: staffOrderCancellationPolicy.transitionReference,
      sourceDigest: result.record.sourceDigest,
      terminatedAt: cancelledAt,
    });
    const options = mocks.terminationOptions[0] as { audit(record: unknown): Promise<unknown> };
    expect(await options.audit(termination.record)).toMatchObject({
      auditId: id(23),
      actor: { type: "User", reference: actor },
      actionCode: "ORDER_TERMINATED",
      sourceChannel: "MERCHANT_WEB",
    });
    const sql = f.query.mock.calls.map((call) => call[0]);
    expect(sql.some((text) => text.startsWith("INSERT INTO rms_ordering.order_revision"))).toBe(
      false,
    );
    expect(sql.findIndex((text) => text.startsWith("INSERT INTO rms_ordering.order_staff"))).toBe(
      sql.length - 2,
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        auditId: id(22),
        actionCode: "ORDER_CANCELLED_BY_STAFF",
        targetType: "Order",
        targetId: order,
        correlationId: id(21),
        reasonCode: "SOLD_OUT",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      }),
    );
  });
  it("writes the dine-in StaffBatchCancellation revision before the record and Audit", async () => {
    const f = storeFixture({ orderType: "DineIn" });
    const result = await f.store.commit(f.tx, commitInput("DineIn"));
    expect(result.record.orderType).toBe("DineIn");
    expect(mocks.termination).not.toHaveBeenCalled();
    const sql = f.query.mock.calls.map((call) => call[0]);
    const revision = sql.findIndex((text) =>
      text.startsWith("INSERT INTO rms_ordering.order_revision"),
    );
    const staff = sql.findIndex((text) =>
      text.startsWith("INSERT INTO rms_ordering.order_staff_cancellation"),
    );
    expect(sql[revision]).toContain("'StaffBatchCancellation'");
    expect(f.query.mock.calls[revision]?.[1]).toEqual([
      brand,
      store,
      order,
      id(20),
      3,
      2,
      cancelledAt,
      id(7),
    ]);
    expect(revision).toBeGreaterThan(0);
    expect(staff).toBeGreaterThan(revision);
    expect(f.query.mock.calls[staff]?.[1]).toContainEqual([id(8), id(9)]);
    expect(sql[staff]).toContain("previous_phase,permission_code");
    expect(sql[staff]).toContain("'Accepted','ordering.order.cancel'");
    expect(mocks.audit).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ targetType: "OrderBatch", targetId: batch }),
    );
  });
  it("binds the source digest to plan, reason and kitchen evidence", async () => {
    const a = storeFixture({ orderType: "DineIn" });
    const first = await a.store.commit(a.tx, commitInput("DineIn"));
    const b = storeFixture({ orderType: "DineIn" });
    const second = await b.store.commit(b.tx, {
      ...commitInput("DineIn"),
      kitchenEvidenceDigest: "sha256:" + "c".repeat(64),
    });
    expect(first.record.sourceDigest).not.toBe(second.record.sourceDigest);
  });
  it.each([
    ["stale plan", { version: 3 }],
    ["already cancelled", { staff: true }],
    ["revision not appended", { revisionInsert: 0 }],
    ["record not inserted", { staffInsert: 0 }],
  ] as const)("refuses and rolls back to the savepoint (%s)", async (_name, overrides) => {
    const f = storeFixture({ orderType: "DineIn", ...(overrides as Partial<State>) });
    await expect(f.store.commit(f.tx, commitInput("DineIn"))).rejects.toThrow(
      "staff order cancellation is unavailable",
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("refuses a cancellation timed before the current Order revision", async () => {
    const f = storeFixture({ orderType: "DineIn" });
    await expect(
      f.store.commit(f.tx, { ...commitInput("DineIn"), cancelledAt: "2026-10-11T09:51:30.000Z" }),
    ).rejects.toThrow();
  });
  it("leaves replay to loadByOperation and never writes twice", async () => {
    const f = storeFixture({ prior: [record()] });
    await expect(f.store.commit(f.tx, commitInput("Pickup"))).rejects.toThrow();
    expect(mocks.termination).not.toHaveBeenCalled();
    expect(await f.store.loadByOperation(f.tx, id(21))).toMatchObject({
      cancellationReference: id(20),
    });
    f.state.prior = [];
    expect(await f.store.loadByOperation(f.tx, id(21))).toBe(null);
  });
});

describe("reader and discovery", () => {
  it("exposes the compensation view by payment event and lists by Order", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("order_staff_cancellation") ? [record()] : [],
      rowCount: 1,
    }));
    const tx = { query } as unknown as ConsumerTransaction;
    const reader = createPostgresStaffOrderCancellationReader({
      brandReference: brand,
      storeReference: store,
    });
    expect(
      await reader.loadCompensationByPaymentEvent({
        transaction: tx,
        paymentEventReference: id(14),
      }),
    ).toMatchObject({ reason: "CancelledByStaff", dispositionReference: id(20) });
    expect(await reader.listByOrders(tx, [order])).toHaveLength(1);
    await expect(reader.listByOrders(tx, [id(77)])).rejects.toThrow();
    expect(await reader.listByOrders(tx, [])).toEqual([]);
  });
  it("pages disposition rows and staff cancellations as one ordered union when asked", async () => {
    const disposition = {
      dispositionReference: id(30),
      brandReference: brand,
      storeReference: store,
      orderReference: id(31),
      orderBatchReference: id(32),
      submissionReference: id(33),
      paymentTransactionReference: id(34),
      paymentIntentReference: id(35),
      paymentAttemptReference: id(36),
      paymentEventReference: id(37),
      sourceVersion: 2,
      sourceCheckpoint: id(38),
      sourceDigest: "sha256:" + "d".repeat(64),
      evaluatedAt: cancelledAt,
      disposition: "PaidWithoutFulfillableOrder",
      confirmationReference: null,
      sourceSnapshotDigest: null,
      confirmedAt: null,
      eventReference: null,
      correlationReference: id(39),
      reason: "OrderNoLongerFulfillable",
      kitchenReleaseDisposition: "Blocked",
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes(") candidates ORDER BY"))
        return {
          rows: [
            { disposition_id: id(20), payment_event_id: id(14), source: "StaffCancellation" },
            { disposition_id: id(30), payment_event_id: id(37), source: "Disposition" },
          ],
          rowCount: 2,
        };
      if (sql.startsWith("SELECT disposition_id,payment_event_id FROM"))
        return { rows: [{ disposition_id: id(30), payment_event_id: id(37) }], rowCount: 1 };
      if (sql.includes("FROM rms_ordering.order_staff_cancellation"))
        return { rows: [record()], rowCount: 1 };
      if (sql.includes("FROM rms_ordering.order_payment_disposition_record"))
        return { rows: [disposition], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const tx = { query } as unknown as ConsumerTransaction;
    const options = {
      scope: { brandReference: brand, storeReference: store },
      authorize: async () => true,
    };
    const page = await createPostgresOrderCompensationCandidateReader({
      ...options,
      includeStaffCancellations: true,
    })(tx, { afterDispositionReference: null, limit: 2 });
    expect(page.candidates.map((c) => [c.dispositionReference, c.reason])).toEqual([
      [id(20), "CancelledByStaff"],
      [id(30), "OrderNoLongerFulfillable"],
    ]);
    expect(page.nextAfterDispositionReference).toBe(id(30));
    // Default keeps the disposition-only page.
    query.mockClear();
    await createPostgresOrderCompensationCandidateReader(options)(tx, {
      afterDispositionReference: null,
      limit: 2,
    });
    expect(query.mock.calls.some((call) => call[0].includes("order_staff_cancellation"))).toBe(
      false,
    );
  });
  it("lists paid, accepted Batches of the asked Orders only", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("disposition='Confirmed'")
        ? [{ order_id: order, order_batch_id: batch }]
        : [],
      rowCount: 1,
    }));
    const tx = { query } as unknown as ConsumerTransaction;
    expect([
      ...(await listStoreConfirmedOrderBatches(
        tx,
        { brandReference: brand, storeReference: store },
        [order],
      )),
    ]).toEqual([batch]);
    expect(query.mock.calls[1]?.[0]).toContain("order_acceptance_record");
    await expect(
      listStoreConfirmedOrderBatches(tx, { brandReference: brand, storeReference: store }, [
        id(77),
      ]),
    ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  });
});
