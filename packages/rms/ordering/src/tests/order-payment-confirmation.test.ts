import { parseAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  createOrderPaymentConfirmationCandidate,
  createOrderPaymentDispositionBinding,
} from "../index.js";
import { orderCreatedSourceInput } from "../application/order-created-source.js";
import { orderPaymentSourceFixture as fixture } from "./order-payment-source.fixture.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
describe("Ordering confirmation candidate from synthetic authorized inputs", () => {
  it("binds source acceptance and full payment including tip without publishing an event", () => {
    const input = fixture();
    const result = createOrderPaymentConfirmationCandidate(input);
    expect(result.disposition).toBe("Confirmed");
    expect(result.sourceVersion).toBe(2);
    if (result.disposition !== "Confirmed") throw new Error("Expected confirmation candidate");
    expect(result.sourceSnapshotDigest).toBe(
      hash(
        orderCreatedSourceInput(
          input.order,
          input.order.orderNumberAllocation.businessDateResolution,
        ),
      ),
    );
    expect(result.sourceCheckpoint).toBe(input.acceptance.acceptanceReference);
    expect(result.sourceDigest).toBe(
      hash(
        createOrderPaymentDispositionBinding({ event: input.paymentEvent, disposition: result }),
      ),
    );
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("rejects an invalid digest provider rather than emitting an unbound candidate", () => {
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...fixture(),
        sha256: () => "unavailable",
      }),
    ).toThrow();
  });
  it.each([
    { orderReference: id(99) },
    { orderBatchReference: id(99) },
    { storeReference: id(99) },
    { expectedOrderVersion: 2, acceptedOrderVersion: 3 },
    { acceptedAt: "2099-01-01T00:00:00.000Z" },
  ])("rejects mismatched or future acceptance %j", (patch) => {
    const f = fixture();
    expect(() =>
      createOrderPaymentConfirmationCandidate({ ...f, acceptance: { ...f.acceptance, ...patch } }),
    ).toThrow();
  });
  it.each([
    { submissionReference: id(99) },
    { sourceCartReference: id(99) },
    { sourceCartVersion: 99 },
    { quoteReference: id(99) },
    { guestSessionReference: id(99) },
  ])("rejects another submission/payment preparation %j", (patch) => {
    const f = fixture();
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...f,
        preparation: { ...f.preparation, ...patch },
      }),
    ).toThrow();
  });
  it("rejects wrong captured amount, wrong order allocation and a regressing observation", () => {
    const f = fixture();
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...f,
        paymentEvent: {
          ...f.paymentEvent,
          payload: { ...f.paymentEvent.payload, amountMinor: "1" },
        },
      }),
    ).toThrow();
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...f,
        preparation: {
          ...f.preparation,
          orderAllocation: {
            ...f.preparation.orderAllocation,
            amountMinor: f.preparation.orderAllocation.amountMinor + 1n,
          },
          tip: { ...f.preparation.tip, amountMinor: 99n },
        },
      }),
    ).toThrow();
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...f,
        observedAt: new Date(Date.parse(f.observedAt) - 1).toISOString(),
      }),
    ).toThrow();
  });
});

describe("Additional Batch confirmation candidate", () => {
  function additionalFixture() {
    const base = fixture();
    const r = orderWriteFixture({ at: base.observedAt, dineIn: true }).request.record;
    const b = r.order.batches[0];
    if (!b) throw new Error("fixture batch required");
    const snapshot = parseAdditionalDiningBatchSnapshot({
      brandReference: r.order.brandReference,
      storeReference: r.order.storeReference,
      orderReference: r.order.orderReference,
      diningSessionReference: r.order.diningSessionReference,
      guestSessionReference: r.guestSessionReference,
      originalOrderCreatedAt: new Date(Date.parse(r.createdAt) - 60000).toISOString(),
      expectedOrderVersion: 3,
      batchSequence: 2,
      snapshotVersion: 1,
      batch: b,
      items: r.items,
    });
    const amount = r.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
    return {
      ...base,
      order: snapshot,
      submissionKind: "Additional" as const,
      acceptance: {
        ...base.acceptance,
        brandReference: snapshot.brandReference,
        storeReference: snapshot.storeReference,
        orderReference: snapshot.orderReference,
        orderBatchReference: b.orderBatchReference,
        expectedOrderVersion: 4,
        acceptedOrderVersion: 5,
      },
      preparation: {
        ...base.preparation,
        brandReference: snapshot.brandReference,
        storeReference: snapshot.storeReference,
        orderReference: snapshot.orderReference,
        orderBatchReference: b.orderBatchReference,
        submissionReference: b.submissionReference,
        guestSessionReference: snapshot.guestSessionReference,
        sourceCartReference: b.sourceCartReference,
        sourceCartVersion: b.sourceCartVersion,
        quoteReference: b.quoteReference,
        orderAllocation: { amountMinor: amount, currencyCode: "CAD" },
        total: { amountMinor: amount + 100n, currencyCode: "CAD" },
      },
      paymentEvent: {
        ...base.paymentEvent,
        tenantId: snapshot.brandReference,
        storeId: snapshot.storeReference,
        payload: {
          ...base.paymentEvent.payload,
          orderReference: snapshot.orderReference,
          amountMinor: (amount + 100n).toString(),
        },
      },
    };
  }
  it("confirms only actual Additional items and preserves the Additional source digest", () => {
    const input = additionalFixture();
    const result = createOrderPaymentConfirmationCandidate(input);
    expect(result.disposition).toBe("Confirmed");
    if (result.disposition !== "Confirmed") throw new Error("confirmation required");
    expect(result.sourceSnapshotDigest).toBe(
      hash(encodeAdditionalDiningBatchSnapshot(input.order)),
    );
    expect(result.sourceVersion).toBe(5);
    expect(result.orderBatchReference).toBe(input.order.batch.orderBatchReference);
  });
  it("rejects acceptance before append, another Batch and mismatched snapshot version", () => {
    const input = additionalFixture();
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...input,
        acceptance: { ...input.acceptance, expectedOrderVersion: 3, acceptedOrderVersion: 4 },
      }),
    ).toThrow();
    expect(() =>
      createOrderPaymentConfirmationCandidate({
        ...input,
        acceptance: { ...input.acceptance, orderBatchReference: id(999) },
      }),
    ).toThrow();
    expect(() => createOrderPaymentConfirmationCandidate({ ...input, quoteVersion: 2 })).toThrow();
  });
});

describe("Initial Dining acceptance after another batch advances the aggregate", () => {
  it("binds confirmation to actual acceptance version while retaining the initial snapshot", () => {
    const f = fixture();
    const order = {
      ...f.order,
      order: { ...f.order.order, orderType: "DineIn", diningSessionReference: id(90) },
    };
    const result = createOrderPaymentConfirmationCandidate({
      ...f,
      order,
      acceptance: { ...f.acceptance, expectedOrderVersion: 2, acceptedOrderVersion: 3 },
    });
    expect(result.disposition).toBe("Confirmed");
    expect(result.sourceVersion).toBe(3);
    expect(result.sourceCheckpoint).toBe(f.acceptance.acceptanceReference);
    expect(order.order.aggregateVersion).toBe(1);
  });
});
