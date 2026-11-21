import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresCapacityAllocationTerminalStore,
  type CapacityHoldWriteTransaction,
} from "../index.js";
const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `0198a700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const scope = { brandReference: id(1), storeReference: id(2) };
function request(consumed = false) {
  const allocation = {
    slot: {
      ...scope,
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
    allocationReference: id(9),
    orderReference: id(10),
    fulfillmentReference: id(11),
    state: "Active",
    version: 1,
    createdAt: "2026-09-10T10:01:00.000Z",
    updatedAt: "2026-09-10T10:01:00.000Z",
    consumedAt: null,
  };
  return {
    transition: {
      allocation,
      scope: { ...scope },
      expectedVersion: 1,
      at: "2026-09-10T10:02:00.000Z",
      action: "Release",
      fulfillmentInProgressAt: consumed ? "2026-09-10T10:01:30.000Z" : null,
    },
    operationReference: id(20),
    intentDigest: digest,
    audit: {
      auditId: id(7),
      brandId: id(1),
      storeId: id(2),
      actor: { type: "System" },
      actionCode: consumed
        ? "FULFILLMENT_CAPACITY_ALLOCATION_CONSUME"
        : "FULFILLMENT_CAPACITY_ALLOCATION_RELEASE",
      targetType: "FulfillmentCapacityAllocation",
      targetId: id(9),
      reasonCode: "AUTHORIZED_CAPACITY_TRANSITION",
      correlationId: id(8),
      occurredAt: "2026-09-10T10:02:00.000Z",
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      retentionPolicyCode: "SYNTHETIC_RETENTION",
      retentionPolicyVersion: 1,
    },
  };
}
function fixture(consumed = false) {
  let terminal = false;
  const receipt = () => ({
    brand: id(1),
    store: id(2),
    operation: id(20),
    digest,
    allocation: id(9),
    state: consumed ? "Consumed" : "Released",
    at: request().transition.at,
    inProgressAt: request(consumed).transition.fulfillmentInProgressAt,
    consumedAt: consumed ? request(consumed).transition.fulfillmentInProgressAt : null,
  });
  const query = vi.fn<CapacityHoldWriteTransaction["query"]>(async (sql) => {
    if (sql.includes("AS receipt")) return { rows: terminal ? [{ receipt: receipt() }] : [] };
    if (sql.includes("AS allocation"))
      return { rows: [{ allocation: request().transition.allocation }] };
    if (sql.startsWith("SELECT slot_id")) return { rows: [{ reference: id(3) }] };
    if (sql.startsWith("SELECT allocation_id")) return { rows: [] };
    if (sql.startsWith("INSERT INTO rms_fulfillment.capacity_allocation_terminal")) {
      terminal = true;
      return { rows: [{ reference: id(9) }] };
    }
    return { rows: [] };
  });
  const entered = vi.fn(async () => undefined);
  const store = createPostgresCapacityAllocationTerminalStore(
    {
      async run(action) {
        await entered();
        return action({ query });
      },
    },
    scope,
  );
  return {
    store,
    query,
    entered,
    receipt,
    existing() {
      terminal = true;
    },
  };
}
beforeEach(() => {
  mocks.audit.mockReset().mockResolvedValue(undefined);
});
describe("Allocation terminal append", () => {
  it.each([false, true])(
    "persists original owner release/consumption, consumed=%s",
    async (consumed) => {
      const f = fixture(consumed);
      const result = await f.store.append(request(consumed));
      expect(result.status).toBe("Created");
      expect(result.allocation.state).toBe(consumed ? "Consumed" : "Released");
      expect(result.allocation.consumedAt).toBe(consumed ? "2026-09-10T10:01:30.000Z" : null);
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(result.allocation.slot)).toBe(true);
    },
  );
  it.each([false, true])(
    "replays terminal history without returning units again, consumed=%s",
    async (consumed) => {
      const f = fixture(consumed);
      f.existing();
      expect((await f.store.append(request(consumed))).status).toBe("Existing");
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
  it("rejects changed operation intent", async () => {
    const f = fixture();
    f.existing();
    const value = request();
    value.intentDigest = `sha256:${"b".repeat(64)}`;
    await expect(f.store.append(value)).rejects.toMatchObject({
      code: "CAPACITY_IDEMPOTENCY_CONFLICT",
    });
  });
  it("captures progress and allocation before waits", async () => {
    const f = fixture(true);
    const value = request(true);
    f.entered.mockImplementation(async () => {
      value.transition.fulfillmentInProgressAt = null;
      value.transition.allocation.units = 9;
    });
    expect((await f.store.append(value)).allocation.consumedAt).toBe("2026-09-10T10:01:30.000Z");
  });
  it.each([
    "scope",
    "version",
    "missing progress",
    "extra",
    "audit target",
    "audit action",
    "getter",
  ])("rejects invalid %s before I/O", async (kind) => {
    const f = fixture();
    const value = request();
    const getter = vi.fn();
    if (kind === "scope") value.transition.allocation.slot.storeReference = id(99);
    if (kind === "version") value.transition.expectedVersion = 2;
    if (kind === "missing progress")
      Reflect.deleteProperty(value.transition, "fulfillmentInProgressAt");
    if (kind === "extra") Object.assign(value.transition, { extra: true });
    if (kind === "audit target") value.audit.targetId = id(99);
    if (kind === "audit action") value.audit.actionCode = "OTHER_ACTION";
    if (kind === "getter")
      Object.defineProperty(value, "transition", { get: getter, enumerable: true });
    await expect(f.store.append(value)).rejects.toMatchObject({ code: "CAPACITY_INPUT_INVALID" });
    expect(f.entered).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["terminal", "provenance", "receipt scope", "sparse", "witness", "Audit", "commit"])(
    "fails closed on %s",
    async (kind) => {
      const f = fixture();
      const original = f.query.getMockImplementation();
      f.query.mockImplementation(async (sql, v) => {
        if (sql.startsWith("SELECT allocation_id") && kind === "terminal")
          return { rows: [{ reference: id(9) }] };
        if (sql.includes("AS allocation") && kind === "provenance")
          return { rows: [{ allocation: { ...request().transition.allocation, units: 2 } }] };
        if (sql.includes("AS receipt") && kind === "receipt scope")
          return { rows: [{ receipt: { ...f.receipt(), store: id(99) } }] };
        if (sql.includes("AS receipt") && kind === "sparse") return { rows: new Array(1) };
        if (sql.startsWith("INSERT") && kind === "witness") return { rows: [] };
        return original?.(sql, v);
      });
      if (kind === "Audit") mocks.audit.mockRejectedValue(new Error("private"));
      const store =
        kind === "commit"
          ? createPostgresCapacityAllocationTerminalStore(
              {
                async run(action) {
                  await action({ query: f.query });
                  throw new Error("private");
                },
              },
              scope,
            )
          : f.store;
      await expect(store.append(request())).rejects.toMatchObject({
        code: ["terminal", "provenance"].includes(kind)
          ? "CAPACITY_TRANSITION_CONFLICT"
          : "CAPACITY_DEPENDENCY_UNAVAILABLE",
        message: "scheduled capacity is unavailable",
      });
    },
  );
});
