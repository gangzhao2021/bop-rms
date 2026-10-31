import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { createPostgresReconciliationFollowUpQuery } from "@rms/payment";
import { createMerchantReconciliationFollowUpTransactions } from "./merchant-reconciliation-follow-up-transactions.js";
import type { createMerchantReconciliationFollowUpCommand } from "./merchant-reconciliation-follow-up-command.js";
type Options = Pick<
  Parameters<typeof createMerchantReconciliationFollowUpCommand>[0],
  "persistence" | "authentication"
>;
export function createMerchantReconciliationFollowUpQuery(options: Options) {
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["exceptionReference"]);
    const exceptionReference = String(
      parseOpaqueUuidV7(raw.exceptionReference, "ACTOR_REFERENCE_INVALID"),
    );
    const bridge = await createMerchantReconciliationFollowUpTransactions({
      persistence: options.persistence,
      sessionCookie: input.sessionCookie,
      sessionReference: session.sessionReference,
      exceptionReference,
      verifyAssignee: async () => false,
    });
    return bridge.transactions.run(async (tx) =>
      createPostgresReconciliationFollowUpQuery({
        scope: bridge.scope,
        authorize: async (t, q, purpose) => {
          if (
            t !== tx ||
            purpose !== "ReadPaymentReconciliationFollowUp" ||
            q.tenantReference !== bridge.scope.tenantReference ||
            q.brandReference !== bridge.scope.brandReference ||
            q.storeReference !== bridge.scope.storeReference ||
            q.exceptionReference !== exceptionReference
          )
            return false;
          return (await bridge.resolveAuthority(t)).authorize();
        },
      })(tx, exceptionReference),
    );
  };
}
