import {
  createPostgresPaymentReconciliationExceptionSource,
  createPostgresPaymentIntentBindingSource,
  parsePaymentReference,
} from "../../packages/rms/payment/src/index.ts";
import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
/** Retained transaction for scoped owner reads and an explicit projection consumer. */
export function createInternalReconciliationExceptionPageRunner(resources, consume) {
  const deny = () => {
    throw Error("INTERNAL_RECONCILIATION_EXCEPTIONS_UNAVAILABLE");
  };
  if (!isPilotRuntime()) return deny();
  const binding = resources.publicProfile.binding;
  const scope = Object.freeze({
    tenantReference: String(parsePaymentReference(binding.tenantReference)),
    brandReference: String(parsePaymentReference(resources.scope.brandReference)),
    storeReference: String(parsePaymentReference(resources.scope.storeReference)),
    environment: "Test",
  });
  const validUntil = parseCanonicalInstant(binding.validUntil);
  if (
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return deny();
  const active = () => isPilotRuntime() && parseCanonicalInstant(resources.now()) < validUntil;
  if (!active()) return deny();
  return async (input) => {
    if (!active()) return deny();
    return resources.transactions.run(async (tx) => {
      let open = true;
      const observedAt = parseCanonicalInstant(resources.now());
      const sameScope = (t, q) =>
        open &&
        t === tx &&
        active() &&
        q.brandReference === scope.brandReference &&
        q.storeReference === scope.storeReference;
      const intent = createPostgresPaymentIntentBindingSource({
        scope,
        authorize: async (t, q) =>
          sameScope(t, q) &&
          q.tenantReference === scope.tenantReference &&
          q.environment === "Test" &&
          q.observedAt === observedAt,
      });
      const reader = createPostgresPaymentReconciliationExceptionSource({
        scope,
        authorize: async (t, q) => sameScope(t, q) && q.purpose === "ProjectOrderException",
        resolveIntent: async (t, paymentIntentReference) => {
          if (t !== tx || !open || !active()) return deny();
          return intent(t, { paymentIntentReference, observedAt });
        },
      });
      try {
        const result = await reader(tx, input);
        if (!active()) return deny();
        const output = await consume({
          tx,
          page: result,
          scope,
          authorize: () => open && active(),
          reread: async () => {
            if (!open || !active()) return deny();
            return reader(tx, input);
          },
        });
        if (!active()) return deny();
        return output;
      } finally {
        open = false;
      }
    });
  };
}

/** Read-only wrapper; no projection consumer is installed. */
export function createInternalReconciliationExceptions(resources) {
  return createInternalReconciliationExceptionPageRunner(resources, ({ page }) => page);
}
