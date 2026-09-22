import { appendAuditRecordInTransaction } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaidWithoutFulfillableOrderDisposition,
  PaymentCompensationError,
} from "../application/paid-without-fulfillable-order.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";

/** One audit per observed worker failure; raw errors/Provider payloads are never accepted. */
export function createPaymentCompensationFailureRecorder(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly authorize: (
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly dispositionReference: string;
      readonly purpose: "RecordCompensationExecutionFailure";
    },
  ) => Promise<boolean>;
  readonly now: () => string;
  readonly newAuditReference: () => string;
}) {
  const brandReference = String(parsePaymentReference(options.scope.brandReference));
  const storeReference = String(parsePaymentReference(options.scope.storeReference));
  return async (value: unknown, code: "COMPENSATION_EXECUTION_FAILED"): Promise<void> => {
    const disposition = parsePaidWithoutFulfillableOrderDisposition(value);
    if (code !== "COMPENSATION_EXECUTION_FAILED")
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_INPUT_INVALID");
    if (
      disposition.brandReference !== brandReference ||
      disposition.storeReference !== storeReference
    )
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    try {
      await options.transactions.run(async (tx) => {
        const authorize = async () => {
          if (
            (await options.authorize(tx, {
              brandReference,
              storeReference,
              orderReference: disposition.orderReference,
              dispositionReference: disposition.dispositionReference,
              purpose: "RecordCompensationExecutionFailure",
            })) !== true
          )
            throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        await appendAuditRecordInTransaction(tx, {
          auditId: parsePaymentReference(options.newAuditReference()),
          brandId: brandReference,
          storeId: storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_COMPENSATION_EXECUTION_FAILED",
          targetType: "Order",
          targetId: disposition.orderReference,
          reasonCode: code,
          correlationId: disposition.dispositionReference,
          occurredAt: parsePaymentInstant(options.now()),
          sourceChannel: "PAYMENT_COMPENSATION",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        });
        await authorize();
      });
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE");
    }
  };
}
