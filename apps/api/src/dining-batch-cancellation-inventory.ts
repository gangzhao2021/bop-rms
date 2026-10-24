import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderBatchCheckoutCancellationReader,
  parseOrderBatchCheckoutCancellation,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";
type Cancellation = ReturnType<typeof parseOrderBatchCheckoutCancellation>;
const fail = (): never => {
  throw new Error("DINING_CANCELLATION_INVENTORY_UNAVAILABLE");
};
/** Caller retains Payment/Ordering fences and must roll back the transaction on any failure. */
export function createDiningBatchCancellationInventory(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  systemActorReference: string;
  now(): string;
  authorize(tx: ConsumerTransaction, record: Cancellation): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  // WP-2423 Q12: the shared release keeps this wrapper's child namespace and reason unchanged.
  const release = createSubmissionInventoryRelease({
    scope,
    systemActorReference: options.systemActorReference,
    reasonCode: "CHECKOUT_DEADLINE_REACHED",
    now: options.now,
  });
  return async (transaction: ConsumerTransaction, value: unknown): Promise<boolean> => {
    const raw = readClosedRecord(value, ["mode", "cancellation"]),
      record = parseOrderBatchCheckoutCancellation(raw.cancellation);
    if (
      !["Release", "Verify"].includes(String(raw.mode)) ||
      record.tenantReference !== scope.tenantReference ||
      record.brandReference !== scope.brandReference ||
      record.storeReference !== scope.storeReference ||
      record.cancelledAt > parseOrderingInstant(options.now())
    )
      return fail();
    const allowed = async () => (await options.authorize(transaction, record)) === true;
    if (!(await allowed())) return fail();
    const stored = await createPostgresOrderBatchCheckoutCancellationReader({
      ...scope,
      now: options.now,
      authorize: async (tx, identity) =>
        tx === transaction &&
        identity.orderReference === record.orderReference &&
        identity.orderBatchReference === record.orderBatchReference &&
        identity.operationReference === record.operationReference &&
        (await allowed()),
    }).loadOperation(transaction, {
      orderReference: record.orderReference,
      orderBatchReference: record.orderBatchReference,
      operationReference: record.operationReference,
    });
    if (stored === null || canonicalizeRfc8785(stored) !== canonicalizeRfc8785(record))
      return fail();
    const request = {
      source: {
        kind: "DiningCancellationInventory/v1",
        reference: record.cancellationReference,
        submissionReference: record.submissionReference,
        orderReference: record.orderReference,
        occurredAt: record.cancelledAt,
      },
      // The release is written in the cancellation transaction, at the cancellation instant.
      releasedAt: record.cancelledAt,
      authorize: allowed,
    };
    if (raw.mode === "Verify") {
      const verified = await release.verify(transaction, request);
      if (verified.status === "NothingToRelease" && verified.reason === "NotTracked")
        return await allowed();
      return verified.status === "AlreadyApplied" ? true : fail();
    }
    // A prior release for this cancellation must be verified through Verify, never replayed here.
    const result = await release.release(transaction, request);
    if (result.status === "NothingToRelease" && result.reason === "NotTracked")
      return await allowed();
    return result.status === "Released" ? true : fail();
  };
}
