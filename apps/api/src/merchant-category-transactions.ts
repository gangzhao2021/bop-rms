import {
  CatalogError,
  CatalogProductListError,
  CatalogOptionSetListError,
  type CategoryPersistenceAuthority,
} from "@rms/catalog";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { OptionPriceAuthoringError, TaxConfigWorkflowError } from "@rms/pricing";
import {
  StoreSetupOperationError,
  StoreSetupReferenceError,
  StoreConfigurationOriginalError,
  StoreConfigurationAdministrationServiceError,
} from "@rms/store";
import { StorePaymentConfigurationError } from "@rms/payment";
import { DigitalReceiptTemplateError } from "@rms/printing-device";
import { BrandStoreTopologyError, BrandConfigurationOperationError } from "@bop/tenant";

type Transaction = Parameters<CategoryPersistenceAuthority["holdUntilTransactionCompletes"]>[0];
type Check = () => Promise<void>;
type FinalAssert = () => void;
interface State {
  phase: "work" | "checks" | "final" | "closed";
  failed: boolean;
  pending: number;
  checks: Map<Check, FinalAssert | undefined>;
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const bounded = (error: unknown): never => {
  if (
    error instanceof CatalogError ||
    error instanceof CatalogProductListError ||
    error instanceof CatalogOptionSetListError ||
    error instanceof OptionPriceAuthoringError ||
    error instanceof TaxConfigWorkflowError ||
    error instanceof StoreSetupOperationError ||
    error instanceof StoreSetupReferenceError ||
    error instanceof StoreConfigurationOriginalError ||
    error instanceof StoreConfigurationAdministrationServiceError ||
    error instanceof StorePaymentConfigurationError ||
    error instanceof DigitalReceiptTemplateError ||
    error instanceof BrandStoreTopologyError ||
    error instanceof BrandConfigurationOperationError
  )
    throw error;
  return unavailable();
};

// Only exact live wrappers created below are discoverable. The locator cannot
// register on a driver transaction, copied wrapper or completed host.
const liveRegistrations = new WeakMap<
  object,
  {
    readonly transaction: Transaction;
    readonly register: (tx: Transaction, check: Check, finalAssert?: FinalAssert) => Promise<void>;
  }
>();
export async function registerMerchantTransactionBeforeCommit(
  actualTx: object,
  guard: Check,
  finalAssert?: FinalAssert,
): Promise<void> {
  const registration = liveRegistrations.get(actualTx);
  if (!registration) return unavailable();
  await registration.register(registration.transaction, guard, finalAssert);
}

/** Transport composition over the existing transaction runner. The runner owns
 * COMMIT/ROLLBACK and must roll back failed actions. Checks run before its action
 * returns. No statement, authority grant, or unchecked transaction is supplied.
 */
export function createMerchantCategoryTransactions(
  source: PersistentMerchantBffOptions["transactions"],
) {
  if (!source || typeof source.run !== "function") return unavailable();
  const active = new WeakMap<Transaction, State>();
  const registerBeforeCommit = async (
    tx: Transaction,
    check: Check,
    finalAssert?: FinalAssert,
  ): Promise<void> => {
    const state = active.get(tx);
    if (!state) return unavailable();
    if (
      state.phase !== "work" ||
      typeof check !== "function" ||
      (finalAssert !== undefined && typeof finalAssert !== "function") ||
      (state.checks.has(check) && state.checks.get(check) !== finalAssert) ||
      (!state.checks.has(check) && state.checks.size >= 128)
    ) {
      state.failed = true;
      return unavailable();
    }
    state.checks.set(check, finalAssert);
  };
  const transactions = Object.freeze({
    async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      if (typeof work !== "function") return unavailable();
      try {
        return await source.run(async (original) => {
          const state: State = { phase: "work", failed: false, pending: 0, checks: new Map() };
          const tx: Transaction = Object.freeze({
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              if (state.phase === "closed" || state.phase === "final" || state.failed) {
                state.failed = true;
                return unavailable();
              }
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
          liveRegistrations.set(tx, { transaction: tx, register: registerBeforeCommit });
          try {
            const result = await work(tx);
            if (state.failed || state.pending !== 0 || state.checks.size === 0)
              return unavailable();
            state.phase = "checks";
            for (const check of state.checks.keys()) {
              await check();
              if (state.failed || state.pending !== 0) return unavailable();
            }
            // A later asynchronous authority check can consume an earlier
            // owner's lease. Reassert every original lease without another
            // await or business query before returning to the COMMIT owner.
            state.phase = "final";
            for (const assert of state.checks.values()) {
              if (assert === undefined) continue;
              const returned: unknown = assert();
              if (returned !== undefined) {
                state.failed = true;
                // Reject async assertions without leaving their rejection
                // unhandled. No promise is awaited in this phase.
                if (returned instanceof Promise) void returned.catch(() => undefined);
                return unavailable();
              }
              if (state.failed || state.pending !== 0) return unavailable();
            }
            return result;
          } finally {
            state.phase = "closed";
            active.delete(tx);
            liveRegistrations.delete(tx);
          }
        });
      } catch (error) {
        return bounded(error);
      }
    },
  });
  return Object.freeze({
    transactions,
    async registerBeforeCommit(
      tx: Transaction,
      check: Check,
      finalAssert?: FinalAssert,
    ): Promise<void> {
      await registerBeforeCommit(tx, check, finalAssert);
    },
  });
}
