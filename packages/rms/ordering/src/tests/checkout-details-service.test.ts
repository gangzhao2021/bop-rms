import { createGuestSession } from "@bop/identity";
import { expect, it, vi } from "vitest";
import {
  createCheckoutDetailsService,
  type CheckoutDetailsPorts,
} from "../application/checkout-details-service.js";
import type { CheckoutDetailsSnapshot } from "../domain/checkout-details.js";
import { fixture, id } from "./configured-cart-quote.fixture.js";
function setup(dining = false) {
  const f = fixture(dining),
    q = f.quote;
  let at: string = f.observedAt,
    permitted = true,
    saved: CheckoutDetailsSnapshot | null = null;
  const guest = createGuestSession({
    sessionReference: id(65),
    version: 1,
    status: "Active",
    brandReference: f.cart.brandReference,
    storeReference: f.cart.storeReference,
    publicStoreReference: id(80),
    publicTableReference: dining ? id(81) : null,
    channel: dining ? "DineIn" : "Pickup",
    locale: "en-CA",
    qrReference: id(82),
    qrRevocationVersion: 1,
    diningState: dining ? "DiningBound" : "ContextOnly",
    diningSessionReference: dining ? id(67) : null,
    diningParticipantReference: dining ? id(68) : null,
    createdAt: f.observedAt,
    lastSeenAt: f.observedAt,
    idleExpiresAt: "2026-08-02T20:00:00.000Z",
    absoluteExpiresAt: "2026-08-03T16:00:00.000Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const attachment = {
    operationReference: id(91),
    operationIntentHash: q.inputDigest,
    guestSessionReference: id(65),
    cartReference: q.cartReference,
    brandReference: q.brandReference,
    storeReference: q.storeReference,
    cartVersion: q.cartVersion,
    quoteReference: q.quoteReference,
    quoteVersion: 2,
    quoteInputDigest: q.inputDigest,
    currencyCode: q.currencyMetadata.currencyCode,
    currencyMetadataVersion: q.currencyMetadata.metadataVersion,
    currencyMetadataVersionReference: q.currencyMetadata.metadataVersionReference,
    subtotal: q.subtotal,
    discount: q.discount,
    tax: q.tax,
    fee: q.fee,
    total: q.total,
    lines: q.lines.map((line) => ({
      lineReference: line.lineReference,
      sellableReference: line.sellableReference,
      productVersionReference: line.productVersionReference,
      menuVersionReference: line.menuVersionReference,
      quantity: line.quantity,
    })),
    warnings: q.warnings,
    quoteCreatedAt: q.createdAt,
    quoteExpiresAt: q.expiresAt,
    attachedAt: q.createdAt,
    idempotencyExpiresAt: new Date(Date.parse(q.createdAt) + 86400000).toISOString(),
  };
  const required = [
    {
      documentReference: id(92),
      documentVersion: 1,
      documentDigest: q.inputDigest,
      purposeCode: "ORDER_TERMS",
    },
  ];
  const authorize = vi.fn<CheckoutDetailsPorts["authorization"]["authorize"]>(async (input) =>
    permitted ? { guestSession: guest, audit: { observedAt: input.observedAt } } : null,
  );
  const loadCart = vi.fn(async () => f.cart),
    loadQuote = vi.fn(async () => attachment);
  const current = vi.fn<CheckoutDetailsPorts["policies"]["current"]>(async (input) => ({
    ...input,
    checkedAt: input.observedAt,
    validUntil: q.expiresAt,
    required,
  }));
  // The service policy port uses a closed result: omit request-only observedAt.
  current.mockImplementation(async (input) => ({
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    orderType: input.orderType,
    checkedAt: input.observedAt,
    validUntil: q.expiresAt,
    required,
  }));
  const persist = vi.fn<CheckoutDetailsPorts["repository"]["save"]>(async (input) => {
    saved = input.snapshot;
    return { status: "Saved", snapshot: saved };
  });
  const resolve = vi.fn(async () => saved);
  const service = createCheckoutDetailsService({
    now: () => at,
    authorization: { authorize },
    policies: { current },
    repository: { loadCart, loadQuote, resolveOperation: resolve, save: persist },
  });
  const command = {
    operationReference: id(94),
    detailsReference: id(95),
    expectedVersion: 0,
    cartReference: f.cart.cartReference,
    cartVersion: f.cart.aggregateVersion,
    quoteReference: q.quoteReference,
    quoteVersion: 2,
    pickupContact: dining
      ? null
      : { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
    receipt: { choice: "InSession", email: null },
    policies: required,
  };
  return {
    f,
    q,
    guest,
    attachment,
    required,
    service,
    command,
    authorize,
    loadCart,
    loadQuote,
    current,
    persist,
    resolve,
    permit: (value: boolean) => {
      permitted = value;
    },
    advance: (value: string) => {
      at = value;
    },
  };
}
it.each([false, true])("saves current bound details for Dining=%s", async (dining) => {
  const f = setup(dining);
  const result = await f.service.save(f.command);
  expect(result.status).toBe("Saved");
  expect(result.snapshot).toMatchObject({
    guestSessionReference: String(f.guest.sessionReference),
    orderType: dining ? "DineIn" : "Pickup",
    receipt: { choice: "InSession", email: null },
  });
  expect(f.persist).toHaveBeenCalledOnce();
});
it("recovers the original after quote expiry without rewriting policy or time", async () => {
  const f = setup();
  const original = await f.service.save(f.command);
  f.advance(f.q.expiresAt);
  f.current.mockResolvedValue(null);
  expect(await f.service.save(f.command)).toEqual({ ...original, status: "AlreadySaved" });
  expect(f.persist).toHaveBeenCalledOnce();
  expect(f.current).toHaveBeenCalledOnce();
});
it.each(["Cart", "Quote", "Policy"] as const)(
  "denies lost authority during %s before writing",
  async (stage) => {
    const f = setup();
    if (stage === "Cart")
      f.loadCart.mockImplementationOnce(async () => {
        f.permit(false);
        return f.f.cart;
      });
    if (stage === "Quote")
      f.loadQuote.mockImplementationOnce(async () => {
        f.permit(false);
        return f.attachment;
      });
    if (stage === "Policy")
      f.current.mockImplementationOnce(async (input) => {
        f.permit(false);
        return {
          brandReference: input.brandReference,
          storeReference: input.storeReference,
          orderType: input.orderType,
          checkedAt: input.observedAt,
          validUntil: f.q.expiresAt,
          required: f.required,
        };
      });
    await expect(f.service.save(f.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.persist).not.toHaveBeenCalled();
  },
);
it("refuses missing policy authority instead of assuming an empty requirement", async () => {
  const f = setup();
  f.current.mockResolvedValue(null);
  await expect(f.service.save(f.command)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.persist).not.toHaveBeenCalled();
});
it("requires the exact current policy version and digest", async () => {
  const f = setup();
  await expect(
    f.service.save({ ...f.command, policies: [{ ...f.required[0], documentVersion: 2 }] }),
  ).rejects.toMatchObject({ code: "CART_SELECTION_INVALID" });
  expect(f.persist).not.toHaveBeenCalled();
});
it("rejects a foreign Guest on the attached Quote", async () => {
  const f = setup();
  f.loadQuote.mockResolvedValue({ ...f.attachment, guestSessionReference: id(99) });
  await expect(f.service.save(f.command)).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
  expect(f.persist).not.toHaveBeenCalled();
});
it("keeps a post-write authorization failure uncertain", async () => {
  const f = setup();
  f.persist.mockImplementation(async (input) => {
    f.permit(false);
    return { status: "Saved", snapshot: input.snapshot };
  });
  await expect(f.service.save(f.command)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.persist).toHaveBeenCalledOnce();
});
it("rejects changed detail intent under the original operation", async () => {
  const f = setup();
  await f.service.save(f.command);
  await expect(
    f.service.save({
      ...f.command,
      receipt: { choice: "TransactionalEmail", email: "receipt@example.invalid" },
    }),
  ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
  expect(f.persist).toHaveBeenCalledOnce();
});

it("rejects a same-version Cart whose content changed during policy lookup", async () => {
  const f = setup();
  f.loadCart.mockResolvedValueOnce(f.f.cart).mockResolvedValueOnce({ ...f.f.cart, items: [] });
  await expect(f.service.save(f.command)).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
  expect(f.persist).not.toHaveBeenCalled();
});
it("rejects a future-dated Guest before reading private details", async () => {
  const f = setup();
  f.advance(new Date(Date.parse(f.f.observedAt) - 1000).toISOString());
  await expect(f.service.save(f.command)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
  expect(f.resolve).not.toHaveBeenCalled();
});

it("returns a bounded invalid-detail result before persistence", async () => {
  const f = setup();
  await expect(
    f.service.save({
      ...f.command,
      pickupContact: { name: "Synthetic guest", channel: "Phone", value: "invalid" },
    }),
  ).rejects.toMatchObject({ code: "CHECKOUT_DETAILS_INPUT_INVALID" });
  expect(f.persist).not.toHaveBeenCalled();
});
