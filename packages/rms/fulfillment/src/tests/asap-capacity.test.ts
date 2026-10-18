import { describe, expect, it } from "vitest";
import {
  prepareAsapCapacityCommitment,
  sealAsapCapacityCommitment,
  finishAsapCapacityCommitment,
  assertAsapCapacityPaymentUsable,
  parseAsapCapacityCommitment,
} from "../index.js";
const ref = (n: number) => "01900000-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function input() {
  return {
    allocationReference: ref(1),
    guestSessionReference: ref(2),
    cartReference: ref(3),
    quoteReference: ref(4),
    submissionReference: ref(5),
    orderReference: ref(6),
    orderBatchReference: ref(7),
    fulfillmentReference: ref(8),
    paymentOperationReference: ref(9),
    slot: {
      brandReference: ref(10),
      storeReference: ref(11),
      slotReference: ref(12),
      fulfillmentType: "Pickup",
      configVersion: 1,
      startsAt: at,
      endsAt: "2026-09-10T12:30:00.000Z",
    },
    cartVersion: 1,
    units: 2,
    unitsRuleVersion: 1,
    unitsInputDigest: "sha256:" + "a".repeat(64),
    intentDigest: "sha256:" + "b".repeat(64),
    preparedAt: at,
    preparationValidUntil: "2026-09-10T12:05:00.000Z",
  };
}
function current() {
  return { slot: input().slot, capacityLimit: 5, occupiedUnits: 3, observedAt: at };
}
function prepared() {
  return prepareAsapCapacityCommitment(input(), current());
}
function acknowledgement() {
  const source = input();
  return {
    allocationReference: source.allocationReference,
    guestSessionReference: source.guestSessionReference,
    cartReference: source.cartReference,
    quoteReference: source.quoteReference,
    submissionReference: source.submissionReference,
    orderReference: source.orderReference,
    orderBatchReference: source.orderBatchReference,
    fulfillmentReference: source.fulfillmentReference,
    paymentOperationReference: source.paymentOperationReference,
    brandReference: source.slot.brandReference,
    storeReference: source.slot.storeReference,
    cartVersion: source.cartVersion,
    intentDigest: source.intentDigest,
    acknowledgedAt: at,
  };
}
function sealed() {
  return sealAsapCapacityCommitment(prepared(), acknowledgement(), at, at);
}
describe("ASAP capacity commitment", () => {
  it("uses direct allocation provenance without a scheduled hold", () => {
    const original = input();
    const result = prepareAsapCapacityCommitment(original, current());
    original.slot.configVersion = 9;
    expect(result.slot.configVersion).toBe(1);
    expect(result).not.toHaveProperty("holdReference");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.slot)).toBe(true);
  });
  it.each([0, 1, 4])("rejects insufficient shared capacity %s", (capacityLimit) => {
    expect(() => prepareAsapCapacityCommitment(input(), { ...current(), capacityLimit })).toThrow(
      expect.objectContaining({ code: "ASAP_CAPACITY_INSUFFICIENT" }),
    );
  });
  it("rejects a stale configuration observation", () => {
    expect(() =>
      prepareAsapCapacityCommitment(input(), {
        ...current(),
        slot: { ...input().slot, configVersion: 2 },
      }),
    ).toThrow(expect.objectContaining({ code: "ASAP_CAPACITY_CONFLICT" }));
  });
  it("rejects unsafe unit arithmetic", () => {
    expect(() =>
      prepareAsapCapacityCommitment(input(), {
        ...current(),
        capacityLimit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
  it("seals exactly the original thirty minute clock", () => {
    expect(sealed()).toMatchObject({
      state: "PaymentPending",
      capacityExpiresAt: "2026-09-10T12:30:00.000Z",
    });
    expect(() => sealAsapCapacityCommitment(sealed(), acknowledgement(), at, at)).toThrow();
  });
  it.each(["orderReference", "orderBatchReference", "paymentOperationReference", "storeReference"])(
    "rejects a mismatched ordering acknowledgement %s",
    (key) => {
      expect(() =>
        sealAsapCapacityCommitment(prepared(), { ...acknowledgement(), [key]: ref(99) }, at, at),
      ).toThrow();
    },
  );
  it("rejects sealing after preparation expires", () => {
    expect(() =>
      sealAsapCapacityCommitment(prepared(), acknowledgement(), at, input().preparationValidUntil),
    ).toThrow();
  });
  it("requires a sealed live clock, including the exclusive expiry", () => {
    expect(() => assertAsapCapacityPaymentUsable(prepared(), at)).toThrow();
    expect(assertAsapCapacityPaymentUsable(sealed(), "2026-09-10T12:29:59.999Z").state).toBe(
      "PaymentPending",
    );
    expect(() => assertAsapCapacityPaymentUsable(sealed(), "2026-09-10T12:30:00.000Z")).toThrow();
  });
  it("does not permit premature expiry or terminal resurrection", () => {
    expect(() => finishAsapCapacityCommitment(sealed(), "Expired", at)).toThrow();
    const expired = finishAsapCapacityCommitment(sealed(), "Expired", "2026-09-10T12:30:00.000Z");
    expect(expired.version).toBe(3);
    expect(() =>
      finishAsapCapacityCommitment(expired, "Released", "2026-09-10T12:31:00.000Z"),
    ).toThrow();
    expect(() => assertAsapCapacityPaymentUsable(expired, at)).toThrow();
  });
  it("rejects a forged consumed history at the exclusive Payment deadline", () => {
    expect(() =>
      parseAsapCapacityCommitment({
        ...sealed(),
        state: "Consumed",
        version: 3,
        terminalAt: "2026-09-10T12:30:00.000Z",
      }),
    ).toThrow();
  });
  it("cannot consume capacity after its original clock has released occupancy", () => {
    expect(() =>
      finishAsapCapacityCommitment(sealed(), "Consumed", "2026-09-10T12:30:00.000Z"),
    ).toThrow();
  });
  it("rejects unsealed consumption and injected hold references", () => {
    expect(() => finishAsapCapacityCommitment(prepared(), "Consumed", at)).toThrow();
    expect(() => parseAsapCapacityCommitment({ ...prepared(), holdReference: ref(99) })).toThrow();
  });
});
