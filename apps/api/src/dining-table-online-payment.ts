import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createCancelIntentRequest,
  createCreateIntentRequest,
  createPostgresDiningTableSettlementStore,
  createRetrieveIntentRequest,
  type DiningTableOnlinePaymentRecord,
  type PaymentProviderAdapter,
  type PaymentProviderOutcome,
} from "@rms/payment";
import {
  readDiningTableBill,
  tableTipMinor,
  type DiningTableBill,
  type DiningTableTip,
} from "./merchant-dining-table-checkout.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4 (decisions 3-5): a guest pays the whole table on their phone.
 * One attempt is one Provider transaction for the table's bill and the tip chosen once. It is
 * created with the Provider first (its own idempotency key, so a retry finds the same one) and
 * then recorded; the database refuses it when another attempt is open or the table already paid
 * or was written off — then the Provider transaction is cancelled. The outcome is what the
 * Provider reports: captured → the table's one settlement (method Online, split by round under its
 * settlement number, tip on the last round); failed or cancelled → the guest may try again.
 * Staff "stop" an attempt a guest gave up on: whatever the Provider says is recorded (a payment
 * the guest did finish becomes the settlement; an unfinished one is cancelled).
 * Provider calls never run inside a database transaction.
 */
export type DiningTableOnlinePaymentErrorCode =
  | "TABLE_ONLINE_PAYMENT_NOT_CHECKING_OUT"
  | "TABLE_ONLINE_PAYMENT_NOTHING_OWED"
  | "TABLE_ONLINE_PAYMENT_ALREADY_PAID"
  | "TABLE_ONLINE_PAYMENT_BILL_CHANGED"
  | "TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING"
  | "TABLE_ONLINE_PAYMENT_STILL_PROCESSING"
  | "TABLE_ONLINE_PAYMENT_INPUT_INVALID"
  | "TABLE_ONLINE_PAYMENT_UNAVAILABLE";
export class DiningTableOnlinePaymentError extends Error {
  constructor(readonly code: DiningTableOnlinePaymentErrorCode) {
    super(code);
    this.name = "DiningTableOnlinePaymentError";
  }
}
const fail = (code: DiningTableOnlinePaymentErrorCode): never => {
  throw new DiningTableOnlinePaymentError(code);
};

export interface TableOnlinePaymentAuthority {
  readonly diningSessionReference: string;
  /** The guest paying (a staff stop uses the guest who started the attempt). */
  readonly guestSessionReference: string | null;
  /** Rechecks the caller in this transaction (guest or staff). */
  allowed(tx: ConsumerTransaction): Promise<boolean>;
}
interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface DiningTableOnlinePaymentOptions {
  readonly scope: Scope;
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  readonly provider: Pick<
    PaymentProviderAdapter,
    "createIntent" | "retrieveIntent" | "cancelIntent"
  >;
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly now: () => string;
  readonly nextReference: () => string;
}

/** The guest-facing state of the table's payment. */
export interface DiningTableOnlinePaymentView {
  readonly bill: DiningTableBill;
  /** The open attempt this guest can finish (pay with a card, or come back to). */
  readonly attempt: null | {
    readonly onlinePaymentReference: string;
    /** The guest's operation the Provider transaction was created under (internal only). */
    readonly operationReference: string;
    readonly providerIntentReference: string;
    readonly totalMinor: string;
    readonly tipMinor: string;
    readonly mine: boolean;
  };
}

const sha = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
/** The attempt's reference, derived from the guest's operation (a retry finds the same one). */
function attemptReference(operationReference: string) {
  const digest = createHash("sha256")
    .update("DiningTableOnlinePayment:" + operationReference)
    .digest("hex");
  return (
    operationReference.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    (8 + (parseInt(digest.slice(3, 4), 16) & 3)).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}
const milliseconds = (value: string) => new Date(Date.parse(value)).toISOString();

export function createDiningTableOnlinePayments(options: DiningTableOnlinePaymentOptions) {
  const scope = options.scope;
  const store = (authority: TableOnlinePaymentAuthority) =>
    createPostgresDiningTableSettlementStore({
      scope,
      authorize: async (tx) =>
        (await authority.allowed(tx as unknown as ConsumerTransaction)) === true,
    });
  const context = (attempt: { onlinePaymentReference: string; operationReference: string }) => ({
    provider: "Stripe" as const,
    environment: options.environment,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    paymentAttemptReference: attempt.onlinePaymentReference,
    operationReference: attempt.operationReference,
  });
  const snapshot = (outcome: PaymentProviderOutcome, attempt: DiningTableOnlinePaymentRecord) =>
    outcome.kind === "Snapshot" &&
    String(outcome.providerIntentReference) === attempt.providerIntentReference
      ? outcome
      : null;
  const bill = async (
    tx: ConsumerTransaction,
    authority: TableOnlinePaymentAuthority,
  ): Promise<DiningTableBill> =>
    readDiningTableBill(tx, scope, {
      diningSessionReference: authority.diningSessionReference,
      observedAt: milliseconds(options.now()),
      authorize: () => authority.allowed(tx),
    });
  const attemptsOf = async (
    tx: ConsumerTransaction,
    authority: TableOnlinePaymentAuthority,
    orderReference: string,
  ) => store(authority).listOnlinePaymentsByOrders(tx, [orderReference]);
  const viewOf = (
    current: DiningTableBill,
    attempts: readonly DiningTableOnlinePaymentRecord[],
    authority: TableOnlinePaymentAuthority,
  ): DiningTableOnlinePaymentView => {
    const open = attempts.find((attempt) => attempt.outcome === null);
    const { settlementRecord, ...publicBill } = current as DiningTableBill & {
      settlementRecord?: unknown;
    };
    void settlementRecord;
    return Object.freeze({
      bill: publicBill,
      attempt:
        open === undefined
          ? null
          : Object.freeze({
              onlinePaymentReference: open.onlinePaymentReference,
              operationReference: open.operationReference,
              providerIntentReference: open.providerIntentReference,
              totalMinor: open.totalMinor.toString(),
              tipMinor: open.tipMinor.toString(),
              mine: open.guestSessionReference === authority.guestSessionReference,
            }),
    });
  };

  /** The owed rounds and what the table pays now (the same rule as staff use at the table). */
  const owedPlan = (current: DiningTableBill, tip: DiningTableTip) => {
    if (current.paymentTiming !== "PayLater" || current.sessionPhase !== "Closing")
      return fail("TABLE_ONLINE_PAYMENT_NOT_CHECKING_OUT");
    if (current.settlement !== null || current.writeOff !== null)
      return fail("TABLE_ONLINE_PAYMENT_ALREADY_PAID");
    if (!current.consistent) return fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
    const owed = current.rounds.filter((round) => !round.paid && round.totalMinor !== "0");
    if (current.orderReference === null || owed.length === 0)
      return fail("TABLE_ONLINE_PAYMENT_NOTHING_OWED");
    let tipMinor: bigint;
    try {
      tipMinor = tableTipMinor(tip, BigInt(current.owed.subtotalMinor));
    } catch {
      return fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID");
    }
    return {
      orderReference: current.orderReference,
      owed,
      roundsMinor: BigInt(current.owed.totalMinor),
      tipMinor,
    };
  };

  /**
   * Records what the Provider reports for an attempt; a capture becomes the table's settlement.
   * Returns false when the Provider has no final answer yet.
   */
  const recordOutcome = async (
    authority: TableOnlinePaymentAuthority,
    attempt: DiningTableOnlinePaymentRecord,
    outcome: NonNullable<ReturnType<typeof snapshot>>,
    actor: { type: "System" } | { type: "User"; reference: string },
  ) => {
    const status =
      outcome.status === "Captured"
        ? ("Captured" as const)
        : outcome.status === "Failed"
          ? ("Failed" as const)
          : outcome.status === "Cancelled"
            ? ("Cancelled" as const)
            : null;
    if (status === null) return false;
    if (
      status === "Captured" &&
      (outcome.capturedAmount.amountMinor !== attempt.totalMinor ||
        outcome.capturedAmount.currencyCode !== "CAD" ||
        outcome.providerTransactionReference === null)
    )
      return fail("TABLE_ONLINE_PAYMENT_UNAVAILABLE");
    await options.transactions.run(async (tx) => {
      const recordedAt = milliseconds(options.now());
      const occurredAt =
        milliseconds(outcome.observedAt) > recordedAt
          ? recordedAt
          : milliseconds(outcome.observedAt);
      const owner = store(authority);
      await owner.recordOnlinePaymentOutcome(tx, {
        onlinePaymentReference: attempt.onlinePaymentReference,
        orderReference: attempt.orderReference,
        status,
        capturedMinor: status === "Captured" ? attempt.totalMinor : null,
        providerTransactionReference:
          status === "Captured" ? String(outcome.providerTransactionReference) : null,
        occurredAt,
        recordedAt,
        auditReference: options.nextReference(),
        correlationReference: attempt.operationReference,
        actor,
      });
      if (status !== "Captured") return;
      const current = await bill(tx, authority);
      if (current.settlement !== null) return;
      const owed = current.rounds.filter((round) => !round.paid && round.totalMinor !== "0");
      if (BigInt(current.owed.totalMinor) !== attempt.roundsMinor)
        return fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
      const [saved] = await owner
        .listOnlinePaymentsByOrders(tx, [attempt.orderReference])
        .then((all) =>
          all.filter((entry) => entry.onlinePaymentReference === attempt.onlinePaymentReference),
        );
      await owner.record(tx, {
        settlementReference: options.nextReference(),
        operationReference: attempt.operationReference,
        intentDigest: attempt.intentDigest,
        diningSessionReference: attempt.diningSessionReference,
        orderReference: attempt.orderReference,
        method: "Online",
        rounds: owed.map((round) => ({
          orderBatchReference: round.orderBatchReference,
          submissionReference: round.submissionReference,
          sequence: round.roundNumber,
          roundMinor: BigInt(round.totalMinor),
        })),
        tipMinor: attempt.tipMinor,
        tenderedMinor: null,
        environment: options.environment,
        slipReference: null,
        recordingReason: "AtTable",
        takenAt: saved?.outcome?.occurredAt ?? occurredAt,
        recordedAt,
        // The guest's online payment is recorded by the System; the guest is not a staff actor.
        actorReference: attempt.guestSessionReference,
        auditReference: options.nextReference(),
        correlationReference: attempt.operationReference,
        onlinePaymentReference: attempt.onlinePaymentReference,
      });
    });
    return true;
  };

  /** Asks the Provider about the open attempt and records any final answer. */
  const refreshOpen = async (
    authority: TableOnlinePaymentAuthority,
    stop: { actor: { type: "System" } | { type: "User"; reference: string } } | null,
  ) => {
    const found = await options.transactions.run(async (tx) => {
      const current = await bill(tx, authority);
      if (current.orderReference === null) return null;
      return (await attemptsOf(tx, authority, current.orderReference)).find(
        (attempt) => attempt.outcome === null,
      );
    });
    if (found === null || found === undefined) return;
    const request = {
      context: context(found),
      providerIntentReference: found.providerIntentReference,
    };
    let reported = snapshot(
      await options.provider.retrieveIntent(
        createRetrieveIntentRequest({
          operation: "RetrieveIntent",
          purpose: "RetrievePaymentIntent",
          ...request,
        } as never),
      ),
      found,
    );
    const actor = stop?.actor ?? { type: "System" as const };
    if (reported !== null && (await recordOutcome(authority, found, reported, actor))) return;
    if (stop === null) return;
    // Staff stop an attempt the guest gave up on: cancel it with the Provider, then record what
    // the Provider says (a payment the guest did finish meanwhile is still recorded as paid).
    reported = snapshot(
      await options.provider.cancelIntent(
        createCancelIntentRequest({
          operation: "CancelIntent",
          purpose: "CancelPaymentIntent",
          idempotencyKey: "dining-table-online-cancel:" + found.onlinePaymentReference,
          ...request,
        } as never),
      ),
      found,
    );
    if (reported === null || !(await recordOutcome(authority, found, reported, actor)))
      return fail("TABLE_ONLINE_PAYMENT_STILL_PROCESSING");
  };

  const read = (authority: TableOnlinePaymentAuthority) =>
    options.transactions.run(async (tx) => {
      const current = await bill(tx, authority);
      const attempts =
        current.orderReference === null
          ? []
          : await attemptsOf(tx, authority, current.orderReference);
      return viewOf(current, attempts, authority);
    });

  return Object.freeze({
    read,
    /**
     * The guest pays the whole table: the bill as it stands and the tip chosen once. Coming back
     * (same operation, or this guest's own open attempt) returns the same attempt.
     */
    async start(
      authority: TableOnlinePaymentAuthority,
      command: { readonly operationReference: string; readonly tip: DiningTableTip },
    ): Promise<DiningTableOnlinePaymentView> {
      if (authority.guestSessionReference === null)
        return fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID");
      // An earlier attempt may have finished with the Provider meanwhile.
      await refreshOpen(authority, null);
      const intentDigest = sha({
        kind: "DiningTableOnlinePayment/v1",
        diningSessionReference: authority.diningSessionReference,
        tip: command.tip,
      });
      const plan = await options.transactions.run(async (tx) => {
        const current = await bill(tx, authority);
        const attempts =
          current.orderReference === null
            ? []
            : await attemptsOf(tx, authority, current.orderReference);
        const same = attempts.find(
          (attempt) => attempt.operationReference === command.operationReference,
        );
        if (same !== undefined) {
          if (same.intentDigest !== intentDigest) return fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID");
          return { view: viewOf(current, attempts, authority) };
        }
        const open = attempts.find((attempt) => attempt.outcome === null);
        if (open !== undefined)
          return open.guestSessionReference === authority.guestSessionReference
            ? { view: viewOf(current, attempts, authority) }
            : fail("TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING");
        return { plan: owedPlan(current, command.tip) };
      });
      if ("view" in plan) return plan.view;
      const onlinePaymentReference = attemptReference(command.operationReference);
      const attempt = { onlinePaymentReference, operationReference: command.operationReference };
      const totalMinor = plan.plan.roundsMinor + plan.plan.tipMinor;
      const created = await options.provider.createIntent(
        createCreateIntentRequest({
          operation: "CreateIntent",
          purpose: "CreatePaymentIntent",
          context: context(attempt),
          idempotencyKey: "dining-table-online:" + onlinePaymentReference,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          amount: { amountMinor: totalMinor, currencyCode: "CAD" },
        } as never),
      );
      if (created.kind !== "Snapshot") return fail("TABLE_ONLINE_PAYMENT_UNAVAILABLE");
      try {
        await options.transactions.run(async (tx) => {
          // The bill may have changed while the Provider answered: what is owed must still be it.
          const current = await bill(tx, authority);
          const again = owedPlan(current, command.tip);
          if (again.roundsMinor !== plan.plan.roundsMinor || again.tipMinor !== plan.plan.tipMinor)
            return fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
          await store(authority).recordOnlinePayment(tx, {
            onlinePaymentReference,
            operationReference: command.operationReference,
            intentDigest,
            diningSessionReference: authority.diningSessionReference,
            orderReference: again.orderReference,
            guestSessionReference: authority.guestSessionReference as string,
            roundsMinor: again.roundsMinor,
            tipMinor: again.tipMinor,
            providerAccountReference: options.providerAccountReference,
            environment: options.environment,
            providerIntentReference: String(created.providerIntentReference),
            createdAt: milliseconds(options.now()),
            auditReference: options.nextReference(),
          });
        });
      } catch (error) {
        // Staff took a payment, another guest started paying, or the bill changed meanwhile:
        // nothing may be charged on this Provider transaction.
        await options.provider
          .cancelIntent(
            createCancelIntentRequest({
              operation: "CancelIntent",
              purpose: "CancelPaymentIntent",
              context: context(attempt),
              idempotencyKey: "dining-table-online-cancel:" + onlinePaymentReference,
              providerIntentReference: created.providerIntentReference,
            } as never),
          )
          .catch(() => undefined);
        if (error instanceof DiningTableOnlinePaymentError) throw error;
        const message = String((error as { message?: unknown } | null)?.message ?? "");
        return fail(
          /already paid|written off/u.test(message)
            ? "TABLE_ONLINE_PAYMENT_ALREADY_PAID"
            : /already paying/u.test(message)
              ? "TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING"
              : "TABLE_ONLINE_PAYMENT_UNAVAILABLE",
        );
      }
      return read(authority);
    },
    /** What the Provider says about the open attempt (after the guest paid, failed or came back). */
    async refresh(authority: TableOnlinePaymentAuthority) {
      await refreshOpen(authority, null);
      return read(authority);
    },
    /** Staff stop the attempt a guest gave up on (recording a payment the guest did finish). */
    async stop(authority: TableOnlinePaymentAuthority, actorReference: string) {
      await refreshOpen(authority, { actor: { type: "User", reference: actorReference } });
      return read(authority);
    },
  });
}
