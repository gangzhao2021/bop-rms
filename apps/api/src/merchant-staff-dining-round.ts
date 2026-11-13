import { createHash } from "node:crypto";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningCheckoutHoldSource,
  createPostgresDiningTableStore,
  listDiningSessionTableLabels,
  parseDiningReference,
} from "@rms/dining";
import { listStoreMenuSellableNames } from "@rms/catalog";
import {
  createPostgresAdditionalDiningExecutionReader,
  createPostgresStaffDiningRoundEntryStore,
  parseCustomerNote,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  StaffDiningRoundEntryError,
  CartError,
  listStoreDiningBatchPaymentDeadlines,
  readStaffDiningCart,
  removeStaffDiningCartLines,
  type StaffCartRemovalReason,
  type OrderPaymentPreparationEvidence,
  type StaffDiningRoundEntryRecord,
} from "@rms/ordering";
import type { Money } from "@rms/pricing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { readStoreTipChoices, tipRefusal } from "./merchant-store-features.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  counterOrderPermission,
  counterTipMinor,
  parseCounterOrderCommand,
  addedCartLine,
  checkoutRefusalLineIndex,
  type CounterCartLine,
  type CounterGuestCredentials,
  type CounterGuestPipeline,
  type CounterOrderLine,
  type CounterTipChoice,
} from "./merchant-counter-order.js";
import type { DiningPayLaterRound } from "./dining-pay-later-round.js";
import { createPostgresCardMachinePaymentStore } from "@rms/payment";
import { readStaffDiningRoundPaymentPreparation } from "./staff-dining-round-payment-preparation.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";
import { staffContentLocale } from "./staff-content-locale.js";
import { staffCartReasonCode } from "./merchant-dining-table-cart.js";

/**
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): entering a round for a table on behalf of its
 * guests is the staff ordering permission (Owner, Store Manager, Front of House); opening the
 * table's dining session or a fresh table code for it is the table operation they also hold.
 */
export const staffDiningRoundPermission = counterOrderPermission;
export const staffDiningRoundTablePermission = "dining.operate" as const;

export const staffDiningRoundErrorCodes = [
  "STAFF_ROUND_INPUT_INVALID",
  "STAFF_ROUND_PERMISSION_DENIED",
  "STAFF_ROUND_STORE_NOT_TAKING_ORDERS",
  "STAFF_ROUND_TABLE_UNAVAILABLE",
  /**
   * WP-2423 (v15 staff-round-speed): the round was taken for the party seated when staff started
   * it, and that party has left (the table was closed, or another party is seated now). Nothing
   * is sent; staff check with the guests at the table before sending it for them.
   */
  "STAFF_ROUND_TABLE_PARTY_CHANGED",
  "STAFF_ROUND_TABLE_QR_MISSING",
  "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
  "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS",
  "STAFF_ROUND_ITEM_UNAVAILABLE",
  /** WP-2423: the Store's stock can't make the round as entered (which item, how many left). */
  "STAFF_ROUND_STOCK_SHORT",
  "STAFF_ROUND_NOT_PRICED",
  "STAFF_ROUND_NOT_FINISHED",
  "STAFF_ROUND_IN_PROGRESS",
  /**
   * DEC-PAPER-SEND-IDEMPOTENT: the same round sent again after its first send placed it, once it
   * neither waits for payment nor was paid (its time to pay ended and it was taken off): named by
   * its order and table, nothing new sent or charged.
   */
  "STAFF_ROUND_ALREADY_SENT",
  "STAFF_ROUND_IDEMPOTENCY_CONFLICT",
  /** WP-2423 item 8 ⑦ (Owner decision 11): the Store turned tips off; send it with no tip. */
  "STAFF_ROUND_TIPS_OFF",
  /** The tip percentage is not one the Store offers now: read the choices again. */
  "STAFF_ROUND_TIP_CHOICES_CHANGED",
  /**
   * WP-2423 item 13 ②: the platform paused this merchant's new guests, so a free table is not
   * seated; rounds for tables already seated carry on.
   */
  "STAFF_ROUND_NEW_GUESTS_PAUSED",
  "STAFF_ROUND_UNAVAILABLE",
] as const;
export type StaffDiningRoundErrorCode = (typeof staffDiningRoundErrorCodes)[number];

/**
 * WP-2423 (staff-round-soldout): whether an item guests left in the table's shared Cart can be
 * sent now. `Unavailable`: sold out, off the menu or its setup incomplete; `OptionsChanged`: the
 * dish is sold but its chosen options no longer fit (both: the Ordering owner lets anyone at the
 * table remove it). `Short`: the stock can't make that many (`available` left, 0 or more); only the
 * guests lower or remove it.
 */
export type StaffRoundPendingStanding = "Available" | "Unavailable" | "OptionsChanged" | "Short";
export interface StaffRoundPendingItem {
  readonly cartItemReference: string;
  readonly name: string;
  readonly quantity: number;
  readonly standing: StaffRoundPendingStanding;
  /** For `Short`: how many the Store's stock covers now. */
  readonly available?: number;
}
/** At most this many of the guests' unsellable items are removed with one round. */
export const staffRoundRemovableLimit = 30;
/** At most this many guest lines are decided on with one round (a table cart holds fewer). */
export const staffRoundTableCartLimit = 100;
const removalReasons: readonly unknown[] = ["GuestAsked", "GuestLeft", "CantMake"];

/**
 * WP-2423 M35 (shared-table-cart-staff-round): what staff decided for one of the guests' unsent
 * lines they were shown: send it with this round, or take it out of the table's cart (recorded as
 * theirs, with why: the guest asked, the guest left, the kitchen can't make it).
 */
export interface StaffRoundTableCartDecision {
  readonly cartItemReference: string;
  readonly decision: "Send" | "Remove";
  readonly reason: StaffCartRemovalReason | null;
}
/**
 * The guests' unsent lines staff take in, as they saw them (that cart version). `decisions`: one
 * per line (M35); null for the earlier form, where every line is sent but `removeUnavailable`.
 */
export interface StaffRoundTableCartChoice {
  readonly expectedCartVersion: number;
  readonly removeUnavailable: readonly string[];
  readonly decisions: readonly StaffRoundTableCartDecision[] | null;
}

export class StaffDiningRoundError extends Error {
  readonly code: StaffDiningRoundErrorCode;
  /** For STAFF_ROUND_ITEM_UNAVAILABLE: the zero-based line the store cannot sell now. */
  readonly lineIndex: number | null;
  /** For STAFF_ROUND_TABLE_CART_HAS_ITEMS: what guests put in the table's Cart, and its standing. */
  readonly pendingItems: readonly StaffRoundPendingItem[];
  /** WP-2423: for STAFF_ROUND_STOCK_SHORT, how many of the item the stock covers now (1 or more). */
  readonly available: number | null;
  /** WP-2423: the item is short only because other items in the round use the same stock. */
  readonly sharedStock: boolean;
  /**
   * WP-2423 item 8 ⑦ (v15 finding t): for STAFF_ROUND_TABLE_CART_HAS_ITEMS, the version of the
   * table's Cart those items are in (staff add them to the round against it) and whether guests
   * can still send them themselves (not after last orders).
   */
  tableCart: { readonly cartVersion: number; readonly guestsCanSend: boolean } | null = null;
  /**
   * WP-2423 (staff-round-soldout): for STAFF_ROUND_ITEM_UNAVAILABLE, the dish is sold but the
   * options chosen for it no longer fit the menu.
   */
  optionsChanged = false;
  /**
   * DEC-PAPER-SEND-IDEMPOTENT: for STAFF_ROUND_ALREADY_SENT (and the NOT_FINISHED it starts as),
   * the Store's number of the table's order holding the round, and the table, when known.
   */
  placedOrderNumber: string | null = null;
  placedTableLabel: string | null = null;
  constructor(
    code: StaffDiningRoundErrorCode,
    lineIndex: number | null = null,
    pendingItems: readonly StaffRoundPendingItem[] = [],
    stock: { readonly available: number | null; readonly sharedStock: boolean } = {
      available: null,
      sharedStock: false,
    },
  ) {
    super("staff dining round is unavailable");
    this.name = "StaffDiningRoundError";
    this.code = code;
    this.lineIndex = lineIndex;
    this.pendingItems = pendingItems;
    this.available = stock.available;
    this.sharedStock = stock.sharedStock;
  }
}
const fail = (
  code: StaffDiningRoundErrorCode,
  lineIndex: number | null = null,
  pendingItems: readonly StaffRoundPendingItem[] = [],
  stock?: { readonly available: number | null; readonly sharedStock: boolean },
): never => {
  throw new StaffDiningRoundError(code, lineIndex, pendingItems, stock);
};

export interface StaffDiningRoundLine extends CounterOrderLine {
  /** The guest's note for the kitchen ("no onions"), or null. */
  readonly note: string | null;
}

/**
 * The table guest path, composed from the same owner services the customer app uses (table entry,
 * join with a one-time table code, the table's shared Cart, menu and sold-out checks, quote with
 * tax, checkout, submission of the first or a later round, tip and payment clock). Credentials
 * live only in this request's memory and are never returned or logged.
 */
export interface StaffTableGuestPipeline extends Pick<
  CounterGuestPipeline,
  "addItem" | "quote" | "saveDetails" | "startCheckout"
> {
  /** Whether the table has a code to enter with (nothing is opened for one that doesn't). */
  tableHasQr(input: { readonly tableReference: string }): Promise<boolean>;
  /** Whether the Store takes a dine-in round now (paper rounds after an outage: always). */
  takesOrder(input: { readonly recordedAfterOutage: boolean }): Promise<boolean>;
  /** WP-2423 item 8 ⑦: whether guests can still send a round themselves (not after last orders). */
  guestsCanSend?(): Promise<boolean>;
  /**
   * Starts the table's dining session, or issues a fresh one-time table code for its current
   * session, under this staff member's table authority (Dining owner commands).
   * `expectedDiningSessionReference`: the party the round was taken for; another (or none) is
   * `PartyChanged`, with nothing started or issued.
   */
  openTable(
    staff: { readonly sessionCookie: unknown; readonly csrf: unknown },
    input: {
      readonly tableReference: string;
      readonly expectedDiningSessionReference?: string;
    },
  ): Promise<
    | {
        readonly status: "Opened";
        readonly diningSessionReference: string;
        readonly joinCredential: string;
        /** True when this call started the table's dining session (the table was free). */
        readonly started: boolean;
        /** The issued code's generation (a later code for the table has a higher one). */
        readonly generation: number | null;
      }
    | { readonly status: "TableUnavailable" }
    /** WP-2423 item 13 ②: the table is free and the platform paused new guests. */
    | { readonly status: "NewGuestsPaused" }
    | { readonly status: "PartyChanged" }
  >;
  /**
   * WP-2423 item 7: closes a dining session this request started when the round failed before
   * anything was ordered, with the existing Dining closing commands (Begin, then Finalize, which
   * releases the table) under the staff member's own authority. `Kept`: the session changed since
   * (another code was issued for the table) or the staff member can't close sessions; it stays
   * open and the next round sent for the table uses it.
   */
  abandonTable(
    staff: { readonly sessionCookie: unknown; readonly csrf: unknown },
    input: {
      readonly tableReference: string;
      readonly diningSessionReference: string;
      readonly generation: number | null;
    },
  ): Promise<"Closed" | "Kept">;
  /**
   * Enters with the table's printed QR, as a guest scanning it would. `NoTableQr`: the table has
   * no current code (never created, or turned off), so no guest can join it this way.
   */
  enter(input: {
    readonly tableReference: string;
    readonly requestedAt: string;
  }): Promise<
    | { readonly status: "Established"; readonly credentials: CounterGuestCredentials }
    | { readonly status: "NotAccepting" }
    | { readonly status: "NoTableQr" }
  >;
  join(
    credentials: CounterGuestCredentials,
    input: { readonly joinCredential: string; readonly operationReference: string },
  ): Promise<{ readonly admissionReference: string }>;
  bind(
    credentials: CounterGuestCredentials,
    input: { readonly operationReference: string; readonly admissionReference: string },
  ): Promise<{
    readonly credentials: CounterGuestCredentials;
    readonly guestSessionReference: string;
  }>;
  /** Selects (or creates) the table's shared Cart. */
  selectCart(
    credentials: CounterGuestCredentials,
    input: { readonly operationReference: string; readonly requestedAt: string },
  ): Promise<
    | {
        readonly status: "Selected";
        readonly cartReference: string;
        readonly cartVersion: number;
        /** WP-2423 (staff-round-soldout): the Cart's unsent lines and whether each can be sold now. */
        readonly pendingItems: readonly StaffRoundPendingItem[];
      }
    | { readonly status: "CheckoutInProgress" }
  >;
  /**
   * WP-2423: takes this round's items back out of the table's shared Cart when its checkout was
   * refused (short stock), so guests' Cart is as it was and staff can send the round again.
   * `Kept`: the Cart changed meanwhile (a guest edited it); it is left as it is.
   */
  removeItems?(
    credentials: CounterGuestCredentials,
    input: {
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly cartItemReferences: readonly string[];
    },
  ): Promise<"Removed" | "Kept">;
  /**
   * DEC-DINE-IN-PAY-LATER: submits a round of a table opened pay later — no tip, no payment clock;
   * the round then goes to the kitchen. Absent where pay-later is not composed.
   */
  submitPayLater?(
    credentials: CounterGuestCredentials,
    input: {
      readonly checkoutSessionReference: string;
      readonly selectionReference: string;
      readonly recordedAfterOutage: boolean;
    },
  ): Promise<{
    readonly submissionReference: string;
    readonly kind: "Initial" | "Additional";
    readonly guestSessionReference: string;
  }>;
  /** Submits the round, records the tip choice and starts the payment clock (no Provider). */
  preparePayment(
    credentials: CounterGuestCredentials,
    input: {
      readonly checkoutSessionReference: string;
      readonly selectionReference: string;
      readonly tip: Money;
      readonly recordedAfterOutage: boolean;
    },
  ): Promise<OrderPaymentPreparationEvidence>;
}

export interface StaffDiningRoundResult {
  readonly status: "Placed" | "AlreadyPlaced";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderNumber: string;
  readonly orderVersion: number;
  readonly tableLabel: string | null;
  /** Round total from the quote, tax included. */
  readonly orderMinor: string;
  readonly tipMinor: string;
  /** What staff charge on the card machine (pay later: what the round adds to the table's bill). */
  readonly totalMinor: string;
  /**
   * The card-machine payment must be recorded before then; null when the table pays later
   * (DEC-DINE-IN-PAY-LATER): the round went to the kitchen and the table pays once at the end.
   */
  readonly payBy: string | null;
  readonly payLater: boolean;
  readonly recordedAfterOutage: boolean;
  /**
   * DEC-PAPER-SEND-IDEMPOTENT: present (true) when the round sent again is already paid (its
   * payment record holds it): staff are never asked to charge it again.
   */
  readonly paid?: true;
}

export function parseStaffDiningRoundCommand(value: unknown): {
  readonly operationReference: string;
  readonly tableReference: string;
  readonly lines: readonly StaffDiningRoundLine[];
  readonly tip: CounterTipChoice;
  readonly recordedAfterOutage: boolean;
  /**
   * WP-2423 item 8 ⑦ (v15 finding t): add the items guests left unsent in the table's Cart to
   * this round, as staff saw them (that Cart version); null: the round is only its own lines.
   * WP-2423 (staff-round-soldout): `removeUnavailable` are the guests' lines staff saw marked as
   * not sellable now, taken out of the Cart first (the Ordering owner decides at that instant).
   */
  readonly includeTableCart: StaffRoundTableCartChoice | null;
  /**
   * WP-2423 (v15 staff-round-speed): the table's dining session (its party) when staff started
   * taking this round; null when the table was free then (or the screen predates this).
   */
  readonly expectedDiningSessionReference: string | null;
} {
  try {
    const includes =
      value !== null && typeof value === "object" && Object.hasOwn(value, "includeTableCart");
    const forParty =
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "expectedDiningSessionReference");
    const raw = readClosedRecord(value, [
      "operationReference",
      "tableReference",
      "lines",
      "tip",
      "recordedAfterOutage",
      ...(includes ? ["includeTableCart"] : []),
      ...(forParty ? ["expectedDiningSessionReference"] : []),
    ]);
    const expectedDiningSessionReference =
      !forParty || raw.expectedDiningSessionReference === null
        ? null
        : String(parseOrderingReference(raw.expectedDiningSessionReference));
    let includeTableCart: StaffRoundTableCartChoice | null = null;
    if (includes) {
      const has = (key: string) =>
        raw.includeTableCart !== null &&
        typeof raw.includeTableCart === "object" &&
        Object.hasOwn(raw.includeTableCart, key);
      const removes = has("removeUnavailable");
      const decides = has("lines");
      // One form or the other: per-line decisions, or (earlier screens) the unsellable lines only.
      if (removes && decides) return fail("STAFF_ROUND_INPUT_INVALID");
      const include = readClosedRecord(raw.includeTableCart, [
        "expectedCartVersion",
        ...(removes ? ["removeUnavailable"] : []),
        ...(decides ? ["lines"] : []),
      ]);
      const expectedCartVersion = include.expectedCartVersion;
      if (
        typeof expectedCartVersion !== "number" ||
        !Number.isSafeInteger(expectedCartVersion) ||
        expectedCartVersion < 1
      )
        return fail("STAFF_ROUND_INPUT_INVALID");
      const listed = removes ? include.removeUnavailable : [];
      if (!Array.isArray(listed) || listed.length > staffRoundRemovableLimit)
        return fail("STAFF_ROUND_INPUT_INVALID");
      const removeUnavailable = listed.map((value: unknown) =>
        String(parseOrderingReference(value)),
      );
      if (new Set(removeUnavailable).size !== removeUnavailable.length)
        return fail("STAFF_ROUND_INPUT_INVALID");
      let decisions: readonly StaffRoundTableCartDecision[] | null = null;
      if (decides) {
        const given = include.lines;
        if (!Array.isArray(given) || given.length === 0 || given.length > staffRoundTableCartLimit)
          return fail("STAFF_ROUND_INPUT_INVALID");
        decisions = Object.freeze(
          given.map((entry: unknown) => {
            const withReason =
              entry !== null && typeof entry === "object" && Object.hasOwn(entry, "reason");
            const line = readClosedRecord(entry, [
              "cartItemReference",
              "decision",
              ...(withReason ? ["reason"] : []),
            ]);
            if (line.decision !== "Send" && line.decision !== "Remove")
              return fail("STAFF_ROUND_INPUT_INVALID");
            if (withReason && (line.decision !== "Remove" || !removalReasons.includes(line.reason)))
              return fail("STAFF_ROUND_INPUT_INVALID");
            return Object.freeze({
              cartItemReference: String(parseOrderingReference(line.cartItemReference)),
              decision: line.decision,
              reason:
                line.decision === "Remove"
                  ? withReason
                    ? (line.reason as StaffCartRemovalReason)
                    : ("GuestAsked" as const)
                  : null,
            });
          }),
        );
        const references = decisions.map((line) => line.cartItemReference);
        if (
          new Set(references).size !== references.length ||
          decisions.filter((line) => line.decision === "Remove").length > staffRoundRemovableLimit
        )
          return fail("STAFF_ROUND_INPUT_INVALID");
      }
      includeTableCart = Object.freeze({
        expectedCartVersion,
        removeUnavailable: Object.freeze(removeUnavailable),
        decisions,
      });
    }
    if (!Array.isArray(raw.lines)) return fail("STAFF_ROUND_INPUT_INVALID");
    // WP-2423 M35: a round of only the guests' lines (their phone died, or they asked staff to
    // send what is in the cart): no line of staff's own, at least one guest line sent.
    const guestOnly =
      raw.lines.length === 0 &&
      (includeTableCart?.decisions ?? []).some((line) => line.decision === "Send");
    const notes = raw.lines.map((line: unknown) => {
      const note = readClosedRecord(line, [
        "sellableReference",
        "quantity",
        "optionSelections",
        "note",
      ]).note;
      return note === null ? null : parseCustomerNote(note);
    });
    const parsed = parseCounterOrderCommand({
      operationReference: raw.operationReference,
      // The counter's own rule wants a line; a guest-only round has none of its own to check.
      lines: guestOnly
        ? [{ sellableReference: raw.operationReference, quantity: 1, optionSelections: [] }]
        : raw.lines.map((line: Record<string, unknown>) => ({
            sellableReference: line.sellableReference,
            quantity: line.quantity,
            optionSelections: line.optionSelections,
          })),
      tip: raw.tip,
      recordedAfterOutage: raw.recordedAfterOutage,
    });
    return Object.freeze({
      operationReference: parsed.operationReference,
      tableReference: String(parseOrderingReference(raw.tableReference)),
      lines: Object.freeze(
        guestOnly
          ? []
          : parsed.lines.map((line, index) =>
              Object.freeze({ ...line, note: notes[index] ?? null }),
            ),
      ),
      tip: parsed.tip,
      recordedAfterOutage: parsed.recordedAfterOutage,
      includeTableCart,
      expectedDiningSessionReference,
    });
  } catch (error) {
    if (error instanceof StaffDiningRoundError) throw error;
    return fail("STAFF_ROUND_INPUT_INVALID");
  }
}

interface StaffScope {
  readonly selected: { tenantReference: string; brandReference: string; storeReference: string };
  readonly actorReference: string;
}

/**
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): staff enter a round for a table on behalf of guests
 * who can't or won't use a phone, or a paper round taken during an outage. The round goes through
 * the table guest path under a table guest session the command opens for it (same table session
 * and join rules, the table's shared Cart, same menu, sold-out, option, price, tax, checkout and
 * submission checks) and becomes a round of the table's Order like any guest's. The result is the
 * exact amount to charge on the Store's card machine. The staff member is recorded by Ordering; a
 * retry with the same operation returns the same round.
 */
/**
 * WP-2423 M35 (design 2.2, "idempotent per operation"): the reference of a guest line's staff
 * removal (or of its Audit record) made by one staff round command. It comes from the command and
 * the line, never from a fresh draw, so the removal belongs to that command: a repeat of the same
 * command names the same removal (Ordering replays it), and two commands or two lines never share
 * one. A UUIDv7 dated as the command (its first 48 bits), the rest from SHA-256.
 */
export function staffRemovalReference(
  roundOperationReference: string,
  cartItemReference: string,
  purpose: "Operation" | "Audit",
): string {
  const round = String(parseOrderingReference(roundOperationReference));
  const line = String(parseOrderingReference(cartItemReference));
  const digest = createHash("sha256")
    .update(`WP-2423 staff round removal\n${purpose}\n${round}\n${line}`)
    .digest("hex");
  const variant = ((parseInt(digest.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return String(
    parseOrderingReference(
      `${round.slice(0, 8)}-${round.slice(9, 13)}-7${digest.slice(0, 3)}-${variant}${digest.slice(4, 7)}-${digest.slice(7, 19)}`,
    ),
  );
}

export function createMerchantStaffDiningRound(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  pipeline: StaffTableGuestPipeline;
  nextReference(): string;
  /** Told the original error of an unexpected failure (the pilot logs code and frames only). */
  onUnexpected?(error: unknown): void;
  /** How long an unfinished attempt is treated as still being sent (default two minutes). */
  inProgressMs?: number;
  /** DEC-DINE-IN-PAY-LATER: rounds of tables opened pay later go to the kitchen unpaid. */
  payLater?(scope: StaffScope["selected"]): DiningPayLaterRound;
  /** The Audit retention of a staff removal of a guest line (default the pilot's own). */
  retentionPolicyCode?: string;
  retentionPolicyVersion?: number;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const now = () => options.persistence.now();
  /** The guests' unsent items as the Cart stands now, for staff to decide again. */
  const tableCartRefusal = async (
    items: readonly StaffRoundPendingItem[],
    version: number,
  ): Promise<StaffDiningRoundError> => {
    const refusal = new StaffDiningRoundError("STAFF_ROUND_TABLE_CART_HAS_ITEMS", null, items);
    refusal.tableCart = {
      cartVersion: version,
      guestsCanSend:
        options.pipeline.guestsCanSend === undefined
          ? true
          : await options.pipeline.guestsCanSend(),
    };
    return refusal;
  };
  const hashIntent = (value: string) =>
    "sha256:" + createHash("sha256").update(value).digest("hex");
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<StaffDiningRoundResult> => {
    const session = await options.authentication.authorize(input);
    const command = parseStaffDiningRoundCommand(input.command);
    const intentHash = parseOrderingHash(
      "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            kind: "StaffDiningRound/v1",
            tableReference: command.tableReference,
            lines: command.lines,
            tip: command.tip,
            recordedAfterOutage: command.recordedAfterOutage,
            // A round that takes in the guests' unsent items is a different intent, and so is one
            // that also takes their unsellable lines out (in any order: the same lines).
            ...(command.includeTableCart === null
              ? {}
              : { includeTableCart: command.includeTableCart.expectedCartVersion }),
            ...(command.includeTableCart === null ||
            command.includeTableCart.removeUnavailable.length === 0
              ? {}
              : { removeUnavailable: [...command.includeTableCart.removeUnavailable].sort() }),
            // Taken for a party: a different intent from the same round for whoever sits there.
            ...(command.expectedDiningSessionReference === null
              ? {}
              : { forParty: command.expectedDiningSessionReference }),
            // M35: each guest line's decision (in any order: the same decisions).
            ...(command.includeTableCart?.decisions == null
              ? {}
              : {
                  tableCartLines: [...command.includeTableCart.decisions]
                    .map((line) => [line.cartItemReference, line.decision, line.reason ?? ""])
                    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")),
                }),
          }),
        ),
    );
    const inScope = <T>(
      work: (
        tx: ConsumerTransaction,
        scope: StaffScope,
        allowed: () => Promise<boolean>,
      ) => Promise<T>,
    ) =>
      options.persistence.transactions.run((transaction) =>
        // Resolved in full once at the start and once before the reply; owner reads in between
        // take the run's guard (no re-resolution per read).
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const resolved = await resolveScope(
                transaction,
                input.sessionCookie,
                staffDiningRoundPermission,
                session.sessionReference,
              ).catch(onlyRefusal(() => fail("STAFF_ROUND_PERMISSION_DENIED")));
              // WP-2423 (46940b76 L6): both permissions from one current-fact read (Session,
              // selection, membership, store assignment, permission policy), not two full ones.
              const decisions = await resolved.authorizeActions([
                staffDiningRoundPermission,
                staffDiningRoundTablePermission,
              ]);
              if (
                decisions.get(staffDiningRoundPermission)?.effect !== "Allow" ||
                decisions.get(staffDiningRoundTablePermission)?.effect !== "Allow"
              )
                return fail("STAFF_ROUND_PERMISSION_DENIED");
              return resolved;
            },
            recheck: async (resolved) => (await resolved.allowed()) === true,
            denied: () => fail("STAFF_ROUND_PERMISSION_DENIED"),
          },
          (authority) =>
            work(
              transaction as unknown as ConsumerTransaction,
              {
                selected: {
                  tenantReference: String(authority.scope.selected.tenantReference),
                  brandReference: String(authority.scope.context.brand.brandReference),
                  storeReference: String(authority.scope.store.storeReference),
                },
                actorReference: String(authority.scope.actorReference),
              },
              () => authority.guard(),
            ),
        ),
      );
    /**
     * WP-2423 M35: the table's cart as staff decide on it. Null when there is nothing to decide
     * (no open table, no cart, no unsent line) or when the decisions sent are for exactly this
     * cart; otherwise its lines, named in the staff member's language, to decide again.
     */
    const tableCartMoved = async (
      tx: ConsumerTransaction,
      scope: StaffScope,
    ): Promise<{
      readonly cartVersion: number;
      readonly items: readonly StaffRoundPendingItem[];
    } | null> => {
      const owner = {
        brandReference: scope.selected.brandReference,
        storeReference: scope.selected.storeReference,
      };
      const table = await createPostgresDiningTableStore(
        { run: (work) => work(tx as never) },
        scope.selected,
        { hashIntent, equals: (a, b) => a === b },
      ).loadTable(parseDiningReference(command.tableReference));
      const session = table?.activeDiningSessionReference ?? null;
      // The party the round was taken for has left: refused before anything is touched.
      if (
        command.expectedDiningSessionReference !== null &&
        (session === null ? null : String(session)) !== command.expectedDiningSessionReference
      )
        return fail("STAFF_ROUND_TABLE_PARTY_CHANGED");
      if (session === null) return null;
      const current = await readStaffDiningCart(tx as never, owner, String(session), now());
      if (current === null || current.lines.length === 0) return null;
      const include = command.includeTableCart;
      const decided =
        include?.decisions == null
          ? null
          : new Set(include.decisions.map((line) => line.cartItemReference));
      if (
        include !== null &&
        include.expectedCartVersion === current.cartVersion &&
        (decided === null ||
          (decided.size === current.lines.length &&
            current.lines.every((line) => decided.has(line.cartItemReference))))
      )
        return null;
      const names = await listStoreMenuSellableNames(
        tx as never,
        owner,
        current.lines.map((line) => line.sellableReference),
      );
      // The Catalog read moves the scope to the Brand; restore the Store for what follows.
      await (tx as unknown as { query(sql: string, values: unknown[]): Promise<unknown> }).query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [owner.brandReference, owner.storeReference],
      );
      const chosen = staffContentLocale();
      const nameOf = (byLocale: Readonly<Record<string, string>> | undefined) => {
        const entries = Object.entries(byLocale ?? {});
        return (
          (chosen === null ? undefined : byLocale?.[chosen]) ??
          entries.find(
            ([locale]) => chosen !== null && locale.split("-")[0] === chosen.split("-")[0],
          )?.[1] ??
          entries[0]?.[1] ??
          ""
        );
      };
      return Object.freeze({
        cartVersion: current.cartVersion,
        items: Object.freeze(
          current.lines.map((line) =>
            Object.freeze({
              cartItemReference: line.cartItemReference,
              name: nameOf(names.get(line.sellableReference)),
              quantity: line.quantity,
              // Read only, before a table guest exists: whether it can be sold now is shown by
              // the staff screen's own menu, and checked again when the round is sent.
              standing: "Available" as const,
            }),
          ),
        ),
      });
    };
    /**
     * WP-2423 M06/M35: the guests' lines staff take out of the table's cart with this round, in
     * one transaction as the staff member's own removals (Ordering's staff removal), each with
     * its own Audit record. Not while a guest is paying for that cart version.
     */
    const removeGuestLines = async (
      tx: ConsumerTransaction,
      scope: StaffScope,
      allowed: () => Promise<boolean>,
      input: {
        readonly diningSessionReference: string;
        readonly cartReference: string;
        readonly expectedCartVersion: number;
        readonly keep: readonly string[];
        readonly removals: readonly {
          readonly cartItemReference: string;
          readonly reason: StaffCartRemovalReason;
        }[];
      },
    ) => {
      if (!(await allowed())) return fail("STAFF_ROUND_PERMISSION_DENIED");
      const observedAt = now();
      const holds = createPostgresDiningCheckoutHoldSource(
        { run: (work) => work(tx as never) },
        scope.selected,
      );
      return removeStaffDiningCartLines(
        tx as never,
        {
          brandReference: scope.selected.brandReference,
          storeReference: scope.selected.storeReference,
        },
        {
          diningSessionReference: input.diningSessionReference,
          cartReference: input.cartReference,
          expectedCartVersion: input.expectedCartVersion,
          keep: input.keep,
          lines: input.removals.map((line) => {
            // This command's own removal of this line (a repeat names the same one).
            const operationReference = staffRemovalReference(
              command.operationReference,
              line.cartItemReference,
              "Operation",
            );
            return {
              cartItemReference: line.cartItemReference,
              reason: line.reason,
              operationReference,
              audit: {
                auditId: staffRemovalReference(
                  command.operationReference,
                  line.cartItemReference,
                  "Audit",
                ),
                brandId: scope.selected.brandReference,
                storeId: scope.selected.storeReference,
                actor: { type: "User" as const, reference: scope.actorReference },
                actionCode: "ORDERING_CART_ITEM_REMOVE_BY_STAFF",
                targetType: "OrderingCart",
                targetId: input.cartReference,
                reasonCode: staffCartReasonCode(line.reason),
                correlationId: command.operationReference,
                occurredAt: observedAt,
                sourceChannel: "API" as const,
                dataClassification: "Internal" as const,
                retentionPolicyCode: options.retentionPolicyCode ?? "AUDIT_DEFAULT",
                retentionPolicyVersion: options.retentionPolicyVersion ?? 1,
              },
            };
          }),
          actorReference: scope.actorReference,
          observedAt,
          hashIntent,
          // Any guest's checkout of this cart version (staff are never a participant), asked
          // under the cart row lock.
          checkoutHeld: async (cartVersion) =>
            (await holds.read({
              diningSessionReference: input.diningSessionReference,
              cartReference: input.cartReference,
              cartVersion,
              participantReference: scope.actorReference,
              observedAt,
            })) !== null,
        },
      );
    };
    const entries = (scope: StaffScope, allowed: () => Promise<boolean>) =>
      createPostgresStaffDiningRoundEntryStore({
        brandReference: scope.selected.brandReference,
        storeReference: scope.selected.storeReference,
        authorize: allowed,
      });
    /** The round of a recorded staff entry, from owner records only. */
    const finished = async (
      status: StaffDiningRoundResult["status"],
      entry: StaffDiningRoundEntryRecord,
    ): Promise<StaffDiningRoundResult> =>
      inScope(async (tx, scope, allowed) => {
        const batch = await entries(scope, allowed).loadBatch(
          tx,
          String(entry.guestSessionReference),
        );
        if (batch === null) return fail("STAFF_ROUND_NOT_FINISHED");
        const labels = await listDiningSessionTableLabels(tx as never, scope.selected, [
          String(entry.diningSessionReference),
        ]);
        const payLater = options.payLater?.(scope.selected);
        if (
          payLater !== undefined &&
          (await payLater.isPayLater(tx, String(entry.diningSessionReference)))
        ) {
          // Sent to the kitchen in the same transaction that reads it back, so a retry of a round
          // whose sending was cut off finishes it (an already-sent round is returned as it is).
          const sent = await payLater.confirm(tx, {
            submissionReference: String(batch.submissionReference),
            actorReference: scope.actorReference,
            operationReference: String(entry.operationReference),
            correlationReference: String(entry.operationReference),
            authorize: async () => allowed(),
          });
          const roundMinor = await payLater.roundTotalMinor(tx, {
            orderReference: String(batch.orderReference),
            orderBatchReference: String(batch.orderBatchReference),
            authorize: async () => allowed(),
          });
          return Object.freeze({
            status,
            orderReference: String(batch.orderReference),
            orderBatchReference: String(batch.orderBatchReference),
            orderNumber: batch.orderNumber,
            orderVersion: sent.confirmation.acceptedOrderVersion,
            tableLabel: labels.get(String(entry.diningSessionReference)) ?? null,
            orderMinor: roundMinor.toString(),
            tipMinor: "0",
            totalMinor: roundMinor.toString(),
            payBy: null,
            payLater: true,
            recordedAfterOutage: entry.recordedAfterOutage,
          });
        }
        const current = await readStaffDiningRoundPaymentPreparation(
          tx,
          {
            scope: scope.selected,
            now,
            nextPreparationReference: options.nextReference,
            authorize: allowed,
          },
          {
            submissionReference: String(batch.submissionReference),
            guestSessionReference: String(entry.guestSessionReference),
            tipSelectionReference: String(entry.tipSelectionReference),
          },
        );
        // DEC-PAPER-SEND-IDEMPOTENT: the round's card-machine (or paper) payment record, read only
        // for a round sent again (a first send has none). Cash is not taken for a table round here.
        const paymentRecord = () =>
          createPostgresCardMachinePaymentStore({
            scope: scope.selected,
            authorize: async (_tx, value) =>
              value.orderReference === String(batch.orderReference) && (await allowed()),
          }).loadByBatch(tx, String(batch.orderReference), String(batch.orderBatchReference));
        if (current === null) {
          // Paid already (a paper round the table pays now is paid with its send): the same round
          // at the amounts its payment record holds, so a lost answer is recovered and the round
          // is never sent and paid twice.
          const paid = await paymentRecord();
          if (paid === null) {
            // The round exists but neither waits for payment nor was paid: its time to pay ended
            // and it was taken off. Named when sent again (after the still-sending window).
            const ended = new StaffDiningRoundError("STAFF_ROUND_NOT_FINISHED");
            ended.placedOrderNumber = batch.orderNumber;
            ended.placedTableLabel = labels.get(String(entry.diningSessionReference)) ?? null;
            throw ended;
          }
          const p = paid.preparation;
          return Object.freeze({
            paid: true as const,
            status,
            orderReference: String(batch.orderReference),
            orderBatchReference: String(batch.orderBatchReference),
            orderNumber: batch.orderNumber,
            orderVersion: batch.orderVersion,
            tableLabel: labels.get(String(entry.diningSessionReference)) ?? null,
            orderMinor: p.orderAllocation.amountMinor.toString(),
            tipMinor: p.tip.amountMinor.toString(),
            totalMinor: p.total.amountMinor.toString(),
            payBy: String(p.capacityExpiresAt),
            payLater: false,
            recordedAfterOutage: entry.recordedAfterOutage,
          });
        }
        // WP-2423 D1: a later round's table Order is at the version its other rounds moved it to
        // (the Order header keeps the first round's version).
        const execution = current.additional
          ? await createPostgresAdditionalDiningExecutionReader({
              brandReference: scope.selected.brandReference,
              storeReference: scope.selected.storeReference,
              authorize: async () => allowed(),
            }).loadBySubmission({
              transaction: tx,
              submissionReference: String(batch.submissionReference),
              observedAt: now(),
            })
          : null;
        if (current.additional && execution === null) return fail("STAFF_ROUND_NOT_FINISHED");
        const p = current.preparation;
        // v15 batch-5: the time staff are told is the one the round is cancelled at (Ordering's
        // payment window of the round), never a later minute read from the payment clock.
        const windowEnd = (
          await listStoreDiningBatchPaymentDeadlines(tx as never, scope.selected, [
            String(batch.orderReference),
          ])
        ).find(
          (entry) => entry.orderBatchReference === String(batch.orderBatchReference),
        )?.paymentDeadline;
        const payBy =
          windowEnd !== undefined && Date.parse(windowEnd) < Date.parse(String(p.capacityExpiresAt))
            ? windowEnd
            : String(p.capacityExpiresAt);
        // A round's payment clock stays open once it is paid: a round sent again is read as paid
        // from its payment record, so staff are never asked to charge it a second time.
        const paidAlready = status === "AlreadyPlaced" && (await paymentRecord()) !== null;
        // DEC-PAPER-SEND-IDEMPOTENT (b11): the clock also stays open after the System (or staff)
        // took an unpaid round off. Sent again, such a round, or one whose time to pay has ended,
        // is named by its order and table, never offered for a card-machine charge.
        if (
          status === "AlreadyPlaced" &&
          !paidAlready &&
          (Date.parse(payBy) <= Date.parse(now()) ||
            (await entries(scope, allowed).isTakenOff(tx, String(batch.orderBatchReference))))
        ) {
          // Placed for certain (it has a payment clock), so never answered as still sending.
          const named = new StaffDiningRoundError("STAFF_ROUND_ALREADY_SENT");
          named.placedOrderNumber = batch.orderNumber;
          named.placedTableLabel = labels.get(String(entry.diningSessionReference)) ?? null;
          throw named;
        }
        return Object.freeze({
          ...(paidAlready ? { paid: true as const } : {}),
          status,
          orderReference: String(batch.orderReference),
          orderBatchReference: String(batch.orderBatchReference),
          orderNumber: batch.orderNumber,
          orderVersion: execution?.orderVersion ?? batch.orderVersion,
          tableLabel: labels.get(String(entry.diningSessionReference)) ?? null,
          orderMinor: p.orderAllocation.amountMinor.toString(),
          tipMinor: p.tip.amountMinor.toString(),
          totalMinor: p.total.amountMinor.toString(),
          payBy,
          payLater: false,
          recordedAfterOutage: entry.recordedAfterOutage,
        });
      });
    const earlier = async (record: StaffDiningRoundEntryRecord) => {
      try {
        return await finished("AlreadyPlaced", record);
      } catch (error) {
        if (
          error instanceof StaffDiningRoundError &&
          error.code === "STAFF_ROUND_NOT_FINISHED" &&
          Date.parse(now()) - Date.parse(String(record.createdAt)) <
            (options.inProgressMs ?? 120_000)
        )
          return fail("STAFF_ROUND_IN_PROGRESS");
        // DEC-PAPER-SEND-IDEMPOTENT: the round was placed (its time to pay has since ended), so
        // it is named, as a counter order is, never "didn't go through".
        if (
          error instanceof StaffDiningRoundError &&
          error.code === "STAFF_ROUND_NOT_FINISHED" &&
          error.placedOrderNumber !== null
        ) {
          const named = new StaffDiningRoundError("STAFF_ROUND_ALREADY_SENT");
          named.placedOrderNumber = error.placedOrderNumber;
          named.placedTableLabel = error.placedTableLabel;
          throw named;
        }
        throw error;
      }
    };
    // WP-2423 item 7: a session this request started is closed again if the round fails before
    // its checkout starts (nothing ordered, nothing charged), so no empty session is left seated.
    let startedTable: {
      readonly diningSessionReference: string;
      readonly generation: number | null;
    } | null = null;
    const abandonStartedTable = async () => {
      const started = startedTable;
      startedTable = null;
      if (started === null) return;
      try {
        await options.pipeline.abandonTable(
          { sessionCookie: input.sessionCookie, csrf: input.csrf },
          { tableReference: command.tableReference, ...started },
        );
      } catch (error) {
        try {
          options.onUnexpected?.(error);
        } catch {
          // Reporting never changes the answer.
        }
      }
    };
    /**
     * WP-2423: from the checkout on, the round may exist (an unexpected failure there is answered
     * as still being sent, so the same command recovers it); before it, nothing was ordered and
     * the round's own items are taken back out of the table's Cart.
     */
    let roundMayExist = false;
    let removeRoundItems: (() => Promise<"Removed" | "Kept">) | null = null;
    let settleAfterFailure: (() => Promise<StaffDiningRoundResult>) | null = null;
    try {
      // A retry of the same staff command returns the round it created, never a second one.
      const prior = await inScope(async (tx, scope, allowed) => {
        const found = await entries(scope, allowed).loadByOperation(tx, command.operationReference);
        if (
          found !== null &&
          (found.intentHash !== intentHash || String(found.actorReference) !== scope.actorReference)
        )
          return fail("STAFF_ROUND_IDEMPOTENCY_CONFLICT");
        // Only a tip the Store offers now (a retry returns its round as it was sent).
        const refused =
          found === null
            ? tipRefusal(await readStoreTipChoices(tx, scope.selected), command.tip)
            : null;
        if (refused === "TipsOff") return fail("STAFF_ROUND_TIPS_OFF");
        if (refused === "TipChoicesChanged") return fail("STAFF_ROUND_TIP_CHOICES_CHANGED");
        return found;
      });
      if (prior !== null) return await earlier(prior);
      if (
        !(await options.pipeline.takesOrder({ recordedAfterOutage: command.recordedAfterOutage }))
      )
        return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      // DEC-STAFF-DINE-IN-ROUND (2026-10-15): a table without a code is refused with nothing changed.
      if (!(await options.pipeline.tableHasQr({ tableReference: command.tableReference })))
        return fail("STAFF_ROUND_TABLE_QR_MISSING");
      // WP-2423 M35: guests' unsent lines staff haven't decided on (or a cart that moved on since
      // they did) are refused here, read only, before the table is opened, a table guest joins or
      // the round is recorded: the refusal is quick and leaves nothing behind.
      const stale = await inScope((tx, scope) => tableCartMoved(tx, scope));
      if (stale !== null) throw await tableCartRefusal(stale.items, stale.cartVersion);
      const table = await options.pipeline.openTable(
        { sessionCookie: input.sessionCookie, csrf: input.csrf },
        {
          tableReference: command.tableReference,
          ...(command.expectedDiningSessionReference === null
            ? {}
            : { expectedDiningSessionReference: command.expectedDiningSessionReference }),
        },
      );
      if (table.status === "PartyChanged") return fail("STAFF_ROUND_TABLE_PARTY_CHANGED");
      if (table.status === "NewGuestsPaused") return fail("STAFF_ROUND_NEW_GUESTS_PAUSED");
      if (table.status !== "Opened") return fail("STAFF_ROUND_TABLE_UNAVAILABLE");
      if (table.started)
        startedTable = {
          diningSessionReference: table.diningSessionReference,
          generation: table.generation,
        };
      // v15 2026-11-03: entered after opening, since a table no party is seated at takes no entry.
      // A refusal here closes the table this request started: never an empty session on the floor.
      const entered = await options.pipeline.enter({
        tableReference: command.tableReference,
        requestedAt: now(),
      });
      if (entered.status === "NoTableQr") return fail("STAFF_ROUND_TABLE_QR_MISSING");
      if (entered.status !== "Established") return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      const joined = await options.pipeline.join(entered.credentials, {
        joinCredential: table.joinCredential,
        operationReference: options.nextReference(),
      });
      const bound = await options.pipeline.bind(entered.credentials, {
        operationReference: options.nextReference(),
        admissionReference: joined.admissionReference,
      });
      const credentials = bound.credentials;
      const tipSelectionReference = String(parseOrderingReference(options.nextReference()));
      const entry = await inScope(async (tx, scope, allowed) =>
        entries(scope, allowed).record(
          tx,
          {
            brandReference: parseOrderingReference(scope.selected.brandReference),
            storeReference: parseOrderingReference(scope.selected.storeReference),
            operationReference: parseOrderingReference(command.operationReference),
            intentHash,
            actorReference: parseOrderingReference(scope.actorReference),
            tableReference: parseOrderingReference(command.tableReference),
            diningSessionReference: parseOrderingReference(table.diningSessionReference),
            guestSessionReference: parseOrderingReference(bound.guestSessionReference),
            tipSelectionReference: parseOrderingReference(tipSelectionReference),
            recordedAfterOutage: command.recordedAfterOutage,
            createdAt: parseOrderingInstant(now()),
            auditReference: parseOrderingReference(options.nextReference()),
          },
          joined.admissionReference,
        ),
      );
      // A concurrent retry recorded the same command first: it owns its own table guest (and
      // the table session, which this attempt then never closes).
      if (entry.status === "AlreadyRecorded") {
        startedTable = null;
        return await earlier(entry.record);
      }
      const cart = await options.pipeline.selectCart(credentials, {
        operationReference: options.nextReference(),
        requestedAt: now(),
      });
      if (cart.status !== "Selected") return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
      const report = (error: unknown) => {
        try {
          options.onUnexpected?.(error);
        } catch {
          // Reporting never changes the answer.
        }
      };
      const selectAgain = () =>
        options.pipeline.selectCart(credentials, {
          operationReference: options.nextReference(),
          requestedAt: now(),
        });
      // Items guests put in the table's shared Cart and haven't sent yet would be sent and charged
      // with this round. Staff either ask the guests to send or remove them (while guests can
      // still send), or add them to this round, as they saw them: only that same Cart version is
      // taken in (one checkout of the Cart, recorded as this staff round, so a guest's phone
      // retrying its send finds the Cart already sent and adds nothing).
      let cartVersion = cart.cartVersion;
      let pending = cart.pendingItems;
      const include = command.includeTableCart;
      if (pending.length > 0) {
        if (include === null || include.expectedCartVersion !== cart.cartVersion)
          throw await tableCartRefusal(pending, cart.cartVersion);
        // WP-2423 M35: the lines staff take out, and why. Per line, as staff decided each one; in
        // the earlier form, the lines they were shown as not sellable now (the kitchen can't
        // make them).
        const removals =
          include.decisions === null
            ? include.removeUnavailable.map((cartItemReference) => ({
                cartItemReference,
                reason: "CantMake" as StaffCartRemovalReason,
              }))
            : include.decisions
                .filter((line) => line.decision === "Remove")
                .map((line) => ({
                  cartItemReference: line.cartItemReference,
                  reason: line.reason ?? ("GuestAsked" as StaffCartRemovalReason),
                }));
        const out = new Set(removals.map((line) => line.cartItemReference));
        const decided =
          include.decisions === null
            ? null
            : new Set(include.decisions.map((line) => line.cartItemReference));
        // WP-2423 (staff-round-soldout): a guest line that can't be sold now is never sent, so
        // staff decide on each one they were shown; one they didn't see (or one gone) is refused.
        if (
          pending.some(
            (item) => item.standing !== "Available" && !out.has(item.cartItemReference),
          ) ||
          [...out].some(
            (reference) => !pending.some((item) => item.cartItemReference === reference),
          ) ||
          (decided !== null &&
            (decided.size !== pending.length ||
              pending.some((item) => !decided.has(item.cartItemReference))))
        )
          throw await tableCartRefusal(pending, cart.cartVersion);
        if (out.size > 0) {
          // WP-2423 M06/M35: taken out before any line of this round goes in, all at once as the
          // staff member's own removals (who, why, the dish, whose phone added it; each audited),
          // or none at all when the cart moved on. Never put back if the round then fails: that
          // was the staff member's decision, and every phone at the table is told.
          const keep = pending
            .map((item) => item.cartItemReference)
            .filter((reference) => !out.has(reference));
          try {
            await inScope((tx, scope, allowed) =>
              removeGuestLines(tx, scope, allowed, {
                diningSessionReference: table.diningSessionReference,
                cartReference: cart.cartReference,
                expectedCartVersion: cart.cartVersion,
                keep,
                removals,
              }),
            );
          } catch (error) {
            if (error instanceof StaffDiningRoundError) throw error;
            const code = error instanceof CartError ? error.code : null;
            if (code === "CART_CHECKOUT_IN_PROGRESS")
              return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
            if (
              code === "CART_VERSION_CONFLICT" ||
              code === "CART_ITEM_NOT_FOUND" ||
              code === "CART_PERMISSION_DENIED" ||
              code === "CART_UNAVAILABLE"
            ) {
              const fresh = await selectAgain();
              if (fresh.status !== "Selected")
                return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
              throw await tableCartRefusal(fresh.pendingItems, fresh.cartVersion);
            }
            throw error;
          }
          const after = await selectAgain();
          if (after.status !== "Selected") return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
          const kept = pending.filter((item) => !out.has(item.cartItemReference));
          // Only the rest exactly as staff saw it, every item still sellable, is taken in.
          const asSeen =
            after.cartReference === cart.cartReference &&
            after.pendingItems.length === kept.length &&
            after.pendingItems.every(
              (item) =>
                item.standing === "Available" &&
                kept.some(
                  (seen) =>
                    seen.cartItemReference === item.cartItemReference &&
                    seen.quantity === item.quantity,
                ),
            );
          if (!asSeen) throw await tableCartRefusal(after.pendingItems, after.cartVersion);
          cartVersion = after.cartVersion;
          pending = after.pendingItems;
        }
      }
      // A round of only the guests' lines whose lines are gone (sent from a phone meanwhile):
      // nothing to send; staff see the cart as it is now.
      if (command.lines.length === 0 && pending.length === 0)
        throw await tableCartRefusal(pending, cartVersion);
      /** The guests' lines this round takes in (never removed when the round fails). */
      const guestLines = new Set(pending.map((item) => item.cartItemReference));
      // The Cart line each round line went to, to name a line the checkout finds short.
      const cartLines: (string | undefined)[] = [];
      // The Cart as it stands before this round's lines (the guests' lines it takes in), so each
      // added line is told apart from theirs.
      let lines: readonly CounterCartLine[] = pending.map((item) => ({
        cartItemReference: item.cartItemReference,
        quantity: item.quantity,
      }));
      const ownLines = () =>
        [...new Set(cartLines)].filter((reference): reference is string => reference !== undefined);
      // The round's own lines, never a guest's.
      removeRoundItems = async () => {
        const references = ownLines();
        const removeItems = options.pipeline.removeItems;
        // A round of only the guests' lines put nothing of its own in the cart.
        if (command.lines.length === 0) return "Removed";
        try {
          // Only when every line sent so far is known to its Cart line.
          if (
            removeItems !== undefined &&
            references.length > 0 &&
            cartLines.every((reference) => reference !== undefined)
          ) {
            const removed = await removeItems(credentials, {
              cartReference: cart.cartReference,
              cartVersion,
              cartItemReferences: references,
            });
            if (removed === "Removed") return removed;
            // A guest changed the Cart after this round's lines went in: read it again and take
            // what is left of them out once more at its current version, so no staff line stays
            // in the guests' Cart (a later attempt is a new table guest, who could not remove it).
            const current = await selectAgain();
            if (current.status !== "Selected" || current.cartVersion === cartVersion) return "Kept";
            const left = references.filter((reference) =>
              current.pendingItems.some((item) => item.cartItemReference === reference),
            );
            if (left.length === 0) return "Removed";
            return await removeItems(credentials, {
              cartReference: cart.cartReference,
              cartVersion: current.cartVersion,
              cartItemReferences: left,
            });
          }
        } catch (error) {
          report(error);
        }
        return "Kept";
      };
      /**
       * WP-2423 (staff-round-soldout): the quote or checkout found one of the guests' lines can't
       * be sold (it sold out a moment ago, or the Cart's marks could not be read). Once this
       * round's own lines are out, staff see the guests' Cart again with that line marked and
       * decide as before; nothing was ordered or charged.
       */
      const guestLineRefusal = async (
        removed: "Removed" | "Kept",
        reference: string,
        mark: Pick<StaffRoundPendingItem, "standing" | "available">,
        otherwise: () => StaffDiningRoundError,
      ): Promise<StaffDiningRoundError> => {
        if (removed !== "Removed") return otherwise();
        const fresh = await selectAgain();
        if (fresh.status !== "Selected")
          return new StaffDiningRoundError("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
        const own = new Set(ownLines());
        return tableCartRefusal(
          fresh.pendingItems
            .filter((item) => !own.has(item.cartItemReference))
            .map((item) =>
              item.cartItemReference === reference
                ? Object.freeze({
                    cartItemReference: item.cartItemReference,
                    name: item.name,
                    quantity: item.quantity,
                    standing: mark.standing,
                    ...(mark.available === undefined ? {} : { available: mark.available }),
                  })
                : item,
            ),
          fresh.cartVersion,
        );
      };
      for (const [index, line] of command.lines.entries()) {
        const added = await options.pipeline.addItem(credentials, {
          operationReference: options.nextReference(),
          cartReference: cart.cartReference,
          expectedCartVersion: cartVersion,
          sellableReference: line.sellableReference,
          quantity: line.quantity,
          optionSelections: line.optionSelections,
          customerNote: line.note,
          requestedAt: now(),
        });
        if (added.status === "CheckoutInProgress")
          return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
        if (added.status !== "Applied") return fail("STAFF_ROUND_ITEM_UNAVAILABLE", index);
        cartVersion = added.cartVersion;
        cartLines.push(addedCartLine(lines, added.lines));
        lines = added.lines ?? lines;
      }
      /**
       * WP-2423: the round can't be made as entered (found before anything was ordered or
       * charged). Its items come back out of the table's Cart (guests' items were never in it) and
       * a table session this request started is closed again, so staff change the round and send
       * it again.
       */
      const withdraw = async () => {
        const removed =
          cartLines.length === command.lines.length && removeRoundItems !== null
            ? await removeRoundItems()
            : "Kept";
        if (removed === "Removed") startedTable = tableStarted;
        await abandonStartedTable();
        return removed;
      };
      /**
       * WP-2423 DEC-MERCHANT-LOCK-SCOPE: a step from the checkout on failed, so the round may exist.
       * The owner's records say whether it does. If it does, it stands. If not, its items come back
       * out of the table's Cart, so sending again is not refused for them and they are never sent
       * twice; taking them out waits for any submission still holding that Cart, so the records
       * are read once more before staff are told nothing was sent.
       */
      const roundExists = () =>
        inScope(
          async (tx, scope, allowed) =>
            (await entries(scope, allowed).loadBatch(
              tx,
              String(entry.record.guestSessionReference),
            )) !== null,
        );
      settleAfterFailure = async () => {
        if (await roundExists()) return finished("Placed", entry.record);
        const removed = await withdraw();
        if (await roundExists()) return finished("Placed", entry.record);
        // Items that could not be taken out prove nothing: the same command is sent again.
        return fail(removed === "Removed" ? "STAFF_ROUND_UNAVAILABLE" : "STAFF_ROUND_IN_PROGRESS");
      };
      const quoted = await options.pipeline.quote(credentials, {
        operationReference: options.nextReference(),
        cartReference: cart.cartReference,
        cartVersion,
        requestedAt: now(),
      });
      if (quoted.status === "ItemUnavailable") {
        const own = cartLines.indexOf(quoted.cartItemReference);
        if (own < 0 && guestLines.has(quoted.cartItemReference)) {
          // This round's own lines come out here (not again in the catch below).
          const remove = removeRoundItems;
          removeRoundItems = null;
          throw await guestLineRefusal(
            remove === null ? "Kept" : await remove(),
            quoted.cartItemReference,
            { standing: quoted.reason },
            () => new StaffDiningRoundError("STAFF_ROUND_UNAVAILABLE"),
          );
        }
        // One of this round's lines: named; the catch below takes the round's lines back out.
        const refused = new StaffDiningRoundError(
          "STAFF_ROUND_ITEM_UNAVAILABLE",
          own < 0 ? null : own,
        );
        refused.optionsChanged = quoted.reason === "OptionsChanged";
        throw refused;
      }
      // A guest phone started paying for the table's Cart meanwhile; the round's lines come out.
      if (quoted.status === "CheckoutInProgress")
        return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
      if (quoted.status === "TableCheckingOut") return fail("STAFF_ROUND_TABLE_UNAVAILABLE");
      if (quoted.status !== "Quoted") return fail("STAFF_ROUND_NOT_PRICED");
      const tip = counterTipMinor(command.tip, quoted.subtotalMinor);
      await options.pipeline.saveDetails(credentials, {
        operationReference: options.nextReference(),
        detailsReference: options.nextReference(),
        cartReference: cart.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      // From here the round may exist (checkout, submission): the session is never closed for it.
      const tableStarted = startedTable;
      startedTable = null;
      roundMayExist = true;
      const checkout = await options.pipeline.startCheckout(credentials, {
        createOperationReference: options.nextReference(),
        cartReference: cart.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      if (checkout.status === "ItemShort" || checkout.status === "ItemUnavailable") {
        const removed = await withdraw();
        const lineIndex = checkoutRefusalLineIndex(checkout, cartLines);
        const reference = checkout.cartItemReference;
        // WP-2423 (staff-round-soldout): one of the guests' lines. Not sellable now: staff may
        // remove it. Too few in stock (even none left, while the dish is not marked sold out):
        // only the guests lower or remove it, or staff mark it sold out first.
        if (lineIndex === null && reference !== null && guestLines.has(reference))
          throw await guestLineRefusal(
            removed,
            reference,
            checkout.status === "ItemShort"
              ? { standing: "Short", available: checkout.available }
              : { standing: "Unavailable" },
            () => new StaffDiningRoundError("STAFF_ROUND_ITEM_UNAVAILABLE"),
          );
        return checkout.status === "ItemShort" && checkout.available > 0
          ? fail("STAFF_ROUND_STOCK_SHORT", lineIndex, [], {
              available: checkout.available,
              sharedStock: checkout.sharedStock,
            })
          : fail("STAFF_ROUND_ITEM_UNAVAILABLE", lineIndex, [], {
              available: null,
              sharedStock: checkout.status === "ItemShort" && checkout.sharedStock,
            });
      }
      // An owner listed between pricing and checkout: nothing was ordered; staff press again.
      if (checkout.status === "RequoteRequired") {
        await withdraw();
        return fail("STAFF_ROUND_NOT_PRICED");
      }
      if (checkout.status !== "Started") return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      const submitPayLater = options.pipeline.submitPayLater;
      const payLaterRound = options.payLater;
      const payLater =
        payLaterRound !== undefined &&
        submitPayLater !== undefined &&
        (await inScope(async (tx, scope) =>
          payLaterRound(scope.selected).isPayLater(tx, table.diningSessionReference),
        ));
      if (payLater) {
        // DEC-DINE-IN-PAY-LATER: no tip and no charge now; the table pays once at the end.
        try {
          await submitPayLater(credentials, {
            checkoutSessionReference: checkout.checkoutSessionReference,
            selectionReference: tipSelectionReference,
            recordedAfterOutage: command.recordedAfterOutage,
          });
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code !== "ORDER_CREATE_STOCK_SHORT" && code !== "CHECKOUT_REQUOTE_REQUIRED")
            throw error;
          await withdraw();
          return keepingCause(() =>
            fail(
              code === "ORDER_CREATE_STOCK_SHORT"
                ? "STAFF_ROUND_ITEM_UNAVAILABLE"
                : "STAFF_ROUND_NOT_PRICED",
            ),
          )(error);
        }
        return await finished("Placed", entry.record);
      }
      let preparation: OrderPaymentPreparationEvidence;
      try {
        preparation = await options.pipeline.preparePayment(credentials, {
          checkoutSessionReference: checkout.checkoutSessionReference,
          selectionReference: tipSelectionReference,
          tip: { amountMinor: tip, currencyCode: "CAD" } as Money,
          recordedAfterOutage: command.recordedAfterOutage,
        });
      } catch (error) {
        // WP-2423: stock ran out, or an owner listed, between checkout and submission; the
        // submission rolled back, so nothing was ordered or charged and the round's items come
        // back out of the table's Cart.
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== "ORDER_CREATE_STOCK_SHORT" && code !== "CHECKOUT_REQUOTE_REQUIRED")
          throw error;
        await withdraw();
        return keepingCause(() =>
          fail(
            code === "ORDER_CREATE_STOCK_SHORT"
              ? "STAFF_ROUND_ITEM_UNAVAILABLE"
              : "STAFF_ROUND_NOT_PRICED",
          ),
        )(error);
      }
      // The round was submitted with another tip: the same command reads back what it holds.
      if (preparation.tip.amountMinor !== tip) return fail("STAFF_ROUND_IN_PROGRESS");
      return await finished("Placed", entry.record);
    } catch (error) {
      // WP-2423: failed before its checkout, so nothing was ordered: the round's items leave the
      // table's Cart, so sending it again (a new attempt) is not refused for them.
      const remove = roundMayExist ? null : removeRoundItems;
      if (remove !== null) {
        removeRoundItems = null;
        await remove();
      }
      await abandonStartedTable();
      if (error instanceof StaffDiningRoundError) throw error;
      if (
        error instanceof StaffDiningRoundEntryError &&
        error.code === "STAFF_DINING_ROUND_IDEMPOTENCY_CONFLICT"
      )
        return fail("STAFF_ROUND_IDEMPOTENCY_CONFLICT");
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED") return fail("STAFF_ROUND_PERMISSION_DENIED");
      if (code === "COUNTER_ORDER_INPUT_INVALID") return fail("STAFF_ROUND_INPUT_INVALID");
      if (code === "STORE_CLOSED") return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      if (roundMayExist && settleAfterFailure !== null) {
        try {
          return await settleAfterFailure();
        } catch (settling) {
          if (
            settling instanceof StaffDiningRoundError &&
            (settling.code === "STAFF_ROUND_UNAVAILABLE" ||
              settling.code === "STAFF_ROUND_IN_PROGRESS")
          )
            throw settling;
          // Where it stands can't be read now: the same command is sent again to recover it.
        }
      }
      // WP-2423: a definite "could not send" only while nothing can exist yet; once the checkout
      // started the round may exist, so the same command is sent again to recover it.
      return keepingCause(() =>
        fail(roundMayExist ? "STAFF_ROUND_IN_PROGRESS" : "STAFF_ROUND_UNAVAILABLE"),
      )(error);
    }
  };
}
