import type { createPostgresOrdinaryRefundOperationRuntime } from "./ordinary-refund-operation-runtime.js";
import { createPostgresOrdinaryRefundDispatchStore } from "./persistence/ordinary-refund-operation-store.js";
import {
  createPostgresOrdinaryRefundApprovalSubjectSource,
  createPostgresOrdinaryRefundEscalationSource,
} from "./persistence/ordinary-refund-request-store.js";
import { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import { createPostgresOrdinaryRefundApprovalValidationSource } from "./persistence/ordinary-refund-approval-store.js";
import { createPostgresOrdinaryRefundOperationExecutionSource } from "./ordinary-refund-operation-execution-source.js";
import { assertOrdinaryRefundRequester } from "../application/ordinary-refund-approval.js";

type Options = Parameters<typeof createPostgresOrdinaryRefundOperationRuntime>[0];
/** Journal current first-dispatch authority. A renewed approval binds current
 * claims while the original operation, allocation and Provider identity stay
 * immutable. Caller commits before I/O; historical replay never grants a send. */
export function createPostgresOrdinaryRefundDispatchRuntime(options: Options) {
  const subject = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  const approval = createPostgresOrdinaryRefundApprovalValidationSource(options);
  const captureOptions = {
    scope: {
      ...options.scope,
      providerAccountReference: options.providerAccountReference,
      environment: options.environment,
    },
    authorize: options.authorize,
    validatePricing: options.validatePricing,
  };
  const execution = createPostgresOrdinaryRefundOperationExecutionSource({
    ...captureOptions,
    executor: options.executor,
  });
  return createPostgresOrdinaryRefundDispatchStore({
    scope: options.scope,
    authorize: options.authorize,
    prepareCurrent: async (tx, { operation, approvalReference, observedAt }) => {
      const query = {
        orderReference: operation.orderReference,
        requestReference: operation.requestReference,
      };
      const current = await subject(tx, { ...query, observedAt });
      if (current.subject.allocationDigest !== operation.allocationDigest)
        throw new Error("ORDINARY_REFUND_DISPATCH_SOURCE_CHANGED");
      const refreshed = {
        ...operation,
        claimVersion: current.claimVersion,
        claimsDigest: current.subject.claimsDigest,
        approvalReference,
      };
      await execution(tx, refreshed, observedAt);
      let providerBinding: unknown;
      const capture = createPostgresOrdinaryRefundCaptureSource({
        ...captureOptions,
        now: () => observedAt,
      });
      const escalation = await createPostgresOrdinaryRefundEscalationSource({
        scope: options.scope,
        authorize: options.authorize,
        businessDate: options.businessDate,
        captures: async (transaction, input) => {
          const sources = await capture(transaction, input);
          providerBinding = sources.find(
            (source) => source.paymentAttemptReference === operation.paymentAttemptReference,
          )?.providerBinding;
          return sources;
        },
      })(tx, query);
      if (escalation.claimVersion !== current.claimVersion || providerBinding === undefined)
        throw new Error("ORDINARY_REFUND_DISPATCH_SOURCE_CHANGED");
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
      if (escalation.decision.requiresIndependentApproval && approvalReference === null)
        throw new Error("ORDINARY_REFUND_DISPATCH_APPROVAL_REQUIRED");
      if (approvalReference !== null) await approval(tx, { ...query, approvalReference });
      return {
        providerBinding,
        claimVersion: current.claimVersion,
        claimsDigest: current.subject.claimsDigest,
      };
    },
  });
}
