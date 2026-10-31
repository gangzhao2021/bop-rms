import { createGuestSession } from "@bop/identity";
import { expect, it, vi } from "vitest";
import { fixture, id } from "./configured-cart-quote.fixture.js";
import { parseCartAggregate } from "../domain/cart.js";
import { parseConfiguredCartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import {
  createConfiguredCheckoutValidationService,
  type ConfiguredCheckoutValidationPorts,
} from "../application/configured-checkout-validation-service.js";
function setup(dining = false) {
  const f = fixture(dining),
    q = f.quote;
  let at = f.observedAt;
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
  const cart = parseCartAggregate(f.cart);
  const attachment = parseConfiguredCartQuoteAttachment({
    operationReference: id(90),
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
    warnings: q.warnings,
    lines: q.lines.map((line) => ({
      lineReference: line.lineReference,
      sellableReference: line.sellableReference,
      productVersionReference: line.productVersionReference,
      menuVersionReference: line.menuVersionReference,
      quantity: line.quantity,
    })),
    quoteCreatedAt: q.createdAt,
    quoteExpiresAt: q.expiresAt,
    attachedAt: f.observedAt,
    idempotencyExpiresAt: "2026-08-03T16:00:00.000Z",
  });
  const authorize = vi.fn<ConfiguredCheckoutValidationPorts["authorization"]["authorize"]>(
    async () => ({ guestSession: guest }),
  );
  const loadCart = vi.fn(async () => cart);
  const capture = vi.fn<ConfiguredCheckoutValidationPorts["snapshots"]["capture"]>(
    async () => f.catalogLines[0]?.snapshot,
  );
  const load = vi.fn<ConfiguredCheckoutValidationPorts["history"]["load"]>(async () => q);
  const fulfillment = vi.fn<ConfiguredCheckoutValidationPorts["fulfillment"]["validate"]>(
    async (input) =>
      ({
        status: "Accepted",
        ...input,
        checkedAt: input.observedAt,
        evidenceReference: id(95),
        evidenceVersion: 1,
        evidenceDigest: q.inputDigest,
        validUntil: q.expiresAt,
      }) as never,
  );
  fulfillment.mockImplementation(async (input) => {
    const { observedAt, ...scope } = input;
    return {
      ...scope,
      status: "Accepted",
      checkedAt: observedAt,
      evidenceReference: id(95),
      evidenceVersion: 1,
      evidenceDigest: q.inputDigest,
      validUntil: q.expiresAt,
    } as never;
  });
  const ports: ConfiguredCheckoutValidationPorts = {
    authorization: { authorize },
    repository: { loadCart, loadQuote: async () => attachment },
    history: { load },
    snapshots: { capture },
    pricingChannelCode: f.pricingChannelCode,
    now: () => at,
    references: { hashIntent: () => q.inputDigest },
    catalog: {
      validateSelection: async (input) =>
        ({
          status: "Accepted",
          ...input,
          ...cart.items[0]?.catalogSelectionEvidence,
          validatedAt: input.observedAt,
        }) as never,
    },
    fulfillment: { validate: fulfillment },
  };
  const command = {
    validationReference: id(96),
    cartReference: cart.cartReference,
    expectedCartVersion: cart.aggregateVersion,
    quoteReference: q.quoteReference,
    requestedAt: at,
  };
  return {
    f,
    cart,
    attachment,
    authorize,
    loadCart,
    capture,
    load,
    fulfillment,
    command,
    service: createConfiguredCheckoutValidationService(ports),
    setTime: (value: string) => {
      at = value;
    },
  };
}
it.each([false, true])(
  "creates complete configured Checkout evidence for Dining=%s",
  async (dining) => {
    const s = setup(dining),
      result = await s.service.validate(s.command);
    expect(result.quoteVersion).toBe(2);
    expect(result.orderType).toBe(dining ? "DineIn" : "Pickup");
    expect(s.load).toHaveBeenCalledOnce();
    expect(s.authorize).toHaveBeenCalledTimes(3);
    expect(s.loadCart).toHaveBeenCalledTimes(2);
  },
);
it("rejects unavailable original history before fulfillment", async () => {
  const s = setup();
  s.load.mockResolvedValue(null);
  await expect(s.service.validate(s.command)).rejects.toThrow();
  expect(s.fulfillment).not.toHaveBeenCalled();
});
it("rejects changed current option bindings before fulfillment", async () => {
  const s = setup(),
    snapshot = s.f.catalogLines[0]?.snapshot;
  if (!snapshot) throw new Error("missing fixture");
  s.capture.mockResolvedValue({
    ...snapshot,
    options: snapshot.options.map((option) => ({ ...option, bindingReference: id(999) })),
  });
  await expect(s.service.validate(s.command)).rejects.toThrow();
  expect(s.fulfillment).not.toHaveBeenCalled();
});
it("rejects authorization lost during the final Cart read", async () => {
  const s = setup();
  s.loadCart.mockResolvedValueOnce(s.cart).mockImplementationOnce(async () => {
    s.authorize.mockResolvedValue(null);
    return s.cart;
  });
  await expect(s.service.validate(s.command)).rejects.toMatchObject({
    code: "CHECKOUT_PERMISSION_DENIED",
  });
});
it("rejects Cart changes while other dependencies were loading", async () => {
  const s = setup();
  s.loadCart
    .mockResolvedValueOnce(s.cart)
    .mockResolvedValueOnce({ ...s.cart, aggregateVersion: 5 });
  await expect(s.service.validate(s.command)).rejects.toThrow();
});
it.each(["expired", "backwards"])("rejects %s clock after history wait", async (mode) => {
  const s = setup();
  s.load.mockImplementation(async () => {
    s.setTime(mode === "expired" ? s.f.quote.expiresAt : "2026-08-02T15:59:59.999Z");
    return s.f.quote;
  });
  await expect(s.service.validate(s.command)).rejects.toThrow();
  expect(s.fulfillment).not.toHaveBeenCalled();
});
