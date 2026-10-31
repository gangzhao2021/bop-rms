import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresCapacityHoldStore, type CapacityHoldWriteTransaction } from "../index.js";
const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `0198a700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
function request() {
  const hold = {
    slot: {
      brandReference: id(1),
      storeReference: id(2),
      fulfillmentType: "Pickup",
      slotReference: id(3),
      configVersion: 1,
      startsAt: "2026-09-11T12:00:00.000Z",
      endsAt: "2026-09-11T13:00:00.000Z",
    },
    holdReference: id(4),
    cartReference: id(5),
    operationReference: id(6),
    units: 1,
    unitsRuleVersion: 1,
    unitsInputDigest: digest,
    state: "Active",
    version: 1,
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
    expiresAt: "2026-09-10T10:10:00.000Z",
    allocationReference: null,
  };
  return {
    hold,
    intentDigest: digest,
    audit: {
      auditId: id(7),
      brandId: id(1),
      storeId: id(2),
      actor: { type: "System" },
      actionCode: "FULFILLMENT_CAPACITY_HOLD_CREATE",
      targetType: "FulfillmentCapacityHold",
      targetId: id(4),
      reasonCode: "AUTHORIZED_CHECKOUT_CAPACITY",
      correlationId: id(8),
      occurredAt: hold.createdAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "SYNTHETIC_RETENTION",
      retentionPolicyVersion: 1,
    },
  };
}
function fixture() {
  let saved = false;
  const query = vi.fn<CapacityHoldWriteTransaction["query"]>(async (sql) => {
    if (sql.startsWith("INSERT")) {
      saved = true;
      return { rows: [{ reference: id(4) }] };
    }
    if (sql.startsWith("SELECT jsonb"))
      return { rows: saved ? [{ hold: request().hold, intentDigest: digest }] : [] };
    return { rows: [] };
  });
  const entered = vi.fn(async () => undefined);
  const store = createPostgresCapacityHoldStore(
    {
      async run(action) {
        await entered();
        return action({ query });
      },
    },
    { brandReference: id(1), storeReference: id(2) },
  );
  return {
    query,
    entered,
    store,
    existing() {
      saved = true;
    },
  };
}
beforeEach(() => {
  mocks.audit.mockReset().mockResolvedValue(undefined);
});
describe("Scheduled Hold append boundary", () => {
  it("commits a read-back acquisition and Audit in the same supplied transaction", async () => {
    const f = fixture();
    const value = request();
    const result = await f.store.append(value);
    expect(result).toEqual({ status: "Created", hold: value.hold });
    expect(Object.isFrozen(result.hold.slot)).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith({ query: f.query }, value.audit);
    expect(f.query.mock.calls[0]?.[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(f.query.mock.calls[2]?.[1]).toEqual([
      `fulfillment.capacity-hold:${id(1)}:${id(2)}:${id(6)}`,
    ]);
  });
  it("recovers original expired acquisition without renewal or another Audit", async () => {
    const f = fixture();
    f.existing();
    const value = request(); // Historical creation/expiry deliberately remain unchanged.
    expect(await f.store.append(value)).toEqual({ status: "Existing", hold: value.hold });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["intent", "units", "cart", "expiry"])(
    "conflicts on changed %s for original operation",
    async (kind) => {
      const f = fixture();
      f.existing();
      const value = request();
      if (kind === "intent") value.intentDigest = `sha256:${"b".repeat(64)}`;
      if (kind === "units") value.hold.units = 2;
      if (kind === "cart") value.hold.cartReference = id(99);
      if (kind === "expiry") value.hold.expiresAt = "2026-09-10T10:11:00.000Z";
      await expect(f.store.append(value)).rejects.toMatchObject({
        code: "CAPACITY_IDEMPOTENCY_CONFLICT",
      });
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
  it("freezes request and Audit before entering an asynchronous transaction", async () => {
    const f = fixture();
    const value = request();
    f.entered.mockImplementation(async () => {
      value.hold.units = 999;
      value.audit.targetId = id(999);
    });
    expect((await f.store.append(value)).hold.units).toBe(1);
    expect(mocks.audit.mock.calls[0]?.[1].targetId).toBe(id(4));
  });
  it.each([
    "scope",
    "state",
    "units",
    "extra",
    "getter",
    "audit actor",
    "audit scope",
    "audit target",
    "audit action",
    "audit time",
  ])("rejects invalid %s before I/O", async (kind) => {
    const f = fixture();
    const value = request();
    const getter = vi.fn();
    if (kind === "scope") value.hold.slot.storeReference = id(90);
    if (kind === "state") value.hold.state = "Released";
    if (kind === "units") value.hold.units = 0;
    if (kind === "extra") Object.assign(value, { unexpected: true });
    if (kind === "getter") Object.defineProperty(value, "hold", { get: getter, enumerable: true });
    if (kind === "audit actor") value.audit.actor.type = "Customer";
    if (kind === "audit scope") value.audit.storeId = id(90);
    if (kind === "audit target") value.audit.targetId = id(90);
    if (kind === "audit action") value.audit.actionCode = "OTHER_ACTION";
    if (kind === "audit time") value.audit.occurredAt = "2026-09-10T10:01:00.000Z";
    await expect(f.store.append(value)).rejects.toMatchObject({ code: "CAPACITY_INPUT_INVALID" });
    expect(f.entered).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    "null row",
    "two rows",
    "sparse",
    "getter",
    "foreign",
    "operation",
    "slot",
    "missing witness",
    "wrong witness",
    "audit failure",
    "commit failure",
  ])("fails closed on %s without raw dependency details", async (kind) => {
    const f = fixture();
    const original = f.query.getMockImplementation();
    const getter = vi.fn(() => {
      throw new Error("private");
    });
    f.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("SELECT jsonb")) {
        if (kind === "null row") return { rows: [null] };
        if (kind === "two rows") return { rows: [{}, {}] };
        if (kind === "sparse") return { rows: new Array(1) };
        if (kind === "getter")
          return Object.defineProperty({}, "rows", { get: getter, enumerable: true });
        if (["foreign", "operation", "slot"].includes(kind)) {
          const hold = request().hold;
          if (kind === "foreign") hold.slot.storeReference = id(90);
          if (kind === "operation") hold.operationReference = id(90);
          if (kind === "slot") hold.slot.startsAt = "2026-09-11T11:00:00.000Z";
          return { rows: [{ hold, intentDigest: digest }] };
        }
      }
      if (sql.startsWith("INSERT") && kind === "missing witness") return { rows: [] };
      if (sql.startsWith("INSERT") && kind === "wrong witness")
        return { rows: [{ reference: id(90) }] };
      if (!original) throw new Error();
      return original(sql, values);
    });
    if (kind === "audit failure") mocks.audit.mockRejectedValue(new Error("private"));
    const store =
      kind === "commit failure"
        ? createPostgresCapacityHoldStore(
            {
              async run(action) {
                await action({ query: f.query });
                throw new Error("private");
              },
            },
            { brandReference: id(1), storeReference: id(2) },
          )
        : f.store;
    await expect(store.append(request())).rejects.toMatchObject({
      code: kind === "slot" ? "CAPACITY_IDEMPOTENCY_CONFLICT" : "CAPACITY_DEPENDENCY_UNAVAILABLE",
      message: "scheduled capacity is unavailable",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
