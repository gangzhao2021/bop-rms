import { createPostgresOrderBatchIdentitySource } from "@rms/ordering";
import { createPostgresCapturedBatchPaymentSource } from "@rms/payment";
import type { createMerchantOrderAcceptanceCommand } from "./merchant-order-acceptance-command.js";

type Options = Parameters<typeof createMerchantOrderAcceptanceCommand>[0];
type Resolver = Options["resolveConfiguration"];
type Resolution = Awaited<ReturnType<Resolver>>;
type Scope = Parameters<Resolver>[1];
type Transaction = Parameters<Resolver>[0];

/** Server-owned batch-kind and captured-event discovery. Policy/Provider configuration
 * remains an explicitly authorized source; no fallback to a guessed kind or event. */
export function createMerchantAcceptanceConfigurationResolver(options: {
  now(): string;
  authorize(transaction: Transaction, scope: Scope): Promise<boolean>;
  resolvePolicy(
    transaction: Transaction,
    scope: Scope,
  ): Promise<{
    paymentScope: Parameters<typeof createPostgresCapturedBatchPaymentSource>[0]["scope"];
    initial?: Extract<Resolution, { kind?: "Initial" }>["configuration"];
    additional?: Extract<Resolution, { kind: "Additional" }>["configuration"];
  }>;
}): Resolver {
  return async (transaction, scope, command) => {
    const unavailable = (): never => {
      throw new Error("MERCHANT_ACCEPTANCE_CONFIGURATION_UNAVAILABLE");
    };
    if (!(await options.authorize(transaction, scope))) return unavailable();
    const policy = await options.resolvePolicy(transaction, scope);
    if (
      policy.paymentScope.brandReference !== scope.brandReference ||
      policy.paymentScope.storeReference !== scope.storeReference
    )
      return unavailable();
    const query = {
      orderReference: command.orderReference,
      orderBatchReference: command.orderBatchReference,
      observedAt: options.now(),
    };
    const authorize = () => options.authorize(transaction, scope);
    const identity = await createPostgresOrderBatchIdentitySource({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize,
    }).load(transaction, query);
    if (!identity) return unavailable();
    const captured = await createPostgresCapturedBatchPaymentSource({
      scope: policy.paymentScope,
      authorize,
    }).load(transaction, query);
    if (
      !captured ||
      captured.submissionReference !== identity.submissionReference ||
      !(await authorize())
    )
      return unavailable();
    if (identity.kind === "Initial") {
      if (!policy.initial) return unavailable();
      return {
        kind: "Initial",
        configuration: policy.initial,
        paymentEvent: captured.paymentEvent,
      };
    }
    if (!policy.additional) return unavailable();
    return {
      kind: "Additional",
      configuration: policy.additional,
      paymentEvent: captured.paymentEvent,
    };
  };
}
