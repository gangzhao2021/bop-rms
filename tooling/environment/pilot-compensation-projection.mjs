import { createHash } from "node:crypto";
import {
  createPostgresPaymentCompensationExceptionSource,
  parsePaymentExceptionProjectionSource,
} from "../../packages/rms/payment/src/index.ts";
import {
  createPostgresOrderExceptionSourceStore,
  parseOrderExceptionSource,
} from "../../packages/bop/projection/src/index.ts";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
/** Project the latest owner Case, never a worker's optimistic return value. */
export function createInternalCompensationProjection({
  resources,
  scope,
  tenantReference,
  authorize,
}) {
  return async (disposition, caseReference) =>
    resources.transactions.run(async (tx) => {
      const owner = createPostgresPaymentCompensationExceptionSource({
        scope,
        authorize: async (t, input) =>
          t === tx &&
          input.brandReference === scope.brandReference &&
          input.storeReference === scope.storeReference &&
          input.caseReference === caseReference &&
          input.purpose === "ProjectOrderException" &&
          (await authorize(tx, disposition)),
      });
      const read = async () => {
        const current = await owner(tx, caseReference);
        if (!current) throw new Error("INTERNAL_COMPENSATION_PROJECTION_UNAVAILABLE");
        return mapInternalCompensationSource({
          current,
          caseReference,
          scope,
          tenantReference,
          disposition,
        });
      };
      const projections = createPostgresOrderExceptionSourceStore({
        scope: {
          tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        },
        authorize: async (t) => t === tx && (await authorize(tx, disposition)),
        validateSource: async (t, value) => t === tx && json(await read()) === json(value),
      });
      return projections.write(tx, await read(), resources.credentials.reference());
    });
}

/** Shared owner-to-projection mapping for writes and snapshot coverage. */
export function mapInternalCompensationSource({
  current,
  caseReference,
  scope,
  tenantReference,
  disposition,
}) {
  const source = parsePaymentExceptionProjectionSource(current.source);
  if (
    source.exceptionReference !== caseReference ||
    source.brandReference !== scope.brandReference ||
    source.storeReference !== scope.storeReference ||
    source.orderReference !== String(disposition.orderReference) ||
    source.paymentIntentReference !== String(disposition.paymentIntentReference) ||
    source.paymentAttemptReference !== String(disposition.paymentAttemptReference) ||
    (source.state === "Closed") !== (current.resolutionEvidenceReference !== null)
  )
    throw new Error("INTERNAL_COMPENSATION_PROJECTION_UNAVAILABLE");
  const fields = {
    sourceReference: caseReference,
    tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: source.orderReference,
    paymentReference: source.paymentIntentReference,
    diningReference: null,
    kind: "PaidWithoutFulfillableOrder",
    severity: "Critical",
    sourceOwner: "Payment",
    sourceStatus: source.state === "Closed" ? "Final" : "Open",
    providerState:
      source.refundDisposition === "ProviderConfirmed"
        ? "Confirmed"
        : source.refundDisposition === "RefundPending" ||
            source.refundDisposition === "AwaitingProviderConfirmation"
          ? "Pending"
          : "Unknown",
    compensationStatus: source.state === "Closed" ? "Completed" : "Pending",
    sourceVersion: BigInt(current.sourceVersion),
    createdAt: source.openedAt,
    updatedAt: source.updatedAt,
    resolutionEvidenceReference: current.resolutionEvidenceReference,
  };
  return parseOrderExceptionSource({
    ...fields,
    sourceDigest: "sha256:" + createHash("sha256").update(json(fields)).digest("hex"),
  });
}
