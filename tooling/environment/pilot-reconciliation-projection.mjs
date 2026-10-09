import { createHash } from "node:crypto";
import {
  createPostgresOrderExceptionSourceStore,
  parseOrderExceptionSource,
} from "../../packages/bop/projection/src/index.ts";
import {
  createPostgresUnmatchedCaptureRefundStore,
  parsePaymentExceptionProjectionSource,
} from "../../packages/rms/payment/src/index.ts";
import { createInternalReconciliationExceptionPageRunner } from "./pilot-reconciliation-exceptions.mjs";
const json = (value) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
export function createInternalReconciliationProjection(resources) {
  let cursor = null;
  const run = createInternalReconciliationExceptionPageRunner(
    resources,
    async ({ tx, page, scope, authorize, reread }) => {
      const fail = () => {
        throw Error("INTERNAL_RECONCILIATION_PROJECTION_UNAVAILABLE");
      };
      const convert = (value) => mapInternalReconciliationSource(value, scope, tx);
      if (!Array.isArray(page.items) || page.items.length > 5) return fail();
      const sources = await Promise.all(page.items.map(convert));
      let previous = cursor;
      for (const source of sources) {
        if (previous !== null && source.sourceReference <= previous) return fail();
        previous = source.sourceReference;
      }
      if (
        page.nextAfterExceptionReference !== null &&
        (sources.length !== 5 || page.nextAfterExceptionReference !== previous)
      )
        return fail();
      const store = createPostgresOrderExceptionSourceStore({
        scope,
        authorize: async (t) => t === tx && authorize(),
        validateSource: async (t, source) => {
          if (t !== tx || !authorize()) return false;
          const fresh = await reread();
          if (json(fresh) !== json(page)) return false;
          for (const value of fresh.items)
            if (json(await convert(value)) === json(source)) return true;
          return false;
        },
      });
      for (const source of sources)
        await store.write(tx, source, resources.credentials.reference());
      return { next: page.nextAfterExceptionReference, projectedCount: sources.length };
    },
  );
  return async () => {
    const result = await run({ afterExceptionReference: cursor, limit: 5 });
    cursor = result.next;
    return { projectedCount: result.projectedCount, scanComplete: cursor === null };
  };
}

/**
 * Maps a Payment reconciliation exception to the order-exception source. WP-2423 P6: one closed by
 * the Provider-confirmed full refund of its unmatched capture becomes Final, with that refund as the
 * resolution evidence (read from the Payment owner in the same transaction).
 */
export async function mapInternalReconciliationSource(value, scope, tx) {
  const fail = () => {
    throw Error("INTERNAL_RECONCILIATION_PROJECTION_UNAVAILABLE");
  };
  const source = parsePaymentExceptionProjectionSource(value);
  if (
    !source.kind.startsWith("Reconciliation") ||
    source.brandReference !== scope.brandReference ||
    source.storeReference !== scope.storeReference
  )
    return fail();
  let resolution = null;
  if (source.state === "Closed") {
    if (!tx) return fail();
    const refund = await createPostgresUnmatchedCaptureRefundStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async (t, access) => t === tx && access === "Read",
    }).read(tx, source.exceptionReference);
    if (
      refund?.status !== "Refunded" ||
      !refund.request ||
      refund.outcome?.recordedAt !== source.closedAt
    )
      return fail();
    resolution = refund.request.refundReference;
  } else if (source.state !== "Open") return fail();
  const fields = {
    sourceReference: source.exceptionReference,
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: source.orderReference,
    paymentReference: source.paymentIntentReference,
    diningReference: null,
    kind: "PaymentReconciliationDifference",
    severity: source.severity === "Critical" ? "Critical" : "High",
    sourceOwner: "Payment",
    sourceStatus: resolution === null ? "Open" : "Final",
    providerState: resolution === null ? "Unknown" : "Confirmed",
    compensationStatus: resolution === null ? "NotRequested" : "Completed",
    sourceVersion:
      (source.orderReference === null || source.paymentIntentReference === null ? 1n : 2n) +
      (resolution === null ? 0n : 2n),
    createdAt: source.openedAt,
    updatedAt: source.updatedAt,
    resolutionEvidenceReference: resolution,
  };
  return parseOrderExceptionSource({
    ...fields,
    sourceDigest: "sha256:" + createHash("sha256").update(json(fields)).digest("hex"),
  });
}
