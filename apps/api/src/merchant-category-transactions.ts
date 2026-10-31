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
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

type Transaction = Parameters<CategoryPersistenceAuthority["holdUntilTransactionCompletes"]>[0];
type Check = () => Promise<void>;
type FinalAssert = () => void;
interface State {
  phase: "work" | "checks" | "final" | "closed";
  failed: boolean;
  pending: number;
  checks: Map<Check, FinalAssert | undefined>;
  /** Checks that run after every other before-commit check (registered once each). */
  lastChecks: Check[];
  /** A session-setting statement to run before the next statement (the latest one wins). */
  deferred?: { readonly sql: string; readonly values: readonly unknown[] } | undefined;
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** The database runner's retryable conflict: nothing of the failed attempt was committed. */
export const isTransactionConflict = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  Object.getOwnPropertyDescriptor(error, "code")?.value === "TENANT_DATABASE_TRANSACTION_CONFLICT";
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
/**
 * The live phase of a transaction this host runs ("work" while the action runs, "checks" while
 * its before-commit checks run), or undefined for any other object (a driver transaction, a
 * copied wrapper or a completed host). WP-2423: per-transaction authorization reuse keys on it.
 */
const livePhases = new WeakMap<object, State>();
export function merchantTransactionPhase(actualTx: unknown): State["phase"] | undefined {
  if (actualTx === null || typeof actualTx !== "object") return undefined;
  return livePhases.get(actualTx)?.phase;
}
/**
 * Runs `sql` (a transaction-local `set_config` statement) immediately before the next statement
 * of this live host transaction; a later deferral replaces an earlier one that has not run yet.
 * WP-2423: a remembered authorization answer restores the row-level-security scope its full
 * resolution leaves selected without a statement per reuse.
 */
export function deferMerchantTransactionStatement(
  actualTx: unknown,
  sql: string,
  values: readonly unknown[],
): boolean {
  if (actualTx === null || typeof actualTx !== "object") return false;
  const state = livePhases.get(actualTx);
  if (!state || (state.phase !== "work" && state.phase !== "checks") || state.failed) return false;
  if (
    !/^SELECT set_config\('bop\.[a-z_]+',\$1,true\)(?:,set_config\('bop\.[a-z_]+',(?:\$2|''),true\))*$/u.test(
      sql,
    )
  )
    return false;
  state.deferred = Object.freeze({ sql, values: Object.freeze([...values]) });
  return true;
}
/**
 * Runs `check` after every other before-commit check of this live host transaction (so after its
 * last statement that could change what `check` reads). WP-2423: the once-per-transaction Brand
 * authorization re-check.
 */
export function registerMerchantTransactionLastCheck(actualTx: unknown, check: Check): void {
  if (actualTx === null || typeof actualTx !== "object") return unavailable();
  const state = livePhases.get(actualTx);
  if (
    !state ||
    state.phase !== "work" ||
    typeof check !== "function" ||
    state.lastChecks.length >= 8
  ) {
    if (state) state.failed = true;
    return unavailable();
  }
  if (!state.lastChecks.includes(check)) state.lastChecks.push(check);
}
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
    /**
     * `retryConflict` (read-only work only): a transaction that failed only on a lock wait,
     * serialization failure or deadlock is rerun with short backoff; one that keeps conflicting
     * stays a `TENANT_DATABASE_TRANSACTION_CONFLICT` so the route answers "retry later" (503 with
     * Retry-After), never a plain outage. Write work keeps its bounded outcome.
     */
    async run<T>(
      work: (tx: Transaction) => Promise<T>,
      options?: { readonly retryConflict?: boolean },
    ): Promise<T> {
      if (typeof work !== "function") return unavailable();
      const retry = options?.retryConflict === true;
      try {
        return await (retry ? retryTransactionConflict(attempt) : attempt());
      } catch (error) {
        if (retry && isTransactionConflict(error)) throw error;
        return bounded(error);
      }
      async function attempt(): Promise<T> {
        return source.run(async (original) => {
          const state: State = {
            phase: "work",
            failed: false,
            pending: 0,
            checks: new Map(),
            lastChecks: [],
          };
          const tx: Transaction = Object.freeze({
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              if (state.phase === "closed" || state.phase === "final" || state.failed) {
                state.failed = true;
                return unavailable();
              }
              state.pending++;
              try {
                const deferred = state.deferred;
                if (deferred !== undefined) {
                  state.deferred = undefined;
                  await original.query(deferred.sql, deferred.values);
                }
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
          livePhases.set(tx, state);
          try {
            const result = await work(tx);
            if (state.failed || state.pending !== 0 || state.checks.size === 0)
              return unavailable();
            state.phase = "checks";
            for (const check of [...state.checks.keys(), ...state.lastChecks]) {
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
            livePhases.delete(tx);
          }
        });
      }
    },
    /** Read-only work: a conflicted transaction is rerun (see `run`, `retryConflict`). */
    runRead<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      return transactions.run(work, { retryConflict: true });
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
