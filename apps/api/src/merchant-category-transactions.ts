import {
  CatalogError,
  CatalogProductListError,
  type CategoryPersistenceAuthority,
} from "@rms/catalog";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Transaction = Parameters<CategoryPersistenceAuthority["holdUntilTransactionCompletes"]>[0];
type Check = () => Promise<void>;
interface State {
  phase: "work" | "checks" | "closed";
  failed: boolean;
  pending: number;
  checks: Set<Check>;
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const bounded = (error: unknown): never => {
  if (error instanceof CatalogError || error instanceof CatalogProductListError) throw error;
  return unavailable();
};

/** Transport composition over the existing transaction runner. The runner owns
 * COMMIT/ROLLBACK and must roll back failed actions. Checks run before its action
 * returns. No statement, authority grant, or unchecked transaction is supplied.
 */
export function createMerchantCategoryTransactions(
  source: PersistentMerchantBffOptions["transactions"],
) {
  if (!source || typeof source.run !== "function") return unavailable();
  const active = new WeakMap<Transaction, State>();
  const transactions = Object.freeze({
    async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      if (typeof work !== "function") return unavailable();
      try {
        return await source.run(async (original) => {
          const state: State = { phase: "work", failed: false, pending: 0, checks: new Set() };
          const tx: Transaction = Object.freeze({
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              if (state.phase === "closed" || state.failed) return unavailable();
              state.pending++;
              try {
                const result = await original.query(sql, values);
                if (active.get(tx) !== state) return unavailable();
                if (!result || typeof result !== "object") return unavailable();
                const rows = Object.getOwnPropertyDescriptor(result, "rows");
                const count = Object.getOwnPropertyDescriptor(result, "rowCount");
                if (
                  !rows ||
                  !("value" in rows) ||
                  !Array.isArray(rows.value) ||
                  (count &&
                    (!("value" in count) ||
                      (count.value !== undefined &&
                        count.value !== null &&
                        (!Number.isSafeInteger(count.value) || count.value < 0))))
                )
                  return unavailable();
                return {
                  rows: rows.value as readonly Row[],
                  ...(count?.value === undefined ? {} : { rowCount: count.value as number | null }),
                };
              } catch (error) {
                state.failed = true;
                return bounded(error);
              } finally {
                state.pending--;
              }
            },
          });
          active.set(tx, state);
          try {
            const result = await work(tx);
            if (state.failed || state.pending !== 0 || state.checks.size === 0)
              return unavailable();
            state.phase = "checks";
            for (const check of state.checks) {
              await check();
              if (state.failed || state.pending !== 0) return unavailable();
            }
            return result;
          } finally {
            state.phase = "closed";
            active.delete(tx);
          }
        });
      } catch (error) {
        return bounded(error);
      }
    },
  });
  return Object.freeze({
    transactions,
    async registerBeforeCommit(tx: Transaction, check: Check): Promise<void> {
      const state = active.get(tx);
      if (!state) return unavailable();
      if (
        state.phase !== "work" ||
        typeof check !== "function" ||
        (!state.checks.has(check) && state.checks.size >= 64)
      ) {
        state.failed = true;
        return unavailable();
      }
      state.checks.add(check);
    },
  });
}
