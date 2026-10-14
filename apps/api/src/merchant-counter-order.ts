import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
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
  "COUNTER_ORDER_NOT_PRICED",
  "COUNTER_ORDER_NOT_FINISHED",
  "COUNTER_ORDER_IN_PROGRESS",
  "COUNTER_ORDER_IDEMPOTENCY_CONFLICT",
  "COUNTER_ORDER_UNAVAILABLE",
] as const;
export type CounterOrderErrorCode = (typeof counterOrderErrorCodes)[number];
export class CounterOrderError extends Error {
  readonly code: CounterOrderErrorCode;
  /** For COUNTER_ORDER_ITEM_UNAVAILABLE: the zero-based line the store cannot sell now. */
  readonly lineIndex: number | null;
  constructor(code: CounterOrderErrorCode, lineIndex: number | null = null) {
    super("counter order is unavailable");
    this.name = "CounterOrderError";
    this.code = code;
    this.lineIndex = lineIndex;
  }
}
const fail = (code: CounterOrderErrorCode, lineIndex: number | null = null): never => {
  throw new CounterOrderError(code, lineIndex);
};

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
      readonly requestedAt: string;
    },
  ): Promise<
    | { readonly status: "Applied"; readonly cartVersion: number }
    | { readonly status: "NotAvailable" }
  >;
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
  | { readonly kind: "Percent"; readonly percent: 10 | 15 | 18 | 20 }
  | { readonly kind: "Amount"; readonly amountMinor: string };

export interface CounterOrderLine {
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionSelections: readonly { optionReference: string; quantity: number }[];
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
    if (![10, 15, 18, 20].includes(raw.percent as number))
      return fail("COUNTER_ORDER_INPUT_INVALID");
    return Object.freeze({ kind: "Percent", percent: raw.percent as 10 | 15 | 18 | 20 });
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
    const inScope = <T>(
      work: (
        tx: ConsumerTransaction,
        scope: CounterStaffScope,
        allowed: () => Promise<boolean>,
      ) => Promise<T>,
    ) =>
      options.persistence.transactions.run(async (transaction) => {
        const resolved = await resolveScope(
          transaction,
          input.sessionCookie,
          counterOrderPermission,
          session.sessionReference,
        ).catch(() => fail("COUNTER_ORDER_PERMISSION_DENIED"));
        const allowed = async () => (await resolved.allowed()) === true;
        if (!(await allowed())) return fail("COUNTER_ORDER_PERMISSION_DENIED");
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
          allowed,
        );
      });
    const entries = (scope: CounterStaffScope, allowed: () => Promise<boolean>) =>
      createPostgresCounterOrderEntryStore({
        brandReference: scope.selected.brandReference,
        storeReference: scope.selected.storeReference,
        authorize: allowed,
      });
    /** The finished order of a recorded counter entry, from owner records only. */
    const finished = async (
      status: CounterOrderResult["status"],
      entry: CounterOrderEntryRecord,
    ): Promise<CounterOrderResult> =>
      inScope(async (tx, scope, allowed) => {
        const order = await entries(scope, allowed).loadOrder(tx, String(entry.cartReference));
        if (order === null) return fail("COUNTER_ORDER_NOT_FINISHED");
        const current = await readCounterPaymentPreparation(
          tx,
          {
            scope: scope.selected,
            now,
            nextPreparationReference: options.nextReference,
            authorize: allowed,
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
      const prior = await inScope(async (tx, scope, allowed) => {
        const found = await entries(scope, allowed).loadByOperation(tx, command.operationReference);
        if (
          found !== null &&
          (found.intentHash !== intentHash || String(found.actorReference) !== scope.actorReference)
        )
          return fail("COUNTER_ORDER_IDEMPOTENCY_CONFLICT");
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
      const entry = await inScope(async (tx, scope, allowed) => {
        const created = await entries(scope, allowed).record(tx, {
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
        if (added.status !== "Applied") return fail("COUNTER_ORDER_ITEM_UNAVAILABLE", index);
        cartVersion = added.cartVersion;
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
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      return fail("COUNTER_ORDER_UNAVAILABLE");
    }
  };
}
