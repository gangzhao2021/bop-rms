import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderExceptionSource, type OrderExceptionSource } from "@bop/projection";
import {
  parsePaymentExceptionProjectionSource,
  parsePaymentRefundedEnvelope,
  type createPostgresPaymentCompensationExceptionSource,
} from "@rms/payment";

/** Composition of public owner sources only. Caller authorizes tenant/Brand/Store association. */
export function createPaymentOrderExceptionSource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly load: ReturnType<typeof createPostgresPaymentCompensationExceptionSource>;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const unavailable = (): never => {
    throw new Error("ORDER_EXCEPTION_SOURCE_UNAVAILABLE");
  };
  return async (tx: ConsumerTransaction, value: unknown): Promise<OrderExceptionSource> => {
    const event = parsePaymentRefundedEnvelope(value);
    if (
      event.tenantId !== options.brandReference ||
      event.storeId !== options.storeReference ||
      (await options.authorize(tx)) !== true
    )
      return unavailable();
    const current = await options.load(tx, event.payload.compensationCaseReference);
    if (current === null) return unavailable();
    const source = parsePaymentExceptionProjectionSource(current.source);
    if (
      source.kind !== "PaidWithoutFulfillableOrder" ||
      source.brandReference !== options.brandReference ||
      source.storeReference !== options.storeReference ||
      source.exceptionReference !== event.payload.compensationCaseReference ||
      source.orderReference !== event.payload.orderReference ||
      source.paymentIntentReference !== event.payload.paymentIntentReference ||
      source.paymentAttemptReference !== event.payload.paymentAttemptReference ||
      source.refundDisposition !== "ProviderConfirmed" ||
      Date.parse(source.updatedAt) < Date.parse(event.payload.providerConfirmedAt) ||
      !Number.isSafeInteger(current.sourceVersion) ||
      current.sourceVersion < 1 ||
      (source.state === "Closed") !== (current.resolutionEvidenceReference !== null)
    )
      return unavailable();
    const fields = {
      sourceReference: source.exceptionReference,
      tenantReference: options.tenantReference,
      brandReference: options.brandReference,
      storeReference: options.storeReference,
      orderReference: source.orderReference,
      paymentReference: source.paymentIntentReference,
      diningReference: null,
      kind: "PaidWithoutFulfillableOrder",
      severity: "Critical",
      sourceOwner: "Payment",
      sourceStatus: source.state === "Closed" ? "Final" : "Open",
      providerState: "Confirmed",
      compensationStatus: source.state === "Closed" ? "Completed" : "Pending",
      sourceVersion: BigInt(current.sourceVersion),
      createdAt: source.openedAt,
      updatedAt: source.updatedAt,
      resolutionEvidenceReference: current.resolutionEvidenceReference,
    };
    const sourceDigest =
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify(fields, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
          ),
        )
        .digest("hex");
    const result = parseOrderExceptionSource({ ...fields, sourceDigest });
    if ((await options.authorize(tx)) !== true) return unavailable();
    return result;
  };
}
