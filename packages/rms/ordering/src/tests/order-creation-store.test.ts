import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  createPostgresOrderCreationStore,
  createOrderNumberAllocation,
  parseOrderCreationRecord,
  type OrderSubmissionInventoryFinalizer,
} from "../index.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const mocks = vi.hoisted(() => ({ audit: vi.fn(), outbox: vi.fn(), read: vi.fn() }));
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
vi.mock("@bop/eventing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/eventing")>()),
  appendEventInTransaction: mocks.outbox,
}));
vi.mock("../infrastructure/persistence/order-creation-query-store.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../infrastructure/persistence/order-creation-query-store.js")
  >()),
  readOrderCreationHistory: mocks.read,
}));
function setup(inventoryFinalizer?: OrderSubmissionInventoryFinalizer) {
  const f = orderWriteFixture();
  const expected = parseOrderCreationRecord({
    ...f.request.record,
    orderNumberAllocation: createOrderNumberAllocation({
      orderReference: f.request.record.order.orderReference,
      allocatedAt: f.request.record.createdAt,
      sequence: 1n,
      businessDateResolution: f.request.businessDateResolution,
    }),
  });
  mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce(expected);
  let checks = 0,
    late = false,
    failCommit = false;
  const enter = vi.fn();
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    void values;
    if (sql.startsWith("WITH observed"))
      return {
        rows: [{ valid: !(late && ++checks >= 3), observedAt: f.request.record.createdAt }],
      };
    if (sql.startsWith("SELECT cart_id")) return { rows: [{ reference: f.cart.cartReference }] };
    if (sql.startsWith("SELECT jsonb_build_object")) return { rows: [{ cart: f.cart }] };
    if (sql.startsWith("INSERT INTO rms_ordering.order_number_counter"))
      return { rows: [{ sequence: "1" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const store = createPostgresOrderCreationStore(
    {
      async run(action) {
        enter();
        const value = await action({ query });
        if (failCommit) throw new Error("private commit detail");
        return value;
      },
    },
    f.scope,
    undefined,
    1,
    undefined,
    undefined,
    inventoryFinalizer,
  );
  return {
    ...f,
    expected,
    query,
    enter,
    store,
    late: () => {
      late = true;
    },
    failCommit: () => {
      failCommit = true;
    },
  };
}
beforeEach(() => {
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.outbox.mockReset().mockResolvedValue(undefined);
  mocks.read.mockReset();
});
describe("WP-2402 inventory finalization at the Order boundary", () => {
  it("passes the locked current Cart and same transaction before allocating an Order number", async () => {
    let statementsAtFinalization: string[] = [];
    let auditCallsAtFinalization = -1;
    const finalize = vi.fn<OrderSubmissionInventoryFinalizer["finalize"]>(async () => {
      statementsAtFinalization = f.query.mock.calls.map(([sql]) => sql);
      auditCallsAtFinalization = mocks.audit.mock.calls.length;
    });
    const f = setup({ finalize });
    expect(await f.store.append(f.request)).toEqual({ status: "Created", record: f.expected });
    const input = finalize.mock.calls[0]?.[0];
    if (input === undefined) throw new Error("inventory finalizer was not called");
    expect(input.transaction.query).toBe(f.query);
    expect(input.cart).toEqual(f.cart);
    expect(input.record).toEqual(f.request.record);
    expect(input.checkoutValidationEvidence).toEqual(f.request.checkoutValidationEvidence);
    expect(input.observedAt).toBe(f.request.record.createdAt);
    expect(statementsAtFinalization.some((sql) => sql.startsWith("SELECT cart_id"))).toBe(true);
    expect(statementsAtFinalization.some((sql) => sql.startsWith("INSERT"))).toBe(false);
    expect(auditCallsAtFinalization).toBe(0);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("WITH observed"))).toHaveLength(4);
  });

  it("propagates finalization failure without creating an Order or exposing dependency details", async () => {
    const finalize = vi.fn().mockRejectedValue(new Error("private inventory detail"));
    const f = setup({ finalize });
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      message: "order creation is unavailable",
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it("rejects a deadline crossed during inventory work before writing the Order", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const f = setup({ finalize });
    f.late();
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_VALIDATION_EXPIRED",
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("recovers the original submission without reserving inventory again", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const f = setup({ finalize });
    mocks.read.mockReset().mockResolvedValue(f.expected);
    expect(await f.store.append(f.request)).toEqual({ status: "Existing", record: f.expected });
    expect(finalize).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("WP-2352 atomic Order write boundary", () => {
  it("captures the request before an asynchronous runner can mutate caller-owned data", async () => {
    const f = setup();
    const audit = { ...f.request.audit };
    f.enter.mockImplementation(() => {
      Object.assign(f.request.audit, { actionCode: "CHANGED_AFTER_ENTRY" });
    });
    expect(await f.store.append(f.request)).toEqual({ status: "Created", record: f.expected });
    expect(mocks.audit).toHaveBeenCalledWith({ query: f.query }, audit);
  });

  it("returns exact read-back and appends public Audit/Outbox in the owning transaction", async () => {
    const f = setup();
    expect(await f.store.append(f.request)).toEqual({ status: "Created", record: f.expected });
    expect(mocks.audit).toHaveBeenCalledWith({ query: f.query }, f.request.audit);
    expect(mocks.outbox).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]?.[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(f.query.mock.calls.filter(([s]) => s.startsWith("WITH observed"))).toHaveLength(3);
    expect(f.query.mock.calls.filter(([s]) => s.startsWith("INSERT"))).toHaveLength(7);
    expect(
      f.query.mock.calls.find(([s]) =>
        s.startsWith("INSERT INTO rms_ordering.order_revision"),
      )?.[1],
    ).toEqual([
      f.expected.submissionReference,
      f.expected.order.brandReference,
      f.expected.order.storeReference,
      f.expected.order.orderReference,
      f.expected.createdAt,
    ]);
  });
  it("recovers original expired history without touching Cart, counter, Audit or Outbox", async () => {
    const f = setup();
    mocks.read.mockReset().mockResolvedValue(f.expected);
    expect(await f.store.append(f.request)).toEqual({ status: "Existing", record: f.expected });
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.outbox).not.toHaveBeenCalled();
  });
  it.each(["intent", "guest"])("conflicts on original %s mismatch", async (kind) => {
    const f = setup();
    mocks.read.mockReset().mockResolvedValue({
      ...f.expected,
      [kind === "intent" ? "submissionIntentHash" : "guestSessionReference"]: "different",
    });
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_IDEMPOTENCY_CONFLICT",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["audit target", "audit action", "event digest", "intent digest", "extra", "getter"])(
    "rejects invalid %s before transaction",
    async (kind) => {
      const f = setup();
      const input = structuredClone(f.request);
      let executed = 0;
      if (kind === "audit target")
        Object.assign(input, {
          audit: { ...input.audit, targetId: input.record.submissionReference },
        });
      if (kind === "audit action")
        Object.assign(input, { audit: { ...input.audit, actionCode: "OTHER_ACTION" } });
      if (kind === "event digest")
        Object.assign(input, {
          event: {
            ...input.event,
            payload: { ...input.event.payload, sourceSnapshotDigest: "sha256:" + "f".repeat(64) },
          },
        });
      if (kind === "intent digest")
        Object.assign(input, {
          record: { ...input.record, submissionIntentHash: ("sha256:" + "f".repeat(64)) as never },
        });
      if (kind === "extra") Object.assign(input, { extra: true });
      if (kind === "getter")
        Object.defineProperty(input, "record", {
          enumerable: true,
          get() {
            executed++;
            return f.request.record;
          },
        });
      await expect(f.store.append(input)).rejects.toMatchObject({
        code: "ORDER_CREATE_INPUT_INVALID",
      });
      expect(f.enter).not.toHaveBeenCalled();
      expect(executed).toBe(0);
    },
  );
  it("rejects expired final database fence even after preparing all effects", async () => {
    const f = setup();
    f.late();
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_VALIDATION_EXPIRED",
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.outbox).toHaveBeenCalledTimes(1);
  });
  it("does not turn an unknown commit into a durable success", async () => {
    const f = setup();
    f.failCommit();
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      message: "order creation is unavailable",
    });
  });
  it("rejects a substituted read-back record", async () => {
    const f = setup();
    mocks.read
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...f.expected, submissionIntentHash: "different" });
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each(["audit", "outbox"])("bounds public %s failure", async (kind) => {
    const f = setup();
    (kind === "audit" ? mocks.audit : mocks.outbox).mockRejectedValue(
      new Error("private dependency detail"),
    );
    await expect(f.store.append(f.request)).rejects.toMatchObject({
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      message: "order creation is unavailable",
    });
  });
});
