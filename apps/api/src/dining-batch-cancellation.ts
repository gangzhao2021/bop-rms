import { readClosedRecord } from "@bop/identity";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentOperationFence,
  createPostgresPaymentTerminalStore,
  parsePaymentIntentCreationRecord,
} from "@rms/payment";
import {
  listStoreDiningBatchPaymentDeadlines,
  createPostgresOrderBatchCheckoutCancellationReader,
  createPostgresOrderBatchCheckoutCancellationStore,
  parseOrderBatchCheckoutCancellation,
  parseOrderBatchCheckoutExpiry,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { createDiningBatchCancellationSource } from "./dining-batch-cancellation-source.js";
import { evaluateDiningBatchCancellationWorkflow } from "./dining-batch-cancellation-workflow.js";
import { isPaymentUnconfirmed } from "./open-payment-attempt-resolution.js";
type SourceOptions = Parameters<typeof createDiningBatchCancellationSource>[0];
type Cancellation = ReturnType<typeof parseOrderBatchCheckoutCancellation>;
type Evidence = Awaited<ReturnType<ReturnType<typeof createDiningBatchCancellationSource>["load"]>>;
type StaffEvidence = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createDiningBatchCancellationSource>["loadForStaff"]>>
>;
/** Why a manager can't cancel this round as unpaid. */
export type StaffUnpaidRoundRefusal = "NotFound" | "Paid" | "PaymentInProgress" | "NotCancellable";
type Workflow = Parameters<typeof evaluateDiningBatchCancellationWorkflow>[0];
const unavailable = (): never => {
  throw new Error("DINING_BATCH_CANCELLATION_UNAVAILABLE");
};
/** Internal System command with mandatory same-transaction Inventory completion.
 * No financial compensation or table/session mutation.
 * The caller must reuse the same durable operation reference after uncertain responses.
 *
 * WP-2423: two kinds of unpaid round are cancelled when their payment window ends — one whose
 * payment failed (`CHECKOUT_DEADLINE_REACHED`), and one for which no payment was ever started
 * (`PAYMENT_NOT_STARTED`: a staff-entered round nobody recorded as paid on the card machine, or a
 * guest round whose online payment never began). For the latter Payment is re-read under the
 * payment operation fence: a round with any online payment or card-machine payment is left alone
 * (`NotEligible`), since money may have moved. The cancellation publishes `OrderCancelled`.
 */
export function createDiningBatchCancellation(
  options: SourceOptions & {
    transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
    newReference(): string;
    inventory(
      transaction: ConsumerTransaction,
      input: Readonly<{
        mode: "Release" | "Verify";
        cancellation: ReturnType<typeof parseOrderBatchCheckoutCancellation>;
      }>,
    ): Promise<boolean>;
    /**
     * WP-2423 abandoned payment: the Store's Provider account, to read Payment's terminal facts
     * (whose failure reason tells a never-finished payment from a declined card, and which a
     * manager's cancellation of an unpaid round must find failed). Without it a failed payment is
     * cancelled as CHECKOUT_DEADLINE_REACHED and staff cannot cancel unpaid rounds here.
     */
    paymentAccount?: { providerAccountReference: string; environment: "Test" | "Live" };
    resolvePolicy(
      tx: ConsumerTransaction,
      evidence: StaffEvidence | Evidence,
    ): Promise<null | {
      systemActorReference: string;
      workflowVersionReference: string;
      transitionReference: string;
      policy: Workflow["policy"];
      gates: Workflow["gates"];
    }>;
  },
) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  return Object.freeze({
    async cancel(value: unknown) {
      try {
        if (typeof options.inventory !== "function") return unavailable();
        const raw = readClosedRecord(value, ["operationReference", "expiry"]),
          operationReference = parseOrderingReference(raw.operationReference),
          expiry = parseOrderBatchCheckoutExpiry(raw.expiry),
          started = parseOrderingInstant(options.now());
        if (
          (expiry.status !== "PaymentFailed" && expiry.status !== "AwaitingPaymentResolution") ||
          expiry.tenantReference !== scope.tenantReference ||
          expiry.brandReference !== scope.brandReference ||
          expiry.storeReference !== scope.storeReference ||
          expiry.observedAt > started
        )
          return unavailable();
        return await options.transactions.run(async (transaction) => {
          const allowed = async (tx: unknown) =>
            tx === transaction && (await options.authorize(transaction, expiry));
          if (!(await allowed(transaction))) return unavailable();
          await createPostgresPaymentOperationFence({
            ...scope,
            now: options.now,
            authorize: async (tx, query) =>
              query.orderReference === expiry.orderReference &&
              query.paymentOperationReference === expiry.paymentOperationReference &&
              (await allowed(tx)),
          }).acquire(transaction, {
            orderReference: expiry.orderReference,
            paymentOperationReference: expiry.paymentOperationReference,
          });
          const original = await createPostgresOrderBatchCheckoutCancellationReader({
            ...scope,
            now: options.now,
            authorize: allowed,
          }).loadOperation(transaction, {
            orderReference: expiry.orderReference,
            orderBatchReference: expiry.orderBatchReference,
            operationReference,
          });
          if (original) {
            if (
              original.operationReference !== operationReference ||
              original.expiryRecordReference !== expiry.recordReference ||
              original.expiryEvidenceDigest !== expiry.evidenceDigest ||
              original.submissionReference !== expiry.submissionReference ||
              original.paymentOperationReference !== expiry.paymentOperationReference ||
              !(await allowed(transaction))
            )
              return unavailable();
            if (
              (await options.inventory(
                transaction,
                Object.freeze({ mode: "Verify", cancellation: original }),
              )) !== true ||
              !(await allowed(transaction))
            )
              return unavailable();
            return Object.freeze({ status: "Existing" as const, record: original });
          }
          if (expiry.status === "AwaitingPaymentResolution") {
            // Under the fence above no payment for this round can start or be recorded meanwhile.
            const runner = {
              run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
            };
            const intent = await createPostgresPaymentIntentCreationStore(
              runner,
              { brandReference: scope.brandReference, storeReference: scope.storeReference },
              { now: options.now, generateObservationReference: unavailable },
            ).resolveOperation(expiry.paymentOperationReference);
            const card = await createPostgresCardMachinePaymentStore({
              scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
              authorize: async (tx) => tx === transaction && (await allowed(tx)),
            }).loadByPaymentOperation(transaction, expiry.paymentOperationReference);
            if (intent !== null || card !== null) {
              if (!(await allowed(transaction))) return unavailable();
              return Object.freeze({
                status: "NotEligible" as const,
                reason: "PaymentStarted" as const,
              });
            }
          }
          const evidence = await createDiningBatchCancellationSource({
            ...options,
            scope,
            authorize: allowed,
          }).load(transaction, expiry);
          const reasonCode =
            expiry.status === "AwaitingPaymentResolution"
              ? ("PAYMENT_NOT_STARTED" as const)
              : (await failureReason(transaction, expiry, allowed)) === "Cancelled"
                ? ("PAYMENT_NOT_COMPLETED" as const)
                : ("CHECKOUT_DEADLINE_REACHED" as const);
          return await write(transaction, {
            operationReference,
            evidence,
            identity: expiry,
            reasonCode,
            actorReference: null,
            allowed,
            started,
          });
        });
      } catch {
        return unavailable();
      }
    },
    /**
     * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): a manager cancels a dine-in round
     * nobody paid for, before its payment window ends ("Cancel this unpaid round"). Runs in the
     * caller's transaction (which authorized the manager and re-checks before commit). Under the
     * round's payment operation fence Payment must prove nothing was charged: no card-machine
     * payment, and the online payment (if any) has a failed terminal outcome — the caller asks the
     * Provider first and cancels a never-confirmed attempt. Same append-only cancellation, Workflow
     * transition, stock release and OrderCancelled event as the System's, with the reason
     * STAFF_CANCELLED_UNPAID and the manager as the audit actor. Same operation reference → the
     * original outcome.
     *
     * `paymentUnconfirmed`: the manager checked with the guest after the card provider could not
     * confirm the round's online payment (still unresolved `unconfirmedPaymentGraceMs` after the
     * payment window ended, re-checked here from Ordering's deadline). Then an online attempt
     * without a terminal outcome does not block the cancellation (a succeeded one still does); the
     * audit records `providerPaymentUnconfirmed`. A charge that still arrives is refunded
     * automatically ("paid without a fulfillable order").
     */
    async cancelUnpaidForStaff(
      transaction: ConsumerTransaction,
      input: {
        operationReference: string;
        orderReference: string;
        orderBatchReference: string;
        actorReference: string;
        authorize(tx: ConsumerTransaction): Promise<boolean>;
        paymentUnconfirmed?: boolean;
      },
    ): Promise<
      | { status: "Created" | "Existing"; record: Cancellation }
      | { status: "NotEligible"; reason: StaffUnpaidRoundRefusal }
    > {
      const operationReference = parseOrderingReference(input.operationReference),
        orderReference = parseOrderingReference(input.orderReference),
        orderBatchReference = parseOrderingReference(input.orderBatchReference),
        actorReference = parseOrderingReference(input.actorReference),
        started = parseOrderingInstant(options.now());
      const refuse = (reason: StaffUnpaidRoundRefusal) =>
        Object.freeze({ status: "NotEligible" as const, reason });
      if (options.paymentAccount === undefined || typeof options.inventory !== "function")
        return unavailable();
      const identity = { orderReference, orderBatchReference };
      const allowed = async (tx: unknown) =>
        tx === transaction &&
        (await input.authorize(transaction)) === true &&
        (await options.authorize(transaction, identity));
      if (!(await allowed(transaction))) return unavailable();
      // Replay of the same staff command: the original outcome, nothing written.
      const original = await createPostgresOrderBatchCheckoutCancellationReader({
        ...scope,
        now: options.now,
        authorize: allowed,
      }).loadOperation(transaction, { orderReference, orderBatchReference, operationReference });
      if (original !== null) {
        if (
          original.reasonCode !== "STAFF_CANCELLED_UNPAID" ||
          (await options.inventory(
            transaction,
            Object.freeze({ mode: "Verify", cancellation: original }),
          )) !== true
        )
          return unavailable();
        return Object.freeze({ status: "Existing" as const, record: original });
      }
      // Takes the payment operation fence and reads the round's current owner facts.
      const evidence = await createDiningBatchCancellationSource({
        ...options,
        scope,
        authorize: allowed,
      }).loadForStaff(transaction, identity);
      if (evidence === null) return refuse("NotFound");
      const round = evidence.round;
      const target = evidence.items.filter(
        (item) => item.orderBatchReference === orderBatchReference,
      );
      if (
        target.some((item) => item.phase !== "Submitted" || item.everAccepted || item.everStarted)
      )
        return refuse("NotCancellable");
      const runner = {
        run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
      };
      const card = await createPostgresCardMachinePaymentStore({
        scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
        authorize: async (tx) => tx === transaction && (await allowed(tx)),
      }).loadByPaymentOperation(transaction, round.paymentOperationReference);
      if (card !== null) return refuse("Paid");
      let unconfirmed = false;
      const stored = await createPostgresPaymentIntentCreationStore(
        runner,
        { brandReference: scope.brandReference, storeReference: scope.storeReference },
        { now: options.now, generateObservationReference: unavailable },
      ).resolveOperation(round.paymentOperationReference);
      if (stored !== null) {
        const payment = parsePaymentIntentCreationRecord(stored);
        const fact = await createPostgresPaymentTerminalStore(runner, {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          providerAccountReference: options.paymentAccount.providerAccountReference,
          environment: options.paymentAccount.environment,
        }).read(payment.intent.paymentIntentReference);
        if (fact?.outcome === "Succeeded") return refuse("Paid");
        if (
          fact === null ||
          fact.outcome !== "Failed" ||
          String(fact.paymentAttemptReference) !== String(payment.attempt.paymentAttemptReference)
        ) {
          if (input.paymentUnconfirmed !== true) return refuse("PaymentInProgress");
          const deadline = (
            await listStoreDiningBatchPaymentDeadlines(
              transaction,
              { brandReference: scope.brandReference, storeReference: scope.storeReference },
              [orderReference],
            )
          ).find((entry) => entry.orderBatchReference === orderBatchReference);
          if (
            deadline === undefined ||
            !isPaymentUnconfirmed(deadline.paymentDeadline, options.now()) ||
            !(await allowed(transaction))
          )
            return refuse("PaymentInProgress");
          unconfirmed = true;
        }
      }
      return await write(transaction, {
        operationReference,
        evidence,
        identity: round,
        reasonCode: "STAFF_CANCELLED_UNPAID",
        actorReference,
        allowed,
        started,
        ...(unconfirmed ? { afterSummary: { providerPaymentUnconfirmed: true } as const } : {}),
      });
    },
  });
  /** The failure reason of the payment a PaymentFailed expiry names (Payment's terminal fact). */
  async function failureReason(
    transaction: ConsumerTransaction,
    expiry: ReturnType<typeof parseOrderBatchCheckoutExpiry>,
    allowed: (tx: unknown) => Promise<boolean>,
  ): Promise<string | null> {
    if (options.paymentAccount === undefined || expiry.paymentEvidence === null) return null;
    const fact = await createPostgresPaymentTerminalStore(
      { run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction) },
      {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        providerAccountReference: options.paymentAccount.providerAccountReference,
        environment: options.paymentAccount.environment,
      },
    ).read(expiry.paymentEvidence.paymentIntentReference);
    if (!(await allowed(transaction))) return unavailable();
    return fact !== null &&
      fact.outcome === "Failed" &&
      String(fact.paymentAttemptReference) ===
        String(expiry.paymentEvidence.paymentAttemptReference)
      ? fact.failureReason
      : null;
  }
  async function write(
    transaction: ConsumerTransaction,
    input: {
      operationReference: string;
      evidence: Evidence | StaffEvidence;
      identity: {
        orderReference: string;
        orderBatchReference: string;
        submissionReference: string;
        paymentOperationReference: string;
      };
      reasonCode: Cancellation["reasonCode"];
      actorReference: string | null;
      allowed(tx: unknown): Promise<boolean>;
      started: string;
      afterSummary?: { readonly providerPaymentUnconfirmed: true };
    },
  ) {
    const { evidence, identity, allowed } = input;
    const expiry = evidence.expiry;
    const policy = await options.resolvePolicy(transaction, evidence);
    if (!policy) return unavailable();
    const record = parseOrderBatchCheckoutCancellation({
      ...scope,
      operationReference: input.operationReference,
      cancellationReference: options.newReference(),
      orderReference: identity.orderReference,
      orderBatchReference: identity.orderBatchReference,
      submissionReference: identity.submissionReference,
      paymentOperationReference: identity.paymentOperationReference,
      expiryRecordReference: expiry?.recordReference ?? null,
      expiryEvidenceDigest: expiry?.evidenceDigest ?? null,
      expectedOrderVersion: evidence.orderVersion,
      cancelledOrderVersion: evidence.orderVersion + 1,
      expectedSourceCheckpoint: evidence.checkpoint,
      workflowVersionReference: policy.workflowVersionReference,
      transitionReference: policy.transitionReference,
      orderItemReferences: evidence.items
        .filter((item) => item.orderBatchReference === identity.orderBatchReference)
        .map((item) => item.orderItemReference)
        .sort(),
      cancelledAt: evidence.observedAt,
      phase: "Cancelled",
      reasonCode: input.reasonCode,
    });
    const matches = (candidate: typeof record) =>
      candidate.orderReference === identity.orderReference &&
      candidate.orderBatchReference === identity.orderBatchReference &&
      candidate.paymentOperationReference === identity.paymentOperationReference;
    const writer = createPostgresOrderBatchCheckoutCancellationStore({
      ...scope,
      now: options.now,
      authorize: async (tx, candidate) => matches(candidate) && (await allowed(tx)),
      fence: async (tx, candidate) => tx === transaction && matches(candidate),
      source: async (tx) => {
        if (tx !== transaction) return unavailable();
        return evidence;
      },
      workflow: async (tx, candidate) => {
        if (tx !== transaction) return unavailable();
        await evaluateDiningBatchCancellationWorkflow({
          transaction,
          source: { record: candidate, expiry, items: evidence.items },
          systemActorReference: policy.systemActorReference,
          policy: policy.policy,
          gates: policy.gates,
          request: {
            ...scope,
            actorReference: policy.systemActorReference,
            resourceReference: record.orderReference,
            resourceVersion: record.expectedOrderVersion,
            purposeCode: policy.policy.purposeCode,
            applicabilityCode: "DineIn",
            expectedVersionReference: record.workflowVersionReference,
            currentState: evidence.progress.phase,
            action: policy.policy.action,
            observedAt: record.cancelledAt,
          },
        });
        return true;
      },
      eventReference: () => options.newReference(),
      audit: (candidate) =>
        Promise.resolve({
          auditId: options.newReference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor:
            input.actorReference === null
              ? { type: "System" }
              : { type: "User", reference: input.actorReference },
          actionCode: "ORDERING_BATCH_CHECKOUT_CANCELLED",
          targetType: "OrderBatch",
          targetId: candidate.orderBatchReference,
          correlationId: candidate.operationReference,
          reasonCode: candidate.reasonCode,
          occurredAt: candidate.cancelledAt,
          sourceChannel: input.actorReference === null ? "SYSTEM" : "MERCHANT_WEB",
          ...(input.afterSummary === undefined ? {} : { afterSummary: input.afterSummary }),
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
    });
    const result = await writer.append(transaction, record);
    if (
      (await options.inventory(
        transaction,
        Object.freeze({ mode: "Release", cancellation: record }),
      )) !== true
    )
      return unavailable();
    if (parseOrderingInstant(options.now()) < input.started || !(await allowed(transaction)))
      return unavailable();
    return result;
  }
}
