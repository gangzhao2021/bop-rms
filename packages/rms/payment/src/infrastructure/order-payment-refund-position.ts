import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundPositionSource } from "./ordinary-refund-position-source.js";
import { createPostgresPaymentCompensationRefundPositionSource } from "./persistence/payment-compensation-refund-position-source.js";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import type { PositionQuery } from "./persistence/ordinary-refund-request-store.js";
type Options = Parameters<typeof createPostgresOrdinaryRefundPositionSource>[0];
const fail = (): never => {
  throw new Error("ORDER_PAYMENT_REFUND_POSITION_UNAVAILABLE");
};
/** Both existing refund owners retain the same Order advisory fence in the
 * caller transaction. Amounts cover refunds only: no capture, receivable,
 * financial-finality, execution permission or Provider call is inferred. */
export function createPostgresOrderPaymentRefundPosition(options: Options) {
  const scope = Object.freeze({
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  const ordinary = createPostgresOrdinaryRefundPositionSource({ ...options, scope });
  return async (tx: ConsumerTransaction, input: PositionQuery) => {
    try {
      const raw = exactPaymentObject(input, [
        "orderReference",
        "paymentTransactionReference",
        "paymentIntentReference",
        "paymentAttemptReference",
        "observedAt",
      ]);
      const query = Object.freeze({
        orderReference: String(parsePaymentReference(raw.orderReference)),
        paymentTransactionReference: String(parsePaymentReference(raw.paymentTransactionReference)),
        paymentIntentReference: String(parsePaymentReference(raw.paymentIntentReference)),
        paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
        observedAt: parsePaymentInstant(raw.observedAt),
      });
      const authorize = async () => {
        if ((await options.authorize(tx, { ...scope, ...query })) !== true) return fail();
        return true;
      };
      await authorize();
      const ordinaryPosition = await ordinary(tx, query);
      const compensation = await createPostgresPaymentCompensationRefundPositionSource({
        scope,
        authorize,
      })(tx, {
        orderReference: query.orderReference,
        paymentTransactionReference: query.paymentTransactionReference,
        paymentAttemptReference: query.paymentAttemptReference,
      });
      for (const position of [ordinaryPosition, compensation])
        if (
          typeof position.confirmedMinor !== "bigint" ||
          typeof position.pendingMinor !== "bigint" ||
          position.confirmedMinor < 0n ||
          position.pendingMinor < 0n ||
          !Number.isSafeInteger(position.version) ||
          position.version < 1 ||
          !/^sha256:[a-f0-9]{64}$/u.test(position.snapshotDigest)
        )
          return fail();
      const { confirmedOrderAllocationMinor, confirmedTipMinor } = ordinaryPosition;
      const ordinaryUnallocated = ordinaryPosition.unallocatedConfirmedMinor;
      if (
        [confirmedOrderAllocationMinor, confirmedTipMinor, ordinaryUnallocated].some(
          (amount) => typeof amount !== "bigint" || amount < 0n,
        ) ||
        confirmedOrderAllocationMinor + confirmedTipMinor + ordinaryUnallocated !==
          ordinaryPosition.confirmedMinor
      )
        return fail();
      // Keep compensation provenance explicit; original capture components are bound downstream.
      const unallocatedConfirmedMinor = ordinaryUnallocated + compensation.confirmedMinor;
      const confirmedMinor = ordinaryPosition.confirmedMinor + compensation.confirmedMinor,
        pendingMinor = ordinaryPosition.pendingMinor + compensation.pendingMinor;
      if (confirmedMinor + pendingMinor > 9223372036854775807n) return fail();
      await authorize();
      return Object.freeze({
        ...scope,
        ...query,
        confirmedMinor,
        pendingMinor,
        confirmedOrderAllocationMinor,
        confirmedTipMinor,
        unallocatedConfirmedMinor,
        unallocatedCompensationMinor: compensation.confirmedMinor,
        ordinaryVersion: ordinaryPosition.version,
        compensationVersion: compensation.version,
        snapshotDigest:
          "sha256:" +
          createHash("sha256")
            .update(
              JSON.stringify([
                scope,
                query,
                ordinaryPosition.snapshotDigest,
                compensation.snapshotDigest,
                confirmedMinor.toString(),
                pendingMinor.toString(),
                confirmedOrderAllocationMinor.toString(),
                confirmedTipMinor.toString(),
                unallocatedConfirmedMinor.toString(),
                compensation.confirmedMinor.toString(),
              ]),
            )
            .digest("hex"),
      });
    } catch {
      return fail();
    }
  };
}
