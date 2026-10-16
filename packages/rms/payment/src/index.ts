export { moduleManifest } from "./module.manifest.js";
export * from "./contracts/store-payment-configuration.js";
export * from "./infrastructure/persistence/store-payment-configuration-store.js";
export * from "./contracts/payment-provider-adapter.js";
export * from "./application/payment-provider-adapter.js";
export * from "./contracts/payment-intent-creation.js";
export * from "./application/payment-kill-switch.js";
export * from "./application/payment-intent-creation-service.js";
export * from "./application/ports/payment-kill-switch-ports.js";
export * from "./application/ports/payment-intent-creation-ports.js";
export * from "./contracts/provider-webhook-verification.js";
export * from "./contracts/payment-webhook-inbox.js";
export * from "./application/provider-webhook-verification-service.js";
export * from "./application/payment-webhook-inbox-service.js";
export * from "./application/ports/payment-webhook-inbox-ports.js";
export * from "./application/ports/provider-webhook-verification-ports.js";
export * from "./infrastructure/stripe/stripe-webhook-signature.js";
export * from "./contracts/payment-terminal-event.js";
export * from "./application/payment-terminal-fact.js";
export * from "./application/payment-terminal-event.js";
export * from "./application/payment-terminal-service.js";
export * from "./application/ports/payment-terminal-ports.js";
export * from "./application/payment-terminal-capture-watchdog.js";
export * from "./application/payment-terminal-capture-watchdog-service.js";
export * from "./application/ports/payment-terminal-capture-watchdog-ports.js";
export * from "./application/payment-status-projection.js";
export * from "./application/payment-status-projection-service.js";
export * from "./application/ports/payment-status-projection-ports.js";
export * from "./application/payment-reconciliation.js";
export * from "./application/payment-reconciliation-service.js";
export * from "./application/payment-reconciliation-query-service.js";
export * from "./application/ports/payment-reconciliation-ports.js";
export * from "./contracts/payment-refunded-event.js";
export * from "./application/paid-without-fulfillable-order.js";
export * from "./application/payment-refunded-event.js";
export * from "./application/paid-without-fulfillable-order-service.js";
export * from "./application/ports/paid-without-fulfillable-order-ports.js";

export * from "./application/payment-tip-selection.js";
export * from "./infrastructure/persistence/payment-tip-selection-store.js";
export * from "./application/payment-tip-selection-service.js";
export * from "./application/payment-preparation-amounts.js";

export {
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentOperationFence,
  createPostgresAdmittedPaymentIntentCreationStore,
  type PaymentIntentClaimAdmission,
  type PaymentIntentTransactionRunner,
} from "./infrastructure/persistence/payment-intent-creation-store.js";

export {
  createCustomerPaymentKillSwitch,
  type CustomerPaymentKillSwitchOptions,
} from "./application/customer-payment-kill-switch.js";

export { deriveConfiguredPaymentPreparationAmounts } from "./application/payment-preparation-amounts.js";

export {
  createStripeOnlineIntentAdapter,
  type StripeOnlineIntentAdapterOptions,
} from "./infrastructure/stripe/stripe-online-intent-adapter.js";

export {
  createCustomerPaymentHandoff,
  CustomerPaymentHandoffError,
  type CustomerPaymentHandoffPorts,
} from "./application/customer-payment-handoff.js";
export {
  createStripeOnlineClientHandoff,
  StripeOnlineClientHandoffError,
} from "./infrastructure/stripe/stripe-online-client-handoff.js";

export { createPostgresPaymentTerminalSource } from "./infrastructure/persistence/payment-terminal-source.js";

export {
  createPostgresPaymentTerminalStore,
  listOrderPaymentTerminalOutcomes,
  type OrderPaymentTerminalOutcome,
} from "./infrastructure/persistence/payment-terminal-store.js";

export { createPostgresPaymentProviderObservationStore } from "./infrastructure/persistence/payment-provider-observation-store.js";

export {
  createPostgresPaymentStatusStore,
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesWithOnlinePayment,
  listStoreOrderOnlinePaidTotals,
  listStoreOrdersWithOnlineRefunds,
} from "./infrastructure/persistence/payment-status-store.js";

export {
  createPaymentStatusEventConsumerService,
  type PaymentStatusEventConsumerPorts,
} from "./application/payment-status-event-consumer.js";

export * from "./infrastructure/persistence/payment-receipt-coverage-source.js";

export { createPostgresPaymentCompensationLeaseStore } from "./infrastructure/persistence/payment-compensation-lease-store.js";

export { createPostgresPaymentCompensationOperationStore } from "./infrastructure/persistence/payment-compensation-operation-store.js";

export { createPostgresPaymentCompensationCaseStore } from "./infrastructure/persistence/payment-compensation-case-store.js";

export {
  encodePaymentCompensationAction,
  decodePaymentCompensationAction,
} from "./application/payment-compensation-action-codec.js";

export { createPostgresPaymentCompensationActionStore } from "./infrastructure/persistence/payment-compensation-action-store.js";

export { createPostgresPaymentCompensationRefundStore } from "./infrastructure/persistence/payment-compensation-refund-store.js";

export { createPostgresPaymentCompensationOperationsStore } from "./infrastructure/persistence/payment-compensation-operations-store.js";

export {
  createPostgresPaymentCompensationOperationEvidence,
  createPostgresPaymentCompensationReconciliationSource,
  createPostgresPaymentCompensationEvidenceValidator,
  createPostgresPaymentCompensationIdentityReader,
} from "./infrastructure/persistence/payment-compensation-evidence-source.js";

export { createPostgresPaymentCompensationRefundPositionSource } from "./infrastructure/persistence/payment-compensation-refund-position-source.js";
// WP-2423 Q8: a captured payment's ordinary refund position (read only), as receipts compose it.
export { createPostgresOrdinaryRefundPositionSource } from "./infrastructure/ordinary-refund-position-source.js";

export { createPostgresPaymentCompensationSource } from "./infrastructure/persistence/payment-compensation-source.js";

export {
  createPostgresPaymentCompensationRuntime,
  type PaymentCompensationRuntimeOptions,
} from "./infrastructure/payment-compensation-runtime.js";

export { createPaymentCompensationFailureRecorder } from "./infrastructure/payment-compensation-failure-recorder.js";

export { createPaymentRefundStatusConsumer } from "./application/payment-refund-status-consumer.js";

export { createPostgresPaymentRefundStatusStore } from "./infrastructure/persistence/payment-refund-status-store.js";

export {
  createPostgresPaymentCompensationExceptionSource,
  createPostgresPaymentCompensationExceptionCandidates,
} from "./infrastructure/persistence/payment-compensation-exception-source.js";

export { createOrdinaryRefundRoleResolver } from "./application/ordinary-refund-role.js";

export { createPostgresOrdinaryRefundOperationRuntime } from "./infrastructure/ordinary-refund-operation-runtime.js";
export { createPostgresOrdinaryRefundPricingSource } from "./infrastructure/ordinary-refund-pricing-source.js";

export { createPostgresCapturedBatchPaymentSource } from "./infrastructure/persistence/captured-batch-payment-source.js";

export { createPostgresOrdinaryRefundWorkSource } from "./infrastructure/persistence/ordinary-refund-operation-store.js";
export { createPostgresOrdinaryRefundSendRuntime } from "./infrastructure/ordinary-refund-send-runtime.js";
export { createPostgresOrdinaryRefundReconciliationRuntime } from "./infrastructure/ordinary-refund-reconciliation-runtime.js";

export {
  createPostgresCancellationRefundRuntime,
  createPostgresCancellationRefundFollowUp,
  readCancellationRefundStatus,
  type CancellationRefundScope,
  type CancellationRefundAuthorizeQuery,
  type CancellationRefundRuntimeOptions,
  type CancellationRefundPreviewInput,
  type CancellationRefundRecordInput,
  type CancellationRefundPreview,
  type CancellationRefundRecordResult,
  type CancellationRefundStatus,
} from "./infrastructure/cancellation-refund-runtime.js";
export {
  readPaymentRemainingRefundable,
  type PaymentRemainingRefundableQuery,
} from "./infrastructure/payment-remaining-refundable.js";
export type {
  OrdinaryRefundCancellationAuthority,
  OrdinaryRefundCancellationAuthorityQuery,
} from "./infrastructure/ordinary-refund-operation-execution-source.js";
export {
  ordinaryRefundClaimKind,
  ordinaryRefundPaymentAmount,
  type OrdinaryRefundCancellationClaim,
} from "./application/ordinary-refund-request.js";

export { createPostgresOrderPaymentRefundPosition } from "./infrastructure/order-payment-refund-position.js";

export { createPostgresOrderPaymentAttemptPosition } from "./infrastructure/persistence/order-payment-attempt-position.js";

export { createPostgresOrderFinancialPosition } from "./infrastructure/order-financial-position.js";

export { assessOrderSettlement, type OrderSettlementInput } from "./domain/order-settlement.js";

export {
  parseOrderSettledFinality,
  type OrderSettledFinality,
} from "./application/order-settled-finality.js";
export { createPostgresOrderSettledFinalityStore } from "./infrastructure/persistence/order-settled-finality-store.js";

export { createPostgresOrdinaryRefundRequestContextSource } from "./infrastructure/persistence/ordinary-refund-request-store.js";

export { createPostgresOrdinaryRefundRequestRuntime } from "./infrastructure/ordinary-refund-request-runtime.js";
export {
  createPostgresOrdinaryRefundApprovalQueueRuntime,
  createPostgresOrdinaryRefundCurrentEscalationSource,
} from "./infrastructure/ordinary-refund-approval-queue-runtime.js";
export {
  createPostgresOrdinaryRefundApprovalStore,
  createPostgresOrdinaryRefundApprovalReader,
  createPostgresOrdinaryRefundDeclineStore,
  OrdinaryRefundDeclineError,
  ordinaryRefundDeclineReasons,
  createPostgresSoleOperatorRefundSummaryReader,
  listOrdinaryRefundApprovalReferences,
} from "./infrastructure/persistence/ordinary-refund-approval-store.js";
// WP-2423 Q19: how an approval satisfied the "another person" rule, and the sole-operator fact.
export {
  ordinaryRefundApprovalModeOf,
  type OrdinaryRefundApprovalMode,
  type OrdinaryRefundSoleOperatorStatus,
} from "./application/ordinary-refund-approval.js";
export { createPostgresOrdinaryRefundApprovalSource } from "./infrastructure/ordinary-refund-approval-source.js";
export {
  createPostgresOrdinaryRefundApprovalSubjectSource,
  readOrdinaryRefundRequestNote,
} from "./infrastructure/persistence/ordinary-refund-request-store.js";

export { createPostgresPaymentIntentBindingSource } from "./infrastructure/persistence/payment-intent-binding-source.js";

export { createPostgresOrdinaryRefundRequestStatusSource } from "./infrastructure/ordinary-refund-request-status-source.js";

export {
  createPostgresPaymentCompensationProviderEvidence,
  createPostgresPaymentCompensationActionOutcomeEvidence,
} from "./infrastructure/persistence/payment-compensation-provider-evidence.js";

export {
  createPostgresPaymentReconciliationExceptionSource,
  createPostgresPaymentReconciliationExceptionDetailReader,
  paymentReconciliationExceptionDetailLimit,
  type PaymentReconciliationExceptionDetail,
} from "./infrastructure/persistence/payment-reconciliation-exception-source.js";

export {
  createPostgresPaymentReconciliationRunSource,
  createPostgresPaymentReconciliationRepository,
  createPostgresPaymentReconciliationResolutionReader,
  type PaymentReconciliationResolution,
} from "./infrastructure/persistence/payment-reconciliation-run-source.js";
export {
  createPostgresPaymentReconciliationDaySource,
  paymentReconciliationDayDifferenceLimit,
  paymentReconciliationDaySettlementCheckLimit,
  paymentReconciliationDayRecheckLimit,
  paymentReconciliationDayAdditionalCheckLimit,
  type PaymentReconciliationDay,
  type PaymentReconciliationDayRun,
  type PaymentReconciliationDayCheck,
} from "./infrastructure/persistence/payment-reconciliation-window-source.js";

export {
  createPostgresPaymentReconciliationCandidates,
  createPostgresPaymentReconciliationCandidateSource,
  createPostgresPaymentCaptureWindowSource,
} from "./infrastructure/persistence/payment-reconciliation-candidates.js";

export { createPostgresOrdinaryRefundWindowSource } from "./infrastructure/ordinary-refund-window-source.js";

export { createPostgresConfirmedCompensationRefundSource } from "./infrastructure/persistence/payment-compensation-refund-source.js";

export * from "./application/provider-capture-reconciliation.js";

export * from "./infrastructure/persistence/provider-capture-exception-store.js";

export * from "./application/reconciliation-follow-up.js";
export * from "./application/reconciliation-follow-up-service.js";
export * from "./infrastructure/persistence/reconciliation-follow-up-store.js";
// WP-2423 P6: full refund of a Provider capture that matches no payment or Order.
export * from "./infrastructure/persistence/unmatched-capture-refund-store.js";

// WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD): payments and refunds on the Store's own card machine.
export * from "./application/card-machine-payment.js";
export { createPostgresCardMachinePaymentStore } from "./infrastructure/persistence/card-machine-payment-store.js";

// WP-2423 Q14: the payments and refunds behind the Store sales reports, as day-end settlement counts them.
export {
  createPostgresStoreSalesPaymentLedger,
  type StoreSalesPayment,
  type StoreSalesPaymentChannel,
  type StoreSalesRefund,
  type StoreSalesRefundItemShare,
  type StoreSalesSettlementTotals,
} from "./infrastructure/persistence/store-sales-payment-ledger.js";
