import { readClosedRecord } from "@bop/identity";
import type { CatalogDishChangeKey, ValidateCatalogSelectionInput } from "@rms/catalog";
import {
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import {
  CheckoutValidationError,
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
} from "../domain/checkout-validation.js";
import {
  parseOrderCatalogLineSnapshot,
  parseOrderPricingLineSnapshot,
  parseConfiguredOrderPricingLineSnapshot,
} from "../domain/order-item-snapshot.js";
import type { OrderCreationPorts } from "./ports/order-creation-ports.js";

/** Map one value at a time: owner ports may share one caller transaction (no concurrent use). */
async function mapInSequence<T, R>(
  values: readonly T[],
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const value of values) results.push(await map(value));
  return results;
}

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
  readonly catalog: {
    capture(input: ValidateCatalogSelectionInput): Promise<unknown>;
    /**
     * WP-2423 (DEC-PRICE-HOLD §3): whether a dish sold now on a newer menu than its price is shown
     * with another name or other allergens. Without it such a dish is priced again.
     */
    dishChanges?(keys: readonly CatalogDishChangeKey[]): Promise<readonly (readonly unknown[])[]>;
  };
  readonly clock: { now(): string };
  /**
   * WP-2423 DEC-MERCHANT-LOCK-SCOPE: the menu version in force now (null when none is). Asked only
   * after the source could not be read: a checkout validated before an owner listed can never be
   * read back, so it is refused as "price again", which the guest's page does, not as an outage
   * the guest would retry for ever.
   */
  readonly currentMenuVersion?: (observedAt: string) => Promise<string | null>;
}
/** Whether this checkout was validated against a menu version that is no longer in force. */
async function menuMovedOn(
  options: OrderSubmissionSourceOptions,
  lines: readonly { readonly menuVersionReference: string }[],
): Promise<boolean> {
  if (options.currentMenuVersion === undefined) return false;
  try {
    const current = await options.currentMenuVersion(options.clock.now());
    return current !== null && lines.some((line) => line.menuVersionReference !== current);
  } catch {
    return false;
  }
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
      let validatedLines: readonly { readonly menuVersionReference: string }[] = [];
      try {
        const evidence = (
          quoteVersion === 2
            ? parseConfiguredCheckoutValidationEvidence
            : parseCheckoutValidationEvidence
        )(readClosedRecord(input, ["evidence"], "ACTOR_SHAPE_INVALID").evidence);
        validatedLines = evidence.catalogLines;
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
            // Owner #26 (DEC-PRICE-HOLD): the validated menu may be newer than the one the guest's
            // price was confirmed on, inside the quote's hold (validUntil never outlasts it).
            item.catalogSelectionEvidence === null ||
            line.productVersionReference !== item.catalogSelectionEvidence.productVersionReference
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
        const captureAll = (capturedAt: string) =>
          mapInSequence(cart.items, async (item) => {
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
                observedAt: capturedAt as never,
              }),
            );
            const validated = expected.get(item.cartItemReference);
            if (
              catalog.brandReference !== brand ||
              catalog.storeReference !== store ||
              catalog.sellableReference !== item.sellableReference ||
              // Owner #26 (DEC-PRICE-HOLD): the Owner may list again between checkout start and
              // send; inside the hold (validUntil, checked by fresh()) the same dish is sent as the
              // menu sells it now at the confirmed price. The dish itself must not have changed.
              validated === undefined ||
              catalog.productVersionReference !== validated.productVersionReference ||
              catalog.capturedAt !== capturedAt ||
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
          });
        // Owner #26 (DEC-PRICE-HOLD): Catalog reads only the menu in force now. A checkout
        // validated before the Owner listed again (a later round sent inside the hold) cannot be
        // read back as of its validation; it is read once more, all dishes at this one instant, as
        // the menu sells them now. The price stays the quote's; the dish must be the same one.
        let lines;
        try {
          lines = await captureAll(evidence.validatedAt);
        } catch (error) {
          if (!(await menuMovedOn(options, validatedLines))) throw error;
          const capturedAt = parseOrderingInstant(options.clock.now());
          fresh();
          lines = await captureAll(capturedAt);
        }
        // WP-2423 (DEC-PRICE-HOLD §3, price-hold-dish-changes): the same product version may
        // be renamed or given other allergens and listed (its draft is edited in place). A dish
        // the guest would be told about differently is never ordered or charged at the held
        // price: the guest's page prices it again and shows it as it is now.
        const moved: CatalogDishChangeKey[] = [];
        for (const line of lines) {
          const item = cart.items.find(
            (value) => value.cartItemReference === line.cartItemReference,
          );
          const priced = item?.catalogSelectionEvidence;
          if (item === undefined || priced == null) throw new OrderSubmissionSourceError();
          if (line.catalog.menuVersionReference !== priced.menuVersionReference)
            moved.push({
              sellableReference: item.sellableReference,
              productVersionReference: priced.productVersionReference,
              fromMenuVersionReference: priced.menuVersionReference,
              toMenuVersionReference: line.catalog.menuVersionReference,
            });
        }
        if (moved.length > 0) {
          const dishChanges = options.catalog.dishChanges;
          if (dishChanges === undefined)
            throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
          const changes = await dishChanges(moved);
          if (
            !Array.isArray(changes) ||
            changes.length !== moved.length ||
            changes.some((change) => !Array.isArray(change) || change.length > 0)
          )
            throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
        }
        fresh();
        assertCartLifecycleActive(cart.lifecycle, last);
        return Object.freeze({ cart, lines: Object.freeze(lines) });
      } catch (error) {
        if (error instanceof CheckoutValidationError && error.code === "CHECKOUT_REQUOTE_REQUIRED")
          throw error;
        if (await menuMovedOn(options, validatedLines))
          throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
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
