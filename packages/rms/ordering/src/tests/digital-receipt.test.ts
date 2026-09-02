import type { GuestSession } from "@bop/identity";
import { describe, expect, it } from "vitest";
import { createDigitalReceiptQueryService } from "../application/digital-receipt-query-service.js";
import { DigitalReceiptError, parseDigitalReceiptChain } from "../domain/digital-receipt.js";

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
