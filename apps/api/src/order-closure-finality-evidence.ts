import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderClosureHistory, parseOrderClosureRecord } from "@rms/ordering";
import {
  createPostgresOrderSettledFinalityStore,
  parseOrderSettledFinality,
  parsePaymentReference,
  parsePaymentInstant,
} from "@rms/payment";
type Options = Omit<Parameters<typeof createPostgresOrderSettledFinalityStore>[0], "audit">;
const fail = (): never => {
  throw Error("ORDER_CLOSURE_FINALITY_EVIDENCE_UNAVAILABLE");
};
/** Historical owner facts only. The caller must separately bind an exception episode;
 * neither a historical closure nor this query asserts the current financial state. */
export function createOrderClosureFinalityEvidence(options: Options) {
  const scope = Object.freeze({
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  const account = String(parsePaymentReference(options.providerAccountReference));
  if (!["Test", "Live"].includes(options.environment)) return fail();
  return async (
    tx: ConsumerTransaction,
    input: {
      orderReference: string;
      closureReference: string;
      observedAt: string;
    },
  ) => {
    try {
      const query = {
        orderReference: String(parsePaymentReference(input.orderReference)),
        observedAt: String(parsePaymentInstant(input.observedAt)),
      };
      const reference = String(parsePaymentReference(input.closureReference));
      const authorize = () => options.authorize(tx, query);
      if ((await authorize()) !== true) return fail();
      const history = await createPostgresOrderClosureHistory({ ...scope, authorize })(tx, query);
      if (
        history.position.tenantReference !== scope.tenantReference ||
        history.position.brandReference !== scope.brandReference ||
        history.position.storeReference !== scope.storeReference ||
        history.position.orderReference !== query.orderReference ||
        history.position.observedAt !== query.observedAt
      )
        return fail();
      const matches = history.records.filter((record) => record.closureReference === reference);
      if (matches.length > 1) return fail();
      const candidate = matches[0];
      if (!candidate || candidate.status !== "Closed") {
        if ((await authorize()) !== true) return fail();
        return null;
      }
      const closure = parseOrderClosureRecord(candidate);
      if (
        closure.tenantReference !== scope.tenantReference ||
        closure.brandReference !== scope.brandReference ||
        closure.storeReference !== scope.storeReference ||
        closure.orderReference !== query.orderReference ||
        closure.occurredAt > query.observedAt ||
        closure.financialFinalityReference === null
      )
        return fail();
      const store = createPostgresOrderSettledFinalityStore({
        ...options,
        scope,
        providerAccountReference: account,
        authorize,
        audit: async () => fail(),
      });
      const value = await store.readFinality(tx, {
        ...query,
        finalityReference: closure.financialFinalityReference,
        expectedOrderVersion: closure.orderVersion,
      });
      if (value === null) return fail();
      const finality = parseOrderSettledFinality(value);
      if (
        finality.tenantReference !== scope.tenantReference ||
        finality.brandReference !== scope.brandReference ||
        finality.storeReference !== scope.storeReference ||
        finality.providerAccountReference !== account ||
        finality.environment !== options.environment ||
        finality.orderReference !== query.orderReference ||
        finality.orderVersion !== closure.orderVersion ||
        String(finality.finalityReference) !== String(closure.financialFinalityReference) ||
        String(finality.decidedAt) > String(closure.occurredAt)
      )
        return fail();
      if ((await authorize()) !== true) return fail();
      return Object.freeze({ closure, finality });
    } catch {
      return fail();
    }
  };
}
