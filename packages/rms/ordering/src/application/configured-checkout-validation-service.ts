import { assertGuestSessionUsable, createGuestSession } from "@bop/identity";
import type { CatalogDishChangeKey, ValidateCatalogSelectionInput } from "@rms/catalog";
import type { ConfiguredPriceQuoteSnapshot, PriceQuoteHistoryReader } from "@rms/pricing";
import { parseCartAggregate, parseOrderingInstant } from "../domain/cart.js";
import { parseOrderCatalogLineSnapshot } from "../domain/order-item-snapshot.js";
import { CheckoutValidationError } from "../domain/checkout-validation.js";
import { bindConfiguredCartQuote } from "./configured-cart-quote-binding.js";
import { createVersionedCheckoutValidationService } from "./checkout-validation-service.js";
import type { CheckoutValidationPorts } from "./ports/checkout-validation-ports.js";

export interface ConfiguredCheckoutValidationPorts extends CheckoutValidationPorts<2> {
  readonly history: PriceQuoteHistoryReader<ConfiguredPriceQuoteSnapshot>;
  readonly snapshots: {
    capture(input: ValidateCatalogSelectionInput): Promise<unknown>;
    /**
     * WP-2423 (DEC-PRICE-HOLD §3): whether a dish found on a newer menu than its price is shown
     * with another name or other allergens. Without it such a dish is priced again.
     */
    dishChanges?(keys: readonly CatalogDishChangeKey[]): Promise<readonly (readonly unknown[])[]>;
  };
  readonly pricingChannelCode: string;
  readonly now: () => string;
}
const unavailable = (): never => {
  throw new CheckoutValidationError("CHECKOUT_DEPENDENCY_UNAVAILABLE");
};
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
/** Complete chosen-option evidence; caller owns current session/CSRF and fulfillment authority. */
async function sameDishesOn(
  ports: Pick<ConfiguredCheckoutValidationPorts, "snapshots">,
  cart: ReturnType<typeof parseCartAggregate>,
  catalogLines: readonly { readonly cartItemReference: string; readonly snapshot: unknown }[],
): Promise<void> {
  const moved: CatalogDishChangeKey[] = [];
  for (const line of catalogLines) {
    const item = cart.items.find((value) => value.cartItemReference === line.cartItemReference);
    const priced = item?.catalogSelectionEvidence;
    if (item === undefined || priced == null || line.snapshot === null) continue;
    let snapshot: ReturnType<typeof parseOrderCatalogLineSnapshot>;
    try {
      snapshot = parseOrderCatalogLineSnapshot(line.snapshot);
    } catch {
      continue;
    }
    if (
      snapshot.productVersionReference === priced.productVersionReference &&
      snapshot.menuVersionReference !== priced.menuVersionReference
    )
      moved.push({
        sellableReference: item.sellableReference,
        productVersionReference: priced.productVersionReference,
        fromMenuVersionReference: priced.menuVersionReference,
        toMenuVersionReference: snapshot.menuVersionReference,
      });
  }
  if (moved.length === 0) return;
  const dishChanges = ports.snapshots.dishChanges;
  if (dishChanges === undefined) throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
  let changes: readonly (readonly unknown[])[];
  try {
    changes = await dishChanges(moved);
  } catch {
    return unavailable();
  }
  if (
    !Array.isArray(changes) ||
    changes.length !== moved.length ||
    changes.some((change) => !Array.isArray(change) || change.length > 0)
  )
    throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
}
export function createConfiguredCheckoutValidationService(
  ports: ConfiguredCheckoutValidationPorts,
) {
  const assertSameDishes = (
    cart: ReturnType<typeof parseCartAggregate>,
    catalogLines: readonly { readonly cartItemReference: string; readonly snapshot: unknown }[],
  ) => sameDishesOn(ports, cart, catalogLines);
  return Object.freeze({
    async validate(input: unknown) {
      let last: string | undefined;
      const now = () => {
        const value = parseOrderingInstant(ports.now());
        if (last !== undefined && value < last) return unavailable();
        last = value;
        return value;
      };
      const authorizations: unknown[] = [];
      let originalCart: ReturnType<typeof parseCartAggregate> | undefined;
      const guarded = {
        ...ports,
        authorization: {
          authorize: async (
            request: Parameters<ConfiguredCheckoutValidationPorts["authorization"]["authorize"]>[0],
          ) => {
            const authorized = await ports.authorization.authorize(request);
            if (authorized !== null) authorizations.push(structuredClone(authorized.guestSession));
            return authorized;
          },
        },
      };
      const core = createVersionedCheckoutValidationService(
        guarded,
        2,
        async (cart, attached, at) => {
          originalCart = cart;
          if (now() < at) return unavailable();
          const quote = await ports.history.load(attached.quoteReference);
          if (quote === null) return unavailable();
          const catalogLines = [];
          for (const item of cart.items) {
            const observedAt = now();
            catalogLines.push({
              cartItemReference: item.cartItemReference,
              snapshot: await ports.snapshots.capture({
                brandReference: cart.brandReference as never,
                storeReference: cart.storeReference as never,
                sourceChannel: cart.sourceChannel,
                orderType: cart.orderType,
                sellableReference: item.sellableReference as never,
                optionSelections: item.optionSelections as never,
                observedAt: observedAt as never,
              }),
            });
          }
          // WP-2423 (DEC-PRICE-HOLD §3, price-hold-dish-changes): inside the hold a dish found
          // on a newer menu keeps its price only when the guest is told the same name and the
          // same allergens; otherwise checkout asks for a new price and the guest sees the dish
          // as it is now (allergen safety before the confirmed price).
          await assertSameDishes(cart, catalogLines);
          const checked = bindConfiguredCartQuote({
            cart,
            quote,
            catalogLines,
            pricingChannelCode: ports.pricingChannelCode,
            observedAt: now(),
          });
          if (
            String(checked.quoteReference) !== attached.quoteReference ||
            checked.quoteVersion !== attached.quoteVersion ||
            String(checked.inputDigest) !== attached.quoteInputDigest ||
            checked.createdAt !== attached.quoteCreatedAt ||
            checked.expiresAt !== attached.quoteExpiresAt
          )
            return unavailable();
          for (const key of ["subtotal", "discount", "tax", "fee", "total"] as const)
            if (json(checked[key]) !== json(attached[key])) return unavailable();
        },
      );
      try {
        const evidence = await core.validate(input);
        const observedAt = now();
        const current = await ports.authorization.authorize({
          action: "ValidateCheckout",
          cartReference: evidence.cartReference,
          validationReference: evidence.validationReference,
          observedAt,
        });
        if (current === null || authorizations.length !== 1)
          throw new CheckoutValidationError("CHECKOUT_PERMISSION_DENIED");
        const original = assertGuestSessionUsable(
          createGuestSession(authorizations[0] as never),
          observedAt,
        );
        const session = assertGuestSessionUsable(
          createGuestSession(current.guestSession),
          observedAt,
        );
        const identity = (value: typeof session) =>
          json(
            Object.fromEntries(
              Object.entries(value).filter(
                ([key]) => key !== "lastSeenAt" && key !== "idleExpiresAt",
              ),
            ),
          );
        if (identity(original) !== identity(session))
          throw new CheckoutValidationError("CHECKOUT_PERMISSION_DENIED");
        const currentCart = await ports.repository.loadCart(evidence.cartReference);
        if (currentCart === null || json(parseCartAggregate(currentCart)) !== json(originalCart))
          return unavailable();
        const finalAuthorization = await ports.authorization.authorize({
          action: "ValidateCheckout",
          cartReference: evidence.cartReference,
          validationReference: evidence.validationReference,
          observedAt: now(),
        });
        const finished = now();
        if (
          finalAuthorization === null ||
          identity(
            assertGuestSessionUsable(createGuestSession(finalAuthorization.guestSession), finished),
          ) !== identity(original)
        )
          throw new CheckoutValidationError("CHECKOUT_PERMISSION_DENIED");
        if (finished >= evidence.validUntil) return unavailable();
        return evidence;
      } catch (error) {
        if (error instanceof CheckoutValidationError) throw error;
        return unavailable();
      }
    },
  });
}
