import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type ConsumerOutcome,
} from "@bop/eventing";
import { CatalogError } from "../../contracts/product.js";
import {
  parseCategorySourceEvent,
  type CategorySourceSnapshot,
} from "../../contracts/category-source.js";
import { createPostgresCategorySourceStore } from "./category-source-store.js";
export interface CategorySourceConsumer {
  consume(value: unknown): Promise<ConsumerOutcome>;
  rebuild(): Promise<CategorySourceSnapshot>;
}
/** Source delivery receipts only. This does not activate a worker or produce the
 * Category tree UI's Product counts/Menu usage projection. Exact current source
 * authorization and Event proof run before Inbox cache lookup on every retry. */
export function createPostgresCategorySourceConsumer(
  options: Omit<Parameters<typeof createPostgresCategorySourceStore>[0], "transactions"> & {
    readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  },
): CategorySourceConsumer {
  const inTransaction = (transaction: ConsumerTransaction) =>
    createPostgresCategorySourceStore({
      ...options,
      transactions: { run: (work) => work(transaction) },
    });
  const consumer: CategorySourceConsumer = {
    async rebuild() {
      try {
        return await options.transactions.run((transaction) =>
          inTransaction(transaction).loadSnapshot(),
        );
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
    async consume(value) {
      const envelope = parseCategorySourceEvent(value);
      try {
        return await options.transactions.run(async (transaction) => {
          try {
            const source = inTransaction(transaction),
              proof = await source.proveEvent(envelope),
              snapshot = await source.loadSnapshot();
            if (BigInt(proof.sourceRevision) > BigInt(snapshot.sourceRevision))
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            const registration: ConsumerRegistration = Object.freeze({
              consumerName: "catalog.category-source:v1",
              consumerVersion: 1,
              eventType: envelope.eventType,
              schemaVersions: Object.freeze([1]),
              ownerModule: "@rms/catalog",
              tenantScope: "brand",
              ordering: "aggregate",
              sideEffect: "record_category_source",
              replaySafe: true,
              handler: async () => ({
                status: "completed" as const,
                resultHash: snapshot.sourceDigest.slice(7),
              }),
            });
            return await consumeEventInTransaction(transaction, registration, envelope);
          } catch (error) {
            if (error instanceof ConsumerTransactionRollback) throw error;
            throw new ConsumerTransactionRollback({
              status:
                error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                  ? "rejected"
                  : "retry_required",
              errorCode:
                error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                  ? "TENANT_SCOPE_DENIED"
                  : "CONSUMER_TEMPORARY_FAILURE",
            });
          }
        });
      } catch (error) {
        if (error instanceof ConsumerTransactionRollback) throw error;
        throw new ConsumerTransactionRollback({
          status: "retry_required",
          errorCode: "COMMIT_OUTCOME_UNKNOWN",
        });
      }
    },
  };
  return Object.freeze(consumer);
}
