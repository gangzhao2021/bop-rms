import type { ConsumerTransaction } from "@bop/eventing";
import {
  ConsumerDeliveryPersistenceError,
  type ConsumerDeliveryPort,
} from "./consumer-delivery.js";

export interface ConsumerDatabaseConnection extends ConsumerTransaction {
  /** Discard a connection whose transaction/transport state is uncertain. */
  release(discard: boolean): void | Promise<void>;
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Uses a real caller-configured connection pool; owns only transaction lifecycle and RLS context. */
export function createConsumerDeliveryDatabase(options: {
  acquire(): Promise<ConsumerDatabaseConnection>;
}): ConsumerDeliveryPort {
  return Object.freeze({
    async transaction<T>(
      scope: Parameters<ConsumerDeliveryPort["transaction"]>[0],
      work: (transaction: ConsumerTransaction) => Promise<T>,
    ): Promise<T> {
      if (
        !reference.test(scope.brandId) ||
        (scope.storeId !== undefined && !reference.test(scope.storeId))
      )
        throw new ConsumerDeliveryPersistenceError("CONSUMER_TEMPORARY_FAILURE");
      let connection: ConsumerDatabaseConnection;
      try {
        connection = await options.acquire();
      } catch {
        throw new ConsumerDeliveryPersistenceError("CONSUMER_TEMPORARY_FAILURE");
      }
      let commitAttempted = false;
      let began = false;
      let discard = false;
      try {
        await connection.query("BEGIN", []);
        began = true;
        await connection.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandId, scope.storeId ?? ""],
        );
        const result = await work(connection);
        commitAttempted = true;
        await connection.query("COMMIT", []);
        return result;
      } catch (error) {
        if (commitAttempted) {
          discard = true;
          throw new ConsumerDeliveryPersistenceError("COMMIT_OUTCOME_UNKNOWN");
        }
        if (began) {
          try {
            await connection.query("ROLLBACK", []);
          } catch {
            discard = true;
          }
        } else discard = true;
        throw error;
      } finally {
        // Cleanup cannot invalidate an acknowledged commit or reveal raw connection failures.
        try {
          await connection.release(discard);
        } catch {
          /* pool cleanup owns disposal */
        }
      }
    },
  });
}
