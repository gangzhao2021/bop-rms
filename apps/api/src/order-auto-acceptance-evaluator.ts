import type { ConsumerTransaction } from "@bop/eventing";
import { listAlcoholSkus } from "@rms/catalog";
import { evaluateIntactReservationPaymentRule } from "@rms/inventory";
import { loadKitchenScreenSeenAt } from "@rms/kitchen";
import {
  createPostgresOrderBatchIdentitySource,
  decideOrderAutoAcceptance,
  loadOrderAutoAcceptanceSetting,
  loadOrderAutoAcceptanceSkip,
  orderAutoAcceptanceFailureIsQuiet,
  orderAutoAcceptancePaidWindowMs,
  parsePaymentSucceededEnvelope,
  recordOrderAutoAcceptanceAccepted,
  recordOrderAutoAcceptanceSkip,
  type OrderAutoAcceptanceSetting,
  type OrderAutoAcceptanceSkipReason,
} from "@rms/ordering";
import { createPostgresCardMachinePaymentStore } from "@rms/payment";
import type { createAdditionalOrderPaidContextSource } from "./additional-order-paid-context-source.js";
import { createMerchantPaidAdditionalOrderAcceptance } from "./merchant-paid-additional-order-acceptance.js";
import { createMerchantPaidOrderAcceptance } from "./merchant-paid-order-acceptance.js";
import type { createOrderCapturedPaymentSource } from "./order-captured-payment-source.js";
import type { createOrderPaidContextSource } from "./order-paid-context-source.js";

export type OrderAutoAcceptanceOutcome = "NotApplicable" | "Accepted" | "Skipped";

/** Whether the Store takes this kind of order now; read once, before any Order or table lock. */
export interface OrderAutoAcceptanceOperating {
  readonly state: string;
  readonly availableServiceModes: readonly string[];
  readonly notReadyForOrders?: boolean;
}

interface PreparedAutoAcceptance {
  readonly setting: OrderAutoAcceptanceSetting;
  readonly operating: OrderAutoAcceptanceOperating | null;
}

const savepoint = "order_auto_acceptance";
const operatingSavepoint = "order_auto_acceptance_operating";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT. Runs in the worker's System transaction, right before the
 * paid-order consumer: when the Store's switch is on and nothing needs a person, it writes the
 * acceptance a staff member would, through the same runtime. The consumer then finds it and confirms
 * the order in this same transaction, so no wait is recorded. The decision itself is Ordering's
 * (`decideOrderAutoAcceptance`); this file gathers its facts and writes. It never fails a payment
 * outcome: any failure rolls back to its savepoint and the order takes the ordinary path, where the
 * wait workload tries again as soon as the condition clears.
 */
export function createOrderAutoAcceptanceEvaluator(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  /** System authority for this Store (checked before every read and write). */
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
  reference(): string;
  now(): string;
  /** The worker's own actor, for the workflow check; the record itself names no person. */
  workflowActorReference: string;
  quoteVersion: 1 | 2;
  captured: ReturnType<typeof createOrderCapturedPaymentSource>;
  context: ReturnType<typeof createOrderPaidContextSource>;
  additionalContext: ReturnType<typeof createAdditionalOrderPaidContextSource>;
  /** The published Accept action of each kind of batch (the same the staff command evaluates). */
  workflow(kind: "Pickup" | "DineIn" | "Additional"): Readonly<{
    purposeCode: string;
    workflowVersionReference: string;
  }>;
  /** Null when it can't be read: counts as not open. May abort the transaction it is given. */
  readOperating(
    transaction: ConsumerTransaction,
    at: string,
  ): Promise<OrderAutoAcceptanceOperating | null>;
  audit: Readonly<{ retentionPolicyCode: string; retentionPolicyVersion: number }>;
  /** An unexpected failure, at most once per payment event; expected refusals stay quiet. */
  report(code: "ORDER_AUTO_ACCEPT_SKIPPED", error: unknown): void;
}) {
  const scope = Object.freeze({ ...options.scope });
  const ownerScope = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  const reported = new Set<string>();
  const report = (eventReference: string, error: unknown) => {
    if (orderAutoAcceptanceFailureIsQuiet(error) || reported.has(eventReference)) return;
    if (reported.size >= 1_000) reported.clear();
    reported.add(eventReference);
    options.report("ORDER_AUTO_ACCEPT_SKIPPED", error);
  };
  /** Rolls back on failure; `null` means it failed (and the transaction is usable again). */
  const guarded = async <T>(
    tx: ConsumerTransaction,
    eventReference: string,
    work: () => Promise<T>,
  ): Promise<{ readonly value: T } | { readonly failure: unknown }> => {
    await tx.query("SAVEPOINT " + savepoint, []);
    try {
      const value = await work();
      await tx.query("RELEASE SAVEPOINT " + savepoint, []);
      return { value };
    } catch (failure) {
      await tx.query("ROLLBACK TO SAVEPOINT " + savepoint, []);
      await tx.query("RELEASE SAVEPOINT " + savepoint, []);
      report(eventReference, failure);
      return { failure };
    }
  };

  function initialRuntime(tx: ConsumerTransaction, orderType: "Pickup" | "DineIn", order: string) {
    const workflow = options.workflow(orderType);
    return systemRuntime(tx, order, workflow, (common) =>
      createMerchantPaidOrderAcceptance({
        ...common,
        context: options.context,
        sourceChannel: "EVENT_CONSUMER",
      }),
    );
  }
  function additionalRuntime(tx: ConsumerTransaction, order: string) {
    return systemRuntime(tx, order, options.workflow("Additional"), (common) =>
      createMerchantPaidAdditionalOrderAcceptance({
        ...common,
        context: options.additionalContext,
      }),
    );
  }
  function systemRuntime<Runtime>(
    tx: ConsumerTransaction,
    order: string,
    workflow: Readonly<{ purposeCode: string; workflowVersionReference: string }>,
    create: (common: {
      scope: typeof scope;
      quoteVersion: 1 | 2;
      recordAs: "System";
      actorReference: string;
      workflowVersionReference: string;
      reasonCode: string;
      acceptance: { action: string; purposeCode: string; permissionCode: string };
      authorizeActor(transaction: ConsumerTransaction): Promise<boolean>;
      authorize(
        transaction: ConsumerTransaction,
        record: { brandReference: string; storeReference: string; orderReference: string },
      ): Promise<boolean>;
      gates: Parameters<typeof createMerchantPaidOrderAcceptance>[0]["gates"];
      audit: Parameters<typeof createMerchantPaidOrderAcceptance>[0]["audit"];
    }) => Runtime,
  ) {
    const state = { expectedVersion: 0 };
    const runtime = create({
      scope,
      quoteVersion: options.quoteVersion,
      recordAs: "System",
      actorReference: options.workflowActorReference,
      workflowVersionReference: workflow.workflowVersionReference,
      reasonCode: "STORE_AUTO_ACCEPT_PAID",
      acceptance: {
        action: "Accept",
        purposeCode: workflow.purposeCode,
        permissionCode: "order.accept",
      },
      authorizeActor: () => options.authorize(tx),
      authorize: async (transaction, record) =>
        record.brandReference === scope.brandReference &&
        record.storeReference === scope.storeReference &&
        record.orderReference === order &&
        (await options.authorize(transaction)),
      gates: {
        authorizeResource: async (transaction, request) =>
          request.tenantReference === scope.tenantReference &&
          request.brandReference === scope.brandReference &&
          request.storeReference === scope.storeReference &&
          request.actorReference === options.workflowActorReference &&
          request.resourceReference === order &&
          request.resourceVersion === state.expectedVersion &&
          (await options.authorize(transaction as ConsumerTransaction)),
        authorizeAction: (transaction) => options.authorize(transaction as ConsumerTransaction),
        // Accept has no configured rules; eligibility checked the reservation.
        evaluateRule: async () => true,
        authorizeOverride: async () => false,
      },
      audit: async (fact) => ({
        ...options.audit,
        auditId: options.reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDER_ACCEPTED",
        targetType: "Order",
        targetId: fact.orderReference,
        correlationId: fact.operationReference,
        reasonCode: fact.reasonCode,
        occurredAt: fact.acceptedAt,
        sourceChannel: "EVENT_CONSUMER",
        afterSummary: { phase: "Accepted" },
        dataClassification: "Restricted",
      }),
    });
    return { runtime, state };
  }

  return Object.freeze({
    /**
     * What is read before any lock: the switch, and for a Store that has it on, whether the Store
     * takes orders. The operating read takes share locks on the Store's configuration and can leave
     * its transaction aborted, so it runs under a savepoint that is always rolled back, with a
     * short lock wait of its own. A Store with the switch off pays one read.
     */
    async prepare(
      tx: ConsumerTransaction,
      eventValue: unknown,
    ): Promise<PreparedAutoAcceptance | null> {
      const type = (eventValue as { eventType?: unknown } | null)?.eventType;
      if (type !== "PaymentSucceeded") return null;
      const event = parsePaymentSucceededEnvelope(eventValue);
      if (event.tenantId !== scope.brandReference || event.storeId !== scope.storeReference)
        return null;
      const read = await guarded(tx, event.eventId, async () =>
        (await options.authorize(tx)) === true
          ? loadOrderAutoAcceptanceSetting(tx, ownerScope)
          : null,
      );
      if ("failure" in read || read.value === null) return null;
      const setting = read.value;
      if (!setting.pickup.on && !setting.dineIn.on) return null;
      const observedAt = options.now();
      const paidAt = event.payload.terminalOccurredAt;
      let operating: OrderAutoAcceptanceOperating | null = null;
      if (Date.parse(observedAt) - Date.parse(paidAt) < orderAutoAcceptancePaidWindowMs) {
        await tx.query("SAVEPOINT " + operatingSavepoint, []);
        try {
          await tx.query("SET LOCAL lock_timeout='250ms'", []);
          operating = await options.readOperating(tx, observedAt);
        } catch {
          operating = null;
        } finally {
          await tx.query("ROLLBACK TO SAVEPOINT " + operatingSavepoint, []);
          await tx.query("RELEASE SAVEPOINT " + operatingSavepoint, []);
        }
      }
      return Object.freeze({ setting, operating });
    },
    /** The decision and its writes, after the outage hold and before the consumer. */
    async apply(
      tx: ConsumerTransaction,
      eventValue: unknown,
      prepared: PreparedAutoAcceptance | null,
    ): Promise<OrderAutoAcceptanceOutcome> {
      if (prepared === null) return "NotApplicable";
      const event = parsePaymentSucceededEnvelope(eventValue);
      const decided = await guarded(tx, event.eventId, async () => {
        if ((await options.authorize(tx)) !== true) return null;
        const facts = await options.captured.resolve(tx, event);
        const p = facts.payment.intent.preparation;
        const identity = await createPostgresOrderBatchIdentitySource({
          ...ownerScope,
          authorize: () => options.authorize(tx),
        }).load(tx, {
          orderReference: p.orderReference,
          orderBatchReference: p.orderBatchReference,
          observedAt: options.now(),
        });
        if (identity === null || identity.submissionReference !== p.submissionReference)
          return null;
        const orderType = identity.orderType as "Pickup" | "DineIn";
        const switchState =
          orderType === "Pickup" ? prepared.setting.pickup : prepared.setting.dineIn;
        if (!switchState.on) return null;
        const orderReference = String(p.orderReference);
        const orderBatchReference = String(p.orderBatchReference);
        // These two never clear: the wait workload comes back every second, so read nothing more.
        const recorded = await loadOrderAutoAcceptanceSkip(tx, ownerScope, orderBatchReference);
        if (recorded === "PaidBeforeSwitch" || recorded === "PaidTooLongAgo") return null;
        const card = await createPostgresCardMachinePaymentStore({
          scope: ownerScope,
          authorize: () => options.authorize(tx),
        }).loadByPaymentOperation(tx, event.correlationId);
        const additional = identity.kind === "Additional";
        const context = additional
          ? await options.additionalContext.resolve(tx, event)
          : await options.context.resolve(tx, event);
        // Accepted, cancelled or otherwise closed: the consumer owns what happens next.
        if ("execution" in context) {
          if (context.execution.acceptance !== null) return null;
        } else {
          if (
            context.acceptance !== null ||
            context.initialExecution.phase !== "Submitted" ||
            context.inventory === null
          )
            return null;
        }
        const items =
          "execution" in context ? context.execution.snapshot.items : context.order.items;
        const alcohol = await listAlcoholSkus(
          tx as never,
          { brandReference: scope.brandReference },
          [...new Set(items.map((item) => String(item.catalog.skuReference)))],
        );
        const stockIntact =
          context.inventory !== null && evaluateIntactReservationPaymentRule(context.inventory);
        const observedAt = String(context.observedAt);
        const operating = prepared.operating;
        const decision = decideOrderAutoAcceptance({
          switchState,
          paidAt: event.payload.terminalOccurredAt,
          observedAt,
          paidOnCardMachine: card !== null,
          deadlineKind:
            "acceptanceDeadline" in context
              ? context.acceptanceDeadline.kind === "Held"
                ? "Held"
                : "Standard"
              : null,
          kitchenScreenSeenAt: await loadKitchenScreenSeenAt(tx, ownerScope),
          storeOpen:
            operating !== null &&
            operating.state === "Open" &&
            operating.notReadyForOrders !== true &&
            operating.availableServiceModes.includes(orderType),
          hasAlcohol: alcohol.size > 0,
          itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
          stockIntact,
        });
        return {
          decision,
          orderReference,
          orderBatchReference,
          orderType,
          additional,
          observedAt,
          itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        };
      });
      if ("failure" in decided || decided.value === null) return "NotApplicable";
      const fact = decided.value;
      const skipped = async (reason: OrderAutoAcceptanceSkipReason) => {
        const recorded = await guarded(tx, event.eventId, async () => {
          if (
            (await loadOrderAutoAcceptanceSkip(tx, ownerScope, fact.orderBatchReference)) === reason
          )
            return;
          await recordOrderAutoAcceptanceSkip(tx, ownerScope, {
            decisionReference: options.reference(),
            orderReference: fact.orderReference,
            orderBatchReference: fact.orderBatchReference,
            reason,
            itemCount: fact.itemCount,
            settingVersion: prepared.setting.version,
            decidedAt: fact.observedAt,
          });
        });
        return "failure" in recorded ? ("NotApplicable" as const) : ("Skipped" as const);
      };
      if (fact.decision.action === "Silent") return "NotApplicable";
      if (fact.decision.action === "Skip") return skipped(fact.decision.reason);
      const accepted = await guarded(tx, event.eventId, async () => {
        const { runtime, state } = fact.additional
          ? additionalRuntime(tx, fact.orderReference)
          : initialRuntime(tx, fact.orderType, fact.orderReference);
        const current = await runtime.current({ transaction: tx, paymentEvent: event });
        state.expectedVersion = current.orderVersion;
        const command = {
          acceptanceReference: options.reference(),
          operationReference: options.reference(),
          orderReference: fact.orderReference,
          orderBatchReference: fact.orderBatchReference,
          expectedOrderVersion: current.orderVersion,
        };
        const committed = await runtime.commit({
          transaction: tx,
          command,
          paymentEvent: event,
        });
        await recordOrderAutoAcceptanceAccepted(tx, ownerScope, {
          decisionReference: options.reference(),
          orderReference: fact.orderReference,
          orderBatchReference: fact.orderBatchReference,
          acceptanceReference: String(committed.record.acceptanceReference),
          itemCount: fact.itemCount,
          settingVersion: prepared.setting.version,
          decidedAt: String(committed.record.acceptedAt),
        });
      });
      // Staff got there first, the version moved, or the switch went off under the lock: a person
      // decides, and the wait workload tries again. Never a failed payment outcome.
      return "failure" in accepted ? skipped("NotEligible") : "Accepted";
    },
  });
}
