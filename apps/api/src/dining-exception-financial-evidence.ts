import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderClosurePosition,
  createPostgresOrderPricedAmountSource,
} from "@rms/ordering";
import {
  createPostgresOrderFinancialPosition,
  createPostgresOrderSettledFinalityStore,
  assessOrderSettlement,
  parseOrderSettledFinality,
  parsePaymentReference,
  parsePaymentInstant,
} from "@rms/payment";
type Options = Parameters<typeof createPostgresOrderFinancialPosition>[0];
interface FinancialEvidence {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly orderVersion: number;
  readonly observedAt: string;
  readonly financialClass: "Settled" | "Unpaid" | "Indeterminate";
  readonly ownerFinalityReference: string | null;
  readonly ownerDecidedAt: string | null;
}
const fail = (): never => {
  throw Error("DINING_EXCEPTION_FINANCIAL_EVIDENCE_UNAVAILABLE");
};
/** Fresh amounts never create finality; existing closure/Payment facts provide it. */
export function createDiningExceptionFinancialEvidence(options: Options) {
  const scope = Object.freeze({
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  const account = String(parsePaymentReference(options.providerAccountReference));
  if (!["Test", "Live"].includes(options.environment)) return fail();
  return async (
    tx: ConsumerTransaction,
    input: { orderReference: string; observedAt: string },
  ): Promise<{ orderVersion: number; financial: FinancialEvidence | null }> => {
    try {
      const query = {
        orderReference: String(parsePaymentReference(input.orderReference)),
        observedAt: String(parsePaymentInstant(input.observedAt)),
      };
      const authorize = () => options.authorize(tx, query);
      if ((await authorize()) !== true) return fail();
      const closure = await createPostgresOrderClosurePosition({ ...scope, authorize })(tx, query);
      const priced = await createPostgresOrderPricedAmountSource({ ...scope, authorize })(
        tx,
        query,
      );
      const financial = await createPostgresOrderFinancialPosition({
        ...options,
        scope,
        authorize,
      })(tx, query);
      for (const value of [closure, priced, financial])
        if (
          String(value.brandReference) !== scope.brandReference ||
          String(value.storeReference) !== scope.storeReference ||
          String(value.orderReference) !== query.orderReference ||
          value.observedAt !== query.observedAt
        )
          return fail();
      if (
        String(closure.tenantReference) !== scope.tenantReference ||
        financial.tenantReference !== scope.tenantReference ||
        financial.providerAccountReference !== account ||
        financial.environment !== options.environment
      )
        return fail();
      const assessment = assessOrderSettlement({
        currencyCode: financial.currencyCode,
        pricedOrderTotalMinor: priced.pricedTotalMinor,
        capturedMinor: financial.capturedMinor,
        capturedOrderAllocationMinor: financial.capturedOrderAllocationMinor,
        capturedTipMinor: financial.capturedTipMinor,
        confirmedRefundMinor: financial.confirmedRefundMinor,
        refundAllocation: financial.refundAllocation,
        pendingRefundMinor: financial.pendingRefundMinor,
        unresolvedAttemptCount: financial.unresolvedAttemptCount,
        pendingAmendmentCount: priced.pendingAmendmentCount,
      });
      const base = { ...scope, ...query, orderVersion: closure.orderVersion };
      let evidence: FinancialEvidence | null = null;
      if (assessment.classification !== "Settled")
        evidence = {
          ...base,
          financialClass: assessment.classification,
          ownerFinalityReference: null,
          ownerDecidedAt: null,
        };
      else if (closure.status === "Closed" && closure.financialFinalityReference !== null) {
        const raw = await createPostgresOrderSettledFinalityStore({
          ...options,
          scope,
          authorize,
          audit: async () => fail(),
        }).readFinality(tx, {
          ...query,
          finalityReference: closure.financialFinalityReference,
          expectedOrderVersion: closure.orderVersion,
        });
        if (!raw) return fail();
        const fact = parseOrderSettledFinality(raw);
        if (
          fact.tenantReference !== scope.tenantReference ||
          fact.brandReference !== scope.brandReference ||
          fact.storeReference !== scope.storeReference ||
          fact.providerAccountReference !== account ||
          fact.environment !== options.environment ||
          fact.orderReference !== query.orderReference ||
          fact.orderVersion !== closure.orderVersion ||
          String(fact.orderCheckpoint) !== String(closure.orderCheckpoint) ||
          String(fact.finalityReference) !== String(closure.financialFinalityReference) ||
          fact.decidedAt > query.observedAt ||
          fact.pricedOrderTotalMinor !== priced.pricedTotalMinor.toString() ||
          fact.capturedMinor !== financial.capturedMinor.toString() ||
          fact.capturedOrderAllocationMinor !== financial.capturedOrderAllocationMinor.toString() ||
          fact.capturedTipMinor !== financial.capturedTipMinor.toString()
        )
          return fail();
        evidence = {
          ...base,
          financialClass: "Settled",
          ownerFinalityReference: fact.finalityReference,
          ownerDecidedAt: fact.decidedAt,
        };
      }
      if ((await authorize()) !== true) return fail();
      return Object.freeze({
        orderVersion: closure.orderVersion,
        financial: evidence === null ? null : Object.freeze(evidence),
      });
    } catch {
      return fail();
    }
  };
}
