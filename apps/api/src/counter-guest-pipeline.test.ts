import { describe, expect, it, vi } from "vitest";
import { CheckoutSessionServiceError } from "@rms/ordering";
import {
  counterEntryOperatingReader,
  createCounterGuestPipeline,
} from "./counter-guest-pipeline.js";
import {
  counterTakesOrder,
  counterTipMinor,
  parseCounterOrderCommand,
} from "./merchant-counter-order.js";

const id = (n: number) => `0198a7c0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const credential = (c: string) => c.repeat(43);
const guest = { sessionCredential: credential("a"), csrfCredential: credential("b") };

function pipeline(overrides: Record<string, unknown> = {}) {
  let sequence = 100;
  const options = {
    pickupQrToken: async () => "qr.token.value",
    entry: {
      establish: vi.fn(async () => ({
        status: "Established",
        channel: "Pickup",
        sessionCredential: guest.sessionCredential,
        csrfCredential: guest.csrfCredential,
      })),
    },
    binding: {
      prepare: vi.fn(async (input: { operationReference: string }) => ({
        status: "Prepared",
        operationReference: input.operationReference,
        sessionCredential: credential("c"),
        csrfCredential: credential("d"),
        recoveryProof: credential("e"),
        expiresAt: "2026-10-13T18:05:00.000Z",
      })),
      activate: vi.fn(async (input: { operationReference: string }) => ({
        status: "Activated",
        operationReference: input.operationReference,
        sessionCredential: credential("c"),
        csrfCredential: credential("d"),
        cookie: {},
      })),
      complete: vi.fn(),
    },
    sessions: { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    cart: {
      getCurrentCart: vi.fn(async () => ({
        status: "Found",
        view: { cart: { cartReference: id(6), version: 1, orderType: "Pickup" } },
      })),
      addItem: vi.fn(async () => ({
        status: "Applied",
        view: { cart: { cartReference: id(6), version: 2, orderType: "Pickup" } },
      })),
    },
    quote: {
      quoteCart: vi.fn(async () => ({
        status: "Created",
        quote: {
          quoteReference: id(7),
          cartReference: id(6),
          cartVersion: 2,
          subtotal: { amountMinor: 1000n, currencyCode: "CAD" },
          total: { amountMinor: 1130n, currencyCode: "CAD" },
          blockingReasons: [],
        },
      })),
    },
    details: {
      save: vi.fn(async (input: { command: Record<string, unknown> }) => ({
        status: "Saved",
        snapshot: {
          cartReference: input.command.cartReference,
          cartVersion: input.command.cartVersion,
          quoteReference: input.command.quoteReference,
        },
      })),
    },
    checkout: { create: vi.fn(), read: vi.fn() },
    takesOrder: vi.fn(async () => true),
    payment: vi.fn(),
    nextReference: () => id(++sequence),
    now: () => "2026-10-13T18:00:00.000Z",
    ...overrides,
  };
  return { options, pipeline: createCounterGuestPipeline(options as never) };
}

describe("counter guest pipeline — WP-2423 Q7", () => {
  it("opens a walk-up pickup guest with the Store's QR, or reports the Store not taking orders", async () => {
    const { pipeline: p, options } = pipeline();
    expect(await p.open({ requestedAt: "2026-10-13T18:00:00.000Z" })).toEqual({
      status: "Established",
      credentials: guest,
    });
    expect(options.entry.establish).toHaveBeenCalledWith(
      expect.objectContaining({ qrToken: "qr.token.value" }),
    );
    options.entry.establish.mockResolvedValueOnce({ status: "NotAccepting" } as never);
    expect(await p.open({ requestedAt: "2026-10-13T18:00:00.000Z" })).toEqual({
      status: "NotAccepting",
    });
    options.entry.establish.mockResolvedValueOnce({
      status: "Established",
      channel: "DineIn",
      sessionCredential: guest.sessionCredential,
      csrfCredential: guest.csrfCredential,
    } as never);
    await expect(p.open({ requestedAt: "2026-10-13T18:00:00.000Z" })).rejects.toThrow();
  });

  it("binds the counter cart under the rotated guest session", async () => {
    const { pipeline: p, options } = pipeline();
    const bound = await p.bindCart(guest, { operationReference: id(9) });
    expect(bound).toEqual({
      credentials: { sessionCredential: credential("c"), csrfCredential: credential("d") },
      guestSessionReference: id(5),
      cartReference: id(6),
      cartVersion: 1,
    });
    expect(options.binding.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateSessionCredential: credential("c"),
        candidateCsrfCredential: credential("d"),
        recoveryProof: credential("e"),
      }),
    );
  });

  it("reports an item the Store cannot sell now (sold out or off the menu)", async () => {
    const { pipeline: p, options } = pipeline();
    const line = {
      operationReference: id(10),
      cartReference: id(6),
      expectedCartVersion: 1,
      sellableReference: id(11),
      quantity: 2,
      optionSelections: [],
      requestedAt: "2026-10-13T18:00:00.000Z",
    };
    expect(await p.addItem(guest, line)).toEqual({ status: "Applied", cartVersion: 2 });
    options.cart.addItem.mockResolvedValueOnce({
      status: "SelectionInvalid",
      issueCodes: ["CATALOG_SELECTION_REJECTED"],
    } as never);
    expect(await p.addItem(guest, line)).toEqual({ status: "NotAvailable" });
    options.cart.addItem.mockResolvedValueOnce({ status: "VersionConflict" } as never);
    await expect(p.addItem(guest, line)).rejects.toThrow();
  });

  it("prices only an unblocked quote of exactly this cart version", async () => {
    const { pipeline: p, options } = pipeline();
    const input = {
      operationReference: id(12),
      cartReference: id(6),
      cartVersion: 2,
      requestedAt: "2026-10-13T18:00:00.000Z",
    };
    expect(await p.quote(guest, input)).toEqual({
      status: "Quoted",
      quoteReference: id(7),
      subtotalMinor: 1000n,
      totalMinor: 1130n,
    });
    expect(await p.quote(guest, { ...input, cartVersion: 3 })).toEqual({ status: "NotPriced" });
    options.quote.quoteCart.mockResolvedValueOnce({ status: "InvalidConfiguration" } as never);
    expect(await p.quote(guest, input)).toEqual({ status: "NotPriced" });
  });

  it("refuses checkout and payment while the Store is not taking pickup orders", async () => {
    const { pipeline: p, options } = pipeline();
    options.checkout.create.mockRejectedValueOnce(new CheckoutSessionServiceError("STORE_CLOSED"));
    expect(
      await p.startCheckout(guest, {
        createOperationReference: id(13),
        cartReference: id(6),
        cartVersion: 2,
        quoteReference: id(7),
      }),
    ).toEqual({ status: "StoreNotTakingOrders" });
    options.takesOrder.mockResolvedValueOnce(false);
    await expect(
      p.preparePayment(guest, {
        checkoutSessionReference: id(14),
        selectionReference: id(15),
        tip: { amountMinor: 0n, currencyCode: "CAD" } as never,
        recordedAfterOutage: true,
      }),
    ).rejects.toMatchObject({ code: "STORE_CLOSED" });
    expect(options.takesOrder).toHaveBeenCalledWith({ recordedAfterOutage: true });
    expect(options.payment).not.toHaveBeenCalled();
  });

  it("saves the checkout details every pickup Order needs, collecting nothing personal", async () => {
    const { pipeline: p, options } = pipeline();
    const input = {
      operationReference: id(16),
      detailsReference: id(17),
      cartReference: id(6),
      cartVersion: 2,
      quoteReference: id(7),
    };
    await p.saveDetails(guest, input);
    expect(options.details.save).toHaveBeenCalledWith({
      ...guest,
      command: {
        operationReference: id(16),
        detailsReference: id(17),
        expectedVersion: 0,
        cartReference: id(6),
        cartVersion: 2,
        quoteReference: id(7),
        quoteVersion: 2,
        pickupContact: null,
        receipt: { choice: "InSession", email: null },
        policies: [],
      },
    });
    options.details.save.mockResolvedValueOnce({
      status: "Saved",
      snapshot: { cartReference: id(6), cartVersion: 1, quoteReference: id(7) },
    });
    await expect(p.saveDetails(guest, input)).rejects.toThrow();
  });
});

describe("counter opening rule — WP-2423 Q7 (online pause does not stop the counter)", () => {
  const status = (
    state: "Open" | "Closed" | "TemporarilyClosed",
    available: string[],
    scheduled?: string[],
  ) => ({
    state,
    availableServiceModes: available,
    ...(scheduled === undefined ? {} : { scheduledServiceModes: scheduled }),
  });
  it("takes a walk-up order during pickup hours, paused or not, and a paper order any time", () => {
    const live = { recordedAfterOutage: false };
    expect(counterTakesOrder(status("Open", ["Pickup"], ["Pickup"]), live)).toBe(true);
    expect(counterTakesOrder(status("TemporarilyClosed", [], ["Pickup", "DineIn"]), live)).toBe(
      true,
    );
    expect(counterTakesOrder(status("Open", ["DineIn"], ["Pickup", "DineIn"]), live)).toBe(true);
    expect(counterTakesOrder(status("Closed", [], []), live)).toBe(false);
    expect(counterTakesOrder(status("Open", ["DineIn"], ["DineIn"]), live)).toBe(false);
    expect(counterTakesOrder(status("Closed", [], []), { recordedAfterOutage: true })).toBe(true);
    // A reader without scheduled hours falls back to the customer rule.
    expect(counterTakesOrder(status("TemporarilyClosed", []), live)).toBe(false);
  });

  it("lets the counter's guest enter while online ordering is paused", async () => {
    const reader = {
      readCurrent: vi.fn(async () => ({
        brandReference: id(1),
        storeReference: id(2),
        evaluatedAt: "2026-10-13T18:00:00.000Z",
        state: "TemporarilyClosed" as const,
        availableServiceModes: [] as never[],
      })),
    };
    const input = {
      brandReference: id(1),
      storeReference: id(2),
      publicStoreReference: id(3),
      evaluatedAt: "2026-10-13T18:00:00.000Z",
    };
    expect(await counterEntryOperatingReader(reader).readCurrent(input)).toMatchObject({
      state: "Open",
      availableServiceModes: ["Pickup"],
      evaluatedAt: "2026-10-13T18:00:00.000Z",
    });
    reader.readCurrent.mockResolvedValueOnce(null as never);
    expect(await counterEntryOperatingReader(reader).readCurrent(input)).toBeNull();
  });
});

describe("counter order command — WP-2423 Q7", () => {
  const command = (overrides: Record<string, unknown> = {}) => ({
    operationReference: id(1),
    lines: [
      {
        sellableReference: id(2),
        quantity: 2,
        optionSelections: [{ optionReference: id(3), quantity: 1 }],
      },
    ],
    tip: { kind: "Percent", percent: 15 },
    recordedAfterOutage: false,
    ...overrides,
  });

  it("accepts lines, a tip choice and the outage flag only", () => {
    expect(parseCounterOrderCommand(command()).tip).toEqual({ kind: "Percent", percent: 15 });
    for (const bad of [
      command({ lines: [] }),
      command({ tip: { kind: "Percent", percent: 12 } }),
      command({ tip: { kind: "Amount", amountMinor: "-1" } }),
      command({ recordedAfterOutage: "yes" }),
      command({ priceMinor: "1" }),
      command({
        lines: [{ sellableReference: id(2), quantity: 100, optionSelections: [] }],
      }),
      command({
        lines: [
          {
            sellableReference: id(2),
            quantity: 1,
            optionSelections: [
              { optionReference: id(3), quantity: 1 },
              { optionReference: id(3), quantity: 1 },
            ],
          },
        ],
      }),
    ])
      expect(() => parseCounterOrderCommand(bad)).toThrowError(
        expect.objectContaining({ code: "COUNTER_ORDER_INPUT_INVALID" }) as unknown as Error,
      );
  });

  it("computes the tip from the quote subtotal like the customer checkout", () => {
    expect(counterTipMinor({ kind: "None" }, 1000n)).toBe(0n);
    expect(counterTipMinor({ kind: "Percent", percent: 15 }, 1033n)).toBe(155n);
    expect(counterTipMinor({ kind: "Percent", percent: 18 }, 1025n)).toBe(185n);
    expect(counterTipMinor({ kind: "Amount", amountMinor: "200" }, 1000n)).toBe(200n);
    expect(() => counterTipMinor({ kind: "Amount", amountMinor: "1001" }, 1000n)).toThrow();
  });
});
