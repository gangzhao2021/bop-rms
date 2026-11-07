import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import {
  createPostgresOrdinaryRefundApprovalSubjectSource,
  createPostgresOrdinaryRefundEscalationSource,
  readOrdinaryRefundRequestNote,
} from "./persistence/ordinary-refund-request-store.js";
import { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import {
  createPostgresOrdinaryRefundApprovalQueueReader,
  createPostgresOrdinaryRefundApprovalReader,
} from "./persistence/ordinary-refund-approval-store.js";
import { createPostgresOrdinaryRefundPricingSource } from "./ordinary-refund-pricing-source.js";
import { createPostgresCardMachinePaymentStore } from "./persistence/card-machine-payment-store.js";

interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
type EscalationOptions = Parameters<typeof createPostgresOrdinaryRefundEscalationSource>[0];
const queueDays = 30;

/** Escalation of one recorded request evaluated now (database clock) on the actual capture,
 * Pricing and Store Business Date sources; the returned observedAt is that clock. */
export function createPostgresOrdinaryRefundCurrentEscalationSource(options: {
  scope: Scope;
  providerAccountReference: string;
  environment: "Test" | "Live";
  authorize(tx: ConsumerTransaction, query: Scope & { orderReference?: string }): Promise<boolean>;
  businessDate: EscalationOptions["businessDate"];
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  const byOrder = (tx: ConsumerTransaction, query: { orderReference: string }) =>
    options.authorize(tx, { ...scope, orderReference: query.orderReference });
  let clock = new Date(0).toISOString();
  const source = createPostgresOrdinaryRefundEscalationSource({
    scope,
    authorize: (transaction, request) => byOrder(transaction, request),
    captures: (transaction, input) =>
      createPostgresOrdinaryRefundCaptureSource({
        scope: {
          ...scope,
          providerAccountReference: options.providerAccountReference,
          environment: options.environment,
        },
        now: () => clock,
        authorize: (t, request) => byOrder(t, request),
        validatePricing: createPostgresOrdinaryRefundPricingSource({
          scope,
          authorize: (t, query) => byOrder(t, query),
        }),
        // WP-2423 item 4: a card-machine refund needs the same approval as an online one.
        allowCardMachine: true,
      })(transaction, input),
    businessDate: options.businessDate,
  });
  return async (
    tx: ConsumerTransaction,
    query: { orderReference: string; requestReference: string },
  ) => {
    const result = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    const value = result.rows[0]?.now;
    clock = parsePaymentInstant(value instanceof Date ? value.toISOString() : value);
    return source(tx, query);
  };
}

/**
 * WP-2423 Q5: refunds at this Store waiting for an independent Owner/Finance decision, or approved
 * and not yet sent for every payment. Escalation is evaluated now (RF-D01–D03), on the same owner
 * sources as approval and first dispatch. Read model only: nothing here approves or sends.
 */
export function createPostgresOrdinaryRefundApprovalQueueRuntime(options: {
  scope: Scope;
  providerAccountReference: string;
  environment: "Test" | "Live";
  /** Current caller authority for this Store (and Order when given), retained through commit. */
  authorize(tx: ConsumerTransaction, query: Scope & { orderReference?: string }): Promise<boolean>;
  businessDate: EscalationOptions["businessDate"];
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  const byOrder = (tx: ConsumerTransaction, query: { orderReference: string }) =>
    options.authorize(tx, { ...scope, orderReference: query.orderReference });
  const list = createPostgresOrdinaryRefundApprovalQueueReader({
    scope,
    authorize: (tx) => options.authorize(tx, scope),
  });
  const subject = createPostgresOrdinaryRefundApprovalSubjectSource({ scope, authorize: byOrder });
  const approvals = createPostgresOrdinaryRefundApprovalReader({ scope, authorize: byOrder });
  return async (tx: ConsumerTransaction, value: { observedAt: string }) => {
    const observedAt = parsePaymentInstant(value.observedAt);
    const escalation = createPostgresOrdinaryRefundCurrentEscalationSource(options);
    const candidates = await list(tx, {
      observedAt,
      since: new Date(Date.parse(observedAt) - queueDays * 86_400_000).toISOString(),
      limit: 50,
    });
    const entries = [];
    for (const candidate of candidates) {
      const query = {
        orderReference: candidate.orderReference,
        requestReference: candidate.requestReference,
      };
      const evaluated = await escalation(tx, query);
      if (candidate.approvalReference === null && !evaluated.decision.requiresIndependentApproval)
        continue;
      const current = await subject(tx, { ...query, observedAt: evaluated.observedAt });
      const approval =
        candidate.approvalReference === null
          ? null
          : await approvals(tx, {
              orderReference: candidate.orderReference,
              approvalReference: candidate.approvalReference,
              observedAt: evaluated.observedAt,
            });
      if (candidate.approvalReference !== null && approval === null)
        throw new Error("ORDINARY_REFUND_APPROVAL_QUEUE_UNAVAILABLE");
      // WP-2423 item 4: refunded on the Store's card machine (recorded there) or sent online.
      let paymentMethod: "Online" | "CardMachine" = "Online";
      const cards = createPostgresCardMachinePaymentStore({
        scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
        authorize: (t, query) => byOrder(t as ConsumerTransaction, query),
      });
      for (const payment of current.request.payments)
        if ((await cards.loadByIntent(tx, payment.paymentIntentReference)) !== null)
          paymentMethod = "CardMachine";
      entries.push(
        Object.freeze({
          orderReference: current.request.orderReference,
          paymentMethod,
          requestReference: current.request.requestReference,
          operationReference: current.request.operationReference,
          requesterReference: current.requesterReference,
          requestedAt: current.request.requestedAt,
          reasonCode: current.request.reasonCode,
          // WP-2423 Q5: the staff note of an "Other" reason, for the approver (Confidential).
          note:
            current.request.reasonCode === "OTHER"
              ? await readOrdinaryRefundRequestNote(tx, scope, current.request.requestReference)
              : null,
          currencyCode: current.request.currencyCode,
          amountMinor: current.request.amountMinor,
          paymentIntentReferences: Object.freeze(
            current.request.payments.map((payment) => payment.paymentIntentReference),
          ),
          paymentAttemptReferences: Object.freeze(
            current.request.payments.map((payment) => payment.paymentAttemptReference),
          ),
          escalationReasons: evaluated.decision.reasons,
          state: approval === null ? ("AwaitingApproval" as const) : ("Approved" as const),
          approval:
            approval === null
              ? null
              : Object.freeze({
                  approvalReference: approval.approval.approvalReference,
                  approverReference: approval.approval.approverReference,
                  approvedAt: approval.approval.approvedAt,
                }),
        }),
      );
    }
    return Object.freeze(entries);
  };
}
