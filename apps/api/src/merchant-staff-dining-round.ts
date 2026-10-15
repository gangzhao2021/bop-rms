import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { listDiningSessionTableLabels } from "@rms/dining";
import {
  createPostgresStaffDiningRoundEntryStore,
  parseCustomerNote,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  StaffDiningRoundEntryError,
  type OrderPaymentPreparationEvidence,
  type StaffDiningRoundEntryRecord,
} from "@rms/ordering";
import type { Money } from "@rms/pricing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  counterOrderPermission,
  counterTipMinor,
  parseCounterOrderCommand,
  type CounterGuestCredentials,
  type CounterGuestPipeline,
  type CounterOrderLine,
  type CounterTipChoice,
} from "./merchant-counter-order.js";
import { readStaffDiningRoundPaymentPreparation } from "./staff-dining-round-payment-preparation.js";

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
  "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
  "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS",
  "STAFF_ROUND_ITEM_UNAVAILABLE",
  "STAFF_ROUND_NOT_PRICED",
  "STAFF_ROUND_NOT_FINISHED",
  "STAFF_ROUND_IN_PROGRESS",
  "STAFF_ROUND_IDEMPOTENCY_CONFLICT",
  "STAFF_ROUND_UNAVAILABLE",
] as const;
export type StaffDiningRoundErrorCode = (typeof staffDiningRoundErrorCodes)[number];
export class StaffDiningRoundError extends Error {
  readonly code: StaffDiningRoundErrorCode;
  /** For STAFF_ROUND_ITEM_UNAVAILABLE: the zero-based line the store cannot sell now. */
  readonly lineIndex: number | null;
  /** For STAFF_ROUND_TABLE_CART_HAS_ITEMS: what guests put in the table's Cart (names only). */
  readonly pendingItems: readonly { readonly name: string; readonly quantity: number }[];
  constructor(
    code: StaffDiningRoundErrorCode,
    lineIndex: number | null = null,
    pendingItems: readonly { readonly name: string; readonly quantity: number }[] = [],
  ) {
    super("staff dining round is unavailable");
    this.name = "StaffDiningRoundError";
    this.code = code;
    this.lineIndex = lineIndex;
    this.pendingItems = pendingItems;
  }
}
const fail = (
  code: StaffDiningRoundErrorCode,
  lineIndex: number | null = null,
  pendingItems: readonly { readonly name: string; readonly quantity: number }[] = [],
): never => {
  throw new StaffDiningRoundError(code, lineIndex, pendingItems);
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
  /** Whether the Store takes a dine-in round now (paper rounds after an outage: always). */
  takesOrder(input: { readonly recordedAfterOutage: boolean }): Promise<boolean>;
  /**
   * Starts the table's dining session, or issues a fresh one-time table code for its current
   * session, under this staff member's table authority (Dining owner commands).
   */
  openTable(
    staff: { readonly sessionCookie: unknown; readonly csrf: unknown },
    input: { readonly tableReference: string },
  ): Promise<
    | {
        readonly status: "Opened";
        readonly diningSessionReference: string;
        readonly joinCredential: string;
      }
    | { readonly status: "TableUnavailable" }
  >;
  /** Enters with the table's printed QR, as a guest scanning it would. */
  enter(input: {
    readonly tableReference: string;
    readonly requestedAt: string;
  }): Promise<
    | { readonly status: "Established"; readonly credentials: CounterGuestCredentials }
    | { readonly status: "NotAccepting" }
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
        readonly pendingItems: readonly { readonly name: string; readonly quantity: number }[];
      }
    | { readonly status: "CheckoutInProgress" }
  >;
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
  /** What staff charge on the card machine. */
  readonly totalMinor: string;
  /** The card-machine payment must be recorded before then. */
  readonly payBy: string;
  readonly recordedAfterOutage: boolean;
}

export function parseStaffDiningRoundCommand(value: unknown): {
  readonly operationReference: string;
  readonly tableReference: string;
  readonly lines: readonly StaffDiningRoundLine[];
  readonly tip: CounterTipChoice;
  readonly recordedAfterOutage: boolean;
} {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "tableReference",
      "lines",
      "tip",
      "recordedAfterOutage",
    ]);
    if (!Array.isArray(raw.lines)) return fail("STAFF_ROUND_INPUT_INVALID");
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
      lines: raw.lines.map((line: Record<string, unknown>) => ({
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
        parsed.lines.map((line, index) => Object.freeze({ ...line, note: notes[index] ?? null })),
      ),
      tip: parsed.tip,
      recordedAfterOutage: parsed.recordedAfterOutage,
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
export function createMerchantStaffDiningRound(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  pipeline: StaffTableGuestPipeline;
  nextReference(): string;
  /** Told the original error of an unexpected failure (the pilot logs code and frames only). */
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
              ).catch(() => fail("STAFF_ROUND_PERMISSION_DENIED"));
              if ((await resolved.allowed()) !== true) return fail("STAFF_ROUND_PERMISSION_DENIED");
              const table = await resolved.authorizeAction(staffDiningRoundTablePermission);
              if (table?.effect !== "Allow") return fail("STAFF_ROUND_PERMISSION_DENIED");
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
        if (current === null) return fail("STAFF_ROUND_NOT_FINISHED");
        const labels = await listDiningSessionTableLabels(tx as never, scope.selected, [
          String(entry.diningSessionReference),
        ]);
        const p = current.preparation;
        return Object.freeze({
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
        throw error;
      }
    };
    try {
      // A retry of the same staff command returns the round it created, never a second one.
      const prior = await inScope(async (tx, scope, allowed) => {
        const found = await entries(scope, allowed).loadByOperation(tx, command.operationReference);
        if (
          found !== null &&
          (found.intentHash !== intentHash || String(found.actorReference) !== scope.actorReference)
        )
          return fail("STAFF_ROUND_IDEMPOTENCY_CONFLICT");
        return found;
      });
      if (prior !== null) return await earlier(prior);
      if (
        !(await options.pipeline.takesOrder({ recordedAfterOutage: command.recordedAfterOutage }))
      )
        return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      const table = await options.pipeline.openTable(
        { sessionCookie: input.sessionCookie, csrf: input.csrf },
        { tableReference: command.tableReference },
      );
      if (table.status !== "Opened") return fail("STAFF_ROUND_TABLE_UNAVAILABLE");
      const entered = await options.pipeline.enter({
        tableReference: command.tableReference,
        requestedAt: now(),
      });
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
        entries(scope, allowed).record(tx, {
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
        }),
      );
      // A concurrent retry recorded the same command first: it owns its own table guest.
      if (entry.status === "AlreadyRecorded") return await earlier(entry.record);
      const cart = await options.pipeline.selectCart(credentials, {
        operationReference: options.nextReference(),
        requestedAt: now(),
      });
      if (cart.status !== "Selected") return fail("STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS");
      // Items guests put in the table's shared Cart and haven't sent yet would be sent and charged
      // with this round: staff ask the guests to send or remove them first.
      if (cart.pendingItems.length > 0)
        return fail("STAFF_ROUND_TABLE_CART_HAS_ITEMS", null, cart.pendingItems);
      let cartVersion = cart.cartVersion;
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
      }
      const quoted = await options.pipeline.quote(credentials, {
        operationReference: options.nextReference(),
        cartReference: cart.cartReference,
        cartVersion,
        requestedAt: now(),
      });
      if (quoted.status !== "Quoted") return fail("STAFF_ROUND_NOT_PRICED");
      const tip = counterTipMinor(command.tip, quoted.subtotalMinor);
      await options.pipeline.saveDetails(credentials, {
        operationReference: options.nextReference(),
        detailsReference: options.nextReference(),
        cartReference: cart.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      const checkout = await options.pipeline.startCheckout(credentials, {
        createOperationReference: options.nextReference(),
        cartReference: cart.cartReference,
        cartVersion,
        quoteReference: quoted.quoteReference,
      });
      if (checkout.status !== "Started") return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      const preparation = await options.pipeline.preparePayment(credentials, {
        checkoutSessionReference: checkout.checkoutSessionReference,
        selectionReference: tipSelectionReference,
        tip: { amountMinor: tip, currencyCode: "CAD" } as Money,
        recordedAfterOutage: command.recordedAfterOutage,
      });
      if (preparation.tip.amountMinor !== tip) return fail("STAFF_ROUND_UNAVAILABLE");
      return await finished("Placed", entry.record);
    } catch (error) {
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
      return fail("STAFF_ROUND_UNAVAILABLE");
    }
  };
}
