import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Transactions = PersistentMerchantBffOptions["transactions"];
type Transaction = Parameters<Parameters<Transactions["run"]>[0]>[0];

/**
 * WP-2423: runs a polled staff read in the snapshot transaction when the composition has one.
 * Kept apart from the merchant BFF composition so staff read modules (pickup queue, Orders list,
 * dining tables) do not load the whole BFF module graph.
 */
export function runMerchantSnapshotRead<T>(
  transactions: Transactions,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return transactions.runSnapshot === undefined
    ? transactions.run(work)
    : transactions.runSnapshot(work);
}
