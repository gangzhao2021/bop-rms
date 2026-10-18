import { describe, expect, it } from "vitest";
import type { GuestSession } from "@bop/identity";
import { createAdditionalReceiptSnapshot } from "../application/additional-receipt-snapshot.js";
import { createDigitalReceiptQueryService } from "../application/digital-receipt-query-service.js";
import { createRefundReceiptSnapshot } from "../application/refund-receipt-snapshot.js";
import {
  decodeDigitalReceiptRecord,
  encodeDigitalReceiptRecord,
} from "../domain/digital-receipt-codec.js";
import {
  parseDigitalReceiptChain,
  parseDigitalReceiptSnapshot,
} from "../domain/digital-receipt.js";

/**
 * WP-2423 (v15 3cd0f8dd M4/M5): a refund version states what each confirmed refund returned, and a
 * visit that ended can still read its own receipt. Amounts mirror the v15 store-day rehearsal:
 * order 19 (flat white $6.00 + mocha $5.75, 13% tax, tip $1.76; the mocha refunded with its tax and
 * a $0.86 share of the tip = $7.36), order 20 (mocha cancelled, $5.75 + $0.75 tax = $6.50).
 */
const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-17T18:00:13.162Z";
const cad = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
const flatWhite = id(11),
  mocha = id(12),
  staffMocha = id(13),
  round1 = id(21),
  round2 = id(22);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    receiptReference: id(6),
    orderReference: id(1),
    guestSessionReference: id(2),
    operatingEntityReference: id(5),
    operatingEntityDisplayName: "Synthetic Operating Entity",
    brandReference: id(3),
    storeReference: id(4),
    storeDisplayName: "Synthetic Store",
    orderNumber: "19",
    issuedAt: at,
    locale: "en-CA",
    templateVersion: "RECEIPT_V1",
    lines: [
      {
        lineReference: flatWhite,
        displayName: "Flat White — Small (8 oz)",
        quantity: 1,
        lineTotal: cad(678n),
        lineSubtotal: cad(600n),
      },
      {
        lineReference: mocha,
        displayName: "Mocha — Small (8 oz)",
        quantity: 1,
        lineTotal: cad(650n),
        lineSubtotal: cad(575n),
      },
    ],
    subtotal: cad(1175n),
    tax: cad(153n),
    tip: cad(176n),
    total: cad(1504n),
    paymentStatus: "Paid",
    refundedTotal: cad(0n),
    ...overrides,
  };
}
function original(overrides: Record<string, unknown> = {}) {
  return {
    recordReference: id(8),
    version: 1,
    kind: "Original",
    recordedAt: at,
    previousRecordReference: null,
    reasonCode: null,
    snapshot: snapshot(overrides),
  };
}
function financial(refunded: bigint, captured = 1504n) {
  return {
    brandReference: id(3),
    storeReference: id(4),
    orderReference: id(1),
    observedAt: "2026-10-17T18:05:11.739Z",
    captured: cad(captured),
    refunded: cad(refunded),
    pendingRefund: cad(0n),
  };
}
const round = (refundedMinor: bigint, overrides: Record<string, unknown> = {}) => ({
  orderBatchReference: round1,
  capturedMinor: 1504n,
  refundedMinor,
  tipMinor: 176n,
  lineReferences: [flatWhite, mocha],
  ...overrides,
});
const mochaRefundItem = {
  orderItemReference: mocha,
  quantity: 1,
  netMinor: 575n,
  taxMinor: 75n,
  tipMinor: 86n,
  otherMinor: 0n,
};
const customerRefund = {
  refundReference: id(31),
  kind: "Refund" as const,
  payments: [
    {
      orderBatchReference: round1,
      items: [
        {
          orderItemReference: mocha,
          quantity: 1,
          netMinor: 575n,
          taxMinor: 75n,
          tipMinor: 86n,
          otherMinor: 0n,
        },
      ],
    },
  ],
};

describe("refund receipt itemization", () => {
  it("states a customer-requested refund's item, tax and tip share", () => {
    const result = createRefundReceiptSnapshot(original(), financial(736n), {
      itemized: [customerRefund],
      rounds: [round(736n)],
    });
    expect(result?.paymentStatus).toBe("PartiallyRefunded");
    expect(result?.refundedTotal).toEqual(cad(736n));
    expect(result?.refunds).toEqual([
      {
        refundReference: id(31),
        kind: "Refund",
        lines: [
          {
            lineReference: mocha,
            displayName: "Mocha — Small (8 oz)",
            quantity: 1,
            amount: cad(575n),
          },
        ],
        tax: cad(75n),
        tip: cad(86n),
        other: cad(0n),
        total: cad(736n),
      },
    ]);
    // Issued versions keep their commercial facts; the record survives storage unchanged.
    const record = {
      ...original(),
      recordReference: id(9),
      version: 2,
      kind: "Refund",
      previousRecordReference: id(8),
      reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
      snapshot: result,
    };
    expect(decodeDigitalReceiptRecord(encodeDigitalReceiptRecord(record)).snapshot).toEqual(result);
    expect(result?.lines).toEqual(parseDigitalReceiptSnapshot(snapshot()).lines);
  });

  it("states an item cancellation of an order without a tip (items and tax) as its own refund", () => {
    const result = createRefundReceiptSnapshot(
      original({ tip: cad(0n), total: cad(1328n) }),
      financial(650n, 1328n),
      {
        itemized: [
          {
            refundReference: id(32),
            kind: "ItemCancellation",
            payments: [
              {
                orderBatchReference: round1,
                items: [
                  {
                    orderItemReference: mocha,
                    quantity: 1,
                    netMinor: 575n,
                    taxMinor: 75n,
                    tipMinor: 0n,
                    otherMinor: 0n,
                  },
                ],
              },
            ],
          },
        ],
        rounds: [round(650n, { capturedMinor: 1328n, tipMinor: 0n })],
      },
    );
    expect(result?.refunds).toEqual([
      expect.objectContaining({
        kind: "ItemCancellation",
        lines: [expect.objectContaining({ lineReference: mocha, amount: cad(575n) })],
        tax: cad(75n),
        tip: cad(0n),
        total: cad(650n),
      }),
    ]);
  });

  it("DEC-TIP-REFUND-PROPORTIONAL: states an item cancellation's tip share, and the rest of the tip when the round is then returned", () => {
    const cancellation = {
      ...customerRefund,
      refundReference: id(33),
      kind: "ItemCancellation" as const,
    };
    const partly = createRefundReceiptSnapshot(original(), financial(736n), {
      itemized: [cancellation],
      rounds: [round(736n)],
    });
    expect(partly?.refunds).toEqual([
      expect.objectContaining({
        kind: "ItemCancellation",
        lines: [expect.objectContaining({ lineReference: mocha, amount: cad(575n) })],
        tax: cad(75n),
        tip: cad(86n),
        total: cad(736n),
      }),
    ]);
    // The store then cancels the rest of the round: the flat white, its tax and the tip left.
    const whole = createRefundReceiptSnapshot(original(), financial(1504n), {
      itemized: [cancellation],
      rounds: [round(1504n)],
    });
    expect(whole?.refunds?.[1]).toEqual(
      expect.objectContaining({
        kind: "RoundRefund",
        tax: cad(78n),
        tip: cad(90n),
        total: cad(768n),
      }),
    );
    expect((whole?.refunds ?? []).reduce((sum, refund) => sum + refund.tip.amountMinor, 0n)).toBe(
      176n,
    );
  });

  it("states what was left of a round returned in full after an earlier item refund", () => {
    // The mocha was refunded first ($7.36); then the whole round was returned: the flat white,
    // its tax and the rest of the tip ($6.78 + $0.90 = $7.68).
    const result = createRefundReceiptSnapshot(original(), financial(1504n), {
      itemized: [customerRefund],
      rounds: [round(1504n)],
    });
    expect(result?.paymentStatus).toBe("Refunded");
    expect(result?.refunds?.[1]).toEqual({
      refundReference: round1,
      kind: "RoundRefund",
      lines: [
        {
          lineReference: flatWhite,
          displayName: "Flat White — Small (8 oz)",
          quantity: 1,
          amount: cad(600n),
        },
      ],
      tax: cad(78n),
      tip: cad(90n),
      other: cad(0n),
      total: cad(768n),
    });
  });

  it("states an amount alone when a payment's refund was not split into items", () => {
    const result = createRefundReceiptSnapshot(original(), financial(300n), {
      itemized: [],
      rounds: [round(300n)],
    });
    expect(result?.refunds).toEqual([
      {
        refundReference: round1,
        kind: "Other",
        lines: [],
        tax: cad(0n),
        tip: cad(0n),
        other: cad(300n),
        total: cad(300n),
      },
    ]);
  });

  it("keeps rounds apart: a staff round on the card machine and an online round", () => {
    const lines = [
      ...snapshot().lines,
      {
        lineReference: staffMocha,
        displayName: "Mocha — Small (8 oz)",
        quantity: 1,
        lineTotal: cad(537n),
        lineSubtotal: cad(475n),
      },
    ];
    const previous = original({
      lines,
      subtotal: cad(1650n),
      tax: cad(215n),
      total: cad(2041n),
    });
    const result = createRefundReceiptSnapshot(previous, financial(537n, 2041n), {
      itemized: [],
      rounds: [
        round(0n),
        {
          orderBatchReference: round2,
          capturedMinor: 537n,
          refundedMinor: 537n,
          tipMinor: 0n,
          lineReferences: [staffMocha],
        },
      ],
    });
    expect(result?.refunds).toEqual([
      expect.objectContaining({
        refundReference: round2,
        kind: "RoundRefund",
        lines: [expect.objectContaining({ lineReference: staffMocha, amount: cad(475n) })],
        tax: cad(62n),
        tip: cad(0n),
        total: cad(537n),
      }),
    ]);
  });

  it("states the amount only when the evidence does not add up (never a guessed split)", () => {
    const tooMuch = createRefundReceiptSnapshot(original(), financial(500n), {
      itemized: [customerRefund],
      rounds: [round(500n)],
    });
    expect(tooMuch?.refundedTotal).toEqual(cad(500n));
    expect(tooMuch?.refunds).toBeUndefined();
    const unknownItem = createRefundReceiptSnapshot(original(), financial(736n), {
      itemized: [
        {
          ...customerRefund,
          payments: [
            {
              orderBatchReference: round1,
              items: [{ ...mochaRefundItem, orderItemReference: id(99) }],
            },
          ],
        },
      ],
      rounds: [round(736n)],
    });
    expect(unknownItem?.refunds).toBeUndefined();
    // Without itemization the version is issued as before.
    expect(createRefundReceiptSnapshot(original(), financial(736n))?.refunds).toBeUndefined();
  });

  it("refuses stated refunds that do not add up to what was refunded or return unsold items", () => {
    const mochaLine = {
      lineReference: mocha,
      displayName: "Mocha",
      quantity: 1,
      amount: cad(575n),
    };
    const refunds = [
      {
        refundReference: id(31),
        kind: "Refund",
        lines: [mochaLine],
        tax: cad(75n),
        tip: cad(86n),
        other: cad(0n),
        total: cad(736n),
      },
    ];
    expect(() =>
      parseDigitalReceiptSnapshot(snapshot({ refundedTotal: cad(736n), refunds })),
    ).not.toThrow();
    expect(() =>
      parseDigitalReceiptSnapshot(snapshot({ refundedTotal: cad(700n), refunds })),
    ).toThrow();
    expect(() =>
      parseDigitalReceiptSnapshot(
        snapshot({
          refundedTotal: cad(736n),
          refunds: [{ ...refunds[0], lines: [{ ...mochaLine, quantity: 2 }] }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseDigitalReceiptSnapshot(
        snapshot({ refundedTotal: cad(736n), refunds: [{ ...refunds[0], total: cad(735n) }] }),
      ),
    ).toThrow();
  });

  it("keeps earlier stated refunds on a later round's version", () => {
    const refunded = createRefundReceiptSnapshot(original(), financial(736n), {
      itemized: [customerRefund],
      rounds: [round(736n)],
    });
    const previous = {
      ...original(),
      recordReference: id(9),
      version: 2,
      kind: "Refund",
      previousRecordReference: id(8),
      reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
      snapshot: refunded,
    };
    const facts: Record<string, unknown> = { ...refunded };
    delete facts.refunds;
    const current = {
      ...facts,
      issuedAt: "2026-10-17T18:06:00.000Z",
      lines: [
        ...snapshot().lines,
        {
          lineReference: staffMocha,
          displayName: "Mocha — Small (8 oz)",
          quantity: 1,
          lineTotal: cad(537n),
          lineSubtotal: cad(475n),
        },
      ],
      subtotal: cad(1650n),
      tax: cad(215n),
      total: cad(2041n),
    };
    expect(createAdditionalReceiptSnapshot(previous, current)?.refunds).toEqual(refunded?.refunds);
  });
});

describe("ended visit receipt read", () => {
  const session = {
    sessionReference: id(2),
    status: "Active",
    version: 1,
    brandReference: id(3),
    storeReference: id(4),
    publicStoreReference: id(20),
    publicTableReference: id(23),
    channel: "DineIn",
    locale: "en-CA",
    qrReference: id(24),
    qrRevocationVersion: 1,
    diningState: "DiningBound",
    diningSessionReference: id(25),
    diningParticipantReference: id(26),
    createdAt: "2026-10-17T18:01:49.437Z",
    lastSeenAt: "2026-10-17T18:01:49.437Z",
    idleExpiresAt: "2026-10-17T22:01:49.437Z",
    absoluteExpiresAt: "2026-10-18T18:01:49.437Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  } as unknown as GuestSession;
  const service = (endedVisit: boolean) =>
    createDigitalReceiptQueryService({
      authorization: {
        authorizeGuest: async () =>
          endedVisit ? { guestSession: session, endedVisit: true } : { guestSession: session },
        authorizeResume: async () => null,
      },
      receipts: {
        load: async () =>
          parseDigitalReceiptChain({
            orderReference: id(1),
            records: [{ ...original(), snapshot: snapshot({ guestSessionReference: id(2) }) }],
          }),
      },
    });
  const read = (endedVisit: boolean, observedAt: string) =>
    service(endedVisit).getCustomer({
      orderReference: id(1),
      observedAt,
      resumeGrantReference: null,
    });

  it("reads its own receipt after the visit went idle, until the Session's absolute expiry", async () => {
    // 08:30 the next morning is past the 4 h idle limit but before the 24 h bound.
    await expect(read(false, "2026-10-18T08:30:00.000Z")).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
    });
    expect((await read(true, "2026-10-18T08:30:00.000Z")).orderReference).toBe(id(1));
    await expect(read(true, "2026-10-18T18:01:49.437Z")).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
    });
  });
});
