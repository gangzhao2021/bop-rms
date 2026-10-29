import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  isTipPercent,
  readStoreFeatures,
  readStoreTipChoices,
  tipRefusal,
} from "./merchant-store-features.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresCounterOrderEntryStore,
  CounterOrderEntryError,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CounterOrderEntryRecord,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import type { Money } from "@rms/pricing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { readCounterPaymentPreparation } from "./counter-payment-preparation.js";

/**
 * WP-2423 Q7: taking an order on behalf of a customer. Front of house, store managers and owners
 * hold it (DEC-PERM-CATALOG); it also covers recording the counter payment from the card machine.
 */
export const counterOrderPermission = "ordering.order.create_staff" as const;

export const counterOrderErrorCodes = [
  "COUNTER_ORDER_INPUT_INVALID",
  "COUNTER_ORDER_PERMISSION_DENIED",
  "COUNTER_ORDER_STORE_NOT_TAKING_ORDERS",
  "COUNTER_ORDER_ITEM_UNAVAILABLE",
  "COUNTER_ORDER_STOCK_SHORT",
  "COUNTER_ORDER_NOT_PRICED",
  "COUNTER_ORDER_NOT_FINISHED",
  "COUNTER_ORDER_IN_PROGRESS",
  "COUNTER_ORDER_IDEMPOTENCY_CONFLICT",
  /**
   * WP-2423: no pickup time covers now (the Store's pickup time schedule ran out), so no pickup
   * order can be entered; staff take it on paper and enter it once pickup times are back.
   */
  "COUNTER_ORDER_NO_PICKUP_TIMES",
  /** WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the Store turned counter ordering off. */
  "COUNTER_ORDER_TURNED_OFF",
  /** WP-2423 item 8 ⑦ (Owner decision 11): the Store turned tips off; send it with no tip. */
  "COUNTER_ORDER_TIPS_OFF",
  /** The tip percentage is not one the Store offers now: read the choices again. */
  "COUNTER_ORDER_TIP_CHOICES_CHANGED",
  "COUNTER_ORDER_UNAVAILABLE",
] as const;
export type CounterOrderErrorCode = (typeof counterOrderErrorCodes)[number];
export class CounterOrderError extends Error {
  readonly code: CounterOrderErrorCode;
  /**
   * For COUNTER_ORDER_ITEM_UNAVAILABLE: the zero-based line the store cannot sell now. For
   * COUNTER_ORDER_STOCK_SHORT: the first line of the item (same options) there is too little of.
   */
  readonly lineIndex: number | null;
  /** For COUNTER_ORDER_STOCK_SHORT: how many of that item the Store's stock covers now (1 or more). */
  readonly available: number | null;
  /**
   * WP-2423: for COUNTER_ORDER_STOCK_SHORT and COUNTER_ORDER_ITEM_UNAVAILABLE, the item could be
   * made on its own; it is short only because other items in the order use the same stock.
   */
  readonly sharedStock: boolean;
  constructor(
    code: CounterOrderErrorCode,
    lineIndex: number | null = null,
    available: number | null = null,
    sharedStock = false,
  ) {
    super("counter order is unavailable");
    this.name = "CounterOrderError";
    this.code = code;
    this.lineIndex = lineIndex;
    this.available = available;
    this.sharedStock = sharedStock;
  }
}
const fail = (
  code: CounterOrderErrorCode,
  lineIndex: number | null = null,
  available: number | null = null,
  sharedStock = false,
): never => {
  throw new CounterOrderError(code, lineIndex, available, sharedStock);
};

/** WP-2423: a guest Cart line as the command sees it after adding an item. */
export interface CounterCartLine {
  readonly cartItemReference: string;
  readonly quantity: number;
}
/**
 * WP-2423: the Cart line an added order line went to (a new line, or an existing line of the same
 * item whose quantity grew); undefined when the Cart did not say.
 */
export function addedCartLine(
  before: readonly CounterCartLine[],
  after: readonly CounterCartLine[] | undefined,
): string | undefined {
  if (after === undefined) return undefined;
  const earlier = new Map(before.map((line) => [line.cartItemReference, line.quantity]));
  const grown = after.filter((line) => line.quantity > (earlier.get(line.cartItemReference) ?? 0));
  return grown.length === 1 ? grown[0]?.cartItemReference : undefined;
}
/**
 * WP-2423: the checkout's answer about one Cart line (short in stock, or not sellable now), as the
 * staff command reports it: the first order line that went to that Cart line.
 */
export type CounterCheckoutItemRefusal =
  | {
      readonly status: "ItemShort";
      readonly cartItemReference: string;
      readonly available: number;
      readonly sharedStock: boolean;
    }
  | { readonly status: "ItemUnavailable"; readonly cartItemReference: string | null };
/** WP-2423: the first order line that went to the Cart line a checkout refusal names. */
export function checkoutRefusalLineIndex(
  refusal: CounterCheckoutItemRefusal,
  cartLines: readonly (string | undefined)[],
): number | null {
  const index =
    refusal.cartItemReference === null ? -1 : cartLines.indexOf(refusal.cartItemReference);
  return index < 0 ? null : index;
}
function refusedAtCheckout(
  refusal: CounterCheckoutItemRefusal,
  cartLines: readonly (string | undefined)[],
): never {
  const lineIndex = checkoutRefusalLineIndex(refusal, cartLines);
  return refusal.status === "ItemShort" && refusal.available > 0
    ? fail("COUNTER_ORDER_STOCK_SHORT", lineIndex, refusal.available, refusal.sharedStock)
    : fail(
        "COUNTER_ORDER_ITEM_UNAVAILABLE",
        lineIndex,
        null,
        refusal.status === "ItemShort" && refusal.sharedStock,
      );
}

/** What the counter reads from the Store's current operating status. */
export interface CounterStoreOperatingNow {
  readonly state: "Open" | "Closed" | "TemporarilyClosed";
  readonly availableServiceModes: readonly string[];
  /** The service the published hours offer now, before any pause. */
  readonly scheduledServiceModes?: readonly string[];
}

/**
 * WP-2423 Q7 (Owner, 2026-10-13): pausing online ordering does not stop the counter. Staff take a
 * walk-up pickup order whenever the Store's published hours offer pickup now, paused or not; a
 * paper order taken during an outage is entered whenever the system is back, even after closing.
 */
export function counterTakesOrder(
  status: CounterStoreOperatingNow,
  input: { readonly recordedAfterOutage: boolean },
): boolean {
  if (input.recordedAfterOutage) return true;
  if (status.scheduledServiceModes !== undefined)
    return status.scheduledServiceModes.includes("Pickup");
  return status.state === "Open" && status.availableServiceModes.includes("Pickup");
}

export interface CounterGuestCredentials {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
}

/**
 * The walk-up guest's ordinary customer path, composed from the same owner services the customer
 * app uses (menu and sold-out checks, quote with tax, store open, pickup capacity, stock
 * reservation). The credentials live only in this request's memory and are never returned.
 */
export interface CounterGuestPipeline {
  /** The counter's opening rule ({@link counterTakesOrder}) on the Store's current status. */
  takesOrder(input: { readonly recordedAfterOutage: boolean }): Promise<boolean>;
  /**
   * WP-2423: whether a pickup time covers now (Fulfillment's schedule has not run out). Asked
   * only after an unexpected failure, so staff are told the real reason instead of "try again".
   */
  pickupTimesNow?(): Promise<boolean>;
  open(input: {
    readonly requestedAt: string;
  }): Promise<
    | { readonly status: "Established"; readonly credentials: CounterGuestCredentials }
    | { readonly status: "NotAccepting" }
  >;
  bindCart(
    credentials: CounterGuestCredentials,
    input: { readonly operationReference: string },
  ): Promise<{
    readonly credentials: CounterGuestCredentials;
    readonly guestSessionReference: string;
    readonly cartReference: string;
    readonly cartVersion: number;
  }>;
  addItem(
    credentials: CounterGuestCredentials,
    input: {
      readonly operationReference: string;
      readonly cartReference: string;
      readonly expectedCartVersion: number;
      readonly sellableReference: string;
      readonly quantity: number;
      readonly optionSelections: readonly { optionReference: string; quantity: number }[];
      /** The guest's note for the kitchen (dine-in staff rounds); none at the counter. */
      readonly customerNote?: string | null;
      readonly requestedAt: string;
    },
  ): Promise<
    | {
        readonly status: "Applied";
        readonly cartVersion: number;
        /** The Cart's lines after the item was added (WP-2423: to name a short line). */
        readonly lines?: readonly CounterCartLine[];
      }
    | { readonly status: "NotAvailable" }
    /** Another guest at the table is paying for the table's Cart (dine-in only). */
    | { readonly status: "CheckoutInProgress" }
  >;
  /**
   * WP-2423 (v15 run): whether the Store's stock covers this quantity of one item (with these
   * options) now: the stock check adding an item makes, as the walk-up guest against its Cart.
   * Without it a short item is reported as not available.
   */
  canSell?(
    credentials: CounterGuestCredentials,
    input: {
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly sellableReference: string;
      readonly quantity: number;
      readonly optionSelections: readonly { optionReference: string; quantity: number }[];
      readonly requestedAt: string;
    },
  ): Promise<boolean>;
  quote(
    credentials: CounterGuestCredentials,
    input: {
      readonly operationReference: string;
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly requestedAt: string;
    },
  ): Promise<
    | {
        readonly status: "Quoted";
        readonly quoteReference: string;
        readonly subtotalMinor: bigint;
        readonly totalMinor: bigint;
      }
    | { readonly status: "NotPriced" }
  >;
  /**
   * The checkout details every pickup Order carries. A walk-up guest gives no contact (staff
   * call the order number) and keeps the card machine slip, so nothing personal is collected.
   */
  saveDetails(
    credentials: CounterGuestCredentials,
    input: {
      readonly operationReference: string;
      readonly detailsReference: string;
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly quoteReference: string;
    },
  ): Promise<void>;
  startCheckout(
    credentials: CounterGuestCredentials,
    input: {
      readonly createOperationReference: string;
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly quoteReference: string;
    },
  ): Promise<
    | { readonly status: "Started"; readonly checkoutSessionReference: string }
    | { readonly status: "StoreNotTakingOrders" }
    /** WP-2423: the Store's stock can't make the Cart as it stands, or an item can't be sold now;
     * nothing was created or charged. */
    | CounterCheckoutItemRefusal
  >;
  /** Submits the Order, records the tip choice and starts the payment clock. */
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

export type CounterTipChoice =
  | { readonly kind: "None" }
  /** One of the Store's tip percentages (checked against them when the order is placed). */
  | { readonly kind: "Percent"; readonly percent: number }
  | { readonly kind: "Amount"; readonly amountMinor: string };

export interface CounterOrderLine {
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionSelections: readonly { optionReference: string; quantity: number }[];
}

/** The same item with the same options: stock is checked for their combined quantity. */
export function sameCounterConfiguration(a: CounterOrderLine, b: CounterOrderLine): boolean {
  const options = (line: CounterOrderLine) =>
    JSON.stringify(
      [...line.optionSelections]
        .map((option) => [option.optionReference, option.quantity] as const)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return a.sellableReference === b.sellableReference && options(a) === options(b);
}

export interface CounterOrderResult {
  readonly status: "Placed" | "AlreadyPlaced";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderNumber: string;
  readonly orderVersion: number;
  /** Order total from the quote, tax included. */
  readonly orderMinor: string;
  readonly tipMinor: string;
  /** What staff charge on the card machine. */
  readonly totalMinor: string;
  /** The order is released automatically if no payment is recorded by then. */
  readonly payBy: string;
  readonly recordedAfterOutage: boolean;
}

interface CounterStaffScope {
  readonly selected: { tenantReference: string; brandReference: string; storeReference: string };
  readonly actorReference: string;
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function parseLines(value: unknown): readonly CounterOrderLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30)
    return fail("COUNTER_ORDER_INPUT_INVALID");
  return Object.freeze(
    value.map((item) => {
      const line = readClosedRecord(item, ["sellableReference", "quantity", "optionSelections"]);
      if (
        typeof line.sellableReference !== "string" ||
        !uuidV7.test(line.sellableReference) ||
        !Number.isSafeInteger(line.quantity) ||
        (line.quantity as number) < 1 ||
        (line.quantity as number) > 99 ||
        !Array.isArray(line.optionSelections) ||
        line.optionSelections.length > 20
      )
        return fail("COUNTER_ORDER_INPUT_INVALID");
      const options = line.optionSelections.map((option: unknown) => {
        const selected = readClosedRecord(option, ["optionReference", "quantity"]);
        if (
          typeof selected.optionReference !== "string" ||
          !uuidV7.test(selected.optionReference) ||
          !Number.isSafeInteger(selected.quantity) ||
          (selected.quantity as number) < 1 ||
          (selected.quantity as number) > 20
        )
          return fail("COUNTER_ORDER_INPUT_INVALID");
        return Object.freeze({
          optionReference: selected.optionReference,
          quantity: selected.quantity as number,
        });
      });
      if (new Set(options.map((option) => option.optionReference)).size !== options.length)
        return fail("COUNTER_ORDER_INPUT_INVALID");
      return Object.freeze({
        sellableReference: line.sellableReference,
        quantity: line.quantity as number,
        optionSelections: Object.freeze(options),
      });
    }),
  );
}

function parseTip(value: unknown): CounterTipChoice {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "None") {
    readClosedRecord(value, ["kind"]);
    return Object.freeze({ kind: "None" });
  }
  if (kind === "Percent") {
    const raw = readClosedRecord(value, ["kind", "percent"]);
    if (!isTipPercent(raw.percent)) return fail("COUNTER_ORDER_INPUT_INVALID");
    return Object.freeze({ kind: "Percent", percent: raw.percent });
  }
  if (kind === "Amount") {
    const raw = readClosedRecord(value, ["kind", "amountMinor"]);
    if (typeof raw.amountMinor !== "string" || !/^(0|[1-9][0-9]{0,8})$/u.test(raw.amountMinor))
      return fail("COUNTER_ORDER_INPUT_INVALID");
    return Object.freeze({ kind: "Amount", amountMinor: raw.amountMinor });
  }
  return fail("COUNTER_ORDER_INPUT_INVALID");
}

/** Tip from the quote subtotal, rounded half up (as on the customer checkout). */
export function counterTipMinor(choice: CounterTipChoice, subtotalMinor: bigint): bigint {
  if (choice.kind === "None") return 0n;
  if (choice.kind === "Percent") return (subtotalMinor * BigInt(choice.percent) + 50n) / 100n;
  const amount = BigInt(choice.amountMinor);
  // A typed tip larger than the order itself is a keying error, not a tip.
  if (amount > subtotalMinor) return fail("COUNTER_ORDER_INPUT_INVALID");
  return amount;
}

export function parseCounterOrderCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "lines",
      "tip",
      "recordedAfterOutage",
    ]);
    if (typeof raw.recordedAfterOutage !== "boolean") return fail("COUNTER_ORDER_INPUT_INVALID");
    return Object.freeze({
      operationReference: String(parseOrderingReference(raw.operationReference)),
      lines: parseLines(raw.lines),
      tip: parseTip(raw.tip),
      recordedAfterOutage: raw.recordedAfterOutage,
    });
  } catch (error) {
    if (error instanceof CounterOrderError) throw error;
    return fail("COUNTER_ORDER_INPUT_INVALID");
  }
}

/**
 * WP-2423 Q7 slice 1 (DEC-COUNTER-PAYMENT-RECORD): staff take a pickup order at the counter for a
 * guest without a phone, or enter a paper order taken during an outage. The order runs through the
 * customer path under a walk-up guest session the counter opens (same menu, sold-out, price, tax,
 * store-open, capacity and stock checks) as a counter (Pos) Cart; the result is an Order awaiting
 * payment with the exact amount to charge on the Store's card machine. The staff member and the
 * command are recorded by Ordering; a retry with the same operation returns the same Order.
 */
export function createMerchantCounterOrder(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  pipeline: CounterGuestPipeline;
  nextReference(): string;
  /**
   * Told the original error of an unexpected failure before staff get "try again"; the pilot
   * logs its code and source frames only (never the order, credentials or payload).
   */
  onUnexpected?(error: unknown): void;
  /** How long an unfinished attempt is treated as still being sent (default two minutes). */
  inProgressMs?: number;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const now = () => options.persistence.now();
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<CounterOrderResult> => {
    const session = await options.authentication.authorize(input);
    const command = parseCounterOrderCommand(input.command);
    const intentHash = parseOrderingHash(
      "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            kind: "CounterPickupOrder/v1",
            lines: command.lines,
            tip: command.tip,
            recordedAfterOutage: command.recordedAfterOutage,
          }),
        ),
    );
    const denied = () => fail("COUNTER_ORDER_PERMISSION_DENIED");
    /**
     * WP-2423: one authorized run per counter transaction. The caller and `counter order`
     * permission are resolved in full once at its start and once more before it commits (inside
     * the transaction, so a withdrawn permission or ended Session never commits); the Ordering
     * owner reads and writes in between take the run's no-query guard.
     */
    const inScope = <T>(
      work: (
        tx: ConsumerTransaction,
        scope: CounterStaffScope,
        guard: () => Promise<boolean>,
      ) => Promise<T>,
    ) =>
      options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const resolved = await resolveScope(
                transaction,
                input.sessionCookie,
                counterOrderPermission,
                session.sessionReference,
              ).catch(denied);
              if ((await resolved.allowed()) !== true) return denied();
              return resolved;
            },
            recheck: async (resolved) => (await resolved.allowed()) === true,
            denied,
          },
          (authority) => {
            const resolved = authority.scope;
            return work(
              transaction as unknown as ConsumerTransaction,
              {
                selected: {
                  tenantReference: String(resolved.selected.tenantReference),
                  brandReference: String(resolved.context.brand.brandReference),
                  storeReference: String(resolved.store.storeReference),
                },
                actorReference: String(resolved.actorReference),
              },
              () => authority.guard(),
            );
          },
        ),
      );
    const entries = (scope: CounterStaffScope, guard: () => Promise<boolean>) =>
      createPostgresCounterOrderEntryStore({
        brandReference: scope.selected.brandReference,
        storeReference: scope.selected.storeReference,
        authorize: guard,
      });
    /** The finished order of a recorded counter entry, from owner records only. */
    const finished = async (
      status: CounterOrderResult["status"],
      entry: CounterOrderEntryRecord,
    ): Promise<CounterOrderResult> =>
      inScope(async (tx, scope, guard) => {
        const order = await entries(scope, guard).loadOrder(tx, String(entry.cartReference));
        if (order === null) return fail("COUNTER_ORDER_NOT_FINISHED");
        const current = await readCounterPaymentPreparation(
          tx,
          {
            scope: scope.selected,
            now,
            nextPreparationReference: options.nextReference,
            authorize: guard,
          },
          {
            submissionReference: String(order.submissionReference),
            guestSessionReference: String(entry.guestSessionReference),
            tipSelectionReference: String(entry.tipSelectionReference),
          },
        );
        if (current === null) return fail("COUNTER_ORDER_NOT_FINISHED");
        const p = current.preparation;
        return Object.freeze({
          status,
          orderReference: String(order.orderReference),
          orderBatchReference: String(order.orderBatchReference),
          orderNumber: current.orderNumber,
          orderVersion: current.orderVersion,
          orderMinor: p.orderAllocation.amountMinor.toString(),
          tipMinor: p.tip.amountMinor.toString(),
          totalMinor: p.total.amountMinor.toString(),
          payBy: String(p.capacityExpiresAt),
          recordedAfterOutage: entry.recordedAfterOutage,
        });
      });
    /**
     * The same staff command sent before. An attempt that created no Order is either still being
     * sent or failed part way; a failed attempt leaves only what an abandoned customer checkout
     * leaves (its pickup capacity hold and guest session lapse on their own), so staff send the
     * order again as a new one.
     */
    const earlier = async (record: CounterOrderEntryRecord) => {
      try {
        return await finished("AlreadyPlaced", record);
      } catch (error) {
        if (
          error instanceof CounterOrderError &&
          error.code === "COUNTER_ORDER_NOT_FINISHED" &&
          Date.parse(now()) - Date.parse(String(record.createdAt)) <
            (options.inProgressMs ?? 120_000)
        )
          return fail("COUNTER_ORDER_IN_PROGRESS");
        throw error;
      }
    };
    try {
      // A retry of the same staff command returns the order it created, never a second one.
      const prior = await inScope(async (tx, scope, guard) => {
        const found = await entries(scope, guard).loadByOperation(tx, command.operationReference);
        if (
          found !== null &&
          (found.intentHash !== intentHash || String(found.actorReference) !== scope.actorReference)
        )
          return fail("COUNTER_ORDER_IDEMPOTENCY_CONFLICT");
        // A new order only while the Store uses counter ordering (a retry returns its order).
        if (found === null && !(await readStoreFeatures(tx, scope.selected, "Refuse")).counterOrder)
          return fail("COUNTER_ORDER_TURNED_OFF");
        // Only a tip the Store offers now (a retry returns its order as it was placed).
        const refused =
          found === null
            ? tipRefusal(await readStoreTipChoices(tx, scope.selected), command.tip)
            : null;
        if (refused === "TipsOff") return fail("COUNTER_ORDER_TIPS_OFF");
        if (refused === "TipChoicesChanged") return fail("COUNTER_ORDER_TIP_CHOICES_CHANGED");
        return found;
      });
      if (prior !== null) return await earlier(prior);
      if (
        !(await options.pipeline.takesOrder({ recordedAfterOutage: command.recordedAfterOutage }))
      )
        return fail("COUNTER_ORDER_STORE_NOT_TAKING_ORDERS");
      const opened = await options.pipeline.open({ requestedAt: now() });
      if (opened.status !== "Established") return fail("COUNTER_ORDER_STORE_NOT_TAKING_ORDERS");
      const bound = await options.pipeline.bindCart(opened.credentials, {
        operationReference: options.nextReference(),
      });
      const credentials = bound.credentials;
      const tipSelectionReference = String(parseOrderingReference(options.nextReference()));
      const entry = await inScope(async (tx, scope, guard) => {
        const created = await entries(scope, guard).record(tx, {
          brandReference: parseOrderingReference(scope.selected.brandReference),
          storeReference: parseOrderingReference(scope.selected.storeReference),
          operationReference: parseOrderingReference(command.operationReference),
          intentHash,
          actorReference: parseOrderingReference(scope.actorReference),
          guestSessionReference: parseOrderingReference(bound.guestSessionReference),
          cartReference: parseOrderingReference(bound.cartReference),
          tipSelectionReference: parseOrderingReference(tipSelectionReference),
          recordedAfterOutage: command.recordedAfterOutage,
          createdAt: parseOrderingInstant(now()),
          auditReference: parseOrderingReference(options.nextReference()),
        });
        return created;
      });
      // A concurrent retry recorded the same command first: it owns its own guest Cart.
      if (entry.status === "AlreadyRecorded") return await earlier(entry.record);
      let cartVersion = bound.cartVersion;
      /**
       * WP-2423 (v15 run): when an item is short, staff are told which one and how many the
       * stock covers now, so they change the quantity instead of seeing "try again". Nothing is
       * placed or charged; the order on the page stays as entered.
       */
      const shortage = async (index: number) => {
        const canSell = options.pipeline.canSell?.bind(options.pipeline);
        const line = command.lines[index];
        if (canSell === undefined || line === undefined) return null;
        const group = [...command.lines.entries()].filter(([, other]) =>
          sameCounterConfiguration(line, other),
        );
        const ordered = group.reduce((sum, [, other]) => sum + other.quantity, 0);
        const sells = (quantity: number) =>
          canSell(credentials, {
            cartReference: bound.cartReference,
            cartVersion,
            sellableReference: line.sellableReference,
            quantity,
            optionSelections: line.optionSelections,
            requestedAt: now(),
          });
        try {
          if (await sells(ordered)) return null;
          // The most the stock covers now, below what was ordered (stock demand grows with
          // quantity, so a binary search finds it).
          let low = 0,
            high = ordered - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (await sells(middle)) low = middle;
            else high = middle - 1;
          }
          return { lineIndex: group[0]?.[0] ?? index, available: low };
        } catch {
          // An explanation that cannot be read never hides the original answer.
          return null;
        }
      };
      const notSellable = async (index: number): Promise<never> => {
        const short = await shortage(index);
        return short !== null && short.available > 0
          ? fail("COUNTER_ORDER_STOCK_SHORT", short.lineIndex, short.available)
          : fail("COUNTER_ORDER_ITEM_UNAVAILABLE", short?.lineIndex ?? index);
      };
      // The Cart line each order line went to, to name a line the checkout finds short.
      const cartLines: (string | undefined)[] = [];
      let lines: readonly CounterCartLine[] = [];
      for (const [index, line] of command.lines.entries()) {
        const added = await options.pipeline.addItem(credentials, {
          operationReference: options.nextReference(),
          cartReference: bound.cartReference,
          expectedCartVersion: cartVersion,
          sellableReference: line.sellableReference,
          quantity: line.quantity,
          optionSelections: line.optionSelections,
          requestedAt: now(),
        });
        if (added.status !== "Applied") return await notSellable(index);
        cartVersion = added.cartVersion;
        cartLines.push(addedCartLine(lines, added.lines));
        lines = added.lines ?? lines;
      }
      // Each line was checked on its own as it was added; the same item on several lines is
      // checked again for the quantity of all of them together (as checkout does).
      if (options.pipeline.canSell !== undefined)
        for (const [index, line] of command.lines.entries()) {
          const first = command.lines.findIndex((other) => sameCounterConfiguration(line, other));
          const repeated = command.lines.some(
            (other, at) => at > index && sameCounterConfiguration(line, other),
          );
          if (first === index && repeated) {
            const short = await shortage(index);
            if (short !== null)
              return short.available > 0
                ? fail("COUNTER_ORDER_STOCK_SHORT", short.lineIndex, short.available)
                : fail("COUNTER_ORDER_ITEM_UNAVAILABLE", short.lineIndex);
          }
        }
      const quoted = await options.pipeline.quote(credentials, {
        operationReference: options.nextReference(),
        cartReference: bound.cartReference,
        cartVersion,
        requestedAt: now(),
      });
      if (quoted.status !== "Quoted") return fail("COUNTER_ORDER_NOT_PRICED");
      const tip = counterTipMinor(command.tip, quoted.subtotalMinor);
      await options.pipeline.saveDetails(credentials, {
        operationReference: options.nextReference(),
        detailsReference: options.nextReference(),
        cartReference: bound.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      const checkout = await options.pipeline.startCheckout(credentials, {
        createOperationReference: options.nextReference(),
        cartReference: bound.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      if (checkout.status === "ItemShort" || checkout.status === "ItemUnavailable")
        return refusedAtCheckout(checkout, cartLines);
      if (checkout.status !== "Started") return fail("COUNTER_ORDER_STORE_NOT_TAKING_ORDERS");
      const preparation = await options.pipeline.preparePayment(credentials, {
        checkoutSessionReference: checkout.checkoutSessionReference,
        selectionReference: tipSelectionReference,
        tip: { amountMinor: tip, currencyCode: "CAD" } as Money,
        recordedAfterOutage: command.recordedAfterOutage,
      });
      if (preparation.tip.amountMinor !== tip) return fail("COUNTER_ORDER_UNAVAILABLE");
      return await finished("Placed", entry.record);
    } catch (error) {
      if (error instanceof CounterOrderError) throw error;
      if (
        error instanceof CounterOrderEntryError &&
        error.code === "COUNTER_ORDER_IDEMPOTENCY_CONFLICT"
      )
        return fail("COUNTER_ORDER_IDEMPOTENCY_CONFLICT");
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("COUNTER_ORDER_PERMISSION_DENIED");
      // The Store closed or paused pickup while the order was being sent.
      if (code === "STORE_CLOSED") return fail("COUNTER_ORDER_STORE_NOT_TAKING_ORDERS");
      // WP-2423: stock ran out between checkout and submission; nothing was placed or charged.
      if (code === "ORDER_CREATE_STOCK_SHORT") return fail("COUNTER_ORDER_ITEM_UNAVAILABLE");
      // WP-2423: the pickup time schedule ran out; say so rather than "try again". A counter
      // order is never refused because the hour is full (DEC-COUNTER-WALK-UP-CAPACITY).
      const covered = await options.pipeline.pickupTimesNow?.().catch(() => true);
      if (covered === false) return fail("COUNTER_ORDER_NO_PICKUP_TIMES");
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      return fail("COUNTER_ORDER_UNAVAILABLE");
    }
  };
}
