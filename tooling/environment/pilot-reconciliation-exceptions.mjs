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
        // WP-2423: a coverage check may `select` the exceptions it needs: the page is listed
        // without per-exception payment links and only the selected ones are read in full.
        const { select, ...query } = input;
        if (select !== undefined && typeof select !== "function") return deny();
        let result;
        if (!select) result = await reader(tx, query);
        else {
          const listed = await createPostgresPaymentReconciliationExceptionSource({
            scope,
            authorize: async (t, q) => sameScope(t, q) && q.purpose === "ProjectOrderException",
          })(tx, query);
          const items = [];
          let previous = query.afterExceptionReference;
          for (const source of listed.items) {
            if (select(source.exceptionReference) !== true)
              items.push(Object.freeze({ reference: source.exceptionReference, skipped: true }));
            else {
              const one = await reader(tx, { afterExceptionReference: previous, limit: 1 });
              if (
                one.items.length !== 1 ||
                one.items[0].exceptionReference !== source.exceptionReference
              )
                return deny();
              items.push(one.items[0]);
            }
            previous = source.exceptionReference;
          }
          result = Object.freeze({
            items: Object.freeze(items),
            nextAfterExceptionReference: listed.nextAfterExceptionReference,
          });
        }
        if (!active()) return deny();
        const output = await consume({
          tx,
          page: result,
          scope,
          authorize: () => open && active(),
          reread: async () => {
            if (!open || !active()) return deny();
            return reader(tx, query);
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
