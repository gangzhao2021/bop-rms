import { fixture, id } from "./configured-cart-quote.fixture.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { createConfiguredOrderPricingSource } from "../application/configured-order-pricing-source.js";
import { createConfiguredOrderItemSnapshots } from "../domain/order-item-snapshot.js";

export async function configuredOrderItemFixture(dining = false) {
  const f = fixture(dining),
    quote = f.quote,
    at = "2026-08-02T16:00:30.000Z";
  const original = orderWriteFixture({ at }).request.checkoutValidationEvidence;
  const scope = {
    brandReference: String(quote.brandReference),
    storeReference: String(quote.storeReference),
  };
  const binding = {
    ...scope,
    cartReference: String(quote.cartReference),
    cartVersion: quote.cartVersion,
    quoteReference: String(quote.quoteReference),
    orderType: f.cart.orderType,
    sourceChannel: f.cart.sourceChannel,
  };
  const evidence = {
    ...original,
    ...binding,
    quoteVersion: 2,
    quoteInputDigest: quote.inputDigest,
    validatedAt: at,
    validUntil: quote.expiresAt,
    catalogLines: quote.lines.map((line) => ({
      cartItemReference: String(line.lineReference),
      sellableReference: String(line.sellableReference),
      productVersionReference: String(line.productVersionReference),
      menuVersionReference: String(line.menuVersionReference),
      validatedAt: at,
    })),
    fulfillment: {
      ...original.fulfillment,
      ...binding,
      checkedAt: at,
      validUntil: quote.expiresAt,
    },
  };
  const prices = await createConfiguredOrderPricingSource({
    scope,
    history: { load: async () => quote },
    clock: { now: () => at },
  }).load({ evidence });
  const catalog = f.catalogLines[0]?.snapshot,
    pricing = prices[0];
  if (!catalog || !pricing) throw new Error("missing synthetic fixture");
  const input = {
    orderReference: id(800),
    orderBatchReference: id(801),
    snapshotCapturedAt: at,
    checkoutValidationEvidence: evidence,
    cart: f.cart,
    lines: [
      {
        orderItemReference: id(802),
        cartItemReference: f.cart.items[0]?.cartItemReference,
        catalog: { ...catalog, capturedAt: at },
        pricing,
      },
    ],
  };
  const item = createConfiguredOrderItemSnapshots(input)[0];
  if (!item) throw new Error("missing synthetic item");
  return { f, input, item };
}
