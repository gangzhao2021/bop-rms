import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresCounterOrderEntryStore,
  createPostgresStaffDiningRoundEntryStore,
  listStoreOrderNumbers,
  parseOrderingReference,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import {
  cardMachineBackEntryWindowMs,
  cardMachinePaymentIntentView,
  CardMachinePaymentError,
  createPostgresCardMachinePaymentStore,
  parseCardMachinePaymentRecord,
  parseCardMachineSlipReference,
  parsePaymentDigest,
  planCounterCashTender,
  cardMachinePaymentTakenMinor,
  parsePaymentInstant,
  type CardMachinePaymentRecord,
  type PaymentIntentClaimAdmission,
} from "@rms/payment";
import { readStoreFirstConfigurationGoverningFrom } from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { readCounterPaymentPreparation } from "./counter-payment-preparation.js";
import { readStaffDiningRoundPaymentPreparation } from "./staff-dining-round-payment-preparation.js";
import { counterOrderPermission } from "./merchant-counter-order.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";

export const cardMachinePaymentCommandErrorCodes = [
  "CARD_MACHINE_INPUT_INVALID",
  "CARD_MACHINE_PERMISSION_DENIED",
  "CARD_MACHINE_NOT_FOUND",
  "CARD_MACHINE_NOT_PAYABLE",
  "CARD_MACHINE_AMOUNT_CHANGED",
  "CARD_MACHINE_PAYMENT_WINDOW_CLOSED",
  "CARD_MACHINE_ALREADY_PAID",
  "CARD_MACHINE_IDEMPOTENCY_CONFLICT",
  /**
   * WP-2423 M160: a paid-at time entered after an outage that is before the Store started using
   * the system (its first configuration governed). Nothing was recorded; the slip time is checked.
   */
  "CARD_MACHINE_TAKEN_BEFORE_RECORDS",
  /**
   * WP-2423 M52: the cash handed over is less than the cash total (rounded to 5 cents). Nothing
   * was recorded.
   */
  "CARD_MACHINE_CASH_TENDER_SHORT",
  /**
   * DEC-PAPER-SEND-IDEMPOTENT (b11): the paper slip is already recorded with another paper order
   * or round of the Store (named by its order number when known). Nothing was recorded.
   */
  "CARD_MACHINE_SLIP_ALREADY_RECORDED",
  "CARD_MACHINE_UNAVAILABLE",
] as const;
export type CardMachinePaymentCommandErrorCode =
  (typeof cardMachinePaymentCommandErrorCodes)[number];
export class CardMachinePaymentCommandError extends Error {
  readonly code: CardMachinePaymentCommandErrorCode;
  /** For CARD_MACHINE_AMOUNT_CHANGED: the amount to charge now. */
  readonly totalMinor: string | null;
  /** For CARD_MACHINE_SLIP_ALREADY_RECORDED: the Store's number of the order holding the slip. */
  slipOrderNumber: string | null = null;
  constructor(code: CardMachinePaymentCommandErrorCode, totalMinor: string | null = null) {
    super("card machine payment is unavailable");
    this.name = "CardMachinePaymentCommandError";
    this.code = code;
    this.totalMinor = totalMinor;
  }
}
const fail = (
  code: CardMachinePaymentCommandErrorCode,
  totalMinor: string | null = null,
): never => {
  throw new CardMachinePaymentCommandError(code, totalMinor);
};

export interface CardMachinePaymentResult {
  readonly status: "Recorded" | "AlreadyRecorded";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly amountMinor: string;
  readonly recordingReason: CardMachinePaymentRecord["recordingReason"];
  readonly takenAt: string;
  readonly recordedAt: string;
  /**
   * WP-2423 M52: a counter order paid in cash — the cash total (rounded to 5 cents), what the
   * guest handed over and the change to give back. Null for the card machine.
   */
  readonly cash?: {
    readonly cashTotalMinor: string;
    readonly roundingMinor: string;
    readonly tenderedMinor: string;
    readonly changeMinor: string;
  } | null;
}

export function parseCardMachinePaymentCommand(value: unknown) {
  try {
    // WP-2423 M52: a cash payment at the counter also says what the guest handed over.
    const inCash =
      value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "tenderedMinor");
    const raw = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "orderBatchReference",
      "expectedTotalMinor",
      "slipReference",
      "takenAt",
      ...(inCash ? ["tenderedMinor"] : []),
    ]);
    if (
      typeof raw.expectedTotalMinor !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(raw.expectedTotalMinor)
    )
      return fail("CARD_MACHINE_INPUT_INVALID");
    const tendered = inCash ? raw.tenderedMinor : null;
    if (
      tendered !== null &&
      (typeof tendered !== "string" ||
        !/^[1-9][0-9]{0,15}$/u.test(tendered) ||
        raw.slipReference !== null)
    )
      return fail("CARD_MACHINE_INPUT_INVALID");
    return Object.freeze({
      operationReference: String(parseOrderingReference(raw.operationReference)),
      orderReference: String(parseOrderingReference(raw.orderReference)),
      orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
      expectedTotalMinor: raw.expectedTotalMinor,
      slipReference:
        raw.slipReference === null ? null : parseCardMachineSlipReference(raw.slipReference),
      /** A back-entered paper order: when it was actually paid. Null at the counter. */
      takenAt: raw.takenAt === null ? null : String(parsePaymentInstant(raw.takenAt)),
      /** WP-2423 M52: cash handed over (exact cents); null when paid on the card machine. */
      tenderedMinor: tendered as string | null,
    });
  } catch (error) {
    if (error instanceof CardMachinePaymentCommandError) throw error;
    return fail("CARD_MACHINE_INPUT_INVALID");
  }
}

export type StaffCardMachineOrderKind = "CounterPickup" | "DiningInitial" | "DiningAdditional";

/**
 * The staff entry behind an order batch and its current payment preparation: a counter pickup
 * order (DEC-COUNTER-PAYMENT-RECORD) or a dine-in round staff entered (DEC-STAFF-DINE-IN-ROUND).
 * Null when no staff member entered this batch.
 */
/**
 * DEC-PAPER-SEND-IDEMPOTENT (b11): refuses a paper slip already recorded with another paper order or
 * round of the Store, naming that order, so the same slip never reaches the day's takings twice.
 */
async function refuseHeldPaperSlip(
  tx: ConsumerTransaction,
  scope: { brandReference: string; storeReference: string },
  payments: Pick<ReturnType<typeof createPostgresCardMachinePaymentStore>, "findPaperSlip">,
  slipReference: string,
  takenAt: string,
  sameSend: (held: { readonly operationReference: string }) => boolean = () => false,
): Promise<void> {
  const held = await payments.findPaperSlip(tx as never, slipReference, takenAt);
  if (held === null || sameSend(held)) return;
  const numbers = await listStoreOrderNumbers(tx, scope, [held.orderReference]);
  const refused = new CardMachinePaymentCommandError("CARD_MACHINE_SLIP_ALREADY_RECORDED");
  refused.slipOrderNumber = numbers.get(held.orderReference) ?? null;
  throw refused;
}

async function resolveStaffEntry(
  tx: ConsumerTransaction,
  scope: { tenantReference: string; brandReference: string; storeReference: string },
  allowed: () => Promise<boolean>,
  command: { orderReference: string; orderBatchReference: string },
  options: { now(): string; nextReference(): string },
) {
  const owners = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: allowed,
  };
  const counter = createPostgresCounterOrderEntryStore(owners);
  const entry = (await counter.listByOrders(tx, [command.orderReference])).get(
    command.orderReference,
  );
  if (entry !== undefined) {
    const order = await counter.loadOrder(tx, String(entry.cartReference));
    if (
      order === null ||
      String(order.orderReference) !== command.orderReference ||
      String(order.orderBatchReference) !== command.orderBatchReference
    )
      return null;
    const current = await readCounterPaymentPreparation(
      tx,
      {
        scope,
        now: options.now,
        nextPreparationReference: options.nextReference,
        authorize: allowed,
      },
      {
        submissionReference: String(order.submissionReference),
        guestSessionReference: String(entry.guestSessionReference),
        tipSelectionReference: String(entry.tipSelectionReference),
      },
    );
    return {
      kind: "CounterPickup" as const,
      submissionReference: String(order.submissionReference),
      recordedAfterOutage: entry.recordedAfterOutage,
      current,
    };
  }
  const round = (
    await createPostgresStaffDiningRoundEntryStore(owners).listByOrders(tx, [
      command.orderReference,
    ])
  ).get(command.orderBatchReference);
  if (round === undefined || round.orderReference !== command.orderReference) return null;
  const batch = await createPostgresStaffDiningRoundEntryStore(owners).loadBatch(
    tx,
    String(round.entry.guestSessionReference),
  );
  if (
    batch === null ||
    String(batch.orderReference) !== command.orderReference ||
    String(batch.orderBatchReference) !== command.orderBatchReference
  )
    return null;
  const current = await readStaffDiningRoundPaymentPreparation(
    tx,
    {
      scope,
      now: options.now,
      nextPreparationReference: options.nextReference,
      authorize: allowed,
    },
    {
      submissionReference: String(batch.submissionReference),
      guestSessionReference: String(round.entry.guestSessionReference),
      tipSelectionReference: String(round.entry.tipSelectionReference),
    },
  );
  return {
    kind: current?.additional === true ? ("DiningAdditional" as const) : ("DiningInitial" as const),
    submissionReference: String(batch.submissionReference),
    recordedAfterOutage: round.entry.recordedAfterOutage,
    current,
  };
}

/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 1–2): after the Store's card machine approved the
 * payment, staff record it. The amount is the server's payment preparation total (quote with tax
 * plus the tip choice), checked against what staff charged; the same payment admission as an
 * online payment (order still payable, capacity clock open, reserved stock intact) applies; the
 * Payment record, its PaymentSucceeded event and audit are one transaction, so the order reaches
 * acceptance and the kitchen through the ordinary consumers. Only counter orders and dine-in rounds
 * staff entered for a table (WP-2423 Q7 slice 2, DEC-STAFF-DINE-IN-ROUND) take this payment.
 */
export function createMerchantCardMachinePayment(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  /** The same owner admission an online payment of a pickup Order passes, built for this staff
   * member's authority. */
  admission(input: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    preparation: OrderPaymentPreparationEvidence;
    allowed(): Promise<boolean>;
    /** Which online payment admission applies: a counter pickup order, or a staff-entered
     * dine-in round (the table Order's first round or a later one). */
    kind: StaffCardMachineOrderKind;
  }): PaymentIntentClaimAdmission;
  environment: "Test" | "Live";
  nextReference(): string;
  /** Told the original error of an unexpected failure (the pilot logs code and frames only). */
  onUnexpected?(error: unknown): void;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const now = () => options.persistence.now();
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<CardMachinePaymentResult> => {
    const session = await options.authentication.authorize(input);
    const command = parseCardMachinePaymentCommand(input.command);
    const intentDigest = parsePaymentDigest(
      "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            kind: "CardMachinePayment/v1",
            orderReference: command.orderReference,
            orderBatchReference: command.orderBatchReference,
            expectedTotalMinor: command.expectedTotalMinor,
            slipReference: command.slipReference,
            takenAt: command.takenAt,
            // A cash payment is a different intent (the card one's digest is unchanged).
            ...(command.tenderedMinor === null ? {} : { tenderedMinor: command.tenderedMinor }),
          }),
        ),
    );
    const reply = (status: CardMachinePaymentResult["status"], record: CardMachinePaymentRecord) =>
      Object.freeze({
        status,
        orderReference: record.orderReference,
        orderBatchReference: record.orderBatchReference,
        amountMinor: record.preparation.total.amountMinor.toString(),
        recordingReason: record.recordingReason,
        takenAt: String(record.takenAt),
        recordedAt: String(record.recordedAt),
        cash:
          record.cash === undefined
            ? null
            : Object.freeze({
                cashTotalMinor: cardMachinePaymentTakenMinor(record).toString(),
                roundingMinor: record.cash.roundingMinor.toString(),
                tenderedMinor: record.cash.tenderedMinor.toString(),
                changeMinor: record.cash.changeMinor.toString(),
              }),
      });
    try {
      // WP-2423: one authorized run. The staff member and the counter-order permission are
      // resolved in full once at the start and once more before the commit (inside this
      // transaction, so a permission withdrawn or Session ended meanwhile records nothing). The
      // Payment, Ordering and admission owner reads in between take the run's no-query guard
      // instead of re-resolving the caller (~30 statements each) while their rows are locked.
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                counterOrderPermission,
                session.sessionReference,
              ).catch(onlyRefusal(() => fail("CARD_MACHINE_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true) return fail("CARD_MACHINE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("CARD_MACHINE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const resolved = authority.scope;
            const allowed = () => authority.guard();
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = {
              tenantReference: String(resolved.selected.tenantReference),
              brandReference: String(resolved.context.brand.brandReference),
              storeReference: String(resolved.store.storeReference),
            };
            const actorReference = String(resolved.actorReference);
            const payments = createPostgresCardMachinePaymentStore({
              scope,
              authorize: async (_tx, value) =>
                value.orderReference === command.orderReference && (await allowed()),
            });
            const prior = await payments.loadByOperation(tx, command.operationReference);
            if (prior !== null) {
              if (
                prior.intentDigest !== intentDigest ||
                prior.actorReference !== actorReference ||
                prior.orderBatchReference !== command.orderBatchReference
              )
                return fail("CARD_MACHINE_IDEMPOTENCY_CONFLICT");
              return reply("AlreadyRecorded", prior);
            }
            const recordedAt = parsePaymentInstant(now());
            const takenAt =
              command.takenAt === null ? recordedAt : parsePaymentInstant(command.takenAt);
            if (
              takenAt > recordedAt ||
              Date.parse(recordedAt) - Date.parse(takenAt) > cardMachineBackEntryWindowMs
            )
              return fail("CARD_MACHINE_INPUT_INVALID");
            // WP-2423 M160: the Store's reports and settlement begin when it started using the
            // system; a payment entered with an earlier time would be in no day. An outage is
            // always after that, so such a time is a mistake: refuse it before anything is written.
            if (command.takenAt !== null) {
              const opening = await readStoreFirstConfigurationGoverningFrom(tx, scope);
              // A Store with no published configuration has no business day yet; its readers
              // refuse until one exists, so there is nothing to compare with here.
              if (opening !== null && takenAt < opening)
                return fail("CARD_MACHINE_TAKEN_BEFORE_RECORDS");
            }
            if (
              (await payments.loadByBatch(
                tx,
                command.orderReference,
                command.orderBatchReference,
              )) !== null
            )
              return fail("CARD_MACHINE_ALREADY_PAID");
            // DEC-PAPER-SEND-IDEMPOTENT (b11): a paper slip is recorded once, on one order or round.
            if (command.takenAt !== null && command.slipReference !== null)
              await refuseHeldPaperSlip(tx, scope, payments, command.slipReference, takenAt);
            // Only an order staff took at the counter, or a dine-in round staff entered for a table,
            // is paid on the Store's card machine.
            const staffEntry = await resolveStaffEntry(tx, scope, allowed, command, {
              now,
              nextReference: options.nextReference,
            });
            if (staffEntry === null) return fail("CARD_MACHINE_NOT_FOUND");
            // WP-2423 (v15 fabf0261): only an order or round taken on paper during an outage is
            // paid at an earlier time. One sent live in the system is paid as it is recorded
            // (the counter and Orders never send a time for it), so a back-dated time for it is
            // refused before anything is written.
            if (command.takenAt !== null && !staffEntry.recordedAfterOutage)
              return fail("CARD_MACHINE_INPUT_INVALID");
            // WP-2423 M52: cash is taken at the counter (walk-up and pickup); a table's cash is
            // taken with its bill at checkout.
            if (command.tenderedMinor !== null && staffEntry.kind !== "CounterPickup")
              return fail("CARD_MACHINE_INPUT_INVALID");
            const order = { submissionReference: staffEntry.submissionReference };
            const current = staffEntry.current;
            if (current === null) return fail("CARD_MACHINE_NOT_PAYABLE");
            const preparation = current.preparation;
            const total = preparation.total.amountMinor.toString();
            if (total !== command.expectedTotalMinor)
              return fail("CARD_MACHINE_AMOUNT_CHANGED", total);
            if (recordedAt >= String(preparation.capacityExpiresAt))
              return fail("CARD_MACHINE_PAYMENT_WINDOW_CLOSED");
            // The table's cash rules: rounded to 5 cents, at least that handed over, the change.
            const cash =
              command.tenderedMinor === null
                ? null
                : planCounterCashTender(preparation, BigInt(command.tenderedMinor));
            const record = parseCardMachinePaymentRecord({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              cardMachinePaymentReference: options.nextReference(),
              paymentIntentReference: options.nextReference(),
              paymentAttemptReference: options.nextReference(),
              paymentOperationReference: current.paymentOperationReference,
              operationReference: command.operationReference,
              intentDigest,
              orderReference: command.orderReference,
              orderBatchReference: command.orderBatchReference,
              submissionReference: String(order.submissionReference),
              preparation,
              environment: options.environment,
              slipReference: command.slipReference,
              recordingReason: command.takenAt === null ? "AtCounter" : "RecordedAfterOutage",
              takenAt,
              recordedAt,
              actorReference,
              eventReference: options.nextReference(),
              auditReference: options.nextReference(),
              ...(cash === null ? {} : { cash }),
            });
            const admitted = await options
              .admission({ scope, preparation, allowed, kind: staffEntry.kind })
              .admit(tx, cardMachinePaymentIntentView(record), recordedAt);
            if (admitted === false || (admitted !== true && admitted.validUntil <= recordedAt))
              return fail("CARD_MACHINE_NOT_PAYABLE");
            const saved = await payments.record(tx, record);
            return reply(saved.status === "Created" ? "Recorded" : "AlreadyRecorded", saved.record);
          },
        ),
      );
    } catch (error) {
      if (error instanceof CardMachinePaymentCommandError) throw error;
      if (error instanceof CardMachinePaymentError) {
        if (error.code === "CARD_MACHINE_IDEMPOTENCY_CONFLICT")
          return fail("CARD_MACHINE_IDEMPOTENCY_CONFLICT");
        if (error.code === "CARD_MACHINE_ALREADY_PAID") return fail("CARD_MACHINE_ALREADY_PAID");
        if (error.code === "CARD_MACHINE_INPUT_INVALID") return fail("CARD_MACHINE_INPUT_INVALID");
        if (error.code === "CARD_MACHINE_PERMISSION_DENIED")
          return fail("CARD_MACHINE_PERMISSION_DENIED");
        if (error.code === "CARD_MACHINE_CASH_TENDER_SHORT")
          return fail("CARD_MACHINE_CASH_TENDER_SHORT");
        if (error.code === "CARD_MACHINE_SLIP_ALREADY_RECORDED")
          return fail("CARD_MACHINE_SLIP_ALREADY_RECORDED");
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED") return fail("CARD_MACHINE_PERMISSION_DENIED");
      if (code === "23505") return fail("CARD_MACHINE_ALREADY_PAID");
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      return keepingCause(() => fail("CARD_MACHINE_UNAVAILABLE"))(error);
    }
  };
}

/** Whether the paid order or round went on to the kitchen (accepted) with its payment record. */
export type CardMachinePaymentAcceptance = "Accepted" | "NotAccepted";

/**
 * WP-2423 (D1, DEC-STAFF-DINE-IN-ROUND decision 4): a counter order or a staff-entered table round
 * paid on the Store's card machine is accepted by the server as part of recording that payment —
 * by the staff member who recorded it, at the Order version the Order is at now (a table Order's
 * version moves with every other round) — so it reaches the kitchen whether or not the page that
 * sent it stays open. A retry of the same payment record (same operation) retries the acceptance;
 * an acceptance already made by anyone is reported as accepted. When the order cannot be accepted
 * now (no acceptance permission, acceptance time passed, stock changed) the payment stays recorded
 * and staff are told to accept it in Orders.
 */
export function withPaidBatchAcceptance(
  record: ReturnType<typeof createMerchantCardMachinePayment>,
  options: {
    accept(
      input: { sessionCookie: unknown; csrf: unknown; command: unknown },
      mode: "CurrentVersion",
    ): Promise<{ status: "Created" | "AlreadyCommitted"; acceptedOrderVersion: number }>;
    nextReference(): string;
    /** Told the original error of an acceptance that did not happen (code and frames only). */
    onNotAccepted?(error: unknown): void;
  },
) {
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<CardMachinePaymentResult & { readonly acceptance: CardMachinePaymentAcceptance }> => {
    const paid = await record(input);
    const attempt = () =>
      options.accept(
        {
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
          command: {
            acceptanceReference: options.nextReference(),
            operationReference: options.nextReference(),
            orderReference: paid.orderReference,
            orderBatchReference: paid.orderBatchReference,
          },
        },
        "CurrentVersion",
      );
    let acceptance: CardMachinePaymentAcceptance;
    try {
      await attempt().catch(async (error: unknown) => {
        // Another acceptance of the same round may have won a race (a retry, or Orders): read
        // again; it then reports the acceptance already made.
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "ORDER_ACCEPTANCE_NOT_ACCEPTABLE") throw error;
        return attempt();
      });
      acceptance = "Accepted";
    } catch (error) {
      try {
        options.onNotAccepted?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      acceptance = "NotAccepted";
    }
    return Object.freeze({ ...paid, acceptance });
  };
}

/**
 * WP-2423 (DEC-PAPER-ORDER-PAID-AT-SEND, v15 batch-5 review): the paid-at time a paper order says
 * it was paid at during the outage, checked as its payment record will check it — not after the
 * server's own now, within the back-entry window, and not before the Store's records begin —
 * before the order is placed. A refusal the payment record would certainly make then never leaves
 * a placed, unpaid paper order behind (a sale that would otherwise be released at its pickup hold
 * unless staff entered it again). Nothing is written; an outage of this read refuses the send as
 * unavailable (never as no permission), so staff send again.
 */
export function createMerchantPaperPaidAtCheck(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  onUnexpected?(error: unknown): void;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    takenAt: string;
    /**
     * DEC-PAPER-SEND-IDEMPOTENT (b11): the slip the paper order's payment carries, its payment
     * operation and the order (or round) operation it is sent with. A slip already recorded with
     * another paper order is refused before anything is placed, unless this is the same send again
     * (that order operation was recorded before: its own replay answers it).
     */
    paperSlip?: {
      readonly slipReference: string | null;
      readonly paymentOperationReference: string;
      readonly orderOperationReference: unknown;
    };
  }): Promise<void> => {
    const session = await options.authentication.authorize(input);
    let takenAt: string;
    try {
      takenAt = String(parsePaymentInstant(input.takenAt));
    } catch {
      return fail("CARD_MACHINE_INPUT_INVALID");
    }
    try {
      await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                counterOrderPermission,
                session.sessionReference,
              ).catch(onlyRefusal(() => fail("CARD_MACHINE_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true) return fail("CARD_MACHINE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("CARD_MACHINE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const now = String(parsePaymentInstant(options.persistence.now()));
            if (
              takenAt > now ||
              Date.parse(now) - Date.parse(takenAt) > cardMachineBackEntryWindowMs
            )
              return fail("CARD_MACHINE_INPUT_INVALID");
            const resolved = authority.scope;
            const opening = await readStoreFirstConfigurationGoverningFrom(
              transaction as unknown as ConsumerTransaction,
              {
                brandReference: String(resolved.context.brand.brandReference),
                storeReference: String(resolved.store.storeReference),
              },
              // The caller's permission was resolved above: this read failing is an outage.
            ).catch(keepingCause(() => fail("CARD_MACHINE_UNAVAILABLE")));
            if (opening !== null && takenAt < opening)
              return fail("CARD_MACHINE_TAKEN_BEFORE_RECORDS");
            const paper = input.paperSlip;
            if (paper === undefined || paper.slipReference === null) return;
            const owners = {
              brandReference: String(resolved.context.brand.brandReference),
              storeReference: String(resolved.store.storeReference),
            };
            const allowed = () => authority.guard();
            const tx = transaction as unknown as ConsumerTransaction;
            const operation = paper.orderOperationReference;
            if (
              typeof operation === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(operation)
            ) {
              const sentBefore =
                (await createPostgresCounterOrderEntryStore({
                  ...owners,
                  authorize: allowed,
                }).loadByOperation(tx as never, operation)) !== null ||
                (await createPostgresStaffDiningRoundEntryStore({
                  ...owners,
                  authorize: allowed,
                }).loadByOperation(tx as never, operation)) !== null;
              if (sentBefore) return;
            }
            await refuseHeldPaperSlip(
              tx,
              owners,
              createPostgresCardMachinePaymentStore({
                scope: owners,
                authorize: async () => allowed(),
              }),
              paper.slipReference,
              takenAt,
              (held) => held.operationReference === paper.paymentOperationReference,
            );
          },
        ),
      );
    } catch (error) {
      if (
        error instanceof CardMachinePaymentCommandError &&
        error.code !== "CARD_MACHINE_UNAVAILABLE"
      )
        throw error;
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      if (error instanceof CardMachinePaymentCommandError) throw error;
      return keepingCause(() => fail("CARD_MACHINE_UNAVAILABLE"))(error);
    }
  };
}
