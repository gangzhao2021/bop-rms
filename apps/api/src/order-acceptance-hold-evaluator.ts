import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderAcceptanceHoldStore,
  decideOrderAcceptanceHold,
  parseOrderingInstant,
  parseOrderingReference,
  parsePaymentSucceededEnvelope,
  type OrderAcceptanceHold,
} from "@rms/ordering";
import { loadStoreBackOnlineAfter, loadStorePresence } from "@rms/store";
import type { createOrderPaidContextSource } from "./order-paid-context-source.js";

type PaidContext = Awaited<ReturnType<ReturnType<typeof createOrderPaidContextSource>["resolve"]>>;

export type OrderAcceptanceHoldOutcome =
  "NotApplicable" | "Unchanged" | "Held" | "Resumed" | "HeldAndResumed" | "Closed";

/**
 * WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD). Runs before the paid-order outcome in the same
 * System transaction: when a paid, unaccepted pickup order's deadline passes while the Store was
 * offline, Ordering records a hold instead of letting the outcome close and refund it; once staff
 * are back online, the hold gets its new deadline (back online + 15 minutes). Presence comes from the
 * Store's public read; the hold facts are Ordering's. Nothing is written for other orders.
 */
export function createOrderAcceptanceHoldEvaluator(options: {
  scope: Readonly<{ brandReference: string; storeReference: string }>;
  context: { resolve(transaction: ConsumerTransaction, event: unknown): Promise<PaidContext> };
  /** System authority for this Store (checked before every read and write). */
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
  reference(): string;
  audit: Readonly<{ retentionPolicyCode: string; retentionPolicyVersion: number }>;
}) {
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const holds = createPostgresOrderAcceptanceHoldStore({
    ...scope,
    authorize: (tx) => options.authorize(tx),
  });
  const audit =
    (actionCode: string, reasonCode: string, occurredAt: string, correlationId: string) =>
    async (hold: OrderAcceptanceHold) => ({
      auditId: options.reference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" as const },
      actionCode,
      targetType: "OrderAcceptanceHold",
      targetId: hold.holdReference,
      correlationId,
      afterSummary: {
        orderReference: hold.orderReference,
        holdSequence: hold.sequence,
        lapsedDeadline: hold.lapsedDeadline,
        storeLastSeenAt: hold.storeLastSeenAt,
        ...((latest) =>
          latest === undefined
            ? {}
            : { storeBackOnlineAt: latest.storeBackOnlineAt, decideBy: latest.decideBy })(
          hold.resolutions.at(-1),
        ),
      },
      reasonCode,
      occurredAt,
      sourceChannel: "SYSTEM",
      dataClassification: "Restricted" as const,
      retentionPolicyCode: options.audit.retentionPolicyCode,
      retentionPolicyVersion: options.audit.retentionPolicyVersion,
    });
  const applicable = (context: PaidContext, terminalOccurredAt: string) => {
    const p = context.payment.intent.preparation;
    return (
      context.order.order.orderType === "Pickup" &&
      context.acceptance === null &&
      context.order.order.canonicalPhase === "Submitted" &&
      context.initialExecution.phase === "Submitted" &&
      context.capacity?.commitment.state === "PaymentPending" &&
      // Paid in time; a payment captured after the window closed is not the Store's to decide.
      terminalOccurredAt >= p.committedAt &&
      terminalOccurredAt < p.capacityExpiresAt
    );
  };
  return Object.freeze({
    async evaluate(
      transaction: ConsumerTransaction,
      eventValue: unknown,
    ): Promise<OrderAcceptanceHoldOutcome> {
      const event = parsePaymentSucceededEnvelope(eventValue);
      if (event.tenantId !== scope.brandReference || event.storeId !== scope.storeReference)
        return "NotApplicable";
      if ((await options.authorize(transaction)) !== true) throw new Error("HOLD_DENIED");
      const context = await options.context.resolve(transaction, event);
      if (!applicable(context, event.payload.terminalOccurredAt)) return "NotApplicable";
      const observedAt = String(parseOrderingInstant(context.observedAt));
      const p = context.payment.intent.preparation;
      const batch = {
        orderReference: String(p.orderReference),
        orderBatchReference: String(p.orderBatchReference),
      };
      let deadline = context.acceptanceDeadline;
      let held = false;
      if (deadline.kind !== "Held") {
        if (observedAt < deadline.deadline) return "Unchanged";
        const atDeadline = await loadStorePresence(transaction, scope, deadline.deadline);
        const decided = decideOrderAcceptanceHold({
          deadline,
          observedAt,
          storeOnlineAtDeadline: atDeadline.online,
          storeLastSeenBeforeDeadline: atDeadline.lastSeenAt,
          storeBackOnlineAt: null,
        });
        if (decided.action !== "Hold") return "Unchanged";
        const recorded = await holds.recordHold(transaction, {
          holdReference: options.reference(),
          ...batch,
          paymentEventReference: event.eventId,
          sequence: decided.sequence,
          lapsedDeadline: decided.lapsedDeadline,
          storeLastSeenAt: decided.storeLastSeenAt,
          heldAt: observedAt,
          audit: audit(
            "ORDER_ACCEPTANCE_HELD_STORE_OFFLINE",
            "STORE_OFFLINE_AT_DEADLINE",
            observedAt,
            event.correlationId,
          ),
        });
        if (recorded.status === "Closed") return "Closed";
        deadline = Object.freeze({ kind: "Held" as const, hold: recorded.hold });
        held = recorded.status === "Created";
      }
      const back = await loadStoreBackOnlineAfter(transaction, scope, deadline.hold.lapsedDeadline);
      const resumed = decideOrderAcceptanceHold({
        deadline,
        observedAt,
        storeOnlineAtDeadline: false,
        storeLastSeenBeforeDeadline: null,
        storeBackOnlineAt: back,
      });
      if (resumed.action !== "Resume") return held ? "Held" : "Unchanged";
      const result = await holds.resolve(transaction, {
        ...batch,
        holdReference: resumed.hold.holdReference,
        resolution: "StoreBackOnline",
        storeBackOnlineAt: resumed.storeBackOnlineAt,
        decideBy: resumed.decideBy,
        actorReference: null,
        recordedAt: observedAt,
        audit: audit(
          "ORDER_ACCEPTANCE_HOLD_STORE_BACK_ONLINE",
          "STORE_BACK_ONLINE",
          observedAt,
          event.correlationId,
        ),
      });
      if (result.status === "Closed") return "Closed";
      if (result.status !== "Created") return held ? "Held" : "Unchanged";
      return held ? "HeldAndResumed" : "Resumed";
    },
  });
}
