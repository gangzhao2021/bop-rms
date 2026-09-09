import type { CatalogSelectionDisplayQuery } from "@rms/catalog";
import { parseGetPublicStoreRequest, type GetPublicStoreResult } from "@rms/store";
import { readClosedRecord } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import type { PickupCartReadResult } from "./pickup-cart-read-service.js";

export interface CustomerCartDisplayMoney {
  readonly amountMinor: string;
  readonly currency: string;
}
export interface CustomerCartDisplayView {
  readonly schemaVersion: 1;
  readonly cart: {
    readonly cartReference: string;
    readonly version: number;
    readonly orderType: "Pickup";
    readonly serviceMode: "Pickup";
    readonly context: { readonly brandName: string; readonly storeName: string };
    readonly lifecycle: {
      readonly status: "Active" | "Abandoned" | "Expired";
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    };
    readonly items: readonly {
      readonly cartItemReference: string;
      readonly sellableReference: string;
      readonly displayName: string;
      readonly quantity: number;
      readonly configuration: readonly {
        readonly optionReference: string;
        readonly displayName: string;
        readonly quantity: number;
      }[];
      readonly customerNote: string | null;
      readonly lineEstimate: {
        readonly status: "Unavailable";
        readonly reasonCode: "LINE_ESTIMATE_UNAVAILABLE";
      };
      readonly warnings: readonly string[];
    }[];
    readonly quote: null | {
      readonly quoteReference: string;
      readonly quoteVersion: number;
      readonly cartVersion: number;
      readonly subtotal: CustomerCartDisplayMoney;
      readonly discount: CustomerCartDisplayMoney;
      readonly tax: CustomerCartDisplayMoney;
      readonly fee: CustomerCartDisplayMoney;
      readonly total: CustomerCartDisplayMoney;
      readonly expiresAt: string;
      readonly warnings: readonly string[];
      readonly blockingReasons: readonly string[];
    };
    readonly warnings: readonly string[];
  };
}
export interface CustomerCartViewPorts {
  readonly reads: { read(input: unknown): Promise<PickupCartReadResult | null> };
  readonly catalog: Pick<CatalogSelectionDisplayQuery, "describeMany">;
  readonly stores: { getPublicStore(input: unknown): Promise<GetPublicStoreResult> };
  readonly quotes: {
    loadLatest(input: {
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly observedAt: string;
    }): Promise<CartQuoteAttachment | null>;
  };
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, keys: readonly string[]) {
  return readClosedRecord(value, keys, "ACTOR_SHAPE_INVALID");
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200)
    return unavailable();
  return value.normalize("NFC").trim();
}
function snapshot(value: PickupCartReadResult) {
  const raw = closed(value, ["context", "cart", "effectiveStatus", "observedAt"]);
  const context = closed(raw.context, ["publicStoreReference", "locale"]);
  const observedAt = parseOrderingInstant(raw.observedAt);
  const storeRequest = parseGetPublicStoreRequest({
    publicStoreReference: context.publicStoreReference,
    requestedLocale: context.locale,
    evaluatedAt: observedAt,
    purpose: "CustomerCart",
  });
  const cart = parseCartAggregate(raw.cart);
  if (
    cart.orderType !== "Pickup" ||
    !["Qr", "Web"].includes(cart.sourceChannel) ||
    cart.lifecycle === null ||
    cart.aggregateVersion > 999_999_999 ||
    cart.updatedAt > observedAt
  )
    return unavailable();
  const effectiveStatus =
    cart.lifecycle.status === "Active" &&
    (observedAt >= cart.lifecycle.idleExpiresAt || observedAt >= cart.lifecycle.absoluteExpiresAt)
      ? "Expired"
      : cart.lifecycle.status;
  if (raw.effectiveStatus !== effectiveStatus) return unavailable();
  return { cart, storeRequest, observedAt, effectiveStatus };
}

export function createCustomerCartViewQuery(ports: CustomerCartViewPorts) {
  return Object.freeze({
    async read(input: unknown): Promise<CustomerCartDisplayView | null> {
      let authorizationErrorCode: "CART_PERMISSION_DENIED" | "CART_INPUT_INVALID" | null = null;
      const read = async () => {
        try {
          return await ports.reads.read(input);
        } catch (error) {
          if (
            error instanceof CartError &&
            (error.code === "CART_PERMISSION_DENIED" || error.code === "CART_INPUT_INVALID")
          )
            authorizationErrorCode = error.code;
          throw error;
        }
      };
      try {
        const loaded = await read();
        if (loaded === null) return null;
        const first = snapshot(loaded);
        const cart = first.cart;
        const requests = cart.items.map((item) => {
          const evidence = item.catalogSelectionEvidence;
          if (evidence === null) return unavailable();
          return {
            brandReference: cart.brandReference,
            storeReference: cart.storeReference,
            menuVersionReference: evidence.menuVersionReference,
            productVersionReference: evidence.productVersionReference,
            sellableReference: item.sellableReference,
            channelCode: evidence.catalogChannelCode,
            orderTypeCode: evidence.catalogOrderTypeCode,
            ruleEvidence: evidence.ruleEvidence,
            optionReferences: item.optionSelections.map((option) => option.optionReference),
            locale: first.storeRequest.requestedLocale,
          };
        });
        const [storeResult, descriptions, quoteResult] = await Promise.all([
          ports.stores.getPublicStore(first.storeRequest),
          ports.catalog.describeMany(requests),
          ports.quotes.loadLatest({
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            observedAt: first.observedAt,
          }),
        ]);
        const store = closed(storeResult, ["status", "profile"]);
        if (store.status !== "Available") return unavailable();
        const profile = closed(store.profile, [
          "profileReference",
          "profileVersion",
          "releaseReference",
          "contentDigest",
          "defaultLocale",
          "selectedLocale",
          "currencyCode",
          "timeZone",
          "brandDisplayName",
          "storeDisplayName",
          "address",
          "businessPhone",
          "website",
          "logoAssetVersionReference",
        ]);
        if (profile.currencyCode !== "CAD") return unavailable();
        const context = Object.freeze({
          brandName: text(profile.brandDisplayName),
          storeName: text(profile.storeDisplayName),
        });
        if (!Array.isArray(descriptions) || descriptions.length !== cart.items.length)
          return unavailable();
        const items = Object.freeze(
          cart.items.map((item, index) => {
            const description = closed(descriptions[index], [
              "status",
              "menuVersionReference",
              "productVersionReference",
              "sellableReference",
              "displayName",
              "options",
            ]);
            if (
              description.status !== "Found" ||
              description.menuVersionReference !==
                item.catalogSelectionEvidence?.menuVersionReference ||
              description.productVersionReference !==
                item.catalogSelectionEvidence?.productVersionReference ||
              description.sellableReference !== item.sellableReference ||
              !Array.isArray(description.options) ||
              description.options.length !== item.optionSelections.length
            )
              return unavailable();
            const options = new Map<string, string>();
            for (const value of description.options) {
              const option = closed(value, ["optionReference", "displayName"]);
              const reference = parseOrderingReference(option.optionReference);
              if (options.has(reference)) return unavailable();
              options.set(reference, text(option.displayName));
            }
            const configuration = Object.freeze(
              item.optionSelections.map((option) => {
                const displayName = options.get(option.optionReference);
                if (displayName === undefined) return unavailable();
                return Object.freeze({ ...option, displayName });
              }),
            );
            return Object.freeze({
              cartItemReference: item.cartItemReference,
              sellableReference: item.sellableReference,
              displayName: text(description.displayName),
              quantity: item.quantity,
              configuration,
              customerNote: item.customerNote,
              lineEstimate: Object.freeze({
                status: "Unavailable" as const,
                reasonCode: "LINE_ESTIMATE_UNAVAILABLE" as const,
              }),
              warnings: Object.freeze([] as string[]),
            });
          }),
        );
        const quote = quoteResult === null ? null : parseCartQuoteAttachment(quoteResult);
        if (
          quote !== null &&
          (quote.brandReference !== cart.brandReference ||
            quote.storeReference !== cart.storeReference ||
            quote.cartReference !== cart.cartReference ||
            quote.cartVersion !== cart.aggregateVersion ||
            quote.guestSessionReference !== cart.createdByActorReference ||
            quote.currencyCode !== profile.currencyCode ||
            quote.attachedAt > first.observedAt ||
            quote.lines.length !== cart.items.length ||
            !quote.lines.every((line) =>
              cart.items.some(
                (item) =>
                  item.cartItemReference === line.lineReference &&
                  item.sellableReference === line.sellableReference &&
                  item.quantity === line.quantity &&
                  item.catalogSelectionEvidence?.menuVersionReference ===
                    line.menuVersionReference &&
                  item.catalogSelectionEvidence?.productVersionReference ===
                    line.productVersionReference,
              ),
            ))
        )
          return unavailable();
        const reloaded = await read();
        if (reloaded === null) return unavailable();
        const final = snapshot(reloaded);
        if (
          JSON.stringify(cart) !== JSON.stringify(final.cart) ||
          first.storeRequest.publicStoreReference !== final.storeRequest.publicStoreReference ||
          first.storeRequest.requestedLocale !== final.storeRequest.requestedLocale ||
          final.observedAt < first.observedAt
        )
          return unavailable();
        const lifecycle = final.cart.lifecycle;
        if (lifecycle === null) return unavailable();
        const money = (value: { amountMinor: bigint; currencyCode: string }) =>
          Object.freeze({
            amountMinor: value.amountMinor.toString(),
            currency: value.currencyCode,
          });
        return Object.freeze({
          schemaVersion: 1,
          cart: Object.freeze({
            cartReference: cart.cartReference,
            version: cart.aggregateVersion,
            orderType: "Pickup",
            serviceMode: "Pickup",
            context,
            lifecycle: Object.freeze({
              status: final.effectiveStatus,
              idleExpiresAt: lifecycle.idleExpiresAt,
              absoluteExpiresAt: lifecycle.absoluteExpiresAt,
            }),
            items,
            quote:
              quote === null
                ? null
                : Object.freeze({
                    quoteReference: quote.quoteReference,
                    quoteVersion: quote.quoteVersion,
                    cartVersion: quote.cartVersion,
                    subtotal: money(quote.subtotal),
                    discount: money(quote.discount),
                    tax: money(quote.tax),
                    fee: money(quote.fee),
                    total: money(quote.total),
                    expiresAt: quote.quoteExpiresAt,
                    warnings: quote.warnings,
                    blockingReasons: Object.freeze(
                      final.observedAt >= quote.quoteExpiresAt ? ["QUOTE_EXPIRED"] : [],
                    ),
                  }),
            warnings: Object.freeze([] as string[]),
          }),
        });
      } catch {
        if (authorizationErrorCode !== null) throw new CartError(authorizationErrorCode);
        return unavailable();
      }
    },
  });
}
