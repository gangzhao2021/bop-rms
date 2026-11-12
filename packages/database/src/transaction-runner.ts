import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import {
  TenantContextDatabaseError,
  tenantContextDatabaseDiagnostic,
  withTenantContextTransaction,
  type TenantDatabaseScope,
} from "./tenant-context.js";
import {
  createTransactionStatementMemo,
  stableReadStatement,
} from "./transaction-statement-memo.js";
import { snapshotReadStatement } from "./snapshot-read.js";
import {
  acquireTenantConnection,
  tenantConnectionAcquireBudgetMaxMs,
} from "./connection-acquire.js";

const retryableSqlStates: ReadonlySet<string> = new Set(["55P03", "40001", "40P01"]);
function sqlState(error: unknown): string {
  const code =
    error !== null && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")?.value
      : undefined;
  return typeof code === "string" ? code : "";
}
/** True for a transaction that failed only because of a lock or serialization conflict. */
export function isRetryableTransactionConflict(error: unknown): boolean {
  return (
    error instanceof TenantContextDatabaseError &&
    error.code === "TENANT_DATABASE_TRANSACTION_CONFLICT"
  );
}

/**
 * WP-2423 (v15 2026-10-14): one transaction is one connection, and its queries must run one at a
 * time. A second query while one is in flight (for example `Promise.all` over owner ports sharing
 * the transaction) is refused with TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY and the whole
 * transaction rolls back, everywhere except production, where the driver still queues it.
 */
function refuseConcurrentQueries(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Read by `customerFailureCode` (apps/api); holds only the sanitized diagnostic. */
const databaseFailureKey = Symbol.for("bop.database.failure");
function attachFailureDiagnostic(
  error: unknown,
  diagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic>,
): void {
  if (
    error === null ||
    typeof error !== "object" ||
    !Object.isExtensible(error) ||
    Object.getOwnPropertyDescriptor(error, databaseFailureKey) !== undefined
  )
    return;
  Object.defineProperty(error, databaseFailureKey, { value: diagnostic, enumerable: false });
}

const transactionLimits =
  "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; " +
  "SET LOCAL idle_in_transaction_session_timeout = '5s'";

export interface DatabaseTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DatabaseTransactionRunner {
  run<T>(action: (transaction: DatabaseTransaction) => Promise<T>): Promise<T>;
  /**
   * WP-2423: a list or detail read staff screens poll. One REPEATABLE READ, READ ONLY snapshot;
   * advisory/table locks are answered locally and row-locking clauses dropped (snapshot-read), so
   * it never waits for, or holds up, a command or another read. It cannot write.
   */
  runSnapshot<T>(action: (transaction: DatabaseTransaction) => Promise<T>): Promise<T>;
}

export function createTenantTransactionRunner(
  pool: Pick<Pool, "connect"> & {
    options: Pick<Pool["options"], "connectionTimeoutMillis" | "query_timeout">;
  },
  scope: TenantDatabaseScope,
  acquire: { readonly acquireBudgetMs?: number } = {},
): DatabaseTransactionRunner {
  for (const timeout of [pool.options.connectionTimeoutMillis, pool.options.query_timeout]) {
    if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 10_000)
      throw new TenantContextDatabaseError("TENANT_DATABASE_SCOPE_INVALID");
  }
  if (
    typeof scope !== "object" ||
    scope === null ||
    Object.getPrototypeOf(scope) !== Object.prototype
  )
    throw new TenantContextDatabaseError("TENANT_DATABASE_SCOPE_INVALID");
  const fixedScope = Object.freeze(
    Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)),
  ) as TenantDatabaseScope;
  // WP-2423 M68 (a): each attempt waits in the pool's queue only for the pool's own short limit
  // (`connectionTimeoutMillis`); attempts are retried with jitter until the request's acquire
  // budget is spent (an entry gives 10 s inside the clients' 15 s; by default one attempt's time).
  const budgetMs = acquire.acquireBudgetMs ?? (pool.options.connectionTimeoutMillis as number);
  if (
    !Number.isInteger(budgetMs) ||
    budgetMs < (pool.options.connectionTimeoutMillis as number) ||
    budgetMs > tenantConnectionAcquireBudgetMaxMs
  )
    throw new TenantContextDatabaseError("TENANT_DATABASE_SCOPE_INVALID");
  const connections = Object.freeze({
    connect: () => acquireTenantConnection(pool, { budgetMs }),
  }) as Pick<Pool, "connect">;
  const run = <T>(
    mode: "ReadWrite" | "Snapshot",
    action: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> =>
    withTenantContextTransaction(
      connections,
      fixedScope,
      async (client) => {
        const state = transactionState(client, mode, fixedScope);
        try {
          const value = await action(state.transaction);
          await state.beforeCommit();
          return state.settle(value);
        } catch (error) {
          return state.report(error);
        } finally {
          state.close();
        }
      },
      mode,
      // The three limits go with BEGIN (one round trip; a parameterless simple query).
      transactionLimits,
    );
  const execute = <T>(
    mode: "ReadWrite" | "Snapshot",
    action: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> => {
    const shared = mode === "ReadWrite" ? together.getStore() : undefined;
    if (shared === undefined || shared.closed || (shared.pool !== null && shared.pool !== pool))
      return run(mode, action);
    return shared.join(pool, fixedScope, () => openShared(shared), action);
  };
  /** The one transaction of a `runTogether` call, begun by its first run on this pool. */
  const openShared = (shared: TogetherSlot): Promise<void> =>
    new Promise<void>((opened, failedToOpen) => {
      let begun = false;
      shared.finished = withTenantContextTransaction(
        connections,
        fixedScope,
        async (client) => {
          const state = transactionState(client, "ReadWrite", fixedScope);
          shared.state = state;
          begun = true;
          opened();
          try {
            await shared.done;
            await state.beforeCommit();
            return state.settle(undefined);
          } catch (error) {
            return state.report(error);
          } finally {
            state.close();
          }
        },
        "ReadWrite",
        transactionLimits,
      ).catch((error: unknown) => {
        if (!begun) failedToOpen(error);
        throw error;
      });
      // A failure before the transaction began is the opening run's own failure.
      shared.finished.catch(() => undefined);
    });
  return Object.freeze<DatabaseTransactionRunner>({
    run: (action) => execute("ReadWrite", action),
    runSnapshot: (action) => execute("Snapshot", action),
  });
}

interface TransactionState {
  readonly transaction: DatabaseTransaction;
  /** The scope the next statements run under (a joined run of another runner's scope). */
  useScope(scope: TenantDatabaseScope): void;
  /**
   * v15 2026-11-12: sends the scope settings the caller wrote after the last statement that ran,
   * before COMMIT. A deferred constraint trigger (such as the batch cancellation's revision
   * binding, 1300_036) runs at COMMIT under the scope the transaction then holds, and reads
   * row-level secured tables under it: an owner that left a Brand-level read and restored its
   * Store scope last must not have that check run under the Brand-level scope.
   */
  beforeCommit(): Promise<void>;
  /** The action's result, unless a statement of the transaction failed or is still running. */
  settle<T>(result: T): T;
  /** The action's error, as the runner reports a failed transaction. */
  report(error: unknown): never;
  close(): void;
}

function transactionState(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  mode: "ReadWrite" | "Snapshot",
  fixedScope: TenantDatabaseScope,
): TransactionState {
  let active = true;
  let failed = false;
  let conflicted = false;
  let conflictDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
  let failureDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
  let concurrent = false;
  let pending = 0;
  const scopeSettings = (scope: TenantDatabaseScope) => ({
    "bop.brand_id": scope.brandId,
    "bop.store_id": typeof scope.storeId === "string" ? scope.storeId : "",
  });
  // The scope settings withTenantContextTransaction installed before this callback; repeats
  // of them, and of locks this transaction already holds, are answered without a round trip.
  const memo = createTransactionStatementMemo(scopeSettings(fixedScope));
  const transaction = Object.freeze<DatabaseTransaction>({
    async query(sql: string, values: readonly unknown[]) {
      if (!active)
        throw new TenantContextDatabaseError(
          "TENANT_DATABASE_TRANSACTION_FAILED",
          tenantContextDatabaseDiagnostic(undefined, true),
        );
      if (pending > 0 && refuseConcurrentQueries()) {
        failed = true;
        concurrent = true;
        throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY");
      }
      // WP-2423 M35: a stable read (its owner's marker) may be answered from this
      // transaction's earlier identical read; the marker itself is not sent.
      const marked = stableReadStatement(sql);
      let statement = marked.sql;
      if (mode === "Snapshot") {
        const planned = snapshotReadStatement(statement);
        if (planned.kind === "Answer") return planned.result;
        statement = planned.sql;
      }
      let settings: { readonly sql: string; readonly values: readonly string[] } | null = null;
      if (pending === 0) {
        const planned = memo.plan(statement, values, marked.stable);
        if (planned.kind === "Answer") return planned.result;
        settings = planned.settings;
      }
      pending += 1;
      try {
        // The scope settings written since the last statement that ran, sent only now.
        if (settings !== null) {
          await client.query(settings.sql, [...settings.values]);
          memo.observe(settings.sql, settings.values);
        }
        const result = await client.query(statement, [...values]);
        memo.observe(statement, values, result, marked.stable);
        return result;
      } catch (error) {
        memo.forget();
        failed = true;
        // Lock timeout, serialization failure and deadlock leave nothing committed; the
        // caller may rerun the whole idempotent transaction. No SQL detail is exposed.
        const diagnostic = tenantContextDatabaseDiagnostic(error);
        failureDiagnostic ??= diagnostic;
        if (retryableSqlStates.has(sqlState(error))) {
          conflicted = true;
          conflictDiagnostic ??= diagnostic;
        }
        throw new TenantContextDatabaseError(
          conflicted
            ? "TENANT_DATABASE_TRANSACTION_CONFLICT"
            : "TENANT_DATABASE_TRANSACTION_FAILED",
          diagnostic,
        );
      } finally {
        pending -= 1;
      }
    },
  });
  return Object.freeze<TransactionState>({
    transaction,
    useScope: (scope) => memo.useScope(scopeSettings(scope)),
    async beforeCommit() {
      // A read-only snapshot fires no trigger; a failed or busy transaction is settled as such.
      if (mode !== "ReadWrite" || !active || failed || pending !== 0) return;
      const settings = memo.pending();
      if (settings === null) return;
      pending += 1;
      try {
        await client.query(settings.sql, [...settings.values]);
        memo.observe(settings.sql, settings.values);
      } catch (error) {
        memo.forget();
        failed = true;
        const diagnostic = tenantContextDatabaseDiagnostic(error);
        failureDiagnostic ??= diagnostic;
        throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED", diagnostic);
      } finally {
        pending -= 1;
      }
    },
    settle<T>(result: T): T {
      if (failed || pending !== 0)
        throw new TenantContextDatabaseError(
          concurrent
            ? "TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY"
            : conflicted
              ? "TENANT_DATABASE_TRANSACTION_CONFLICT"
              : "TENANT_DATABASE_TRANSACTION_FAILED",
          // The swallowed query's SQLSTATE, so a lost connection still reads as retryable.
          conflicted ? conflictDiagnostic : concurrent ? null : failureDiagnostic,
        );
      return result;
    },
    report(error: unknown): never {
      // Whatever the action made of it, a conflicted transaction is reported as retryable,
      // and concurrent use of the transaction as the programming error it is.
      if (concurrent)
        throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY");
      // The first conflict's SQLSTATE stays visible to logging (lock timeout vs serialization).
      if (conflicted)
        throw new TenantContextDatabaseError(
          "TENANT_DATABASE_TRANSACTION_CONFLICT",
          conflictDiagnostic,
        );
      // A caller that turned a failed query into its own error keeps that error; the first
      // failure's SQLSTATE rides along (non-enumerable) so a 503 can be logged with its cause.
      if (failed && failureDiagnostic !== null) attachFailureDiagnostic(error, failureDiagnostic);
      throw error;
    },
    close() {
      active = false;
    },
  });
}

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-SPEED): one `runTogether` call. Its first ordinary run on a pool
 * begins one transaction; every later ordinary run on that pool inside the call joins it (under
 * the joining runner's own Brand and Store scope) instead of beginning its own. It commits once
 * the call's work has finished, or rolls back when the work fails.
 */
interface TogetherSlot {
  pool: object | null;
  state: TransactionState | null;
  opening: Promise<void> | null;
  finished: Promise<unknown> | null;
  closed: boolean;
  readonly done: Promise<void>;
  join<T>(
    pool: object,
    scope: TenantDatabaseScope,
    open: () => Promise<void>,
    action: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}
// One store for every copy of this module in the process (the pilot loads the built runner while
// some compositions load the source), so a call is shared whichever copy began it.
const togetherKey = Symbol.for("bop.database.runTogether");
const together: AsyncLocalStorage<TogetherSlot> = ((globalThis as Record<symbol, unknown>)[
  togetherKey
] ??= new AsyncLocalStorage<TogetherSlot>()) as AsyncLocalStorage<TogetherSlot>;

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-SPEED): runs `work` so that its ordinary transactions on one pool
 * are one transaction. For a check made of several owners' reads (a guest's session, its table
 * binding and its table place): the same reads, in the same order, in one transaction, so they
 * also see one consistent set of facts. Not for work that must commit part of itself on its own:
 * nothing is committed until `work` ends, and any failure rolls all of it back. Snapshot reads,
 * other pools and calls already inside one run as before.
 *
 * Restrictions, which the caller must keep:
 * - `work` must run its reads one after another, never concurrently (no `Promise.all` over runs).
 *   Every ordinary run on the pool shares the one transaction and its one connection, so a second
 *   run started while another is still in flight fails with
 *   TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY (which the guest sees as "unavailable") where it
 *   used to get its own connection.
 * - Every ordinary run on the same pool joins, whichever runner started it: a runner with another
 *   scope runs under its own Brand and Store scope, but its own transaction limits and connection
 *   budget do not apply; the first run's transaction (and its time limit) is used for all of them.
 * After a deploy, the api log is checked for TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY.
 */
export async function runTogether<T>(work: () => Promise<T>): Promise<T> {
  if (together.getStore() !== undefined) return work();
  let finish: (failure?: { readonly error: unknown }) => void = () => undefined;
  const slot: TogetherSlot = {
    pool: null,
    state: null,
    opening: null,
    finished: null,
    closed: false,
    done: new Promise<void>((resolve, reject) => {
      finish = (failure) => (failure === undefined ? resolve() : reject(failure.error));
    }),
    async join(pool, scope, open, action) {
      if (slot.pool === null) {
        slot.pool = pool;
        slot.opening = open();
      }
      await slot.opening;
      const state = slot.state;
      if (state === null || slot.closed)
        throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
      state.useScope(scope);
      try {
        return state.settle(await action(state.transaction));
      } catch (error) {
        return state.report(error);
      }
    },
  };
  slot.done.catch(() => undefined);
  return together.run(slot, async () => {
    let failure: { readonly error: unknown } | undefined;
    let value: T | undefined;
    try {
      value = await work();
    } catch (error) {
      failure = { error };
    }
    slot.closed = true;
    finish(failure);
    if (slot.finished !== null) {
      try {
        await slot.finished;
      } catch (error) {
        // The work's own failure is the answer; a commit failure only when the work succeeded.
        if (failure === undefined) throw error;
      }
    }
    if (failure !== undefined) throw failure.error;
    return value as T;
  });
}
