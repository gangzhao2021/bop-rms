import { describe, expect, it } from "vitest";
import {
  parseScheduledCapacityHold,
  parseScheduledCapacityAllocation,
  planScheduledCapacityConversion,
  planScheduledCapacityHoldRelease,
  planScheduledCapacityAllocationTransition,
  requireScheduledCapacityUnits,
  ScheduledCapacityError,
} from "../index.js";

const ref = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const created = "2026-09-10T12:00:00.000Z";
const beforeExpiry = "2026-09-10T12:09:59.999Z";
const expiry = "2026-09-10T12:10:00.000Z";
const slotStart = "2026-09-10T13:00:00.000Z";
const scope = { brandReference: ref(1), storeReference: ref(2) };
function hold() {
  return {
    slot: {
      ...scope,
      fulfillmentType: "Pickup",
      slotReference: ref(3),
      configVersion: 4,
      startsAt: slotStart,
      endsAt: "2026-09-10T13:30:00.000Z",
    },
    holdReference: ref(4),
    cartReference: ref(5),
    operationReference: ref(6),
    units: 3,
    unitsRuleVersion: 1,
    unitsInputDigest: `sha256:${"a".repeat(64)}`,
    state: "Active",
    version: 1,
    createdAt: created,
    updatedAt: created,
    expiresAt: expiry,
    allocationReference: null,
  };
}
function conversion() {
  return {
    hold: hold(),
    scope,
    expectedVersion: 1,
    at: beforeExpiry,
    allocationReference: ref(7),
    orderReference: ref(8),
    fulfillmentReference: ref(9),
  };
}
function release() {
  return { hold: hold(), scope, expectedVersion: 1, at: beforeExpiry, reason: "Release" };
}
function allocationTransition() {
  return {
    allocation: planScheduledCapacityConversion(conversion()).allocation,
    scope,
    expectedVersion: 1,
    at: expiry,
    action: "Release",
    fulfillmentInProgressAt: null,
  };
}
function code(work: () => unknown, expected = "CAPACITY_INPUT_INVALID") {
  expect(work).toThrow(ScheduledCapacityError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({ code: expected, message: "scheduled capacity is unavailable" });
  }
}

describe("scheduled capacity owner lifecycle", () => {
  it("captures immutable provenance without retaining mutable caller objects", () => {
    const original = hold();
    const parsed = parseScheduledCapacityHold(original);
    original.slot.configVersion = 9;
    original.units = 8;
    expect(parsed.slot.configVersion).toBe(4);
    expect(parsed.units).toBe(3);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.slot)).toBe(true);
  });

  it("converts at the last live millisecond with no additional occupancy", () => {
    const original = conversion();
    const result = planScheduledCapacityConversion(original);
    expect(result.occupancyDelta).toBe(0);
    expect(result.hold).toMatchObject({
      state: "Converted",
      version: 2,
      allocationReference: ref(7),
    });
    expect(result.allocation).toMatchObject({
      state: "Active",
      version: 1,
      holdReference: ref(4),
      cartReference: ref(5),
      operationReference: ref(6),
      units: 3,
      unitsRuleVersion: 1,
      orderReference: ref(8),
      fulfillmentReference: ref(9),
      createdAt: beforeExpiry,
    });
    expect(result.allocation.slot).toEqual(original.hold.slot);
    expect(original.hold.state).toBe("Active");
  });

  it.each([expiry, "2026-09-10T12:10:00.001Z", slotStart])(
    "rejects conversion at/after exclusive expiry %s",
    (at) => {
      code(
        () => planScheduledCapacityConversion({ ...conversion(), at }),
        "CAPACITY_TRANSITION_CONFLICT",
      );
    },
  );

  it("does not convert a still-unexpired hold after its future slot has begun", () => {
    const input = conversion();
    input.hold.expiresAt = "2026-09-10T13:10:00.000Z";
    input.at = slotStart;
    code(() => planScheduledCapacityConversion(input), "CAPACITY_TRANSITION_CONFLICT");
  });

  it("returns units once on release, retaining the original history", () => {
    const input = release();
    const result = planScheduledCapacityHoldRelease(input);
    expect(result).toMatchObject({ hold: { state: "Released", version: 2 }, occupancyDelta: -3 });
    expect(input.hold.state).toBe("Active");
    code(
      () => planScheduledCapacityHoldRelease({ ...input, hold: result.hold, expectedVersion: 2 }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it.each(["Release", "Expire"])("records expiry at the exact boundary for %s", (reason) => {
    const result = planScheduledCapacityHoldRelease({ ...release(), at: expiry, reason });
    expect(result).toMatchObject({ hold: { state: "Expired" }, occupancyDelta: -3 });
    code(
      () =>
        planScheduledCapacityConversion({ ...conversion(), hold: result.hold, expectedVersion: 2 }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it("rejects premature expiry", () => {
    code(
      () => planScheduledCapacityHoldRelease({ ...release(), reason: "Expire" }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it("does not release the converted hold", () => {
    const converted = planScheduledCapacityConversion(conversion());
    code(
      () =>
        planScheduledCapacityHoldRelease({
          ...release(),
          hold: converted.hold,
          expectedVersion: 2,
        }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it("releases an unconsumed allocation exactly once", () => {
    const input = allocationTransition();
    const result = planScheduledCapacityAllocationTransition(input);
    expect(result).toMatchObject({
      allocation: { state: "Released", version: 2 },
      occupancyDelta: -3,
    });
    code(
      () =>
        planScheduledCapacityAllocationTransition({
          ...input,
          allocation: result.allocation,
          expectedVersion: 2,
        }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it.each(["Release", "Consume"])("consumes at slot start for action %s", (action) => {
    const result = planScheduledCapacityAllocationTransition({
      ...allocationTransition(),
      at: slotStart,
      action,
    });
    expect(result).toMatchObject({
      allocation: { state: "Consumed", consumedAt: slotStart },
      occupancyDelta: 0,
    });
    code(
      () =>
        planScheduledCapacityAllocationTransition({
          ...allocationTransition(),
          allocation: result.allocation,
          at: slotStart,
          expectedVersion: 2,
        }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it("retains the earlier InProgress instant when processing its event after slot start", () => {
    const inProgressAt = "2026-09-10T12:30:00.000Z";
    const result = planScheduledCapacityAllocationTransition({
      ...allocationTransition(),
      at: "2026-09-10T13:15:00.000Z",
      fulfillmentInProgressAt: inProgressAt,
    });
    expect(result).toMatchObject({
      allocation: { state: "Consumed", consumedAt: inProgressAt },
      occupancyDelta: 0,
    });
  });

  it("retains slot start when InProgress occurs later", () => {
    const result = planScheduledCapacityAllocationTransition({
      ...allocationTransition(),
      at: "2026-09-10T13:15:00.000Z",
      fulfillmentInProgressAt: "2026-09-10T13:10:00.000Z",
    });
    expect(result.allocation.consumedAt).toBe(slotStart);
  });

  it("consumes early when authoritative Fulfillment InProgress blocks a cancellation release", () => {
    const result = planScheduledCapacityAllocationTransition({
      ...allocationTransition(),
      fulfillmentInProgressAt: expiry,
    });
    expect(result).toMatchObject({
      allocation: { state: "Consumed", consumedAt: expiry },
      occupancyDelta: 0,
    });
  });

  it("requires an actual consumption trigger", () => {
    code(
      () =>
        planScheduledCapacityAllocationTransition({ ...allocationTransition(), action: "Consume" }),
      "CAPACITY_TRANSITION_CONFLICT",
    );
  });

  it.each([created, slotStart])(
    "rejects inconsistent InProgress evidence %s",
    (fulfillmentInProgressAt) => {
      code(() =>
        planScheduledCapacityAllocationTransition({
          ...allocationTransition(),
          fulfillmentInProgressAt,
        }),
      );
    },
  );

  for (const [name, build, run] of [
    ["conversion", conversion, planScheduledCapacityConversion],
    ["hold release", release, planScheduledCapacityHoldRelease],
    ["allocation", allocationTransition, planScheduledCapacityAllocationTransition],
  ] as const) {
    it.each(["brandReference", "storeReference"])("rejects foreign %s in " + name, (field) => {
      code(
        () => run({ ...build(), scope: { ...scope, [field]: ref(99) } }),
        "CAPACITY_SCOPE_MISMATCH",
      );
    });
    it("rejects stale version in " + name, () => {
      code(() => run({ ...build(), expectedVersion: 2 }), "CAPACITY_VERSION_CONFLICT");
    });
    it("rejects reversed clocks in " + name, () => {
      code(
        () => run({ ...build(), at: "2026-09-10T11:59:59.999Z" }),
        "CAPACITY_TRANSITION_CONFLICT",
      );
    });
    it("rejects unknown command fields in " + name, () => {
      code(() => run({ ...build(), overrideCapacity: true }));
    });
  }

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects invalid units %s",
    (units) => code(() => parseScheduledCapacityHold({ ...hold(), units })),
  );

  it.each([
    { state: "Pending" },
    { state: "Active", version: 2 },
    { updatedAt: expiry },
    { state: "Converted", version: 2 },
    { allocationReference: ref(8) },
    { state: "Expired", version: 2, updatedAt: beforeExpiry },
    { state: "Released", version: 2, updatedAt: expiry },
    { expiresAt: created },
    { createdAt: "2026-02-30T12:00:00.000Z" },
    { createdAt: "2026-09-10T12:00:00Z" },
  ])("rejects malformed hold lifecycle %j", (patch) => {
    code(() => parseScheduledCapacityHold({ ...hold(), ...patch }));
  });

  it.each([
    { state: "Consumed", version: 2, consumedAt: null },
    { state: "Active", consumedAt: expiry },
    { state: "Released", version: 2, updatedAt: slotStart },
    { state: "Consumed", version: 2, consumedAt: slotStart, updatedAt: expiry },
    {
      state: "Consumed",
      version: 2,
      consumedAt: "2026-09-10T13:01:00.000Z",
      updatedAt: "2026-09-10T13:02:00.000Z",
    },
    { state: "Active", version: 2 },
  ])("rejects malformed allocation lifecycle %j", (patch) => {
    code(() =>
      parseScheduledCapacityAllocation({ ...allocationTransition().allocation, ...patch }),
    );
  });

  it("rejects getters without executing them at the aggregate and nested slot boundaries", () => {
    let calls = 0;
    const getter = {
      enumerable: true,
      get() {
        calls++;
        return 3;
      },
    };
    const input = hold();
    Object.defineProperty(input, "units", getter);
    code(() => parseScheduledCapacityHold(input));
    const nested = hold();
    Object.defineProperty(nested.slot, "configVersion", getter);
    code(() => parseScheduledCapacityHold(nested));
    expect(calls).toBe(0);
  });

  it.each([
    null,
    [],
    Object.create({}),
    { ...hold(), [Symbol("hidden")]: true },
    Object.defineProperty(hold(), "units", { value: 3, enumerable: false }),
  ])("rejects non-data or open aggregate shapes", (value) =>
    code(() => parseScheduledCapacityHold(value)),
  );

  it("maps hostile reflection errors to a bounded domain error", () => {
    const input = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private payload");
        },
      },
    );
    code(() => parseScheduledCapacityHold(input));
  });
});

describe("capacity admission arithmetic within the future owner transaction", () => {
  it.each([
    { limit: 5, occupied: 2, requested: 3 },
    { limit: Number.MAX_SAFE_INTEGER, occupied: Number.MAX_SAFE_INTEGER - 1, requested: 1 },
  ])("accepts the exact remaining units %j", (input) => {
    expect(requireScheduledCapacityUnits(input)).toBe(input.requested);
  });

  it.each([
    { limit: 5, occupied: 3, requested: 3 },
    { limit: 0, occupied: 0, requested: 1 },
    { limit: 2, occupied: 3, requested: 1 },
    { limit: Number.MAX_SAFE_INTEGER, occupied: Number.MAX_SAFE_INTEGER, requested: 1 },
  ])("rejects insufficient/reduced/overflow capacity %j", (input) => {
    code(() => requireScheduledCapacityUnits(input), "CAPACITY_INSUFFICIENT");
  });

  it.each([
    { limit: -1 },
    { occupied: -1 },
    { occupied: 1.5 },
    { requested: 0 },
    { limit: Infinity },
    { requested: Number.MAX_SAFE_INTEGER + 1 },
    { occupied: "1" },
    { bypass: true },
  ])("rejects invalid capacity arithmetic %j", (patch) => {
    code(() => requireScheduledCapacityUnits({ limit: 5, occupied: 0, requested: 1, ...patch }));
  });
});
