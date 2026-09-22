import { createHash } from "node:crypto";
import {
  createPostgresOrderExceptionSourceStore,
  parseOrderExceptionSource,
} from "../../packages/bop/projection/src/index.ts";
import { parsePaymentExceptionProjectionSource } from "../../packages/rms/payment/src/index.ts";
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
      const convert = (value) => {
        return mapInternalReconciliationSource(value, scope);
      };
      if (!Array.isArray(page.items) || page.items.length > 5) return fail();
      const sources = page.items.map(convert);
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
          return fresh.items.some((value) => json(convert(value)) === json(source));
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

export function mapInternalReconciliationSource(value, scope) {
  const fail = () => {
    throw Error("INTERNAL_RECONCILIATION_PROJECTION_UNAVAILABLE");
  };
  const source = parsePaymentExceptionProjectionSource(value);
  if (
    !source.kind.startsWith("Reconciliation") ||
    source.state !== "Open" ||
    source.brandReference !== scope.brandReference ||
    source.storeReference !== scope.storeReference
  )
    return fail();
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
    sourceStatus: "Open",
    providerState: "Unknown",
    compensationStatus: "NotRequested",
    sourceVersion:
      source.orderReference === null || source.paymentIntentReference === null ? 1n : 2n,
    createdAt: source.openedAt,
    updatedAt: source.updatedAt,
    resolutionEvidenceReference: null,
  };
  return parseOrderExceptionSource({
    ...fields,
    sourceDigest: "sha256:" + createHash("sha256").update(json(fields)).digest("hex"),
  });
}
