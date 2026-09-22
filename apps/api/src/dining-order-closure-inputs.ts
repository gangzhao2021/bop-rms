import { createHash } from "node:crypto";
import {
  createPostgresOrderCancellationRequestStore,
  createPostgresOrderPricedAmountSource,
} from "@rms/ordering";
import { createPostgresOrderFinancialPosition, assessOrderSettlement } from "@rms/payment";
import { createDiningOrderExecutionPosition } from "./dining-order-execution-position.js";
import { createDiningOrderTaskPosition } from "./dining-order-task-position.js";
type Options = Parameters<typeof createDiningOrderTaskPosition>[0];
type Input = Parameters<ReturnType<typeof createDiningOrderTaskPosition>["load"]>[0];
const fail = (): never => {
  throw new Error("DINING_ORDER_CLOSURE_INPUTS_UNAVAILABLE");
};
/** Read-only, current owner evidence. Caller retains the same transaction. Does not
 * invent Task clearance, persist financial finality or authorize Order Close. */
export function createDiningOrderClosureInputs(options: Options) {
  return Object.freeze({
    async load(input: Input) {
      try {
        const tx = input.transaction,
          query = { orderReference: input.orderReference, observedAt: input.observedAt };
        const authorize = () => options.authorize(tx, input);
        if ((await authorize()) !== true) return fail();
        const cancellation = await createPostgresOrderCancellationRequestStore({
          ...options.diningScope,
          authorize,
          validateCurrentSource: async () => false,
          audit: async () => fail(),
        }).loadPosition(tx, query);
        const priced = await createPostgresOrderPricedAmountSource({
          brandReference: options.brandReference,
          storeReference: options.storeReference,
          authorize,
        })(tx, query);
        const execution = await createDiningOrderExecutionPosition(options).load(input);
        if (!execution) return null;
        const financial = await createPostgresOrderFinancialPosition({
          scope: options.diningScope,
          providerAccountReference: options.paymentScope.providerAccountReference,
          environment: options.paymentScope.environment,
          authorize,
        })(tx, query);
        const tasks = await createDiningOrderTaskPosition(options).load(input);
        if (!tasks || tasks.execution.snapshotDigest !== execution.snapshotDigest) return fail();
        for (const source of [cancellation, priced, execution, financial]) {
          if (
            String(source.brandReference) !== String(options.brandReference) ||
            String(source.storeReference) !== String(options.storeReference) ||
            String(source.orderReference) !== String(query.orderReference) ||
            source.observedAt !== query.observedAt ||
            !/^sha256:[a-f0-9]{64}$/u.test(source.snapshotDigest)
          )
            return fail();
        }
        if (
          String(cancellation.tenantReference) !== String(options.diningScope.tenantReference) ||
          financial.tenantReference !== String(options.diningScope.tenantReference) ||
          financial.providerAccountReference !== options.paymentScope.providerAccountReference ||
          financial.environment !== options.paymentScope.environment
        )
          return fail();
        const settlement = assessOrderSettlement({
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
        if ((await authorize()) !== true) return fail();
        return Object.freeze({
          cancellation,
          priced,
          execution,
          financial,
          tasks,
          settlement,
          snapshotDigest:
            "sha256:" +
            createHash("sha256")
              .update(
                JSON.stringify([
                  cancellation.snapshotDigest,
                  priced.snapshotDigest,
                  execution.snapshotDigest,
                  financial.snapshotDigest,
                  tasks.snapshotDigest,
                ]),
              )
              .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  });
}
