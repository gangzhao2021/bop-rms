import type { CatalogSelectionDisplayQuery, ValidateCatalogSelectionInput } from "@rms/catalog";
import { parseGetPublicStoreRequest, type GetPublicStoreResult } from "@rms/store";
import { readClosedRecord } from "@bop/identity";
import {
  CartError,
  CartParticipationEndedError,
  cartItemUnavailableReason,
  readCartError,
  readCartParticipationEnded,
  type CartParticipationEndedReason,
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
import type { CartAdderStandingPort } from "./ports/cart-item-command-ports.js";
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
    /**
     * WP-2423 (same-table-ordering): a table Cart's rounds sent in the last 15 minutes (newest
     * first; a round still awaiting payment first, whatever its age): the round's number at the
     * table, when, whether this phone paid it, which Cart lines it took and where its payment
     * stands, so another phone can tell "being paid" / "sent" / "not ordered" from "changed".
     * Absent for a pickup Cart, and when it can't be read.
     */
    readonly recentRounds?: readonly CustomerCartRecentRound[];
    /**
     * WP-2423 shared-table-checkout (c): dishes staff took out of this table's cart in the last
     * 15 minutes (newest first), so every phone is told. Absent for a pickup Cart, and when it
     * can't be read.
     */
    readonly staffRemoved?: readonly CustomerCartStaffRemoval[];
    /**
     * WP-2423 shared-table-checkout (a): at a table that pays per round, which dishes the next
     * payer starts with (the Store's setting), whether a phone is paying for dishes it chose, and
     * the dishes waiting for the next round. Absent for a pickup Cart and when not composed.
     */
    readonly tablePay?: CustomerCartTablePay;
  };
}
export interface CustomerCartTablePay {
  readonly defaultChoice: "WholeTable" | "OwnDishes";
  /** A phone is paying for dishes it chose: this phone or another one (never which). */
  readonly payer: null | {
    readonly thisPhone: boolean;
    readonly choice: "Mine" | "Chosen";
    /** When the other phones may take their dishes back unless the payer keeps them. */
    readonly expiresAt: string;
    readonly reserved: boolean;
  };
  /** Dishes set aside for the next round (no reference of who added them, only whether it was
   * this phone). */
  readonly waiting: readonly {
    readonly waitingLineReference: string;
    readonly quantity: number;
    readonly names: Readonly<Record<string, string>>;
    readonly withOptions: boolean;
    readonly mine: boolean;
  }[];
  /** Nobody is paying for the round they wait on: this phone may give them back now. */
  readonly returnable: boolean;
}
/** WP-2423 shared-table-checkout (a): Ordering's scope record, with the Store's setting and the
 * table's checkout hold (fail-closed: a read that fails makes the cart read unavailable). */
export interface CustomerCartTablePayPort {
  read(input: {
    readonly diningSessionReference: string;
    readonly cartReference: string;
    readonly cartVersion: number;
    readonly participantReference: string;
    readonly guestSessionReference: string;
    readonly observedAt: string;
  }): Promise<CustomerCartTablePay>;
}
export interface CustomerCartStaffRemoval {
  readonly removedAt: string;
  readonly quantity: number;
  /** The dish's published name by locale (empty when it is on no current menu). */
  readonly names: Readonly<Record<string, string>>;
}
/** WP-2423 shared-table-checkout (c): Ordering's own record of staff removals at a table. */
export interface CustomerCartStaffRemovalsPort {
  recent(input: {
    readonly diningSessionReference: string;
    readonly observedAt: string;
  }): Promise<readonly CustomerCartStaffRemoval[]>;
}
export interface CustomerCartRecentRound {
  readonly roundNumber: number;
  readonly sentAt: string;
  readonly sentByThisPhone: boolean;
  readonly cartItemReferences: readonly string[];
  /** WP-2423 M38: where the round's payment stands, so no phone calls an unpaid round paid. */
  readonly paymentState: CustomerCartRoundPaymentState;
  /** v15 batch-5: staff entered it for the table and charge it on the card machine. */
  readonly enteredByStaff: boolean;
  /** v15 batch-5: a dish this phone added is in it (true when Ordering does not say). */
  readonly withThisPhoneDishes: boolean;
}
export type CustomerCartRoundPaymentState =
  | "AwaitingPayment"
  | "WaitingForStaff"
  | "Paid"
  | "PayLater"
  | "Cancelled"
  | "StaffDeclined"
  | "StaffCancelled"
  /** WP-2423: charged, but nothing in it could be made; the payment is being refunded. */
  | "PaidNotMade"
  /** WP-2423 M38: its guest stopped before paying; its dishes came back to the cart. */
  | "Returned";
const roundPaymentStates: ReadonlySet<string> = new Set([
  "AwaitingPayment",
  "WaitingForStaff",
  "Paid",
  "PayLater",
  "Cancelled",
  "StaffDeclined",
  "StaffCancelled",
  "PaidNotMade",
  "Returned",
]);
/** WP-2423 (same-table-ordering): Ordering's own rounds sent from a table Cart. */
export interface CustomerCartRecentRoundsPort {
  recent(input: { readonly cartReference: string; readonly observedAt: string }): Promise<
    readonly {
      readonly roundNumber: number;
      readonly sentAt: string;
      readonly guestSessionReference: string;
      /** The table participant who paid it, when Ordering recorded it; else null or absent. */
      readonly participantReference?: string | null;
      readonly cartItemReferences: readonly string[];
      readonly paymentState: CustomerCartRoundPaymentState;
      /** v15 batch-5: absent from an older store (then not entered by staff). */
      readonly enteredByStaff?: boolean;
      /** v15 batch-5: whose phones added its dishes; absent when not read. */
      readonly adderParticipantReferences?: readonly string[];
    }[]
  >;
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
  /**
   * WP-2423 (same-table-ordering): marks another phone's line `ADDER_LEFT_TABLE` when that phone
   * can no longer act at the table, so anyone may remove it. Optional and fail-open (no mark).
   */
  readonly adders?: CartAdderStandingPort;
  readonly rounds?: CustomerCartRecentRoundsPort;
  readonly staffRemovals?: CustomerCartStaffRemovalsPort;
  readonly tablePay?: CustomerCartTablePayPort;
}
type ViewPorts = Omit<CustomerCartViewPorts, "reads"> & {
  readonly adders?: CartAdderStandingPort;
  readonly rounds?: CustomerCartRecentRoundsPort;
  readonly staffRemovals?: CustomerCartStaffRemovalsPort;
  readonly tablePay?: CustomerCartTablePayPort;
  readonly reads: {
    read(input: unknown): Promise<PickupCartReadResult | DiningCartReadResult | null>;
  };
};
const localePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
function tablePayView(value: unknown): CustomerCartTablePay {
  const raw = closed(value, ["defaultChoice", "payer", "waiting", "returnable"]);
  if (
    (raw.defaultChoice !== "WholeTable" && raw.defaultChoice !== "OwnDishes") ||
    typeof raw.returnable !== "boolean" ||
    !Array.isArray(raw.waiting) ||
    raw.waiting.length > 100
  )
    return unavailable();
  let payer: CustomerCartTablePay["payer"] = null;
  if (raw.payer !== null) {
    const found = closed(raw.payer, ["thisPhone", "choice", "expiresAt", "reserved"]);
    if (
      typeof found.thisPhone !== "boolean" ||
      typeof found.reserved !== "boolean" ||
      (found.choice !== "Mine" && found.choice !== "Chosen")
    )
      return unavailable();
    payer = Object.freeze({
      thisPhone: found.thisPhone,
      choice: found.choice,
      expiresAt: parseOrderingInstant(found.expiresAt),
      reserved: found.reserved,
    });
  }
  const waiting = raw.waiting.map((candidate: unknown) => {
    const line = closed(candidate, [
      "waitingLineReference",
      "quantity",
      "names",
      "withOptions",
      "mine",
    ]);
    if (
      typeof line.quantity !== "number" ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 999 ||
      typeof line.withOptions !== "boolean" ||
      typeof line.mine !== "boolean" ||
      line.names === null ||
      typeof line.names !== "object"
    )
      return unavailable();
    return Object.freeze({
      waitingLineReference: String(parseOrderingReference(line.waitingLineReference)),
      quantity: line.quantity,
      names: Object.freeze(
        Object.fromEntries(
          Object.entries(line.names as Readonly<Record<string, unknown>>).filter(
            (entry): entry is [string, string] =>
              localePattern.test(entry[0]) &&
              typeof entry[1] === "string" &&
              entry[1].length > 0 &&
              entry[1].length <= 200,
          ),
        ) as Record<string, string>,
      ),
      withOptions: line.withOptions,
      mine: line.mine,
    });
  });
  return Object.freeze({
    defaultChoice: raw.defaultChoice,
    payer,
    waiting: Object.freeze(waiting),
    returnable: raw.returnable,
  });
}
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
/**
 * WP-2423 (rush-logging-and-entry review): an owner answered that what the cart shows can't be had
 * now (the Store profile, a dish's name). Its answer has no other fields, so reading it as a full
 * answer first logged "ACTOR_SHAPE_INVALID" (12 lines in the 2026-11-13 bursts) instead of what the
 * owner said; the guest's answer is the same "unavailable" as before.
 */
function ownerAnswered(code: "PUBLIC_STORE_UNAVAILABLE" | "CATALOG_DISPLAY_UNAVAILABLE"): never {
  throw Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: new Error(code) });
}
const answerStatus = (value: unknown): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "status")?.value
    : undefined;
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
  "CART_PARTICIPATION_ENDED",
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
      // M126 I.2: why the phone's place at the table ended travels with it.
      let endedReason: CartParticipationEndedReason | null = null;
      const read = async () => {
        try {
          return await ports.reads.read(input);
        } catch (error) {
          const code = readCartError(error)?.code;
          if (code !== undefined && (guestStateCodes as readonly string[]).includes(code))
            authorizationErrorCode = code as GuestStateCode;
          endedReason = readCartParticipationEnded(error);
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
        if (answerStatus(storeResult) !== "Available")
          return ownerAnswered("PUBLIC_STORE_UNAVAILABLE");
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
        // WP-2423 (same-table-ordering): other phones' lines whose phone has left the table.
        const gone = new Set<string>();
        const others = [
          ...new Set(
            cart.items
              .map((item) => item.addedByParticipantReference)
              .filter(
                (participant): participant is NonNullable<typeof participant> =>
                  participant !== null &&
                  first.viewer !== null &&
                  participant !== first.viewer.participantReference,
              )
              .map(String),
          ),
        ];
        if (
          ports.adders !== undefined &&
          others.length > 0 &&
          cart.diningSessionReference !== null
        ) {
          try {
            const standings = await ports.adders.standing({
              diningSessionReference: String(cart.diningSessionReference),
              participantReferences: Object.freeze(others),
              observedAt: first.observedAt,
              // Polled every few seconds by every phone: recorded facts only, never a binding
              // check per phone (the remove command runs the full check).
              check: "Recorded",
            });
            if (Array.isArray(standings))
              for (const standing of standings)
                if (standing.standing === "Gone" && others.includes(standing.participantReference))
                  gone.add(standing.participantReference);
          } catch {
            // Fail-open: no line is marked; the remove command checks again at its own instant.
          }
        }
        // WP-2423 (same-table-ordering): rounds this table Cart sent lately (fail-open: absent).
        let recentRounds: readonly CustomerCartRecentRound[] | undefined;
        if (mode === "DineIn" && ports.rounds !== undefined && first.viewer !== null) {
          try {
            const rounds = await ports.rounds.recent({
              cartReference: cart.cartReference,
              observedAt: first.observedAt,
            });
            if (Array.isArray(rounds) && rounds.length <= 5)
              recentRounds = Object.freeze(
                rounds.map((round) => {
                  if (
                    !Number.isSafeInteger(round.roundNumber) ||
                    round.roundNumber < 1 ||
                    !Array.isArray(round.cartItemReferences) ||
                    !roundPaymentStates.has(round.paymentState)
                  )
                    throw new Error("bad round");
                  return Object.freeze({
                    roundNumber: round.roundNumber,
                    sentAt: parseOrderingInstant(round.sentAt),
                    // The same phone at the table, even on a later session of it; the
                    // session itself only when the participant isn't recorded.
                    sentByThisPhone:
                      round.participantReference !== undefined &&
                      round.participantReference !== null
                        ? parseOrderingReference(round.participantReference) ===
                          first.viewer?.participantReference
                        : parseOrderingReference(round.guestSessionReference) ===
                          first.viewer?.guestSessionReference,
                    cartItemReferences: Object.freeze(
                      round.cartItemReferences.map((reference: string) =>
                        String(parseOrderingReference(reference)),
                      ),
                    ),
                    paymentState: round.paymentState,
                    enteredByStaff: round.enteredByStaff === true,
                    withThisPhoneDishes:
                      round.adderParticipantReferences === undefined
                        ? true
                        : round.adderParticipantReferences.some(
                            (reference: string) =>
                              parseOrderingReference(reference) ===
                              first.viewer?.participantReference,
                          ),
                  });
                }),
              );
          } catch {
            recentRounds = undefined;
          }
        }
        // WP-2423 shared-table-checkout (c): dishes staff took out lately (fail-open: absent).
        let staffRemoved: readonly CustomerCartStaffRemoval[] | undefined;
        if (
          mode === "DineIn" &&
          ports.staffRemovals !== undefined &&
          first.viewer !== null &&
          cart.diningSessionReference !== null
        ) {
          try {
            const removals = await ports.staffRemovals.recent({
              diningSessionReference: String(cart.diningSessionReference),
              observedAt: first.observedAt,
            });
            if (Array.isArray(removals) && removals.length <= 20)
              staffRemoved = Object.freeze(
                removals.map((removal) => {
                  if (
                    !Number.isSafeInteger(removal.quantity) ||
                    removal.quantity < 1 ||
                    removal.names === null ||
                    typeof removal.names !== "object"
                  )
                    throw new Error("bad removal");
                  return Object.freeze({
                    removedAt: parseOrderingInstant(removal.removedAt),
                    quantity: removal.quantity,
                    names: Object.freeze(
                      Object.fromEntries(
                        Object.entries(removal.names as Readonly<Record<string, unknown>>).filter(
                          (entry): entry is [string, string] =>
                            /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(entry[0]) &&
                            typeof entry[1] === "string" &&
                            entry[1].length > 0 &&
                            entry[1].length <= 200,
                        ),
                      ) as Record<string, string>,
                    ),
                  });
                }),
              );
          } catch {
            staffRemoved = undefined;
          }
        }
        // WP-2423 shared-table-checkout (a): who is paying for which dishes (fail-closed).
        let tablePay: CustomerCartTablePay | undefined;
        if (
          mode === "DineIn" &&
          ports.tablePay !== undefined &&
          first.viewer !== null &&
          cart.diningSessionReference !== null
        )
          tablePay = tablePayView(
            await ports.tablePay.read({
              diningSessionReference: String(cart.diningSessionReference),
              cartReference: String(cart.cartReference),
              cartVersion: cart.aggregateVersion,
              participantReference: String(first.viewer.participantReference),
              guestSessionReference: String(first.viewer.guestSessionReference),
              observedAt: first.observedAt,
            }),
          );
        const items = Object.freeze(
          cart.items.map((item, index) => {
            if (answerStatus(descriptions[index]) !== "Found")
              return ownerAnswered("CATALOG_DISPLAY_UNAVAILABLE");
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
                ...(item.addedByParticipantReference !== null &&
                gone.has(String(item.addedByParticipantReference))
                  ? ["ADDER_LEFT_TABLE"]
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
            ...(recentRounds === undefined ? {} : { recentRounds }),
            ...(staffRemoved === undefined ? {} : { staffRemoved }),
            ...(tablePay === undefined ? {} : { tablePay }),
          }),
        });
      } catch (error) {
        if (endedReason !== null) throw new CartParticipationEndedError(endedReason);
        if (authorizationErrorCode !== null) throw new CartError(authorizationErrorCode);
        // Keep what failed, for the log at the edge.
        throw Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: error });
      }
    },
  });
}
