import { describe, expect, it } from "vitest";
import { createPostgresCapacityQueryStore, planScheduledCapacityConversion } from "../index.js";

const id = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const sha = `sha256:${"a".repeat(64)}`;
const scope = { brandReference: id(1), storeReference: id(2) };
function hold() {
  return {
    slot: {
      ...scope,
      slotReference: id(3),
      fulfillmentType: "Pickup",
      configVersion: 1,
      startsAt: "2026-09-10T13:00:00.000Z",
      endsAt: "2026-09-10T13:30:00.000Z",
    },
    holdReference: id(4),
    cartReference: id(5),
    operationReference: id(6),
    units: 1,
    unitsRuleVersion: 1,
    unitsInputDigest: sha,
    state: "Active",
    version: 1,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    expiresAt: "2026-09-10T12:10:00.000Z",
    allocationReference: null,
  };
}
function allocation() {
  return planScheduledCapacityConversion({
    hold: hold(),
    scope,
    expectedVersion: 1,
    at: "2026-09-10T12:05:00.000Z",
    allocationReference: id(7),
    orderReference: id(8),
    fulfillmentReference: id(9),
  }).allocation;
}
const holdInput = { holdReference: id(4), cartReference: id(5) };
const operationInput = { operationReference: id(6), cartReference: id(5), intentDigest: sha };
const allocationInput = {
  allocationReference: id(7),
  orderReference: id(8),
  fulfillmentReference: id(9),
};
function fixture(response: unknown = { rows: [{ hold: hold(), intentDigest: sha }] }) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const runner = {
    async run<T>(
      action: (transaction: {
        query(sql: string, values: readonly unknown[]): Promise<unknown>;
      }) => Promise<T>,
    ) {
      return action({
        async query(sql, values) {
          calls.push({ sql, values });
          return sql.startsWith("SELECT jsonb_build_object") ? response : { rows: [] };
        },
      });
    },
  };
  return { store: createPostgresCapacityQueryStore(runner, scope), calls, runner };
}
const unavailable = {
  code: "CAPACITY_DEPENDENCY_UNAVAILABLE",
  message: "scheduled capacity is unavailable",
};

describe("capacity owner query store", () => {
  it("uses a read-only transaction, exact local scope and parameterized association filters", async () => {
    const { store, calls } = fixture();
    expect(await store.loadHold(holdInput)).toEqual(hold());
    expect(calls[0]).toEqual({ sql: "SET TRANSACTION READ ONLY", values: [] });
    expect(calls[1]?.values).toEqual([id(1), id(2)]);
    expect(calls[2]?.values).toEqual([id(1), id(2), id(4), id(5)]);
    expect(calls[2]?.sql).toContain("h.hold_id=$3 AND h.cart_id=$4");
    expect(calls[2]?.sql).not.toContain(id(4));
  });
  it("uses all three Allocation association references", async () => {
    const { store, calls } = fixture({ rows: [{ allocation: allocation() }] });
    expect(await store.loadAllocation(allocationInput)).toEqual(allocation());
    expect(calls[2]?.values).toEqual([id(1), id(2), id(7), id(8), id(9)]);
    expect(calls[2]?.sql).toContain("a.allocation_id=$3 AND a.order_id=$4 AND a.fulfillment_id=$5");
  });
  it("recovers exact original operation and original expiry", async () => {
    const { store, calls } = fixture();
    const result = await store.resolveHoldOperation(operationInput);
    expect(result?.expiresAt).toBe(hold().expiresAt);
    expect(calls[2]?.sql).toContain("h.operation_id=$3");
    expect(calls[2]?.values).toEqual([id(1), id(2), id(6)]);
  });
  it.each([{ cartReference: id(90) }, { intentDigest: `sha256:${"b".repeat(64)}` }])(
    "rejects operation reuse with changed intent %j",
    async (patch) => {
      await expect(
        fixture().store.resolveHoldOperation({ ...operationInput, ...patch }),
      ).rejects.toMatchObject({
        code: "CAPACITY_IDEMPOTENCY_CONFLICT",
      });
    },
  );
  it("retains terminal history rather than generating a fresh Active Hold", async () => {
    const terminal = {
      ...hold(),
      state: "Expired",
      version: 2,
      updatedAt: "2026-09-10T12:10:00.000Z",
    };
    const result = await fixture({
      rows: [{ hold: terminal, intentDigest: sha }],
    }).store.resolveHoldOperation(operationInput);
    expect(result).toEqual(terminal);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.slot)).toBe(true);
  });
  it("retains Consumed history", async () => {
    const terminal = {
      ...allocation(),
      state: "Consumed",
      version: 2,
      updatedAt: "2026-09-10T13:01:00.000Z",
      consumedAt: "2026-09-10T13:00:00.000Z",
    };
    expect(
      await fixture({ rows: [{ allocation: terminal }] }).store.loadAllocation(allocationInput),
    ).toEqual(terminal);
  });
  it("returns null only for a real empty row collection", async () => {
    const { store } = fixture({ rows: [] });
    expect(await store.loadHold(holdInput)).toBeNull();
    expect(await store.loadAllocation(allocationInput)).toBeNull();
    expect(await store.resolveHoldOperation(operationInput)).toBeNull();
  });
  it("accepts an actual driver-style Result prototype", async () => {
    class Result {
      rows = [{ hold: hold(), intentDigest: sha }];
    }
    expect(await fixture(new Result()).store.loadHold(holdInput)).toEqual(hold());
  });
  for (const [method, input] of [
    ["loadHold", holdInput],
    ["loadAllocation", allocationInput],
    ["resolveHoldOperation", operationInput],
  ] as const) {
    it.each([null, [], {}, { ...input, unexpected: true }])(
      "rejects malformed " + method + " selector before I/O",
      async (value) => {
        const { store, calls } = fixture();
        await expect(store[method](value)).rejects.toMatchObject({
          code: "CAPACITY_INPUT_INVALID",
        });
        expect(calls).toHaveLength(0);
      },
    );
    it("does not execute " + method + " selector getters", async () => {
      let called = 0;
      const value = { ...input };
      const field = Object.keys(input)[0];
      if (field === undefined) throw new Error("missing selector field");
      Object.defineProperty(value, field, {
        enumerable: true,
        get() {
          called++;
          return id(4);
        },
      });
      const { store, calls } = fixture();
      await expect(store[method](value)).rejects.toMatchObject({ code: "CAPACITY_INPUT_INVALID" });
      expect(called).toBe(0);
      expect(calls).toHaveLength(0);
    });
  }
  it.each([
    null,
    {},
    { rows: null },
    { rows: {} },
    { rows: [null] },
    { rows: new Array(1) },
    {
      rows: [
        { hold: hold(), intentDigest: sha },
        { hold: hold(), intentDigest: sha },
      ],
    },
    { rows: [{ hold: hold(), intentDigest: sha, unexpected: true }] },
    { rows: Object.assign([{ hold: hold(), intentDigest: sha }], { map: () => [] }) },
    { rows: Object.assign([{ hold: hold(), intentDigest: sha }], { [Symbol("extra")]: true }) },
  ])("rejects invalid/executable driver collection", async (response) => {
    await expect(fixture(response).store.loadHold(holdInput)).rejects.toMatchObject(unavailable);
  });
  it("never executes driver rows, row payload or nested aggregate accessors", async () => {
    let calls = 0;
    const descriptor = {
      enumerable: true,
      get() {
        calls++;
        return hold();
      },
    };
    for (const response of [
      Object.defineProperty({}, "rows", descriptor),
      { rows: [Object.defineProperty({ intentDigest: sha }, "hold", descriptor)] },
      { rows: [{ hold: Object.defineProperty(hold(), "units", descriptor), intentDigest: sha }] },
      {
        rows: [
          {
            hold: {
              ...hold(),
              slot: Object.defineProperty({ ...hold().slot }, "configVersion", descriptor),
            },
            intentDigest: sha,
          },
        ],
      },
    ])
      await expect(fixture(response).store.loadHold(holdInput)).rejects.toMatchObject(unavailable);
    expect(calls).toBe(0);
  });
  it.each([
    { holdReference: id(99) },
    { cartReference: id(99) },
    { units: 1.5 },
    { slot: { ...hold().slot, storeReference: id(99) } },
    { slot: { ...hold().slot, brandReference: id(99) } },
  ])("rejects wrong Hold results %j", async (patch) => {
    await expect(
      fixture({ rows: [{ hold: { ...hold(), ...patch }, intentDigest: sha }] }).store.loadHold(
        holdInput,
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it.each([
    { allocationReference: id(99) },
    { orderReference: id(99) },
    { fulfillmentReference: id(99) },
    { slot: { ...allocation().slot, storeReference: id(99) } },
    { slot: { ...allocation().slot, brandReference: id(99) } },
  ])("rejects wrong Allocation results %j", async (patch) => {
    await expect(
      fixture({ rows: [{ allocation: { ...allocation(), ...patch } }] }).store.loadAllocation(
        allocationInput,
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it("does not trust a different operation returned by a dependency", async () => {
    await expect(
      fixture({
        rows: [{ hold: { ...hold(), operationReference: id(99) }, intentDigest: sha }],
      }).store.resolveHoldOperation(operationInput),
    ).rejects.toMatchObject(unavailable);
  });
  it("maps transaction failures without exposing driver payloads", async () => {
    const runner = {
      async run<T>(): Promise<T> {
        throw new Error("private database payload");
      },
    };
    const store = createPostgresCapacityQueryStore(runner, scope);
    await expect(store.loadHold(holdInput)).rejects.toMatchObject(unavailable);
  });
  it("captures construction scope and selectors before waiting", async () => {
    const local = { ...scope };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, calls } = fixture();
    const store = createPostgresCapacityQueryStore(
      {
        async run<T>(action: Parameters<typeof runner.run<T>>[0]) {
          await gate;
          return runner.run(action);
        },
      },
      local,
    );
    const selector = { ...holdInput };
    const result = store.loadHold(selector);
    local.storeReference = id(99);
    selector.cartReference = id(99);
    release();
    expect(await result).toEqual(hold());
    expect(calls[2]?.values).toEqual([id(1), id(2), id(4), id(5)]);
  });
  it("rejects executable construction scope without I/O", () => {
    let calls = 0;
    const local = Object.defineProperty({ ...scope }, "storeReference", {
      enumerable: true,
      get() {
        calls++;
        return id(2);
      },
    });
    const { runner, calls: queries } = fixture();
    expect(() => createPostgresCapacityQueryStore(runner, local)).toThrow(
      "scheduled capacity is unavailable",
    );
    expect(calls).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
