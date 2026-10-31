import {
  listBundleComboRecords,
  listStoreAvailabilityRules,
  parseAvailabilitySafetyEvidence,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
  resolveStoreAvailability,
  type CustomerMenuQueryPorts,
  type CustomerMenuStoreFact,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  createPostgresCurrentOptionPriceStore,
  createPostgresCurrentPriceBookStore,
  currentStorePriceBook,
  OptionPriceError,
  PriceResolutionError,
  resolveOptionPrice,
  resolvePrice,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";
import type { CustomerInventoryEvidenceSource } from "./customer-menu-inventory-evidence.js";

/**
 * WP-2423 8.6: what the customer menu shows for each item at the Store — whether the Store offers
 * it, whether it is sold out, and its current base price from the Store's assigned price book (the
 * same book, channel and order type the Quote prices from). WP-2423 slice 4.5: and what one of each
 * published option adds, from the current option prices the Quote uses. Tax is added in the Quote.
 * WP-2423 Q12: and whether its ingredients have run out — an offered item one of which (with its
 * default choices) cannot be made from current stock shows sold out, the same as a manual sold
 * out, until stock is received or released. Unknown stock never marks an item sold out.
 */
export function createCustomerMenuStoreFacts(options: {
  /** A read-only transaction the caller owns and releases. */
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  /** The pricing channel the Quote uses for this customer channel. */
  readonly priceChannelCode: string;
  /** Stock observation in the same read; without it items are never sold out from stock. */
  readonly inventory?: CustomerInventoryEvidenceSource;
}): NonNullable<CustomerMenuQueryPorts["storeFacts"]> {
  const orderTypes: Readonly<Record<string, "Pickup" | "DineIn">> = {
    PICKUP: "Pickup",
    DINE_IN: "DineIn",
  };
  const exponent = options.currencyMetadata.minorUnitExponent;
  const decimal = (minor: bigint) => {
    const negative = minor < 0n;
    const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0");
    const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
    return (negative ? "-" : "") + whole + (exponent === 0 ? "" : "." + digits.slice(-exponent));
  };
  return Object.freeze({
    async load(input) {
      const orderType = orderTypes[input.orderTypeCode];
      return options.transactions.run(async (tx) => {
        const scope = {
          brandReference: String(input.brandReference),
          storeReference: String(input.storeReference),
        };
        const rules = await listStoreAvailabilityRules(tx, scope);
        const assignment = await currentStorePriceBook(tx as never, scope);
        const book =
          assignment === null
            ? null
            : await createPostgresCurrentPriceBookStore(
                { run: (work) => work(tx as never) },
                { brandReference: scope.brandReference },
                options.currencyMetadata,
              ).load({
                priceBookReference: assignment.priceBookReference,
                observedAt: input.requestedAt,
              });
        const optionPriceStore = createPostgresCurrentOptionPriceStore(
          { run: (work) => work(tx as never) },
          scope,
          options.currencyMetadata,
        );
        // WP-2423 item 8 ⑥ part 4: choices standing for a combo's dishes (guests choose them).
        const comboChoices = new Set(
          (await listBundleComboRecords(tx as never, scope)).choices.map((c) => c.optionReference),
        );
        const facts = new Map<string, CustomerMenuStoreFact>();
        for (const sellable of input.sellableReferences) {
          const own = rules.filter((rule) => rule.sellableReference === sellable);
          const resolved = resolveStoreAvailability({
            brandReference: parseCatalogReference(scope.brandReference),
            storeReference: parseCatalogReference(scope.storeReference),
            sellableReference: sellable,
            channelCode: parseCatalogCode(input.channelCode),
            orderTypeCode: parseCatalogCode(input.orderTypeCode),
            at: parseCatalogInstant(input.requestedAt),
            rules: own,
            safetyEvidence: [],
          });
          const soldOut =
            resolved.status === "Unavailable" &&
            own.some(
              (rule) =>
                rule.ruleReference === resolved.ruleReference && rule.reasonCode === "SOLD_OUT",
            );
          let price: CustomerMenuStoreFact["price"] = null;
          if (book !== null && orderType !== undefined)
            try {
              const found = resolvePrice(book, {
                brandReference: scope.brandReference as never,
                storeReference: scope.storeReference as never,
                storeGroupReference: null,
                regionReference: null,
                sellableReference: sellable as never,
                channelCode: options.priceChannelCode as never,
                orderType,
                currencyCode: options.currencyMetadata.currencyCode,
                evaluatedAt: input.requestedAt,
              });
              price = {
                amount: decimal(found.amount.amountMinor),
                currency: found.amount.currencyCode,
              };
            } catch (error) {
              // No price or an ambiguous one: shown as unpriced; the Quote refuses it the same way.
              if (!(error instanceof PriceResolutionError)) throw error;
            }
          const optionPrices = new Map<string, { amount: string; currency: string }>();
          if (orderType !== undefined)
            for (const option of (input.options ?? []).filter(
              (candidate) => candidate.sellableReference === sellable,
            )) {
              const rules = await optionPriceStore.load({
                bindingReference: option.bindingReference,
                optionReference: option.optionReference,
                skuReference: sellable,
                storeGroupReference: null,
                regionReference: null,
                channelCode: options.priceChannelCode,
                orderType,
                observedAt: input.requestedAt,
              });
              try {
                const found = resolveOptionPrice(rules, {
                  brandReference: scope.brandReference as never,
                  storeReference: scope.storeReference as never,
                  storeGroupReference: null,
                  regionReference: null,
                  bindingReference: option.bindingReference as never,
                  optionReference: option.optionReference as never,
                  skuReference: sellable as never,
                  channelCode: options.priceChannelCode as never,
                  orderType,
                  currencyMetadata: options.currencyMetadata,
                  selectedQuantity: 1,
                  itemQuantity: 1,
                  evaluatedAt: input.requestedAt,
                });
                optionPrices.set(option.bindingReference + ":" + option.optionReference, {
                  amount: decimal(found.amount.amountMinor),
                  currency: found.amount.currencyCode,
                });
              } catch (error) {
                // No price or an ambiguous one: shown as unpriced; the Quote refuses it the same way.
                if (!(error instanceof OptionPriceError)) throw error;
              }
            }
          facts.set(sellable, {
            availability:
              resolved.status === "Available" ? "Available" : soldOut ? "SoldOut" : "NotOffered",
            price,
            optionPrices,
            ...(comboChoices.size === 0 ? {} : { comboChoices }),
          });
        }
        // Read last, so a failed stock read cannot disturb the Store's offers and prices above.
        // One observation per shown item in this same read-only transaction (bounded by the
        // evidence source); the cost grows with menu size, not with customers or stock history.
        if (options.inventory !== undefined && input.items !== undefined) {
          let stock: ReadonlyMap<string, unknown> = new Map();
          try {
            stock = await options.inventory.observe(tx as never, {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              observedAt: String(input.requestedAt),
              // Only items otherwise shown as available can become sold out from stock.
              items: input.items.filter(
                (item) => facts.get(item.sellableReference)?.availability === "Available",
              ),
            });
          } catch {
            // Unknown stock never hides or sells out an item; add-to-cart checks stock again.
          }
          for (const [sellable, fact] of facts) {
            const observed = stock.get(sellable);
            if (fact.availability !== "Available" || observed === undefined) continue;
            try {
              // Stock only narrows an offered item. Indeterminate evidence is not passed on: it
              // would make Catalog treat the item as not offered and hide it.
              const evidence = parseAvailabilitySafetyEvidence(observed);
              if (
                evidence.kind === "Inventory" &&
                evidence.status === "Unavailable" &&
                resolveStoreAvailability({
                  brandReference: parseCatalogReference(scope.brandReference),
                  storeReference: parseCatalogReference(scope.storeReference),
                  sellableReference: parseCatalogReference(sellable),
                  channelCode: parseCatalogCode(input.channelCode),
                  orderTypeCode: parseCatalogCode(input.orderTypeCode),
                  at: parseCatalogInstant(input.requestedAt),
                  rules: rules.filter((rule) => rule.sellableReference === sellable),
                  safetyEvidence: [evidence],
                }).status === "Unavailable"
              )
                facts.set(sellable, { ...fact, availability: "SoldOut" });
            } catch {
              // Malformed evidence is unknown stock.
            }
          }
        }
        return facts;
      });
    },
  });
}
