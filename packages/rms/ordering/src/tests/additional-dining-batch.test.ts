import {
  encodeAdditionalDiningBatchSnapshot,
  decodeAdditionalDiningBatchSnapshot,
} from "../domain/additional-dining-batch-codec.js";
import { describe, expect, it } from "vitest";
import {
  createAdditionalDiningBatchSnapshot,
  parseAdditionalDiningBatchSnapshot,
} from "../domain/additional-dining-batch.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const id = (n: number) => "0190ed18-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function additionalBatchFixture() {
  const { record } = orderWriteFixture({ at: "2026-09-13T12:01:00.000Z", dineIn: true }).request;
  return {
    orderReference: record.order.orderReference,
    brandReference: record.order.brandReference,
    storeReference: record.order.storeReference,
    diningSessionReference: record.order.diningSessionReference,
    guestSessionReference: record.guestSessionReference,
    originalOrderCreatedAt: "2026-09-13T12:00:00.000Z",
    expectedOrderVersion: 3,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: record.order.batches[0],
    items: record.items,
  };
}
describe("additional Dining Batch immutable snapshot", () => {
  it("retains the existing Order reference and later Batch without allocating another Order number", () => {
    const input = additionalBatchFixture(),
      result = parseAdditionalDiningBatchSnapshot(input);
    expect(result.orderReference).toBe(input.orderReference);
    expect(result.batch).toEqual(input.batch);
    expect(result.items).toEqual(input.items);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result).not.toHaveProperty("orderNumber");
  });
  it.each([
    { batchSequence: 1 },
    { expectedOrderVersion: 0 },
    { expectedOrderVersion: 2147483647 },
    { batchSequence: 2147483648 },
    { diningSessionReference: null },
    { originalOrderCreatedAt: "2026-09-13T12:02:00.000Z" },
    { storeReference: id(1) },
    { orderReference: id(2) },
    { snapshotVersion: 2 },
    { items: [] },
  ])("rejects incompatible parent or snapshot facts %j", (change) => {
    expect(() =>
      parseAdditionalDiningBatchSnapshot({ ...additionalBatchFixture(), ...change }),
    ).toThrow("additional Dining batch snapshot is invalid");
  });
  it("rejects mismatched item identity instead of attaching an unrelated snapshot", () => {
    const input = additionalBatchFixture();
    expect(() =>
      parseAdditionalDiningBatchSnapshot({
        ...input,
        batch: {
          ...input.batch,
          items: input.batch.items.map((item) => ({ ...item, orderItemReference: id(3) })),
        },
      }),
    ).toThrow("additional Dining batch snapshot is invalid");
  });
});

describe("additional Dining Batch persisted representation", () => {
  it("roundtrips exact Batch and bigint money after JSONB field reordering", () => {
    const original = parseAdditionalDiningBatchSnapshot(additionalBatchFixture());
    const wire = JSON.parse(encodeAdditionalDiningBatchSnapshot(original));
    const reordered = Object.fromEntries(Object.entries(wire).reverse());
    expect(decodeAdditionalDiningBatchSnapshot(JSON.stringify(reordered))).toEqual(original);
    expect(typeof wire.items[0].pricing.total.amountMinor).toBe("string");
  });
  it("retains money above Number.MAX_SAFE_INTEGER", () => {
    const original = additionalBatchFixture();
    const first = original.items[0];
    if (!first) throw new Error("fixture");
    const fee = 9007199254740993n;
    const large = {
      ...original,
      items: [
        {
          ...first,
          pricing: {
            ...first.pricing,
            fee: { amountMinor: fee, currencyCode: "CAD" },
            total: {
              ...first.pricing.total,
              amountMinor: first.pricing.total.amountMinor - first.pricing.fee.amountMinor + fee,
            },
          },
        },
        ...original.items.slice(1),
      ],
    };
    const decoded = decodeAdditionalDiningBatchSnapshot(encodeAdditionalDiningBatchSnapshot(large));
    expect(decoded.items[0]?.pricing.fee.amountMinor).toBe(fee);
  });
  it.each([123, "01", "9223372036854775808"])("rejects damaged persisted money %j", (amount) => {
    const wire = JSON.parse(encodeAdditionalDiningBatchSnapshot(additionalBatchFixture()));
    wire.items[0].pricing.fee.amountMinor = amount;
    expect(() => decodeAdditionalDiningBatchSnapshot(JSON.stringify(wire))).toThrow();
  });
  it("rejects unknown envelope fields and unsupported snapshot versions", () => {
    const wire = JSON.parse(encodeAdditionalDiningBatchSnapshot(additionalBatchFixture()));
    expect(() =>
      decodeAdditionalDiningBatchSnapshot(JSON.stringify({ ...wire, extra: true })),
    ).toThrow();
    expect(() =>
      decodeAdditionalDiningBatchSnapshot(JSON.stringify({ ...wire, snapshotVersion: 3 })),
    ).toThrow();
  });
});

describe("additional Batch construction from checkout inputs", () => {
  function input() {
    const f = orderWriteFixture({ at: "2026-09-13T12:01:00.000Z", dineIn: true });
    const r = f.request.record;
    return {
      snapshot: f.snapshotInput,
      quoteVersion: 1 as const,
      submissionReference: r.submissionReference,
      submittedAt: r.createdAt,
      parent: {
        orderReference: r.order.orderReference,
        brandReference: r.order.brandReference,
        storeReference: r.order.storeReference,
        diningSessionReference: r.order.diningSessionReference,
        originalOrderCreatedAt: "2026-09-13T12:00:00.000Z",
        expectedOrderVersion: 3,
        batchSequence: 2,
      },
    };
  }
  it("builds current items and preserves original Order identity and creation time", () => {
    const i = input(),
      result = createAdditionalDiningBatchSnapshot(i);
    expect(result.orderReference).toBe(i.parent.orderReference);
    expect(result.originalOrderCreatedAt).toBe(i.parent.originalOrderCreatedAt);
    expect(result.batch.submittedAt).toBe(i.submittedAt);
    expect(result.items).toHaveLength(i.snapshot.cart.items.length);
    expect(result).not.toHaveProperty("orderNumber");
  });
  it("rejects a different parent Dining session", () => {
    const i = input();
    expect(() =>
      createAdditionalDiningBatchSnapshot({
        ...i,
        parent: { ...i.parent, diningSessionReference: id(909) },
      }),
    ).toThrow();
  });
  it("rejects expiry between snapshot capture and submission", () => {
    const i = input();
    expect(() =>
      createAdditionalDiningBatchSnapshot({
        ...i,
        submittedAt: i.snapshot.checkoutValidationEvidence.validUntil,
      }),
    ).toThrow();
  });
  it("does not accept Pickup checkout as an additional Dining batch", () => {
    const i = input(),
      pickup = orderWriteFixture({ at: i.submittedAt });
    expect(() =>
      createAdditionalDiningBatchSnapshot({ ...i, snapshot: pickup.snapshotInput }),
    ).toThrow();
  });
});
