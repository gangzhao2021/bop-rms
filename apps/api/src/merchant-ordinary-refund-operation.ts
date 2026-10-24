import {
  createPostgresOrdinaryRefundOperationRuntime,
  createPostgresOrdinaryRefundSendRuntime,
  createPostgresOrdinaryRefundPricingSource,
} from "@rms/payment";
import { parseOpaqueUuidV7 } from "@bop/identity";
import { createMerchantOrdinaryRefundAuthority } from "./merchant-ordinary-refund-authority.js";
import { createMerchantOrdinaryRefundExecutor } from "./merchant-ordinary-refund-executor.js";
import { createMerchantOrdinaryRefundBusinessDate } from "./merchant-ordinary-refund-business-date.js";

type RuntimeOptions = Parameters<typeof createPostgresOrdinaryRefundOperationRuntime>[0];
/** Internal composition, not an HTTP entry point. authorize must bind the
 * authenticated actor/purpose and retain current tenant/store/request fences.
 * The operation must be server-prepared from the authorized request. A route
 * may not pass arbitrary browser operation/Audit objects directly to record.
 */
function resolveRuntimeOptions(options: {
  scope: RuntimeOptions["scope"];
  providerAccountReference: string;
  environment: RuntimeOptions["environment"];
  authorize: RuntimeOptions["authorize"];
  workforce: Parameters<typeof createMerchantOrdinaryRefundAuthority>[0];
  store: Parameters<typeof createMerchantOrdinaryRefundBusinessDate>[0];
}): RuntimeOptions {
  const scope = {
    tenantReference: String(
      parseOpaqueUuidV7(options.scope.tenantReference, "ACTOR_REFERENCE_INVALID"),
    ),
    brandReference: String(
      parseOpaqueUuidV7(options.scope.brandReference, "ACTOR_REFERENCE_INVALID"),
    ),
    storeReference: String(
      parseOpaqueUuidV7(options.scope.storeReference, "ACTOR_REFERENCE_INVALID"),
    ),
  };
  if (
    options.store.tenantReference !== scope.tenantReference ||
    options.store.brandReference !== scope.brandReference ||
    options.store.storeReference !== scope.storeReference
  )
    throw new Error("ORDINARY_REFUND_COMPOSITION_SCOPE_MISMATCH");
  return {
    scope,
    providerAccountReference: options.providerAccountReference,
    environment: options.environment,
    authorize: options.authorize,
    validatePricing: createPostgresOrdinaryRefundPricingSource({
      scope,
      authorize: options.authorize,
    }),
    authority: createMerchantOrdinaryRefundAuthority(options.workforce),
    executor: createMerchantOrdinaryRefundExecutor(options.workforce),
    businessDate: createMerchantOrdinaryRefundBusinessDate(options.store),
  };
}

export function createMerchantOrdinaryRefundOperation(
  options: Parameters<typeof resolveRuntimeOptions>[0],
) {
  return createPostgresOrdinaryRefundOperationRuntime(resolveRuntimeOptions(options));
}

/** Re-evaluates the same current Workforce, MFA, business date and capture sources
 * when recording a dispatch. The owner coordinator commits before Provider I/O. */
export function createMerchantOrdinaryRefundSend(
  options: Parameters<typeof resolveRuntimeOptions>[0] &
    Omit<Parameters<typeof createPostgresOrdinaryRefundSendRuntime>[0], "dispatch">,
) {
  return createPostgresOrdinaryRefundSendRuntime({
    dispatch: resolveRuntimeOptions(options),
    transactions: options.transactions,
    provider: options.provider,
    authorizeRecovery: options.authorizeRecovery,
    generateObservationIdentity: options.generateObservationIdentity,
  });
}
