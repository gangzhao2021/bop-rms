import type { ConsumerTransaction } from "@bop/eventing";
import { exactPaymentObject } from "../application/payment-intent-creation.js";
import { assertOrdinaryRefundRequester } from "../application/ordinary-refund-approval.js";
import { createPostgresOrdinaryRefundOperationExecutionSource } from "./ordinary-refund-operation-execution-source.js";
import {
  createPostgresOrdinaryRefundEscalationSource,
  createPostgresOrdinaryRefundApprovalSubjectSource,
} from "./persistence/ordinary-refund-request-store.js";
import { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import { createPostgresOrdinaryRefundApprovalValidationSource } from "./persistence/ordinary-refund-approval-store.js";
import {
  createPostgresOrdinaryRefundOperationPreparationSource,
  createPostgresOrdinaryRefundOperationStore,
} from "./persistence/ordinary-refund-operation-store.js";

type SubjectOptions = Parameters<typeof createPostgresOrdinaryRefundApprovalSubjectSource>[0];
type ExecutionOptions = Parameters<typeof createPostgresOrdinaryRefundOperationExecutionSource>[0];
type ApprovalOptions = Parameters<typeof createPostgresOrdinaryRefundApprovalValidationSource>[0];
type EscalationOptions = Parameters<typeof createPostgresOrdinaryRefundEscalationSource>[0];
type Options = SubjectOptions & {
  providerAccountReference: string;
  environment: "Test" | "Live";
  validatePricing: ExecutionOptions["validatePricing"];
  executor: ExecutionOptions["executor"];
  authority: ApprovalOptions["authority"];
  businessDate: EscalationOptions["businessDate"];
};
/** Preparation runtime with mandatory actual Payment sources. The composition
 * root must supply current workforce and published Store adapters; caller keeps
 * their fences until commit. Does not call a Provider or authorize replay I/O. */
export function createPostgresOrdinaryRefundOperationRuntime(options: Options) {
  const captureOptions = {
    scope: {
      ...options.scope,
      providerAccountReference: options.providerAccountReference,
      environment: options.environment,
    },
    authorize: options.authorize,
    validatePricing: options.validatePricing,
  };
  const execute = createPostgresOrdinaryRefundOperationExecutionSource({
    ...captureOptions,
    executor: options.executor,
  });
  const subject = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  const approval = createPostgresOrdinaryRefundApprovalValidationSource(options);
  const store = createPostgresOrdinaryRefundOperationStore({
    scope: options.scope,
    authorize: options.authorize,
    validateCurrent: async (tx, operation, at) => {
      const execution = await execute(tx, operation, at);
      const query = {
        orderReference: operation.orderReference,
        requestReference: operation.requestReference,
      };
      const escalation = await createPostgresOrdinaryRefundEscalationSource({
        scope: options.scope,
        authorize: options.authorize,
        captures: createPostgresOrdinaryRefundCaptureSource({
          ...captureOptions,
          now: () => execution.observedAt,
        }),
        businessDate: options.businessDate,
      })(tx, query);
      if (escalation.claimVersion !== operation.claimVersion) return false;
      const current = await subject(tx, { ...query, observedAt: escalation.observedAt });
      const expected = {
        ...options.scope,
        orderReference: operation.orderReference,
        actorReference: current.requesterReference,
      };
      assertOrdinaryRefundRequester({
        expected,
        observedAt: escalation.observedAt,
        authority: await options.authority(tx, {
          ...expected,
          permissionCode: "payment.refund.request",
          observedAt: escalation.observedAt,
        }),
      });
      if (escalation.decision.requiresIndependentApproval && operation.approvalReference === null)
        return false;
      if (operation.approvalReference !== null)
        await approval(tx, { ...query, approvalReference: operation.approvalReference });
      return true;
    },
  });
  const prepare = createPostgresOrdinaryRefundOperationPreparationSource(options);
  return {
    ...store,
    /** identities must come from the authenticated command/server. Financial
     * facts and Audit bindings are derived here, in the caller's single tx. */
    async prepareAndRecord(tx: ConsumerTransaction, identities: unknown, policy: unknown) {
      const auditPolicy = exactPaymentObject(policy, [
        "reasonCode",
        "retentionPolicyCode",
        "retentionPolicyVersion",
      ]);
      const operation = await prepare(tx, identities);
      return store.record(tx, operation, {
        auditId: operation.auditReference,
        brandId: operation.brandReference,
        storeId: operation.storeReference,
        actor: { type: "User", reference: operation.executorReference },
        actionCode: "PAYMENT_ORDINARY_REFUND_PREPARED",
        targetType: "PaymentRefundOperation",
        targetId: operation.operationReference,
        correlationId: operation.operationReference,
        occurredAt: operation.preparedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        reasonCode: auditPolicy.reasonCode,
        retentionPolicyCode: auditPolicy.retentionPolicyCode,
        retentionPolicyVersion: auditPolicy.retentionPolicyVersion,
      });
    },
  };
}
