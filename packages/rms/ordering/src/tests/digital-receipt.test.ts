import { createAdditionalReceiptSnapshot } from "../application/additional-receipt-snapshot.js";
import { createRefundReceiptSnapshot } from "../application/refund-receipt-snapshot.js";
import {
  decodeDigitalReceiptRecord,
  encodeDigitalReceiptRecord,
} from "../domain/digital-receipt-codec.js";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it } from "vitest";
import { createDigitalReceiptQueryService } from "../application/digital-receipt-query-service.js";
import {
  DigitalReceiptError,
  parseDigitalReceiptChain,
  parseDigitalReceiptSnapshot,
} from "../domain/digital-receipt.js";

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-12T14:00:00.000Z";
const refs = {
  order: id(1),
  guest: id(2),
  brand: id(3),
  store: id(4),
  entity: id(5),
  receipt: id(6),
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    receiptReference: refs.receipt,
    orderReference: refs.order,
    guestSessionReference: refs.guest,
    operatingEntityReference: refs.entity,
    operatingEntityDisplayName: "Synthetic Operating Entity",
    brandReference: refs.brand,
    storeReference: refs.store,
    storeDisplayName: "Synthetic Store",
    orderNumber: "1001",
    issuedAt: at,
    locale: "en-CA",
    templateVersion: "RECEIPT_V1",
    lines: [
      {
        lineReference: id(7),
        displayName: "Synthetic bowl",
        quantity: 1,
        lineTotal: { amountMinor: 1000n, currencyCode: "CAD" },
      },
    ],
    subtotal: { amountMinor: 1000n, currencyCode: "CAD" },
    tax: { amountMinor: 130n, currencyCode: "CAD" },
    tip: { amountMinor: 0n, currencyCode: "CAD" },
    total: { amountMinor: 1130n, currencyCode: "CAD" },
    paymentStatus: "Paid",
    refundedTotal: { amountMinor: 0n, currencyCode: "CAD" },
    ...overrides,
  };
}

function chain() {
  return {
    orderReference: refs.order,
    records: [
      {
        recordReference: id(8),
        version: 1,
        kind: "Original",
        recordedAt: at,
        previousRecordReference: null,
        reasonCode: null,
        snapshot: snapshot(),
      },
      {
        recordReference: id(9),
        version: 2,
        kind: "Reissue",
        recordedAt: "2026-08-12T14:05:00.000Z",
        previousRecordReference: id(8),
        reasonCode: "CUSTOMER_REQUEST",
        snapshot: snapshot(),
      },
    ],
  };
}

function guest(): GuestSession {
  return {
    sessionReference: refs.guest,
    status: "Active",
    version: 1,
    brandReference: refs.brand,
    storeReference: refs.store,
    publicStoreReference: id(20),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA" as never,
    qrReference: id(21),
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: "2026-08-12T12:00:00.000Z" as never,
    lastSeenAt: at as never,
    idleExpiresAt: "2026-08-12T18:00:00.000Z" as never,
    absoluteExpiresAt: "2026-08-13T12:00:00.000Z" as never,
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  } as unknown as GuestSession;
}

describe("digital receipt chain", () => {
  it("keeps a reissue linked and byte-equivalent to the prior immutable snapshot", () => {
    const parsed = parseDigitalReceiptChain(chain());
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1]?.snapshot).toStrictEqual(parsed.records[0]?.snapshot);
    expect(Object.isFrozen(parsed.records)).toBe(true);
  });

  it.each([
    () => ({ ...chain(), records: [{ ...chain().records[0], version: 2 }] }),
    () => ({
      ...chain(),
      records: [chain().records[0], { ...chain().records[1], previousRecordReference: id(99) }],
    }),
    () => ({
      ...chain(),
      records: [
        chain().records[0],
        {
          ...chain().records[1],
          snapshot: snapshot({ total: { amountMinor: 999n, currencyCode: "CAD" } }),
        },
      ],
    }),
  ])("rejects a broken append-only chain %#", (candidate) => {
    expect(() => parseDigitalReceiptChain(candidate())).toThrow(DigitalReceiptError);
  });

  it("authorizes an exact Guest Session and rejects cross-Store receipt drift", async () => {
    let stored = chain();
    const service = createDigitalReceiptQueryService({
      authorization: {
        authorizeGuest: async () => ({ guestSession: guest() }),
        authorizeResume: async () => null,
      },
      receipts: { load: async () => stored as never },
    });
    await expect(
      service.getCustomer({
        orderReference: refs.order,
        observedAt: at,
        resumeGrantReference: null,
      }),
    ).resolves.toMatchObject({ orderReference: refs.order });
    stored = {
      ...chain(),
      records: chain().records.map((record) => ({
        ...record,
        snapshot: snapshot({ storeReference: id(99) }),
      })),
    };
    await expect(
      service.getCustomer({
        orderReference: refs.order,
        observedAt: at,
        resumeGrantReference: null,
      }),
    ).rejects.toMatchObject({ code: "DIGITAL_RECEIPT_PERMISSION_DENIED" });
  });

  it("accepts only a verified resume grant bound to the same Order and scope", async () => {
    const service = createDigitalReceiptQueryService({
      authorization: {
        authorizeGuest: async () => null,
        authorizeResume: async () => ({
          orderReference: refs.order,
          brandReference: refs.brand,
          storeReference: refs.store,
          consumedAt: at,
        }),
      },
      receipts: { load: async () => chain() as never },
    });
    await expect(
      service.getCustomer({
        orderReference: refs.order,
        observedAt: at,
        resumeGrantReference: id(30),
      }),
    ).resolves.toMatchObject({ orderReference: refs.order });
  });
});

describe("lossless receipt discounts and fees", () => {
  const money = (amountMinor: bigint, currencyCode = "CAD") => ({ amountMinor, currencyCode });
  it("preserves frozen discount and fee without changing the legacy snapshot shape", () => {
    const old = snapshot();
    expect(parseDigitalReceiptSnapshot(old)).toEqual(old);
    expect(Object.hasOwn(parseDigitalReceiptSnapshot(old), "adjustments")).toBe(false);
    const adjusted = snapshot({
      adjustments: { discount: money(100n), fee: money(50n) },
      total: money(1080n),
    });
    expect(parseDigitalReceiptSnapshot(adjusted)).toEqual(adjusted);
  });
  it.each([
    { discount: money(100n) },
    { discount: money(100n), fee: money(50n), extra: true },
    { discount: money(1001n), fee: money(50n) },
    { discount: money(100n, "USD"), fee: money(50n) },
  ])("rejects incomplete, excessive or foreign-currency adjustments", (adjustments) => {
    expect(() =>
      parseDigitalReceiptSnapshot(snapshot({ adjustments, total: money(1080n) })),
    ).toThrow(DigitalReceiptError);
  });
  it("does not allow a reissue to add adjustments to an old original", () => {
    const value = chain();
    const reissue = value.records[1];
    if (!reissue) throw new Error("missing synthetic reissue");
    reissue.snapshot = snapshot({ adjustments: { discount: money(0n), fee: money(0n) } });
    expect(() => parseDigitalReceiptChain(value)).toThrow(DigitalReceiptError);
  });
});

it("rejects a receipt amount that cannot be persisted as signed 64-bit minor units", () => {
  expect(() =>
    parseDigitalReceiptSnapshot(
      snapshot({
        subtotal: { amountMinor: 9223372036854775808n, currencyCode: "CAD" },
        tax: { amountMinor: 0n, currencyCode: "CAD" },
        total: { amountMinor: 9223372036854775808n, currencyCode: "CAD" },
      }),
    ),
  ).toThrow(DigitalReceiptError);
});

describe("persisted receipt record encoding", () => {
  it("round-trips original and reissue history without injecting adjustments", () => {
    for (const record of parseDigitalReceiptChain(chain()).records) {
      const encoded = encodeDigitalReceiptRecord(record);
      expect(decodeDigitalReceiptRecord(encoded)).toEqual(record);
      expect(encoded).not.toContain("adjustments");
    }
  });

  it("preserves adjustments and amounts above the safe integer boundary", () => {
    const amount = 9007199254740993n;
    const original = chain().records[0];
    const record = {
      ...original,
      snapshot: snapshot({
        subtotal: { amountMinor: amount, currencyCode: "CAD" },
        tax: { amountMinor: 0n, currencyCode: "CAD" },
        adjustments: {
          discount: { amountMinor: 1n, currencyCode: "CAD" },
          fee: { amountMinor: 2n, currencyCode: "CAD" },
        },
        total: { amountMinor: amount + 1n, currencyCode: "CAD" },
      }),
    };
    expect(decodeDigitalReceiptRecord(encodeDigitalReceiptRecord(record))).toEqual(record);
  });

  it("rejects numeric, noncanonical, negative and overflowing stored money", () => {
    const encoded = encodeDigitalReceiptRecord(chain().records[0]);
    for (const amount of ["1000", '"01000"', '"-1"', '"1e3"', '"9223372036854775808"']) {
      expect(() =>
        decodeDigitalReceiptRecord(
          encoded.replace('"amountMinor":"1000"', '"amountMinor":' + amount),
        ),
      ).toThrow(DigitalReceiptError);
    }
    expect(() => decodeDigitalReceiptRecord(" ".repeat(1024 * 1024 + 1))).toThrow(
      DigitalReceiptError,
    );
    expect(() => decodeDigitalReceiptRecord("{}")).toThrow(DigitalReceiptError);
  });
});

it("denies a receipt from a different order even when the Guest and Store match", async () => {
  const query = createDigitalReceiptQueryService({
    authorization: {
      authorizeGuest: async () => ({ guestSession: guest() }),
      authorizeResume: async () => null,
    },
    receipts: { load: async () => parseDigitalReceiptChain(chain()) },
  });
  await expect(
    query.getCustomer({
      orderReference: id(999),
      observedAt: at,
      resumeGrantReference: null,
    }),
  ).rejects.toMatchObject({ code: "DIGITAL_RECEIPT_PERMISSION_DENIED" });
});

it("preserves the full Operating Entity legal-name bound", () => {
  const name = "S".repeat(200);
  expect(
    parseDigitalReceiptSnapshot(snapshot({ operatingEntityDisplayName: name }))
      .operatingEntityDisplayName,
  ).toBe(name);
  expect(() =>
    parseDigitalReceiptSnapshot(snapshot({ operatingEntityDisplayName: name + "S" })),
  ).toThrow(DigitalReceiptError);
});

function refundFinancial(confirmed = 0n, pending = 0n) {
  return {
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    observedAt: "2026-08-12T15:00:00.000Z",
    captured: { amountMinor: 1130n, currencyCode: "CAD" },
    refunded: { amountMinor: confirmed, currencyCode: "CAD" },
    pendingRefund: { amountMinor: pending, currencyCode: "CAD" },
  };
}
it("appends refund status without replacing original commercial facts", () => {
  const previous = chain().records[0];
  const financial = refundFinancial(100n, 200n);
  const result = createRefundReceiptSnapshot(previous, financial);
  expect(result).toEqual({
    ...snapshot(),
    paymentStatus: "RefundPending",
    refundedTotal: { amountMinor: 100n, currencyCode: "CAD" },
  });
  expect(previous?.snapshot.paymentStatus).toBe("Paid");
  expect(result?.issuedAt).toBe(at);
});
it.each([
  [0n, 200n, "RefundPending"],
  [100n, 0n, "PartiallyRefunded"],
  [1130n, 0n, "Refunded"],
] as const)(
  "derives refund state from confirmed %s and pending %s",
  (confirmed, pending, status) => {
    expect(
      createRefundReceiptSnapshot(chain().records[0], refundFinancial(confirmed, pending))
        ?.paymentStatus,
    ).toBe(status);
  },
);
it("does not append duplicate visible refund state", () => {
  expect(createRefundReceiptSnapshot(chain().records[0], refundFinancial())).toBeNull();
  const previous = {
    ...chain().records[1],
    snapshot: snapshot({ paymentStatus: "RefundPending" }),
  };
  expect(createRefundReceiptSnapshot(previous, refundFinancial(0n, 500n))).toBeNull();
});
it("rejects foreign scope, changed capture, over-refund and regression", () => {
  const previous = {
    ...chain().records[1],
    kind: "Refund",
    snapshot: snapshot({
      paymentStatus: "PartiallyRefunded",
      refundedTotal: { amountMinor: 100n, currencyCode: "CAD" },
    }),
  };
  for (const financial of [
    refundFinancial(99n),
    refundFinancial(1131n),
    refundFinancial(1130n, 1n),
    { ...refundFinancial(100n), orderReference: id(99) },
    { ...refundFinancial(100n), storeReference: id(99) },
    { ...refundFinancial(100n), observedAt: at },
    { ...refundFinancial(100n), captured: { amountMinor: 1200n, currencyCode: "CAD" } },
    { ...refundFinancial(100n), pendingRefund: { amountMinor: -1n, currencyCode: "CAD" } },
    { ...refundFinancial(100n), refunded: { amountMinor: 100n, currencyCode: "USD" } },
  ])
    expect(() => createRefundReceiptSnapshot(previous, financial)).toThrow();
  expect(() =>
    createRefundReceiptSnapshot({ ...previous, kind: "Void" }, refundFinancial(200n)),
  ).toThrow();
});

describe("additional paid receipt snapshots", () => {
  const original = () => {
    const value = chain().records[0];
    if (!value) throw new Error("missing fixture");
    return value;
  };
  const additional = () => {
    const old = snapshot();
    return snapshot({
      lines: [...old.lines, { ...old.lines[0], lineReference: id(70) }],
      subtotal: { amountMinor: 2000n, currencyCode: "CAD" },
      tax: { amountMinor: 260n, currencyCode: "CAD" },
      total: { amountMinor: 2260n, currencyCode: "CAD" },
    });
  };
  it("adds paid items without changing the original and treats replay as no change", () => {
    const previous = original(),
      current = additional();
    expect(createAdditionalReceiptSnapshot(previous, current)?.total.amountMinor).toBe(2260n);
    expect(previous.snapshot.total.amountMinor).toBe(1130n);
    const correction = {
      ...previous,
      recordReference: id(71),
      version: 2,
      kind: "Correction",
      previousRecordReference: previous.recordReference,
      reasonCode: "ORDER_ADDITIONAL_PAYMENT_CAPTURED",
      snapshot: current,
    };
    expect(
      parseDigitalReceiptChain({ orderReference: refs.order, records: [previous, correction] })
        .records,
    ).toHaveLength(2);
    expect(
      createAdditionalReceiptSnapshot(correction, {
        ...current,
        issuedAt: "2026-08-12T14:01:00.000Z",
      }),
    ).toBeNull();
  });
  it("rejects rewriting or removing old items and cross-order or cross-issuer updates", () => {
    const current = additional();
    for (const candidate of [
      { ...current, lines: [{ ...current.lines[0], displayName: "Changed" }, current.lines[1]] },
      { ...current, lines: [current.lines[1]] },
      { ...current, orderReference: id(90) },
      { ...current, operatingEntityReference: id(91) },
    ])
      expect(() => createAdditionalReceiptSnapshot(original(), candidate)).toThrow(
        DigitalReceiptError,
      );
  });
  it("does not use additional issuance to change only refund state or revive a void", () => {
    expect(() =>
      createAdditionalReceiptSnapshot(
        original(),
        snapshot({
          paymentStatus: "PartiallyRefunded",
          refundedTotal: { amountMinor: 100n, currencyCode: "CAD" },
        }),
      ),
    ).toThrow(DigitalReceiptError);
    const previous = {
      ...original(),
      kind: "Void",
      version: 2,
      previousRecordReference: id(75),
      reasonCode: "VOIDED",
    };
    expect(() => createAdditionalReceiptSnapshot(previous, additional())).toThrow(
      DigitalReceiptError,
    );
  });
});
