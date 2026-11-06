import { describe, expect, it, vi } from "vitest";
import { CartClientError, type CartView } from "../cart/types.js";
import { SessionPaymentClientError } from "../payment/session-payment-client.js";
import {
  getTablePaymentTiming,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { manualRetryBusyTotalMs } from "./checkout-client.js";
import { CheckoutDetailsClientError, type CheckoutDetailsDraft } from "./details-client.js";
import { CheckoutSessionClientError } from "./session-client.js";
import { createSendRoundController, sendFailureState, type SendRoundPorts } from "./send-round.js";
import type { CheckoutQuote } from "./types.js";

const id = (n: number) => `018f9a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cad = (amountMinor: string) => ({ amountMinor, currency: "CAD" });
const cart = (version = 3, items = 1): CartView =>
  ({
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "TEST", storeName: "TEST" },
      lifecycle: { status: "Active", idleExpiresAt: "", absoluteExpiresAt: "" },
      items: Array.from({ length: items }, (_, index) => ({ cartItemReference: id(50 + index) })),
      quote: null,
      warnings: [],
    },
  }) as unknown as CartView;
const quote = (overrides: Partial<CheckoutQuote> = {}): CheckoutQuote => ({
  quoteReference: id(2),
  quoteVersion: 2,
  cartVersion: 3,
  subtotal: cad("2000"),
  discount: cad("0"),
  tax: cad("260"),
  fee: cad("0"),
  total: cad("2260"),
  expiresAt: "2099-01-01T00:00:00.000Z",
  warnings: [],
  blockingReasons: [],
  priceChange: null,
  ...overrides,
});
const seen = { amountMinor: 2000n, currency: "CAD" };

function setUp(overrides: Partial<SendRoundPorts> = {}) {
  const calls: string[] = [];
  let quoted = 0;
  let placed = false;
  const ports: { [K in keyof SendRoundPorts]: ReturnType<typeof vi.fn<SendRoundPorts[K]>> } = {
    // As the server: a round placed took everything out of the cart.
    readCart: vi.fn<SendRoundPorts["readCart"]>(async () => (placed ? cart(4, 0) : cart())),
    readTable: vi.fn<SendRoundPorts["readTable"]>(async () => {
      calls.push("table");
      return { checkingOut: false };
    }),
    readDetails: vi.fn<SendRoundPorts["readDetails"]>(async (selection) => {
      calls.push("details-read");
      return { ...selection, details: null };
    }),
    quote: vi.fn<SendRoundPorts["quote"]>(async () => {
      calls.push("quote");
      quoted += 1;
      return quote({ quoteReference: id(100 + quoted) });
    }),
    saveDetails: vi.fn<SendRoundPorts["saveDetails"]>(async (draft, operationReference) => {
      calls.push("details-save");
      return {
        operationReference,
        detailsReference: draft.detailsReference,
        detailsVersion: draft.expectedVersion + 1,
        cartReference: draft.cartReference,
        cartVersion: draft.cartVersion,
        quoteReference: draft.quoteReference,
        quoteVersion: draft.quoteVersion,
        orderType: draft.orderType,
        receiptChoice: draft.receipt.choice,
        recordedAt: "2026-11-05T00:00:00.000Z",
      };
    }),
    createSession: vi.fn<SendRoundPorts["createSession"]>(async (selection) => {
      calls.push("session");
      return { ...selection, checkoutSessionReference: id(3), createdAt: "" };
    }),
    send: vi.fn<SendRoundPorts["send"]>(async () => {
      calls.push("send");
      placed = true;
      return { status: "Sent" as const };
    }),
  };
  Object.assign(ports, overrides);
  let key = 200;
  return {
    ports,
    calls,
    controller: createSendRoundController(ports as SendRoundPorts, () => id((key += 1))),
  };
}

const lost = () => new CartClientError("network_unknown");
const unsent = { status: "unconfirmed", mayBePlaced: false };
const maybeSent = { status: "unconfirmed", mayBePlaced: true };

describe("WP-2423 item 6: placing a round from the cart", () => {
  it("places a round in one tap: table, quote, details, checkout, send, in that order", async () => {
    const { controller, calls, ports } = setUp();
    await controller.send(cart(), seen);
    // The table and the current details are read together.
    expect(calls.slice(0, 2).sort()).toEqual(["details-read", "table"]);
    expect(calls.slice(2)).toEqual(["quote", "details-save", "session", "send"]);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    const [draft] = ports.saveDetails.mock.calls[0] ?? [];
    expect(draft).toMatchObject({
      expectedVersion: 0,
      pickupContact: null,
      receipt: { choice: "InSession", email: null },
      policies: [],
      quoteVersion: 2,
    });
  });

  it("says when a round waits for staff first", async () => {
    const { controller } = setUp({
      send: vi.fn<SendRoundPorts["send"]>(async () => ({ status: "Held" })),
    });
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: true });
  });

  it("retry after a lost answer repeats the same keys", async () => {
    const { controller, ports } = setUp();
    ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    ports.readCart.mockResolvedValue(cart(4, 0));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(maybeSent);
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    const [[, firstSelection], [, secondSelection]] = ports.send.mock.calls as [
      [string, string],
      [string, string],
    ];
    expect(secondSelection).toBe(firstSelection);
    expect(ports.send.mock.calls[1]?.[0]).toBe(ports.send.mock.calls[0]?.[0]);
    // Nothing before the send runs again.
    expect(ports.quote).toHaveBeenCalledTimes(1);
    expect(ports.saveDetails).toHaveBeenCalledTimes(1);
    expect(ports.createSession).toHaveBeenCalledTimes(1);
    // A guest's retry doesn't cost another long wait through a busy Store.
    expect(ports.send.mock.calls[1]?.[2]).toEqual({ busyTotalMs: manualRetryBusyTotalMs });
  });

  it("a send whose answer was lost finishes with the same key even after the cart emptied", async () => {
    const { controller, ports } = setUp();
    ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    ports.send.mockResolvedValueOnce({ status: "AlreadySent" });
    ports.readCart.mockResolvedValue(cart(4, 0));
    await controller.send(cart(), seen);
    // The order transaction emptied the cart before the answer got lost: nothing to quote now.
    await controller.send(null, null);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.send).toHaveBeenCalledTimes(2);
    expect(ports.send.mock.calls[1]?.[1]).toBe(ports.send.mock.calls[0]?.[1]);
    expect(ports.readTable).toHaveBeenCalledTimes(1);
  });

  it("a retry with no price to hand still compares with what the guest saw", async () => {
    const { controller, ports } = setUp();
    ports.quote.mockRejectedValueOnce(lost());
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(unsent);
    await controller.send(cart(), null);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.quote.mock.calls[1]?.[1]).toBe(ports.quote.mock.calls[0]?.[1]);
  });

  it("a lost checkout repeats with the same key while the cart and quote are unchanged", async () => {
    const { controller, ports } = setUp();
    ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(unsent);
    await controller.send(cart(), null);
    expect(ports.createSession.mock.calls[1]?.[1]).toBe(ports.createSession.mock.calls[0]?.[1]);
    expect(ports.createSession.mock.calls[1]?.[0]).toEqual(ports.createSession.mock.calls[0]?.[0]);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
  });

  it("nothing was placed before a send, so a cart that moved on ends a lost checkout", async () => {
    const version = setUp();
    version.ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await version.controller.send(cart(), seen);
    expect(version.controller.getState()).toEqual(unsent);
    // Another guest added a dish: Try again finds that out before anything else.
    version.ports.readCart.mockResolvedValue(cart(4));
    await version.controller.send(cart(), null);
    expect(version.controller.getState()).toEqual({ status: "cart-changed" });
    expect(version.ports.createSession).toHaveBeenCalledTimes(1);
    expect(version.ports.readTable).toHaveBeenCalledTimes(1);
    // The next tap is about the cart as the guest now sees it: all new keys.
    await version.controller.send(cart(4), seen);
    expect(version.controller.getState()).toEqual({ status: "sent", held: false });
    expect(version.ports.quote.mock.calls[1]?.[1]).not.toBe(version.ports.quote.mock.calls[0]?.[1]);
    expect(version.ports.createSession.mock.calls[1]?.[1]).not.toBe(
      version.ports.createSession.mock.calls[0]?.[1],
    );
    expect(version.ports.send).toHaveBeenCalledTimes(1);
  });

  it("another guest's quote on the same cart version ends a lost checkout too", async () => {
    const { controller, ports } = setUp();
    ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await controller.send(cart(), seen);
    const replaced = cart();
    ports.readCart.mockResolvedValue({
      ...replaced,
      cart: { ...replaced.cart, quote: quote({ quoteReference: id(99) }) },
    } as unknown as CartView);
    await controller.send(cart(), null);
    expect(controller.getState()).toEqual({ status: "cart-changed" });
    expect(ports.createSession).toHaveBeenCalledTimes(1);
  });

  it("the guest's own quote on the cart is no change", async () => {
    const { controller, ports } = setUp();
    ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await controller.send(cart(), seen);
    const attached = ports.createSession.mock.calls[0]?.[0].quoteReference;
    const own = cart();
    ports.readCart.mockResolvedValueOnce({
      ...own,
      cart: { ...own.cart, quote: quote({ quoteReference: attached ?? "" }) },
    } as unknown as CartView);
    await controller.send(cart(), null);
    expect(ports.createSession.mock.calls[1]?.[1]).toBe(ports.createSession.mock.calls[0]?.[1]);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
  });

  it("a lost answer before any send is looked into at once, without a tap", async () => {
    const moved = setUp();
    moved.ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    moved.ports.readCart.mockResolvedValue(cart(4));
    await moved.controller.send(cart(), seen);
    expect(moved.controller.getState()).toEqual({ status: "cart-changed" });
    // Someone else's round emptied it: that's what the page says, never "may have been placed".
    const placed = setUp();
    placed.ports.quote.mockRejectedValueOnce(lost());
    placed.ports.readCart.mockResolvedValue(cart(5, 0));
    await placed.controller.send(cart(), seen);
    expect(placed.controller.getState()).toEqual({ status: "cart-changed" });
    // No answer to that read either: it stays a retry, and nothing sends by itself.
    const dark = setUp();
    dark.ports.quote.mockRejectedValue(lost());
    dark.ports.readCart.mockRejectedValue(lost());
    await dark.controller.send(cart(), seen);
    expect(dark.controller.getState()).toEqual(unsent);
  });

  it("a cart read that fails decides nothing, unless the tap's own cart already moved on", async () => {
    const { controller, ports } = setUp();
    ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await controller.send(cart(), seen);
    ports.readCart.mockRejectedValue(lost());
    await controller.send(cart(), null);
    expect(ports.createSession.mock.calls[1]?.[1]).toBe(ports.createSession.mock.calls[0]?.[1]);
    const stale = setUp();
    stale.ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await stale.controller.send(cart(), seen);
    stale.ports.readCart.mockRejectedValue(lost());
    await stale.controller.send(cart(4), null);
    expect(stale.controller.getState()).toEqual({ status: "cart-changed" });
    expect(stale.ports.createSession).toHaveBeenCalledTimes(1);
  });

  it("once a send was attempted the plan outlives any cart, and says the round may exist", async () => {
    const { controller, ports } = setUp();
    ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    ports.readCart.mockResolvedValue(cart(4));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(maybeSent);
    await controller.send(cart(4), null);
    expect(ports.send.mock.calls[1]?.[1]).toBe(ports.send.mock.calls[0]?.[1]);
    expect(ports.createSession).toHaveBeenCalledTimes(1);
  });

  it("a retry that finishes an older round says when the cart holds more", async () => {
    const dish = setUp();
    dish.ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    await dish.controller.send(cart(), seen);
    // A dish added while the answer was unknown is still in the cart afterwards.
    dish.ports.readCart.mockResolvedValue(cart(5));
    await dish.controller.send(cart(5), null);
    expect(dish.controller.getState()).toEqual({ status: "sent", held: false, more: true });
    // No answer about the cart either: placed is all that can be said.
    const dark = setUp();
    dark.ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    await dark.controller.send(cart(), seen);
    dark.ports.readCart.mockRejectedValue(lost());
    await dark.controller.send(null, null);
    expect(dark.controller.getState()).toEqual({ status: "sent", held: false, more: true });
    // An ordinary tap costs no extra read: the round took the cart it was made from.
    const tap = setUp();
    await tap.controller.send(cart(), seen);
    expect(tap.ports.readCart).not.toHaveBeenCalled();
  });

  it("a lost details save retried sends the identical body", async () => {
    const { controller, ports } = setUp();
    ports.saveDetails.mockRejectedValueOnce(new CheckoutDetailsClientError("unknown"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(unsent);
    // What a re-read would answer now if the lost save had landed.
    ports.readDetails.mockResolvedValue({
      cartReference: id(1),
      cartVersion: 3,
      orderType: "DineIn",
      details: { detailsVersion: 1 } as never,
    });
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    const [first, second] = ports.saveDetails.mock.calls;
    expect(second?.[0]).toBe(first?.[0] as CheckoutDetailsDraft);
    expect(second?.[1]).toBe(first?.[1]);
    expect(ports.readDetails).toHaveBeenCalledTimes(1);
    expect(ports.saveDetails).toHaveBeenCalledTimes(2);
  });

  it("after a save is acknowledged the plan never saves details again", async () => {
    const { controller, ports } = setUp();
    ports.createSession.mockRejectedValueOnce(new CheckoutSessionClientError("unknown"));
    await controller.send(cart(), seen);
    await controller.send(cart(), seen);
    expect(ports.saveDetails).toHaveBeenCalledTimes(1);
  });

  it("stops before saving anything when the total went up, and the second tap continues with the same quote", async () => {
    const { controller, ports } = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => quote({ subtotal: cad("2200") })),
    });
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({
      status: "confirm-total",
      total: cad("2260"),
      reason: "changed",
    });
    expect(ports.saveDetails).not.toHaveBeenCalled();
    expect(ports.createSession).not.toHaveBeenCalled();
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.quote).toHaveBeenCalledTimes(1);
    expect(ports.send).toHaveBeenCalledTimes(1);
  });

  it("a total the same or lower goes straight through", async () => {
    const { controller, ports } = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => quote({ subtotal: cad("1800") })),
    });
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.send).toHaveBeenCalledTimes(1);
  });

  it("a fee or a total not shown stops once", async () => {
    const fee = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => quote({ fee: cad("100") })),
    });
    await fee.controller.send(cart(), seen);
    expect(fee.controller.getState()).toMatchObject({ status: "confirm-total", reason: "fees" });
    await fee.controller.send(cart(), seen);
    expect(fee.controller.getState()).toEqual({ status: "sent", held: false });
    const unseen = setUp();
    await unseen.controller.send(cart(), null);
    expect(unseen.controller.getState()).toMatchObject({
      status: "confirm-total",
      reason: "shown",
    });
    expect(unseen.ports.saveDetails).not.toHaveBeenCalled();
    await unseen.controller.send(cart(), null);
    expect(unseen.controller.getState()).toEqual({ status: "sent", held: false });
    const reconfirm = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () =>
        quote({
          priceChange: {
            outcome: "Changed",
            totalChange: cad("0"),
            requiresReconfirmation: true,
            evaluatedAt: "2026-11-05T00:00:00.000Z",
          },
        }),
      ),
    });
    await reconfirm.controller.send(cart(), seen);
    expect(reconfirm.controller.getState()).toMatchObject({
      status: "confirm-total",
      reason: "changed",
    });
  });

  it("prices that ran out are read again silently, before anything is sent", async () => {
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const { ports } = setUp();
    const quotes = [
      quote({ subtotal: cad("2200"), expiresAt: "2026-11-05T00:05:00.000Z" }),
      quote({
        quoteReference: id(9),
        subtotal: cad("2200"),
        expiresAt: "2026-11-05T01:00:00.000Z",
      }),
    ];
    ports.quote.mockImplementation(async () => quotes.shift() as CheckoutQuote);
    let key = 300;
    const controller = createSendRoundController(
      ports as SendRoundPorts,
      () => id((key += 1)),
      () => now,
    );
    await controller.send(cart(), seen);
    expect(controller.getState()).toMatchObject({ status: "confirm-total" });
    // The guest looks at the total for a while; the same total doesn't ask twice.
    now += 600_000;
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.quote).toHaveBeenCalledTimes(2);
    expect(ports.quote.mock.calls[1]?.[1]).not.toBe(ports.quote.mock.calls[0]?.[1]);
    expect(ports.saveDetails.mock.calls[0]?.[0].quoteReference).toBe(id(9));
  });

  it("a Store with documents answers the save and opens the page", async () => {
    const { controller, ports } = setUp();
    ports.saveDetails.mockRejectedValueOnce(new CheckoutDetailsClientError("policy"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "needs-page" });
    expect(ports.createSession).not.toHaveBeenCalled();
    // Saved with no documents: never a separate policy read a slow phone clock could fail.
    expect(ports.saveDetails.mock.calls[0]?.[0].policies).toEqual([]);
    expect(Object.keys(ports)).not.toContain("readPolicy");
  });

  it("a quote's warning also opens the page", async () => {
    const { controller, ports } = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => quote({ warnings: ["ANYTHING"] })),
    });
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "needs-page" });
    expect(ports.saveDetails).not.toHaveBeenCalled();
  });

  it("a blocking reason says so in the guest's words and sends nothing", async () => {
    const { controller, ports } = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => quote({ blockingReasons: ["ANYTHING"] })),
    });
    await controller.send(cart(), seen);
    const state = controller.getState();
    expect(state.status).toBe("blocked");
    expect("messages" in state ? state.messages : []).toEqual([
      "This order can’t be paid yet. Ask staff for help.",
    ]);
    expect(ports.saveDetails).not.toHaveBeenCalled();
  });

  it("a table already checking out says so and sends nothing", async () => {
    const read = setUp({
      readTable: vi.fn<SendRoundPorts["readTable"]>(async () => ({ checkingOut: true })),
    });
    await read.controller.send(cart(), seen);
    expect(read.controller.getState()).toEqual({ status: "table-checking-out" });
    expect(read.ports.quote).not.toHaveBeenCalled();
    // A table read that failed decides nothing; the quote says it then.
    const answered = setUp({
      readTable: vi.fn<SendRoundPorts["readTable"]>(async () => {
        throw new Error("no answer");
      }),
      quote: vi.fn<SendRoundPorts["quote"]>(async () => {
        throw new CartClientError("cart_table_checking_out");
      }),
    });
    await answered.controller.send(cart(), seen);
    expect(answered.controller.getState()).toEqual({ status: "table-checking-out" });
  });

  it("checks the table again on every retry", async () => {
    const { controller, ports } = setUp();
    ports.quote.mockRejectedValueOnce(lost());
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(unsent);
    ports.readTable.mockResolvedValue({ checkingOut: true });
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "table-checking-out" });
    expect(ports.readTable).toHaveBeenCalledTimes(2);
    expect(ports.saveDetails).not.toHaveBeenCalled();
  });

  it("item short names the line, store closed ends retries, a pay-first table goes to payment", async () => {
    const line = { cartItemReference: id(50), available: 0, sharedStock: false };
    const short = setUp({
      createSession: vi.fn<SendRoundPorts["createSession"]>(async () => {
        throw new CheckoutSessionClientError("item_short", null, line);
      }),
    });
    await short.controller.send(cart(), seen);
    expect(short.controller.getState()).toEqual({
      status: "refused",
      refusal: "item_short",
      line,
    });
    const closed = setUp({
      createSession: vi.fn<SendRoundPorts["createSession"]>(async () => {
        throw new CheckoutSessionClientError("store_closed");
      }),
    });
    await closed.controller.send(cart(), seen);
    expect(closed.controller.getState()).toEqual({ status: "store-closed" });
    const shortAtSend = setUp({
      send: vi.fn<SendRoundPorts["send"]>(async () => {
        throw new SessionPaymentClientError("items_short");
      }),
    });
    await shortAtSend.controller.send(cart(), seen);
    expect(shortAtSend.controller.getState()).toEqual({
      status: "refused",
      refusal: "item_short",
      line: null,
    });
    setCustomerCsrfCredential("c".repeat(43));
    const payFirst = setUp({
      send: vi.fn<SendRoundPorts["send"]>(async () => {
        throw new SessionPaymentClientError("pay_first_table");
      }),
    });
    await payFirst.controller.send(cart(), seen);
    expect(payFirst.controller.getState()).toEqual({ status: "pay-first" });
    expect(getTablePaymentTiming()).toBe("PayFirst");
    setCustomerCsrfCredential(null);
  });

  it("a busy table waits and asks again with a new operation", async () => {
    const { controller, ports } = setUp();
    ports.quote.mockRejectedValueOnce(
      new CartClientError("cart_checkout_in_progress", { retryAfterSeconds: 30 }),
    );
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({
      status: "busy",
      wait: "checkout-in-progress",
      retryAfterSeconds: 30,
    });
    await controller.send(cart(), seen);
    expect(ports.quote.mock.calls[1]?.[1]).not.toBe(ports.quote.mock.calls[0]?.[1]);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
  });

  it("a changed cart starts over with new keys", async () => {
    const { controller, ports } = setUp();
    ports.quote.mockRejectedValueOnce(new CartClientError("cart_version_conflict"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "cart-changed" });
    await controller.send(cart(4), seen);
    expect(ports.quote.mock.calls[1]?.[1]).not.toBe(ports.quote.mock.calls[0]?.[1]);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
  });

  it("a second phone tapping after the first sent ends at cart-changed, with no second round", async () => {
    const { controller, ports } = setUp();
    // The first phone's send deleted every line and moved the version on.
    ports.quote.mockRejectedValueOnce(new CartClientError("cart_version_conflict"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "cart-changed" });
    expect(ports.send).not.toHaveBeenCalled();
    // The page re-reads an empty cart; nothing is left to place.
    await controller.send(cart(5, 0), null);
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("a cart that emptied under an unfinished plan says someone placed it", async () => {
    const { controller, ports } = setUp();
    ports.quote.mockRejectedValueOnce(lost());
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(unsent);
    ports.readCart.mockResolvedValue(cart(5, 0));
    await controller.send(cart(5, 0), null);
    expect(controller.getState()).toEqual({ status: "cart-changed" });
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("leaving forgets a stop, but never a send that may have happened", async () => {
    const stopped = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => quote({ subtotal: cad("2200") })),
    });
    await stopped.controller.send(cart(), seen);
    expect(stopped.controller.getState().status).toBe("confirm-total");
    stopped.controller.reset();
    expect(stopped.controller.getState()).toEqual({ status: "idle" });
    // Coming back asks again rather than treating the old total as agreed.
    await stopped.controller.send(cart(), seen);
    expect(stopped.controller.getState().status).toBe("confirm-total");
    const lostSend = setUp();
    lostSend.ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    await lostSend.controller.send(cart(), seen);
    lostSend.controller.reset();
    await lostSend.controller.send(null, null);
    expect(lostSend.ports.send.mock.calls[1]?.[1]).toBe(lostSend.ports.send.mock.calls[0]?.[1]);
    // A checkout that was never sent placed nothing: coming back starts over.
    const lostCheckout = setUp();
    lostCheckout.ports.createSession.mockRejectedValueOnce(
      new CheckoutSessionClientError("unknown"),
    );
    await lostCheckout.controller.send(cart(), seen);
    lostCheckout.controller.reset();
    await lostCheckout.controller.send(cart(), seen);
    expect(lostCheckout.ports.createSession.mock.calls[1]?.[1]).not.toBe(
      lostCheckout.ports.createSession.mock.calls[0]?.[1],
    );
  });

  it("a details conflict restarts once with a whole new plan, then asks the guest", async () => {
    const { controller, ports } = setUp();
    ports.saveDetails.mockRejectedValueOnce(new CheckoutDetailsClientError("conflict"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    const [first, second] = ports.quote.mock.calls;
    expect(second?.[1]).not.toBe(first?.[1]);
    expect(ports.send).toHaveBeenCalledTimes(1);
    const twice = setUp();
    twice.ports.saveDetails.mockRejectedValue(new CheckoutDetailsClientError("requote"));
    await twice.controller.send(cart(), seen);
    expect(twice.controller.getState()).toEqual(unsent);
    expect(twice.ports.saveDetails).toHaveBeenCalledTimes(2);
  });

  it("a send that says not ready starts over once with new session and selection keys", async () => {
    const { controller, ports } = setUp();
    ports.send.mockRejectedValueOnce(new SessionPaymentClientError("not_ready"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.createSession.mock.calls[1]?.[1]).not.toBe(ports.createSession.mock.calls[0]?.[1]);
    expect(ports.send.mock.calls[1]?.[1]).not.toBe(ports.send.mock.calls[0]?.[1]);
  });

  it.each([
    [
      "the send",
      (ports: ReturnType<typeof setUp>["ports"]) =>
        ports.send.mockRejectedValueOnce(new SessionPaymentClientError("requote_required")),
    ],
    [
      "the checkout start",
      (ports: ReturnType<typeof setUp>["ports"]) =>
        ports.createSession.mockRejectedValueOnce(
          new CheckoutSessionClientError("requote_required"),
        ),
    ],
  ] as const)(
    "a menu updated before %s prices the round again once and places it once",
    async (_, refuse) => {
      const { controller, ports, calls } = setUp();
      refuse(ports);
      await controller.send(cart(), seen);
      expect(controller.getState()).toEqual({ status: "sent", held: false });
      expect(ports.quote).toHaveBeenCalledTimes(2);
      expect(ports.quote.mock.calls[1]?.[1]).not.toBe(ports.quote.mock.calls[0]?.[1]);
      expect(ports.createSession.mock.calls[1]?.[0].quoteReference).toBe(id(102));
      // Placed once: the refused attempt placed nothing.
      expect(calls.filter((call) => call === "send")).toHaveLength(1);
    },
  );

  it("a menu update that raised the price asks the guest before the round goes, once", async () => {
    let quoted = 0;
    const { controller, ports } = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => {
        quoted += 1;
        return quoted === 1
          ? quote({ quoteReference: id(101) })
          : quote({ quoteReference: id(102), subtotal: cad("2200"), total: cad("2486") });
      }),
    });
    ports.send.mockRejectedValueOnce(new SessionPaymentClientError("requote_required"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({
      status: "confirm-total",
      total: cad("2486"),
      reason: "changed",
    });
    expect(ports.send).toHaveBeenCalledTimes(1);
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual({ status: "sent", held: false });
    expect(ports.quote).toHaveBeenCalledTimes(2);
    expect(ports.send).toHaveBeenCalledTimes(2);
    expect(ports.createSession.mock.calls.at(-1)?.[0].quoteReference).toBe(id(102));
  });

  it("a menu that moves again while it is priced again stops, saying nothing was placed", async () => {
    const { controller, ports } = setUp();
    ports.send.mockRejectedValue(new SessionPaymentClientError("requote_required"));
    await controller.send(cart(), seen);
    expect(controller.getState()).toEqual(unsent);
    expect(ports.send).toHaveBeenCalledTimes(2);
  });

  it("an ended session says so", async () => {
    const quoted = setUp({
      quote: vi.fn<SendRoundPorts["quote"]>(async () => {
        throw new CartClientError("cart_session_expired");
      }),
    });
    await quoted.controller.send(cart(), seen);
    expect(quoted.controller.getState()).toEqual({ status: "session-ended" });
    const read = setUp({
      readDetails: vi.fn<SendRoundPorts["readDetails"]>(async () => {
        throw new CheckoutDetailsClientError("denied");
      }),
    });
    await read.controller.send(cart(), seen);
    expect(read.controller.getState()).toEqual({ status: "session-ended" });
    expect(read.ports.quote).not.toHaveBeenCalled();
  });

  it("two taps at once are one send", async () => {
    const { controller, ports } = setUp();
    await Promise.all([controller.send(cart(), seen), controller.send(cart(), seen)]);
    expect(ports.send).toHaveBeenCalledTimes(1);
  });

  it("only a tap sends: nothing runs by itself after a lost answer", async () => {
    const { controller, ports } = setUp();
    ports.send.mockRejectedValueOnce(new SessionPaymentClientError("unknown"));
    await controller.send(cart(), seen);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ports.send).toHaveBeenCalledTimes(1);
  });
});

describe("what the checkout page says about its own send", () => {
  it.each([
    ["store_closed", "store_closed"],
    ["items_short", "items_short"],
    ["pay_first_table", "pay_first"],
    ["unknown", "failed"],
    ["denied", "failed"],
  ] as const)("%s reads as %s", (code, expected) => {
    expect(sendFailureState(new SessionPaymentClientError(code))).toBe(expected);
  });
  it("anything else may be tried again", () => {
    expect(sendFailureState(new TypeError("Failed to fetch"))).toBe("failed");
  });
});
