import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createCancelIntentRequest,
  createCreateIntentRequest,
  createPostgresDiningTableSettlementStore,
  createRetrieveIntentRequest,
  type DiningTableOnlinePaymentRecord,
  type DiningTableSplitPlanRecord,
  type PaymentProviderAdapter,
  type PaymentProviderOutcome,
} from "@rms/payment";
import {
  readDiningTableBill,
  roundOrdersOf,
  tableTipMinor,
  type DiningTableBill,
  type DiningTableTip,
} from "./merchant-dining-table-checkout.js";
import { tipRefusal } from "./merchant-store-features.js";

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
  /** WP-2423 item 8 ⑦ (Owner decision 11): the Store turned tips off; pay with no tip. */
  | "TABLE_ONLINE_PAYMENT_TIPS_OFF"
  /** The tip percentage is not one the Store offers now: the bill is read again. */
  | "TABLE_ONLINE_PAYMENT_TIP_CHOICES_CHANGED"
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
    /** WP-2423 item 8 ④: the part of a split bill this payment is for (null: the whole table). */
    readonly partNumber: number | null;
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
  ): Promise<Awaited<ReturnType<typeof readDiningTableBill>>> =>
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
    // This guest's own open payment first; otherwise a whole-table one another guest started.
    const open =
      attempts.find(
        (attempt) =>
          attempt.outcome === null &&
          attempt.guestSessionReference === authority.guestSessionReference,
      ) ?? attempts.find((attempt) => attempt.outcome === null && attempt.part === null);
    const { settlementRecord, splitPlanRecord, ...publicBill } = current as DiningTableBill & {
      settlementRecord?: unknown;
      splitPlanRecord?: unknown;
    };
    void settlementRecord;
    void splitPlanRecord;
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
              partNumber: open.part?.partNumber ?? null,
            }),
    });
  };

  /** The owed rounds and what the table pays now (the same rule as staff use at the table). */
  /**
   * WP-2423 item 8 ④: a split bill is paid part by part — the guest's chosen part, its own amount
   * and its tip on its own share before tax; a bill paid whole, the whole table.
   */
  const owedPlan = (
    current: DiningTableBill & { splitPlanRecord?: DiningTableSplitPlanRecord | null },
    tip: DiningTableTip,
    partNumber: number | null,
  ) => {
    if (current.paymentTiming !== "PayLater" || current.sessionPhase !== "Closing")
      return fail("TABLE_ONLINE_PAYMENT_NOT_CHECKING_OUT");
    if (current.settlement !== null || current.writeOff !== null)
      return fail("TABLE_ONLINE_PAYMENT_ALREADY_PAID");
    if (!current.consistent) return fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
    if ((current.split === null) !== (partNumber === null))
      return fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID");
    const part =
      current.split === null
        ? null
        : (current.split.parts.find((entry) => entry.partNumber === partNumber) ??
          fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID"));
    if (part !== null && part.payment !== null) return fail("TABLE_ONLINE_PAYMENT_ALREADY_PAID");
    const plan = current.splitPlanRecord ?? null;
    if (part !== null && plan === null) return fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
    const owed = current.rounds.filter((round) => !round.paid && round.totalMinor !== "0");
    if (current.orderReference === null || owed.length === 0)
      return fail("TABLE_ONLINE_PAYMENT_NOTHING_OWED");
    const refused = tipRefusal(current.tips, tip);
    if (refused === "TipsOff") return fail("TABLE_ONLINE_PAYMENT_TIPS_OFF");
    if (refused === "TipChoicesChanged") return fail("TABLE_ONLINE_PAYMENT_TIP_CHOICES_CHANGED");
    let tipMinor: bigint;
    try {
      tipMinor = tableTipMinor(
        tip,
        BigInt(part === null ? current.owed.subtotalMinor : part.subtotalMinor),
      );
    } catch {
      return fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID");
    }
    return {
      orderReference: current.orderReference,
      owed,
      roundsMinor: BigInt(part === null ? current.owed.totalMinor : part.amountMinor),
      tipMinor,
      part:
        part === null || plan === null
          ? null
          : { splitPlanReference: plan.splitPlanReference, partNumber: part.partNumber },
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
      // WP-2423 item 8 ④: a part's capture pays exactly that part's slices of the rounds.
      const planPart =
        attempt.part === null
          ? null
          : ((current.splitPlanRecord?.splitPlanReference === attempt.part.splitPlanReference
              ? current.splitPlanRecord.parts.find(
                  (entry) => entry.partNumber === attempt.part?.partNumber,
                )
              : undefined) ?? fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED"));
      if (
        planPart === null
          ? BigInt(current.owed.totalMinor) !== attempt.roundsMinor
          : planPart.amountMinor !== attempt.roundsMinor
      )
        return fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
      const roundOf = new Map(current.rounds.map((round) => [round.orderBatchReference, round]));
      const [saved] = await owner
        .listOnlinePaymentsByOrders(tx, [attempt.orderReference])
        .then((all) =>
          all.filter((entry) => entry.onlinePaymentReference === attempt.onlinePaymentReference),
        );
      await owner.record(tx, {
        // WP-2423 item 8 ⑨: a merged table's rounds stay on their own Order.
        roundOrders: roundOrdersOf(current.rounds),
        settlementReference: options.nextReference(),
        operationReference: attempt.operationReference,
        intentDigest: attempt.intentDigest,
        diningSessionReference: attempt.diningSessionReference,
        orderReference: attempt.orderReference,
        method: "Online",
        rounds:
          planPart === null
            ? owed.map((round) => ({
                orderBatchReference: round.orderBatchReference,
                submissionReference: round.submissionReference,
                sequence: round.roundNumber,
                roundMinor: BigInt(round.totalMinor),
              }))
            : planPart.slices.map((slice) => {
                const round =
                  roundOf.get(slice.orderBatchReference) ??
                  fail("TABLE_ONLINE_PAYMENT_BILL_CHANGED");
                return {
                  orderBatchReference: slice.orderBatchReference,
                  submissionReference: round.submissionReference,
                  sequence: round.roundNumber,
                  roundMinor: slice.roundMinor,
                };
              }),
        ...(attempt.part === null ? {} : { part: attempt.part }),
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
    // WP-2423 item 8 ④: guests may be paying different parts at once — ask about each.
    const open = await options.transactions.run(async (tx) => {
      const current = await bill(tx, authority);
      if (current.orderReference === null) return [];
      return (await attemptsOf(tx, authority, current.orderReference)).filter(
        (attempt) => attempt.outcome === null,
      );
    });
    for (const found of open) await refreshOne(authority, found, stop);
  };
  const refreshOne = async (
    authority: TableOnlinePaymentAuthority,
    found: DiningTableOnlinePaymentRecord,
    stop: { actor: { type: "System" } | { type: "User"; reference: string } } | null,
  ) => {
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
      command: {
        readonly operationReference: string;
        readonly tip: DiningTableTip;
        /** WP-2423 item 8 ④: the part of a split bill this guest pays (null: the whole table). */
        readonly partNumber?: number | null;
      },
    ): Promise<DiningTableOnlinePaymentView> {
      const partNumber = command.partNumber ?? null;
      if (authority.guestSessionReference === null)
        return fail("TABLE_ONLINE_PAYMENT_INPUT_INVALID");
      // An earlier attempt may have finished with the Provider meanwhile.
      await refreshOpen(authority, null);
      const intentDigest = sha({
        kind: "DiningTableOnlinePayment/v1",
        diningSessionReference: authority.diningSessionReference,
        tip: command.tip,
        ...(partNumber === null ? {} : { partNumber }),
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
        // This guest finishes (or comes back to) their own open payment first. Another guest's
        // open payment blocks the same part, or everything when either is for the whole table.
        const open = attempts.filter((attempt) => attempt.outcome === null);
        if (
          open.some((attempt) => attempt.guestSessionReference === authority.guestSessionReference)
        )
          return { view: viewOf(current, attempts, authority) };
        if (
          open.some(
            (attempt) =>
              attempt.part === null ||
              partNumber === null ||
              attempt.part.partNumber === partNumber,
          )
        )
          return fail("TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING");
        return { plan: owedPlan(current, command.tip, partNumber) };
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
          const again = owedPlan(current, command.tip, partNumber);
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
            ...(again.part === null ? {} : { part: again.part }),
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
