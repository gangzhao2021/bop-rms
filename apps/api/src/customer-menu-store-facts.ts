import {
  listStoreAvailabilityRules,
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

/**
 * WP-2423 8.6: what the customer menu shows for each item at the Store — whether the Store offers
 * it, whether it is sold out, and its current base price from the Store's assigned price book (the
 * same book, channel and order type the Quote prices from). WP-2423 slice 4.5: and what one of each
 * published option adds, from the current option prices the Quote uses. Tax is added in the Quote.
 */
export function createCustomerMenuStoreFacts(options: {
  /** A read-only transaction the caller owns and releases. */
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  /** The pricing channel the Quote uses for this customer channel. */
  readonly priceChannelCode: string;
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
          });
        }
        return facts;
      });
    },
  });
}
