import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPaymentCompensationRuntime,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentCompensationProviderEvidence,
  createPostgresPaymentCompensationActionOutcomeEvidence,
  createPostgresPaymentCompensationOperationEvidence,
  parsePaidWithoutFulfillableOrderDisposition,
  createPaymentProviderContext,
  parsePaymentReference,
  type PaymentCompensationRuntimeOptions,
  type PaymentProviderAdapter,
} from "@rms/payment";
import { createPaymentCompensationDispositionEvidence } from "./payment-compensation-disposition-evidence.js";
import { createPaymentCompensationCaseEvidence } from "./payment-compensation-case-evidence.js";
import { createPaymentCompensationObservedProvider } from "./payment-compensation-observed-provider.js";
type Runtime = PaymentCompensationRuntimeOptions;
export interface PaymentCompensationCompositionOptions {
  disposition: unknown;
  tenantReference: string;
  transactions: Runtime["transactions"];
  scope: Runtime["scope"];
  clock: Runtime["runtime"]["clock"];
  references: Runtime["runtime"]["references"];
  audit: Runtime["runtime"]["audit"];
  provider: Pick<PaymentProviderAdapter, "retrieveIntent" | "refundPayment">;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
  otherRefunds: Runtime["source"]["otherRefunds"];
  lease: Pick<Runtime["lease"], "leaseDurationMs" | "newFenceReference">;
  newObservationReference(): string;
  operations: Runtime["operations"];
  authorizeOperations: Runtime["runtime"]["authorization"]["authorizeOperations"];
}
/** One durable OnlineCard compensation binding. Construction reads owners only;
 * execution and named-actor reconciliation remain explicit operations. */
export async function createPaymentCompensationComposition(
  options: PaymentCompensationCompositionOptions,
): Promise<ReturnType<typeof createPostgresPaymentCompensationRuntime>> {
  const disposition = parsePaidWithoutFulfillableOrderDisposition(options.disposition);
  const scope = Object.freeze({ ...options.scope });
  const evidence = createPaymentCompensationDispositionEvidence({
    scope,
    now: options.clock.now,
    authorize: options.authorize,
  });
  const authorized = (tx: ConsumerTransaction) => evidence(tx, disposition);
  const terminal = await options.transactions.run(async (tx) => {
    if (!(await authorized(tx))) throw new Error("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    const fact = await createPostgresPaymentTerminalStore({ run: (work) => work(tx) }, scope).read(
      disposition.paymentIntentReference,
    );
    if (!fact || fact.outcome !== "Succeeded" || !(await authorized(tx)))
      throw new Error("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
    return fact;
  });
  const payment = {
    environment: scope.environment,
    paymentTransactionReference: String(disposition.paymentTransactionReference),
    paymentAttemptReference: String(disposition.paymentAttemptReference),
  };
  const operationReference = options.references.operationFor({
    ...payment,
    brandReference: String(disposition.brandReference),
    storeReference: String(disposition.storeReference),
    orderReference: String(disposition.orderReference),
    purpose: "CompensatePaidWithoutFulfillableOrder",
  });
  const caseReference = options.references.caseFor({
    ...payment,
    orderReference: String(disposition.orderReference),
    reason: "PaidWithoutFulfillableOrder",
    purpose: "CompensatePaidWithoutFulfillableOrder",
  });
  const actionReference = options.references.actionFor({
    ...payment,
    compensationCaseReference: caseReference,
    purpose: "RefundPaidWithoutFulfillableOrder",
  });
  const scoped = (input: { brandReference: string; storeReference: string }) =>
    input.brandReference === scope.brandReference && input.storeReference === scope.storeReference;
  const caseAccess = async (
    tx: ConsumerTransaction,
    input: { brandReference: string; storeReference: string; caseReference: string },
  ) => scoped(input) && input.caseReference === caseReference && (await authorized(tx));
  const source: Runtime["source"] = {
    otherRefunds: options.otherRefunds,
    authorize: async (tx, input) =>
      scoped(input) &&
      input.orderReference === String(disposition.orderReference) &&
      input.paymentIntentReference === String(disposition.paymentIntentReference) &&
      input.paymentTransactionReference === payment.paymentTransactionReference &&
      input.paymentAttemptReference === payment.paymentAttemptReference &&
      (await authorized(tx)),
  };
  const cases = createPaymentCompensationCaseEvidence({
    disposition,
    validateDisposition: async (tx, value) =>
      JSON.stringify(value) === JSON.stringify(disposition) && (await authorized(tx)),
    source: { ...source, scope, tenantReference: options.tenantReference, clock: options.clock },
  });
  const provider = createPaymentCompensationObservedProvider({
    transactions: options.transactions,
    context: createPaymentProviderContext({
      provider: "Stripe",
      environment: scope.environment,
      brandReference: parsePaymentReference(scope.brandReference),
      storeReference: parsePaymentReference(scope.storeReference),
      paymentAttemptReference: parsePaymentReference(payment.paymentAttemptReference),
      operationReference: parsePaymentReference(actionReference),
    }),
    paymentIntentReference: String(disposition.paymentIntentReference),
    providerIntentReference: terminal.providerIntentReference,
    provider: options.provider,
    authorize: authorized,
    now: options.clock.now,
    newObservationReference: options.newObservationReference,
  });
  const refundEvidence = createPostgresPaymentCompensationProviderEvidence({
    scope,
    authorize: authorized,
  });
  const outcomeEvidence = createPostgresPaymentCompensationActionOutcomeEvidence({
    scope,
    authorize: authorized,
    now: options.clock.now,
  });
  const resultEvidence = createPostgresPaymentCompensationOperationEvidence({
    scope,
    authorize: async (tx, record) =>
      JSON.stringify(record.disposition) === JSON.stringify(disposition) && (await authorized(tx)),
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("PAYMENT_COMPENSATION_INTERAC_UNAVAILABLE");
  };
  return createPostgresPaymentCompensationRuntime({
    tenantReference: options.tenantReference,
    transactions: options.transactions,
    scope,
    source,
    runtime: {
      clock: options.clock,
      references: options.references,
      audit: options.audit,
      provider,
      interac: { resolve: unavailable, resolveClaim: unavailable, claim: unavailable },
      authorization: {
        authorize: async (value) =>
          JSON.stringify(value) === JSON.stringify(disposition) &&
          (await options.transactions.run(authorized)),
        authorizeInterac: async () => false,
        authorizeOperations: options.authorizeOperations,
      },
    },
    lease: {
      ...options.lease,
      authorize: async (tx, input) =>
        scoped(input) &&
        input.operationReference === operationReference &&
        input.paymentAttemptReference === payment.paymentAttemptReference &&
        (await authorized(tx)),
    },
    cases: {
      authorize: caseAccess,
      validateOpen: cases.validateOpen,
      validateCurrentSource: cases.validateCurrentSource,
    },
    actions: {
      authorize: async (tx, input) =>
        scoped(input) && input.actionReference === actionReference && (await authorized(tx)),
      validateClaim: cases.validateClaim,
      validateOutcome: outcomeEvidence,
    },
    repository: {
      authorize: async (tx, input) =>
        scoped(input) && input.operationReference === operationReference && (await authorized(tx)),
      validateSources: resultEvidence,
    },
    refunds: {
      authorize: caseAccess,
      validateEvidence: async (tx, input) =>
        input.caseRecord.caseReference === caseReference &&
        (await refundEvidence(tx, input.receipt.fact)),
    },
    operations: {
      authorize: async (tx, input) =>
        (await caseAccess(tx, input)) && (await options.operations.authorize(tx, input)),
      validateEvidence: async (tx, input) =>
        input.caseRecord.caseReference === caseReference &&
        (await authorized(tx)) &&
        (await options.operations.validateEvidence(tx, input)),
    },
  });
}
