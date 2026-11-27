import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { parsePaymentRefundedEnvelope } from "../../application/payment-refunded-event.js";
import { decodePaymentCompensationRefund } from "../../application/payment-compensation-refund-codec.js";
import { PaymentStatusProjectionError } from "../../application/payment-status-projection.js";
import type { PaymentRefundedEnvelope } from "../../contracts/payment-refunded-event.js";

export function createPostgresPaymentRefundStatusStore(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly refundReference: string;
      readonly access: "Read" | "Write";
    },
  ): Promise<boolean>;
}) {
  const brandReference = parsePaymentReference(options.scope.brandReference);
  const storeReference = parsePaymentReference(options.scope.storeReference);
  const fail = (
    code:
      | "PAYMENT_STATUS_PERMISSION_DENIED"
      | "PAYMENT_STATUS_VERSION_CONFLICT"
      | "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" = "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new PaymentStatusProjectionError(code);
  };
  const encode = (event: PaymentRefundedEnvelope) =>
    JSON.stringify(event, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  const bound = (event: PaymentRefundedEnvelope, refund: string) => {
    if (
      event.tenantId !== brandReference ||
      event.storeId !== storeReference ||
      event.payload.refundReference !== refund
    )
      fail("PAYMENT_STATUS_VERSION_CONFLICT");
    return event;
  };
  const authorize = async (
    tx: ConsumerTransaction,
    refundReference: string,
    access: "Read" | "Write",
  ) => {
    if (
      (await options.authorize(tx, { brandReference, storeReference, refundReference, access })) !==
      true
    )
      fail("PAYMENT_STATUS_PERMISSION_DENIED");
  };
  const read = async (tx: ConsumerTransaction, refund: string) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_refund_status_projection WHERE brand_id=$1 AND store_id=$2 AND refund_id=$3",
      [brandReference, storeReference, refund],
    );
    if (result.rows.length === 0) return null;
    const value = result.rows[0]?.record;
    if (result.rows.length !== 1 || typeof value !== "string" || value.length > 65536)
      return fail();
    const raw = JSON.parse(value);
    if (raw.aggregateVersion !== "1") return fail();
    return bound(parsePaymentRefundedEnvelope({ ...raw, aggregateVersion: 1n }), refund);
  };
  const run = async <T>(
    tx: ConsumerTransaction,
    refund: string,
    access: "Read" | "Write",
    work: () => Promise<T>,
  ) => {
    try {
      parsePaymentReference(refund);
      await authorize(tx, refund, access);
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      const result = await work();
      await authorize(tx, refund, access);
      return result;
    } catch (error) {
      if (error instanceof PaymentStatusProjectionError) throw error;
      return fail();
    }
  };
  return {
    load: (tx: ConsumerTransaction, refund: string) =>
      run(tx, refund, "Read", () => read(tx, refund)),
    write: async (tx: ConsumerTransaction, value: PaymentRefundedEnvelope) => {
      const event = bound(parsePaymentRefundedEnvelope(value), value.payload.refundReference);
      const refund = event.payload.refundReference;
      await run(tx, refund, "Write", async () => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "payment-refund-status:" + brandReference + ":" + storeReference + ":" + refund,
        ]);
        const source = await tx.query(
          "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund WHERE brand_id=$1 AND store_id=$2 AND refund_id=$3",
          [brandReference, storeReference, refund],
        );
        if (source.rows.length !== 1) return fail();
        const actual = decodePaymentCompensationRefund(source.rows[0]?.record);
        if (encode(actual.event) !== encode(event)) return fail("PAYMENT_STATUS_VERSION_CONFLICT");
        const current = await read(tx, refund);
        if (current !== null) {
          if (encode(current) !== encode(event)) fail("PAYMENT_STATUS_VERSION_CONFLICT");
          return;
        }
        await tx.query(
          "INSERT INTO rms_payment.payment_refund_status_projection (brand_id,store_id,refund_id,order_id,event_id,record_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
          [
            brandReference,
            storeReference,
            refund,
            event.payload.orderReference,
            event.eventId,
            encode(event),
          ],
        );
      });
    },
  };
}
