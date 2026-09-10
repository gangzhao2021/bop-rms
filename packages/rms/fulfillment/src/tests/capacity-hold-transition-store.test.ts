import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresCapacityHoldTransitionStore,
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
function request(mode: "Convert" | "Release" = "Convert") {
  const at = "2026-09-10T10:01:00.000Z";
  const hold = {
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
    state: "Active",
    version: 1,
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
    expiresAt: "2026-09-10T10:10:00.000Z",
    allocationReference: null,
  };
  const common = { hold, scope: { ...scope }, expectedVersion: 1, at };
  return {
    transition:
      mode === "Convert"
        ? {
            ...common,
            allocationReference: id(9),
            orderReference: id(10),
            fulfillmentReference: id(11),
          }
        : { ...common, reason: "Release" },
    operationReference: id(20),
    intentDigest: digest,
    audit: {
      auditId: id(7),
      brandId: id(1),
      storeId: id(2),
      actor: { type: "System" },
      actionCode:
        mode === "Convert"
          ? "FULFILLMENT_CAPACITY_HOLD_CONVERT"
          : "FULFILLMENT_CAPACITY_HOLD_RELEASE",
      targetType: "FulfillmentCapacityHold",
      targetId: id(4),
      reasonCode: "AUTHORIZED_CHECKOUT_CAPACITY",
      correlationId: id(8),
      occurredAt: at,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "SYNTHETIC_RETENTION",
      retentionPolicyVersion: 1,
    },
  };
}
function fixture(mode: "Convert" | "Release" = "Convert") {
  let terminal = false;
  const receipt = () => ({
    brand: id(1),
    store: id(2),
    operation: id(20),
    digest,
    hold: id(4),
    state: mode === "Convert" ? "Converted" : "Released",
    at: request().transition.at,
    allocation: mode === "Convert" ? id(9) : null,
    order: mode === "Convert" ? id(10) : null,
    fulfillment: mode === "Convert" ? id(11) : null,
    allocationCreatedAt: mode === "Convert" ? request().transition.at : null,
  });
  const query = vi.fn<CapacityHoldWriteTransaction["query"]>(async (sql) => {
    if (sql.includes("AS receipt")) return { rows: terminal ? [{ receipt: receipt() }] : [] };
    if (sql.includes("AS hold,"))
      return { rows: [{ hold: request().transition.hold, intentDigest: digest }] };
    if (sql.startsWith("SELECT slot_id")) return { rows: [{ reference: id(3) }] };
    if (sql.startsWith("SELECT hold_id")) return { rows: [] };
    if (sql.startsWith("INSERT INTO rms_fulfillment.capacity_hold_terminal")) {
      terminal = true;
      return { rows: [{ reference: id(4) }] };
    }
    if (sql.startsWith("INSERT INTO rms_fulfillment.capacity_allocation"))
      return { rows: [{ reference: id(9) }] };
    return { rows: [] };
  });
  const entered = vi.fn(async () => undefined);
  const store = createPostgresCapacityHoldTransitionStore(
    {
      async run(action) {
        await entered();
        return action({ query });
      },
    },
    scope,
  );
  return {
    query,
    entered,
    store,
    receipt,
    existing() {
      terminal = true;
    },
  };
}
beforeEach(() => {
  mocks.audit.mockReset().mockResolvedValue(undefined);
});
describe("capacity Hold transition transaction adapter", () => {
  it.each(["Convert", "Release"] as const)(
    "persists %s and Audit as one owner transaction",
    async (mode) => {
      const f = fixture(mode);
      const result = await (mode === "Convert" ? f.store.convert : f.store.release)(request(mode));
      expect(result.status).toBe("Created");
      expect(result.hold.state).toBe(mode === "Convert" ? "Converted" : "Released");
      expect(result.allocation?.allocationReference ?? null).toBe(
        mode === "Convert" ? id(9) : null,
      );
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(result.hold.slot)).toBe(true);
      expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(
        mode === "Convert" ? 2 : 1,
      );
    },
  );
  it.each(["Convert", "Release"] as const)(
    "replays %s without another write or Audit",
    async (mode) => {
      const f = fixture(mode);
      f.existing();
      expect(
        (await (mode === "Convert" ? f.store.convert : f.store.release)(request(mode))).status,
      ).toBe("Existing");
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
  it("conflicts on altered transition intent", async () => {
    const f = fixture();
    f.existing();
    const value = request();
    value.intentDigest = `sha256:${"b".repeat(64)}`;
    await expect(f.store.convert(value)).rejects.toMatchObject({
      code: "CAPACITY_IDEMPOTENCY_CONFLICT",
    });
  });
  it("preserves a previously terminal Hold", async () => {
    const f = fixture();
    const original = f.query.getMockImplementation();
    f.query.mockImplementation(async (sql, v) =>
      sql.startsWith("SELECT hold_id") ? { rows: [{ reference: id(4) }] } : original?.(sql, v),
    );
    await expect(f.store.convert(request())).rejects.toMatchObject({
      code: "CAPACITY_TRANSITION_CONFLICT",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("captures transition and Audit before transaction waits", async () => {
    const f = fixture();
    const value = request();
    f.entered.mockImplementation(async () => {
      value.transition.hold.units = 999;
      value.audit.targetId = id(99);
    });
    expect((await f.store.convert(value)).hold.units).toBe(1);
    expect(mocks.audit.mock.calls[0]?.[1].targetId).toBe(id(4));
  });
  it.each(["scope", "version", "expired", "audit", "extra", "getter"])(
    "rejects invalid %s before I/O",
    async (kind) => {
      const f = fixture();
      const value = request();
      const getter = vi.fn();
      if (kind === "scope") value.transition.hold.slot.storeReference = id(99);
      if (kind === "version") value.transition.expectedVersion = 2;
      if (kind === "expired") value.transition.at = value.transition.hold.expiresAt;
      if (kind === "audit") value.audit.targetId = id(99);
      if (kind === "extra") Object.assign(value.transition, { extra: true });
      if (kind === "getter")
        Object.defineProperty(value, "transition", { get: getter, enumerable: true });
      await expect(f.store.convert(value)).rejects.toMatchObject({
        code: "CAPACITY_INPUT_INVALID",
      });
      expect(f.entered).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it.each([
    "original",
    "scope",
    "operation",
    "sparse",
    "getter",
    "terminal witness",
    "allocation witness",
    "Audit",
    "commit",
  ])("rejects %s dependency failure", async (kind) => {
    const f = fixture();
    const original = f.query.getMockImplementation();
    const getter = vi.fn();
    f.query.mockImplementation(async (sql, v) => {
      if (sql.includes("AS receipt")) {
        if (kind === "sparse") return { rows: new Array(1) };
        if (kind === "getter")
          return Object.defineProperty({}, "rows", { get: getter, enumerable: true });
        if (kind === "scope" || kind === "operation")
          return {
            rows: [
              { receipt: { ...f.receipt(), [kind === "scope" ? "store" : "operation"]: id(99) } },
            ],
          };
      }
      if (sql.includes("AS hold,") && kind === "original")
        return {
          rows: [{ hold: { ...request().transition.hold, units: 2 }, intentDigest: digest }],
        };
      if (
        sql.startsWith("INSERT INTO rms_fulfillment.capacity_hold_terminal") &&
        kind === "terminal witness"
      )
        return { rows: [] };
      if (
        sql.startsWith("INSERT INTO rms_fulfillment.capacity_allocation") &&
        kind === "allocation witness"
      )
        return { rows: [{ reference: id(99) }] };
      return original?.(sql, v);
    });
    if (kind === "Audit") mocks.audit.mockRejectedValue(new Error("private failure"));
    const store =
      kind === "commit"
        ? createPostgresCapacityHoldTransitionStore(
            {
              async run(action) {
                await action({ query: f.query });
                throw new Error("private");
              },
            },
            scope,
          )
        : f.store;
    await expect(store.convert(request())).rejects.toMatchObject({
      code:
        kind === "original" ? "CAPACITY_TRANSITION_CONFLICT" : "CAPACITY_DEPENDENCY_UNAVAILABLE",
      message: "scheduled capacity is unavailable",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
