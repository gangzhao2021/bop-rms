import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";
import { createPostgresOrdinaryRefundObservationStore } from "./persistence/ordinary-refund-operation-store.js";

/** Actual immutable Payment history supplies observation binding. The caller
 * retains system reconciliation authorization and commits the returned write. */
export function createPostgresOrdinaryRefundObservationRuntime(
  options: Parameters<typeof createPostgresOrdinaryRefundRecoverySource>[0],
) {
  return createPostgresOrdinaryRefundObservationStore({
    scope: options.scope,
    authorize: options.authorize,
    recover: createPostgresOrdinaryRefundRecoverySource(options),
  });
}
