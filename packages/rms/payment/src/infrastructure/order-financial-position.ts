import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderPaymentAttemptPosition } from "./persistence/order-payment-attempt-position.js";
import { createPostgresOrderPaymentRefundPosition } from "./order-payment-refund-position.js";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
const fail = (): never => {
  throw new Error("ORDER_FINANCIAL_POSITION_UNAVAILABLE");
};
const reference = (value: unknown) => String(parsePaymentReference(value));
/** Current Payment facts only. Ordering owns the receivable; this position does not
 * issue financial finality or permit closure. Retain the caller transaction/fences.
 * Snapshot digest binds this observation, including the refund owners' digests. */
export function createPostgresOrderFinancialPosition(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  providerAccountReference: string;
  environment: "Test" | "Live";
  authorize(
    tx: ConsumerTransaction,
    query: { orderReference: string; observedAt: string },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
      tenantReference: reference(options.scope.tenantReference),
      brandReference: reference(options.scope.brandReference),
      storeReference: reference(options.scope.storeReference),
    }),
    providerAccountReference = reference(options.providerAccountReference),
    environment = options.environment;
  if (!["Test", "Live"].includes(environment)) return fail();
  return async (tx: ConsumerTransaction, input: { orderReference: string; observedAt: string }) => {
    try {
      const raw = exactPaymentObject(input, ["orderReference", "observedAt"]),
        query = Object.freeze({
          orderReference: reference(raw.orderReference),
          observedAt: String(parsePaymentInstant(raw.observedAt)),
        });
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
        return true;
      };
      await authorize();
      const position = await createPostgresOrderPaymentAttemptPosition({
        scope: { ...scope, providerAccountReference, environment },
        authorize,
      }).load(tx, query);
      if (
        position.brandReference !== scope.brandReference ||
        position.storeReference !== scope.storeReference ||
        position.orderReference !== query.orderReference ||
        position.observedAt !== query.observedAt ||
        position.providerAccountReference !== providerAccountReference ||
        position.environment !== environment
      )
        return fail();
      const refunds = createPostgresOrderPaymentRefundPosition({
        scope,
        providerAccountReference,
        environment,
        authorize,
      });
      let confirmedRefundMinor = 0n,
        pendingRefundMinor = 0n,
        capturedMinor = 0n,
        capturedOrderAllocationMinor = 0n,
        capturedTipMinor = 0n,
        refundedOrderMinor = 0n,
        refundedTipMinor = 0n,
        unallocatedRefundMinor = 0n;
      const captures = [];
      for (const attempt of position.attempts) {
        if (attempt.outcome !== "Succeeded") continue;
        if (attempt.terminalReference === null || !/^[1-9][0-9]{0,18}$/u.test(attempt.totalMinor))
          return fail();
        const captureMinor = BigInt(attempt.totalMinor);
        if (
          !/^[1-9][0-9]{0,18}$/u.test(attempt.orderAllocationMinor) ||
          !/^(?:0|[1-9][0-9]{0,18})$/u.test(attempt.tipMinor)
        )
          return fail();
        const allocationMinor = BigInt(attempt.orderAllocationMinor),
          tipMinor = BigInt(attempt.tipMinor);
        if (allocationMinor + tipMinor !== captureMinor) return fail();
        const refund = await refunds(tx, {
          ...query,
          paymentTransactionReference: attempt.terminalReference,
          paymentIntentReference: attempt.paymentIntentReference,
          paymentAttemptReference: attempt.paymentAttemptReference,
        });
        if (
          typeof refund.confirmedMinor !== "bigint" ||
          typeof refund.pendingMinor !== "bigint" ||
          refund.confirmedMinor < 0n ||
          refund.pendingMinor < 0n ||
          refund.confirmedMinor + refund.pendingMinor > captureMinor ||
          !/^sha256:[a-f0-9]{64}$/u.test(refund.snapshotDigest)
        )
          return fail();
        let orderRefund = refund.confirmedOrderAllocationMinor,
          tipRefund = refund.confirmedTipMinor,
          unallocated = refund.unallocatedConfirmedMinor;
        if (
          [orderRefund, tipRefund, unallocated].some((v) => typeof v !== "bigint" || v < 0n) ||
          orderRefund + tipRefund + unallocated !== refund.confirmedMinor ||
          orderRefund > allocationMinor ||
          tipRefund > tipMinor
        )
          return fail();
        const compensationUnallocated = refund.unallocatedCompensationMinor;
        if (
          typeof compensationUnallocated !== "bigint" ||
          compensationUnallocated < 0n ||
          compensationUnallocated > unallocated
        )
          return fail();
        // A fully reversed capture leaves no ambiguity about aggregate order/tip components.
        // Never derive a partial allocation or absorb missing ordinary-refund evidence.
        if (
          refund.confirmedMinor === captureMinor &&
          refund.pendingMinor === 0n &&
          unallocated > 0n &&
          unallocated === compensationUnallocated
        ) {
          orderRefund = allocationMinor;
          tipRefund = tipMinor;
          unallocated = 0n;
        }
        refundedOrderMinor += orderRefund;
        refundedTipMinor += tipRefund;
        unallocatedRefundMinor += unallocated;
        capturedMinor += captureMinor;
        capturedOrderAllocationMinor += allocationMinor;
        capturedTipMinor += tipMinor;
        confirmedRefundMinor += refund.confirmedMinor;
        pendingRefundMinor += refund.pendingMinor;
        captures.push(
          Object.freeze({
            paymentTransactionReference: attempt.terminalReference,
            paymentIntentReference: attempt.paymentIntentReference,
            paymentAttemptReference: attempt.paymentAttemptReference,
            orderBatchReference: attempt.orderBatchReference,
            capturedMinor: captureMinor,
            orderAllocationMinor: allocationMinor,
            tipMinor,
            confirmedRefundMinor: refund.confirmedMinor,
            pendingRefundMinor: refund.pendingMinor,
            refundedOrderMinor: orderRefund,
            refundedTipMinor: tipRefund,
            unallocatedRefundMinor: unallocated,
            refundSnapshotDigest: refund.snapshotDigest,
          }),
        );
      }
      if (capturedMinor !== position.capturedMinor || capturedMinor > 9223372036854775807n)
        return fail();
      await authorize();
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            scope,
            providerAccountReference,
            environment,
            query,
            position.snapshotDigest,
            captures.map((c) => [c.paymentTransactionReference, c.refundSnapshotDigest]),
            capturedMinor.toString(),
            capturedOrderAllocationMinor.toString(),
            capturedTipMinor.toString(),
            confirmedRefundMinor.toString(),
            pendingRefundMinor.toString(),
            refundedOrderMinor.toString(),
            refundedTipMinor.toString(),
            unallocatedRefundMinor.toString(),
          ]),
        )
        .digest("hex");
      return Object.freeze({
        ...scope,
        ...query,
        providerAccountReference,
        environment,
        currencyCode: "CAD" as const,
        capturedMinor,
        capturedOrderAllocationMinor,
        capturedTipMinor,
        confirmedRefundMinor,
        pendingRefundMinor,
        refundAllocation: Object.freeze({
          orderMinor: refundedOrderMinor,
          tipMinor: refundedTipMinor,
          unallocatedMinor: unallocatedRefundMinor,
        }),
        netCapturedMinor: capturedMinor - confirmedRefundMinor,
        unresolvedAttemptCount: position.unresolvedCount,
        failedAttemptCount: position.failedCount,
        captures: Object.freeze(captures),
        snapshotDigest: "sha256:" + digest,
      });
    } catch {
      return fail();
    }
  };
}
