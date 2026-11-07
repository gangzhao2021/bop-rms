import { createHash } from "node:crypto";
import {
  createPostgresOrderCancellationRequestStore,
  createPostgresOrderPricedAmountSource,
  createPostgresStaffOrderCancellationReader,
} from "@rms/ordering";
import { createPostgresOrderFinancialPosition, assessOrderSettlement } from "@rms/payment";
import { createDiningOrderExecutionPosition } from "./dining-order-execution-position.js";
import { createDiningOrderTaskPosition } from "./dining-order-task-position.js";
import { readCardMachineCancellationRefund } from "./merchant-order-staff-cancellation.js";
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
        // WP-2423 (B759): a round staff cancelled owes the guest its refund until it is made: on
        // the card machine until the Store records it, online until Payment's compensation
        // confirms it. That refund is pending, so the Order is not Settled before it is made.
        const owner = {
          brandReference: String(options.brandReference),
          storeReference: String(options.storeReference),
        };
        let cancellationOwedMinor = 0n; // refunds owed by staff cancellations (machine or online)
        for (const record of await createPostgresStaffOrderCancellationReader(owner).listByOrders(
          tx,
          [String(query.orderReference)],
        )) {
          const owed = await readCardMachineCancellationRefund(
            tx,
            owner,
            record,
            async () => (await authorize()) === true,
          );
          if (owed !== null) {
            if (owed.status === "Pending") cancellationOwedMinor += BigInt(owed.amountMinor);
            continue;
          }
          // An online round cancelled with a refund is owed its whole remaining capture until
          // Payment's compensation refunds it; before the compensation case records its own
          // pending refund nothing else shows it, so the rest of that capture is pending here
          // (what Payment already counts as confirmed or pending is not counted twice).
          if (record.refundDisposition !== "Refund") continue;
          const capture = financial.captures.find(
            (entry) =>
              entry.paymentAttemptReference === String(record.paymentAttemptReference) &&
              entry.paymentTransactionReference === String(record.paymentTransactionReference),
          );
          if (capture === undefined) return fail();
          const rest =
            capture.capturedMinor - capture.confirmedRefundMinor - capture.pendingRefundMinor;
          if (rest > 0n) cancellationOwedMinor += rest;
        }
        const settlement = assessOrderSettlement({
          currencyCode: financial.currencyCode,
          pricedOrderTotalMinor: priced.pricedTotalMinor,
          capturedMinor: financial.settlement.capturedMinor,
          capturedOrderAllocationMinor: financial.settlement.capturedOrderAllocationMinor,
          capturedTipMinor: financial.settlement.capturedTipMinor,
          confirmedRefundMinor: financial.settlement.confirmedRefundMinor,
          refundAllocation: financial.settlement.refundAllocation,
          pendingRefundMinor: financial.settlement.pendingRefundMinor + cancellationOwedMinor,
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
