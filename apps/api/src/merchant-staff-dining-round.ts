import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { listDiningSessionTableLabels } from "@rms/dining";
import {
  createPostgresAdditionalDiningExecutionReader,
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
  addedCartLine,
  checkoutRefusalLineIndex,
  type CounterCartLine,
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
  "STAFF_ROUND_TABLE_QR_MISSING",
  "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
  "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS",
  "STAFF_ROUND_ITEM_UNAVAILABLE",
  /** WP-2423: the Store's stock can't make the round as entered (which item, how many left). */
  "STAFF_ROUND_STOCK_SHORT",
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
  /** WP-2423: for STAFF_ROUND_STOCK_SHORT, how many of the item the stock covers now (1 or more). */
  readonly available: number | null;
  /** WP-2423: the item is short only because other items in the round use the same stock. */
  readonly sharedStock: boolean;
  constructor(
    code: StaffDiningRoundErrorCode,
    lineIndex: number | null = null,
    pendingItems: readonly { readonly name: string; readonly quantity: number }[] = [],
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
  pendingItems: readonly { readonly name: string; readonly quantity: number }[] = [],
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
        /** True when this call started the table's dining session (the table was free). */
        readonly started: boolean;
        /** The issued code's generation (a later code for the table has a higher one). */
        readonly generation: number | null;
      }
    | { readonly status: "TableUnavailable" }
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
        readonly pendingItems: readonly { readonly name: string; readonly quantity: number }[];
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
        return Object.freeze({
          status,
          orderReference: String(batch.orderReference),
          orderBatchReference: String(batch.orderBatchReference),
          orderNumber: batch.orderNumber,
          orderVersion: execution?.orderVersion ?? batch.orderVersion,
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
      // DEC-STAFF-DINE-IN-ROUND (2026-10-15): enter with the table's code before the table is
      // opened, so a table without a code (or a Store not taking orders) is refused with nothing
      // changed — never an empty dining session left seated on the floor.
      const entered = await options.pipeline.enter({
        tableReference: command.tableReference,
        requestedAt: now(),
      });
      if (entered.status === "NoTableQr") return fail("STAFF_ROUND_TABLE_QR_MISSING");
      if (entered.status !== "Established") return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      const table = await options.pipeline.openTable(
        { sessionCookie: input.sessionCookie, csrf: input.csrf },
        { tableReference: command.tableReference },
      );
      if (table.status !== "Opened") return fail("STAFF_ROUND_TABLE_UNAVAILABLE");
      if (table.started)
        startedTable = {
          diningSessionReference: table.diningSessionReference,
          generation: table.generation,
        };
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
      // Items guests put in the table's shared Cart and haven't sent yet would be sent and charged
      // with this round: staff ask the guests to send or remove them first.
      if (cart.pendingItems.length > 0)
        return fail("STAFF_ROUND_TABLE_CART_HAS_ITEMS", null, cart.pendingItems);
      let cartVersion = cart.cartVersion;
      // The Cart line each round line went to, to name a line the checkout finds short.
      const cartLines: (string | undefined)[] = [];
      let lines: readonly CounterCartLine[] = [];
      // The round's own lines (the Cart had no unsent items before them), never a guest's.
      removeRoundItems = async () => {
        const references = [...new Set(cartLines)].filter(
          (reference): reference is string => reference !== undefined,
        );
        try {
          // Only when every line sent so far is known to its Cart line.
          if (
            options.pipeline.removeItems !== undefined &&
            references.length > 0 &&
            cartLines.every((reference) => reference !== undefined)
          )
            return await options.pipeline.removeItems(credentials, {
              cartReference: cart.cartReference,
              cartVersion,
              cartItemReferences: references,
            });
        } catch (error) {
          try {
            options.onUnexpected?.(error);
          } catch {
            // Reporting never changes the answer.
          }
        }
        return "Kept";
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
      };
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
        await withdraw();
        const lineIndex = checkoutRefusalLineIndex(checkout, cartLines);
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
      if (checkout.status !== "Started") return fail("STAFF_ROUND_STORE_NOT_TAKING_ORDERS");
      let preparation: OrderPaymentPreparationEvidence;
      try {
        preparation = await options.pipeline.preparePayment(credentials, {
          checkoutSessionReference: checkout.checkoutSessionReference,
          selectionReference: tipSelectionReference,
          tip: { amountMinor: tip, currencyCode: "CAD" } as Money,
          recordedAfterOutage: command.recordedAfterOutage,
        });
      } catch (error) {
        // WP-2423: stock ran out between checkout and submission; the submission rolled back, so
        // nothing was ordered or charged and the round's items come back out of the table's Cart.
        if ((error as { code?: unknown } | null)?.code !== "ORDER_CREATE_STOCK_SHORT") throw error;
        await withdraw();
        return fail("STAFF_ROUND_ITEM_UNAVAILABLE");
      }
      // The round was submitted with another tip: the same command reads back what it holds.
      if (preparation.tip.amountMinor !== tip) return fail("STAFF_ROUND_IN_PROGRESS");
      return await finished("Placed", entry.record);
    } catch (error) {
      // WP-2423: failed before its checkout, so nothing was ordered: the round's items leave the
      // table's Cart, so sending it again (a new attempt) is not refused for them.
      const remove = roundMayExist ? null : removeRoundItems;
      removeRoundItems = null;
      if (remove !== null) await remove();
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
      // WP-2423: a definite "could not send" only while nothing can exist yet; once the checkout
      // started the round may exist, so the same command is sent again to recover it.
      return fail(roundMayExist ? "STAFF_ROUND_IN_PROGRESS" : "STAFF_ROUND_UNAVAILABLE");
    }
  };
}
