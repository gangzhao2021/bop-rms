import { readClosedRecord } from "@bop/identity";
import type { ValidateCatalogSelectionInput } from "@rms/catalog";
import {
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import {
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
} from "../domain/checkout-validation.js";
import {
  parseOrderCatalogLineSnapshot,
  parseOrderPricingLineSnapshot,
  parseConfiguredOrderPricingLineSnapshot,
} from "../domain/order-item-snapshot.js";
import type { OrderCreationPorts } from "./ports/order-creation-ports.js";

export class OrderSubmissionSourceError extends Error {
  readonly code = "ORDER_SUBMISSION_SOURCE_UNAVAILABLE";
  constructor() {
    super("order submission source is unavailable");
    this.name = "OrderSubmissionSourceError";
  }
}
export interface OrderSubmissionSourceOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly carts: { load(reference: string): Promise<unknown> };
  readonly pricing: { load(input: { readonly evidence: unknown }): Promise<readonly unknown[]> };
  readonly catalog: { capture(input: ValidateCatalogSelectionInput): Promise<unknown> };
  readonly clock: { now(): string };
}
function createVersionedOrderSubmissionSource<V extends 1 | 2>(
  options: OrderSubmissionSourceOptions,
  quoteVersion: V,
): OrderCreationPorts<V>["source"] {
  const rawScope = readClosedRecord(
    options.scope,
    ["brandReference", "storeReference"],
    "ACTOR_SHAPE_INVALID",
  );
  const brand = parseOrderingReference(rawScope.brandReference),
    store = parseOrderingReference(rawScope.storeReference);
  return Object.freeze({
    async load(input: Parameters<OrderCreationPorts<V>["source"]["load"]>[0]) {
      try {
        const evidence = (
          quoteVersion === 2
            ? parseConfiguredCheckoutValidationEvidence
            : parseCheckoutValidationEvidence
        )(readClosedRecord(input, ["evidence"], "ACTOR_SHAPE_INVALID").evidence);
        let last = parseOrderingInstant(options.clock.now());
        const fresh = () => {
          const now = parseOrderingInstant(options.clock.now());
          if (now < last || now < evidence.validatedAt || now >= evidence.validUntil)
            throw new OrderSubmissionSourceError();
          last = now;
        };
        fresh();
        if (evidence.brandReference !== brand || evidence.storeReference !== store)
          throw new OrderSubmissionSourceError();
        const cart = parseCartAggregate(await options.carts.load(evidence.cartReference));
        fresh();
        assertCartLifecycleActive(cart.lifecycle, last);
        if (
          cart.brandReference !== brand ||
          cart.storeReference !== store ||
          cart.cartReference !== evidence.cartReference ||
          cart.aggregateVersion !== evidence.cartVersion ||
          cart.orderType !== evidence.orderType ||
          cart.sourceChannel !== evidence.sourceChannel ||
          cart.items.length !== evidence.catalogLines.length
        )
          throw new OrderSubmissionSourceError();
        const expected = new Map(
          evidence.catalogLines.map((line) => [line.cartItemReference, line]),
        );
        for (const item of cart.items) {
          const line = expected.get(item.cartItemReference);
          if (
            !line ||
            line.sellableReference !== item.sellableReference ||
            line.menuVersionReference !== item.catalogSelectionEvidence?.menuVersionReference ||
            line.productVersionReference !== item.catalogSelectionEvidence?.productVersionReference
          )
            throw new OrderSubmissionSourceError();
        }
        const rawPrices = await options.pricing.load({ evidence });
        fresh();
        if (
          !Array.isArray(rawPrices) ||
          rawPrices.length !== cart.items.length ||
          Reflect.ownKeys(rawPrices).length !== rawPrices.length + 1
        )
          throw new OrderSubmissionSourceError();
        const prices = Array.from({ length: rawPrices.length }, (_, i) => {
          const value = Object.getOwnPropertyDescriptor(rawPrices, String(i));
          if (!value?.enumerable || !("value" in value)) throw new OrderSubmissionSourceError();
          return quoteVersion === 2
            ? parseConfiguredOrderPricingLineSnapshot(value.value)
            : parseOrderPricingLineSnapshot(value.value);
        });
        const byLine = new Map(prices.map((line) => [line.lineReference, line]));
        if (byLine.size !== cart.items.length) throw new OrderSubmissionSourceError();
        const lines = await Promise.all(
          cart.items.map(async (item) => {
            const price = byLine.get(item.cartItemReference);
            if (
              !price ||
              price.sellableReference !== item.sellableReference ||
              price.quantity !== item.quantity ||
              price.quoteReference !== evidence.quoteReference ||
              price.quoteVersion !== evidence.quoteVersion ||
              price.quoteInputDigest !== evidence.quoteInputDigest ||
              price.quotedAt > evidence.validatedAt
            )
              throw new OrderSubmissionSourceError();
            const catalog = parseOrderCatalogLineSnapshot(
              await options.catalog.capture({
                brandReference: brand as never,
                storeReference: store as never,
                sourceChannel: cart.sourceChannel,
                orderType: cart.orderType,
                sellableReference: item.sellableReference as never,
                optionSelections: item.optionSelections as never,
                observedAt: evidence.validatedAt as never,
              }),
            );
            const validated = expected.get(item.cartItemReference);
            if (
              catalog.brandReference !== brand ||
              catalog.storeReference !== store ||
              catalog.sellableReference !== item.sellableReference ||
              catalog.menuVersionReference !== validated?.menuVersionReference ||
              catalog.productVersionReference !== validated.productVersionReference ||
              catalog.capturedAt !== evidence.validatedAt ||
              catalog.options.length !== item.optionSelections.length ||
              catalog.options.some(
                (option) =>
                  !item.catalogSelectionEvidence?.ruleEvidence.some(
                    (rule) =>
                      rule.bindingReference === option.bindingReference &&
                      rule.optionSetVersionReference === option.optionSetVersionReference,
                  ),
              ) ||
              item.optionSelections.some(
                (selected) =>
                  !catalog.options.some(
                    (option) =>
                      option.optionReference === selected.optionReference &&
                      option.quantity === selected.quantity,
                  ),
              ) ||
              price.taxComponents.some(
                (tax) => tax.taxClassificationReference !== catalog.taxClassificationReference,
              )
            )
              throw new OrderSubmissionSourceError();
            if (price.quoteVersion === 2) {
              if (
                catalog.skuReference !== item.sellableReference ||
                price.optionPrices.length !== catalog.options.length ||
                price.optionPrices.some((option) => {
                  const selected = catalog.options.find(
                    (value) =>
                      value.bindingReference === option.bindingReference &&
                      value.optionReference === option.optionReference,
                  );
                  return (
                    selected === undefined ||
                    selected.quantity !== option.selectedQuantity ||
                    option.brandReference !== brand ||
                    option.storeReference !== store ||
                    option.sellableReference !== item.sellableReference ||
                    option.orderType !== cart.orderType ||
                    option.taxClassificationReference !== catalog.taxClassificationReference
                  );
                })
              )
                throw new OrderSubmissionSourceError();
            }
            return Object.freeze({
              cartItemReference: item.cartItemReference,
              catalog,
              pricing: price,
            });
          }),
        );
        fresh();
        assertCartLifecycleActive(cart.lifecycle, last);
        return Object.freeze({ cart, lines: Object.freeze(lines) });
      } catch {
        throw new OrderSubmissionSourceError();
      }
    },
  });
}

export function createOrderSubmissionSource(options: OrderSubmissionSourceOptions) {
  return createVersionedOrderSubmissionSource(options, 1);
}
export function createConfiguredOrderSubmissionSource(options: OrderSubmissionSourceOptions) {
  return createVersionedOrderSubmissionSource(options, 2);
}
