import type { CatalogSelectionDisplayQuery, ValidateCatalogSelectionInput } from "@rms/catalog";
import { parseGetPublicStoreRequest, type GetPublicStoreResult } from "@rms/store";
import { readClosedRecord } from "@bop/identity";
import {
  CartError,
  cartItemUnavailableReason,
  readCartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  isGuestCartChannel,
} from "../domain/cart.js";
import {
  parseAnyCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import type { DiningCartReadResult, DiningCartViewer } from "./dining-cart-read-service.js";
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
    readonly orderType: "Pickup" | "DineIn";
    readonly serviceMode: "Pickup" | "DineIn";
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
    /**
     * WP-2423 M03: the guest's Order these dishes went to, while the pickup Cart is empty after it
     * (so Back from the paid page shows "already ordered", never a payable checkout), or while the
     * Cart still holds dishes already in it (a Cart filled before pickup Carts were emptied on
     * ordering; their checkout is refused). `notMade`: that Order will not be made, so its
     * dishes can be put back or ordered again. Always null for a table's Cart.
     */
    readonly placedOrder: {
      readonly orderReference: string;
      readonly orderNumber: string;
      readonly notMade: boolean;
    } | null;
  };
}
export interface CustomerCartViewPorts {
  readonly reads: { read(input: unknown): Promise<PickupCartReadResult | null> };
  /** WP-2423 (guest-cart-503): marks lines a stable Catalog fact says can't be sold now. */
  readonly availability?: CustomerCartLineStandingPort;
  readonly catalog: Pick<CatalogSelectionDisplayQuery, "describeMany">;
  readonly stores: { getPublicStore(input: unknown): Promise<GetPublicStoreResult> };
  readonly quotes: {
    loadLatest(input: {
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly observedAt: string;
    }): Promise<CartQuoteAttachment<1 | 2> | null>;
  };
}
/**
 * WP-2423 (guest-cart-503): each line's Catalog standing now (Catalog `CatalogLineStanding`), one
 * read-only transaction per cart read. Optional and fail-open: without it, or when it fails, no line
 * is marked and the quote stays the authority.
 */
export interface CustomerCartLineStandingPort {
  explainMany(inputs: readonly ValidateCatalogSelectionInput[]): Promise<readonly unknown[]>;
}
export interface CustomerDiningCartViewPorts {
  readonly reads: { read(input: unknown): Promise<DiningCartReadResult | null> };
  readonly catalog: CustomerCartViewPorts["catalog"];
  readonly stores: CustomerCartViewPorts["stores"];
  readonly availability?: CustomerCartLineStandingPort;
}
type ViewPorts = Omit<CustomerCartViewPorts, "reads"> & {
  readonly reads: {
    read(input: unknown): Promise<PickupCartReadResult | DiningCartReadResult | null>;
  };
};
const viewerFields = [
  "guestSessionReference",
  "guestSessionVersion",
  "participantReference",
  "participantVersion",
  "diningSessionVersion",
  "tableReference",
  "tableAssignmentVersion",
  "publicTableReference",
  "qrReference",
  "qrRevocationVersion",
] as const;
function viewer(value: unknown): DiningCartViewer {
  const raw = closed(value, viewerFields);
  const version = (key: keyof DiningCartViewer) => {
    const n = raw[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return unavailable();
    return n;
  };
  return Object.freeze({
    guestSessionReference: parseOrderingReference(raw.guestSessionReference),
    guestSessionVersion: version("guestSessionVersion"),
    participantReference: parseOrderingReference(raw.participantReference),
    participantVersion: version("participantVersion"),
    diningSessionVersion: version("diningSessionVersion"),
    tableReference: parseOrderingReference(raw.tableReference),
    tableAssignmentVersion: version("tableAssignmentVersion"),
    publicTableReference: parseOrderingReference(raw.publicTableReference),
    qrReference: parseOrderingReference(raw.qrReference),
    qrRevocationVersion: version("qrRevocationVersion"),
  });
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
function snapshot(value: PickupCartReadResult | DiningCartReadResult, mode: "Pickup" | "DineIn") {
  const raw = closed(
    value,
    mode === "DineIn"
      ? ["context", "cart", "effectiveStatus", "observedAt", "viewer"]
      : ["context", "cart", "effectiveStatus", "observedAt", "placedOrder"],
  );
  const currentViewer = mode === "DineIn" ? viewer(raw.viewer) : null;
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
    cart.orderType !== mode ||
    !isGuestCartChannel(cart.orderType, cart.sourceChannel) ||
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
  let placedOrder: CustomerCartDisplayView["cart"]["placedOrder"] = null;
  if (mode === "Pickup" && raw.placedOrder !== null) {
    const placed = closed(raw.placedOrder, ["orderReference", "orderNumber", "notMade"]);
    if (
      typeof placed.notMade !== "boolean" ||
      typeof placed.orderNumber !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(placed.orderNumber)
    )
      return unavailable();
    placedOrder = Object.freeze({
      orderReference: String(parseOrderingReference(placed.orderReference)),
      orderNumber: placed.orderNumber,
      notMade: placed.notMade,
    });
  }
  return { cart, storeRequest, observedAt, effectiveStatus, viewer: currentViewer, placedOrder };
}

export function createCustomerCartViewQuery(ports: CustomerCartViewPorts) {
  return createViewQuery(ports, "Pickup");
}

/** Shared product display; another participant's restricted note is never published. */
export function createCustomerDiningCartViewQuery(ports: CustomerDiningCartViewPorts) {
  return createViewQuery({ ...ports, quotes: { loadLatest: async () => null } }, "DineIn");
}
const displayLocalePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
/**
 * Owner 2026-10-23: the locale a customer read shows item and option names in (the guest's chosen
 * language), or null for the session's own locale. Names missing in it fall back to the menu
 * language, so an item never shows without a name.
 */
export type CustomerDisplayLocale = string | null;
function displayLocale(value: unknown): CustomerDisplayLocale {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !displayLocalePattern.test(value))
    throw new CartError("CART_INPUT_INVALID");
  return value;
}
const guestStateCodes = [
  "CART_PERMISSION_DENIED",
  "CART_INPUT_INVALID",
  "CART_TABLE_CHECKING_OUT",
  "CART_REPLACEMENT_FORBIDDEN",
] as const;
type GuestStateCode = (typeof guestStateCodes)[number];
function createViewQuery(ports: ViewPorts, mode: "Pickup" | "DineIn") {
  return Object.freeze({
    async read(
      input: unknown,
      requestedDisplayLocale?: CustomerDisplayLocale,
    ): Promise<CustomerCartDisplayView | null> {
      const nameLocale = displayLocale(requestedDisplayLocale);
      // WP-2423 (guest-cart-503): what the guest's own state answers is kept as itself (a table
      // checking out, a phone no longer at the table); only a real fault becomes "unavailable".
      let authorizationErrorCode: GuestStateCode | null = null;
      const read = async () => {
        try {
          return await ports.reads.read(input);
        } catch (error) {
          const code = readCartError(error)?.code;
          if (code !== undefined && (guestStateCodes as readonly string[]).includes(code))
            authorizationErrorCode = code as GuestStateCode;
          throw error;
        }
      };
      try {
        const loaded = await read();
        if (loaded === null) return null;
        const first = snapshot(loaded, mode);
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
            locale: nameLocale ?? first.storeRequest.requestedLocale,
          };
        });
        // Sequential: owner ports may share one caller transaction (no concurrent use of a client).
        const storeResult = await ports.stores.getPublicStore(first.storeRequest);
        const descriptions = await ports.catalog.describeMany(requests);
        const quoteResult = await ports.quotes.loadLatest({
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          observedAt: first.observedAt,
        });
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
        // WP-2423 (guest-cart-503): a line a stable Catalog fact says can't be sold now is marked
        // before anyone taps 下单, so it can be removed. A listing in progress marks nothing.
        let marks: readonly (string | null)[] = cart.items.map(() => null);
        if (ports.availability !== undefined && cart.items.length > 0) {
          try {
            const standings = await ports.availability.explainMany(
              cart.items.map((item) => ({
                brandReference: cart.brandReference as never,
                storeReference: cart.storeReference as never,
                sourceChannel: cart.sourceChannel,
                orderType: cart.orderType,
                sellableReference: item.sellableReference as never,
                optionSelections: item.optionSelections as never,
                observedAt: first.observedAt as never,
              })),
            );
            if (Array.isArray(standings) && standings.length === cart.items.length)
              marks = standings.map((standing) => {
                const reason = cartItemUnavailableReason(standing);
                return reason === null
                  ? null
                  : reason === "OptionsChanged"
                    ? "ITEM_OPTIONS_CHANGED"
                    : "ITEM_UNAVAILABLE";
              });
          } catch {
            // Fail-open: the cart is still shown; the quote names the line if it is refused.
          }
        }
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
              customerNote:
                first.viewer !== null &&
                item.addedByParticipantReference !== first.viewer.participantReference
                  ? null
                  : item.customerNote,
              lineEstimate: Object.freeze({
                status: "Unavailable" as const,
                reasonCode: "LINE_ESTIMATE_UNAVAILABLE" as const,
              }),
              warnings: Object.freeze([
                ...(first.viewer !== null &&
                item.addedByParticipantReference !== first.viewer.participantReference
                  ? ["OTHER_PARTICIPANT_ITEM"]
                  : []),
                ...(marks[index] == null ? [] : [marks[index] as string]),
              ]),
            });
          }),
        );
        // WP-2423 Q27: a cart priced with the configured Quote carries a v2 attachment.
        const quote = quoteResult === null ? null : parseAnyCartQuoteAttachment(quoteResult);
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
        const final = snapshot(reloaded, mode);
        if (
          JSON.stringify(cart) !== JSON.stringify(final.cart) ||
          JSON.stringify(first.viewer) !== JSON.stringify(final.viewer) ||
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
            orderType: mode,
            serviceMode: mode,
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
            placedOrder: final.placedOrder,
          }),
        });
      } catch (error) {
        if (authorizationErrorCode !== null) throw new CartError(authorizationErrorCode);
        // Keep what failed, for the log at the edge.
        throw Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: error });
      }
    },
  });
}
