import { readClosedRecord } from "@bop/identity";
import {
  parseOrderBatchCheckoutExpiry,
  parseOrderBatchCheckoutCancellation,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
type Expiry = ReturnType<typeof parseOrderBatchCheckoutExpiry>;
const fail = (): never => {
  throw new Error("DINING_BATCH_CANCELLATION_DISPATCH_UNAVAILABLE");
};
/** Discovery must use the owner's current failed/uncancelled records. It commits before
 * cancellation acquires financial fences. The immutable expiry ID is the durable operation
 * identity in the separate cancellation ledger, including after process loss.
 */
export function createDiningBatchCancellationDispatcher(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  discover(
    tx: ConsumerTransaction,
    query: { after: string | null; limit: number; observedAt: string },
  ): Promise<unknown>;
  cancel(input: { operationReference: string; expiry: Expiry }): Promise<unknown>;
  now(): string;
  pageSize: number;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    return fail();
  let cursor: string | null = null,
    stopping = false,
    inFlight: Promise<number> | undefined;
  const sameScope = (value: typeof scope) =>
    value.tenantReference === scope.tenantReference &&
    value.brandReference === scope.brandReference &&
    value.storeReference === scope.storeReference;
  async function execute() {
    const at = parseOrderingInstant(options.now());
    const raw = await options.transactions.run((tx) =>
      options.discover(tx, { after: cursor, limit: options.pageSize, observedAt: at }),
    );
    if (!Array.isArray(raw) || raw.length > options.pageSize) return fail();
    const page = raw.map(parseOrderBatchCheckoutExpiry),
      batches = new Set<string>();
    let previous = cursor;
    for (const expiry of page) {
      if (
        !sameScope(expiry) ||
        expiry.status !== "PaymentFailed" ||
        expiry.observedAt > at ||
        (previous !== null && expiry.recordReference <= previous) ||
        batches.has(expiry.orderBatchReference)
      )
        return fail();
      previous = expiry.recordReference;
      batches.add(expiry.orderBatchReference);
    }
    let processed = 0;
    for (const expiry of page) {
      if (stopping) break;
      if (parseOrderingInstant(options.now()) < at) return fail();
      const operationReference = expiry.recordReference;
      const result = readClosedRecord(await options.cancel({ operationReference, expiry }), [
        "status",
        "record",
      ]);
      if (result.status !== "Created" && result.status !== "Existing") return fail();
      const record = parseOrderBatchCheckoutCancellation(result.record);
      if (
        !sameScope(record) ||
        record.operationReference !== operationReference ||
        record.orderReference !== expiry.orderReference ||
        record.orderBatchReference !== expiry.orderBatchReference ||
        record.submissionReference !== expiry.submissionReference ||
        record.paymentOperationReference !== expiry.paymentOperationReference ||
        record.expiryRecordReference !== expiry.recordReference ||
        record.expiryEvidenceDigest !== expiry.evidenceDigest ||
        record.cancelledAt < expiry.observedAt ||
        record.cancelledAt > parseOrderingInstant(options.now())
      )
        return fail();
      processed++;
    }
    if (!stopping)
      cursor = page.length === options.pageSize ? (page.at(-1)?.recordReference ?? null) : null;
    return processed;
  }
  return Object.freeze({
    runOnce(): Promise<number> {
      if (stopping) return Promise.resolve(0);
      if (inFlight) return inFlight;
      inFlight = execute().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async stop() {
      stopping = true;
      await inFlight?.catch(() => undefined);
      return "drained" as const;
    },
  });
}
