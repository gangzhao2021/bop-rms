import { createPaidWithoutFulfillableOrderService } from "../application/paid-without-fulfillable-order-service.js";
import type { PaidWithoutFulfillableOrderPorts } from "../application/ports/paid-without-fulfillable-order-ports.js";
import { createPostgresPaymentCompensationSource } from "./persistence/payment-compensation-source.js";
import { createPostgresPaymentCompensationLeaseStore } from "./persistence/payment-compensation-lease-store.js";
import { createPostgresPaymentCompensationCaseStore } from "./persistence/payment-compensation-case-store.js";
import { createPostgresPaymentCompensationActionStore } from "./persistence/payment-compensation-action-store.js";
import { createPostgresPaymentCompensationOperationStore } from "./persistence/payment-compensation-operation-store.js";
import { createPostgresPaymentCompensationRefundStore } from "./persistence/payment-compensation-refund-store.js";
import { createPostgresPaymentCompensationOperationsStore } from "./persistence/payment-compensation-operations-store.js";
import { createPostgresPaymentCompensationEvidenceValidator } from "./persistence/payment-compensation-evidence-source.js";

type SourceOptions = Parameters<typeof createPostgresPaymentCompensationSource>[0];
type LeaseOptions = Parameters<typeof createPostgresPaymentCompensationLeaseStore>[0];
type CaseOptions = Parameters<typeof createPostgresPaymentCompensationCaseStore>[0];
type ActionOptions = Parameters<typeof createPostgresPaymentCompensationActionStore>[0];
type OperationOptions = Parameters<typeof createPostgresPaymentCompensationOperationStore>[0];
type RefundOptions = Parameters<typeof createPostgresPaymentCompensationRefundStore>[0];
type OperationsOptions = Parameters<typeof createPostgresPaymentCompensationOperationsStore>[0];
type EvidenceOptions = Parameters<typeof createPostgresPaymentCompensationEvidenceValidator>[0];
export interface PaymentCompensationRuntimeOptions {
  readonly tenantReference: SourceOptions["tenantReference"];
  readonly transactions: SourceOptions["transactions"];
  readonly scope: SourceOptions["scope"];
  readonly runtime: Pick<
    PaidWithoutFulfillableOrderPorts,
    "authorization" | "clock" | "provider" | "interac" | "audit" | "references"
  >;
  readonly source: Pick<SourceOptions, "authorize" | "otherRefunds">;
  readonly lease: Pick<LeaseOptions, "authorize" | "leaseDurationMs" | "newFenceReference">;
  readonly cases: Pick<CaseOptions, "authorize" | "validateOpen"> &
    Pick<EvidenceOptions, "validateCurrentSource">;
  readonly actions: Pick<ActionOptions, "authorize" | "validateClaim" | "validateOutcome">;
  readonly repository: Pick<OperationOptions, "authorize" | "validateSources">;
  readonly refunds: Pick<RefundOptions, "authorize" | "validateEvidence">;
  readonly operations: Pick<OperationsOptions, "authorize" | "validateEvidence">;
}

type ClaimInput = Parameters<ActionOptions["validateClaim"]>[1];
interface BalanceClaimInput {
  readonly caseRecord: Pick<
    ClaimInput["caseRecord"],
    | "brandReference"
    | "storeReference"
    | "orderReference"
    | "paymentTransactionReference"
    | "paymentIntentReference"
    | "paymentAttemptReference"
    | "environment"
    | "terminalEvidenceDigest"
  >;
  readonly receipt: Pick<ClaimInput["receipt"], "originalPaymentMethod" | "amount">;
}
/** Re-read balances within the action transaction, before writing a new claim. */
export function createPaymentCompensationClaimBalanceGuard(
  options: Pick<
    SourceOptions,
    "tenantReference" | "scope" | "clock" | "authorize" | "otherRefunds"
  >,
): (
  tx: Parameters<ActionOptions["validateClaim"]>[0],
  input: BalanceClaimInput,
) => Promise<boolean> {
  return async (tx, input) => {
    // Action store already holds the shared Order fence. Borrow this exact
    // transaction: opening another connection here would deadlock or leave
    // a check/write gap for ordinary requests.
    const currentSource = createPostgresPaymentCompensationSource({
      authorize: options.authorize,
      otherRefunds: options.otherRefunds,
      tenantReference: options.tenantReference,
      scope: options.scope,
      clock: options.clock,
      transactions: { run: async (work) => work(tx) },
    });
    const request = {
      brandReference: input.caseRecord.brandReference,
      storeReference: input.caseRecord.storeReference,
      orderReference: input.caseRecord.orderReference,
      paymentTransactionReference: input.caseRecord.paymentTransactionReference,
      paymentIntentReference: input.caseRecord.paymentIntentReference,
      paymentAttemptReference: input.caseRecord.paymentAttemptReference,
    };
    const identity = await currentSource.resolveIdentity(request);
    if (!identity) return false;
    const current = await currentSource.resolve({
      ...request,
      environment: identity.environment,
      identityVersion: identity.identityVersion,
      identityDigest: identity.identityDigest,
    });
    if (
      !current ||
      current.environment !== input.caseRecord.environment ||
      current.terminalEvidenceDigest !== input.caseRecord.terminalEvidenceDigest ||
      current.originalPaymentMethod !== input.receipt.originalPaymentMethod ||
      current.capturedAmount.amountMinor <
        current.confirmedRefundedAmount.amountMinor +
          current.pendingRefundClaimedAmount.amountMinor +
          input.receipt.amount.amountMinor
    )
      return false;
    return true;
  };
}

/** Single scoped durable composition; external truth and current authority remain required.
 * This constructs local runtime objects only and never starts workers or calls a Provider.
 */
export function createPostgresPaymentCompensationRuntime(
  options: PaymentCompensationRuntimeOptions,
) {
  const scope = Object.freeze({ ...options.scope });
  const ownerScope = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  const common = { transactions: options.transactions, scope: ownerScope };
  const lease = createPostgresPaymentCompensationLeaseStore({ ...options.lease, ...common });
  const source = createPostgresPaymentCompensationSource({
    ...options.source,
    tenantReference: options.tenantReference,
    transactions: options.transactions,
    scope,
    clock: options.runtime.clock,
  });
  const cases = createPostgresPaymentCompensationCaseStore({
    authorize: options.cases.authorize,
    validateOpen: options.cases.validateOpen,
    ...common,
    lease,
    validateTransition: createPostgresPaymentCompensationEvidenceValidator({
      scope: ownerScope,
      validateCurrentSource: options.cases.validateCurrentSource,
    }),
  });
  const actions = createPostgresPaymentCompensationActionStore({
    ...options.actions,
    ...common,
    lease,
    async validateClaim(tx, input) {
      const available = await createPaymentCompensationClaimBalanceGuard({
        ...options.source,
        tenantReference: options.tenantReference,
        scope,
        clock: options.runtime.clock,
      })(tx, input);
      return available && (await options.actions.validateClaim(tx, input)) === true;
    },
  });
  const repository = createPostgresPaymentCompensationOperationStore({
    ...options.repository,
    ...common,
    lease,
  });
  const refunds = createPostgresPaymentCompensationRefundStore({
    ...options.refunds,
    ...common,
    lease,
  });
  const operations = createPostgresPaymentCompensationOperationsStore({
    ...options.operations,
    ...common,
  });
  const service = createPaidWithoutFulfillableOrderService({
    ...options.runtime,
    source,
    lease: lease.lease,
    cases,
    actions,
    repository,
    refunds,
    operations,
  });
  return Object.freeze({
    execute: service.execute,
    /** Named-actor acknowledgement uses the same scoped durable operations store. */
    recordOperations: operations.record,
  });
}
