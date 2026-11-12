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
  statementKind,
} from "./transaction-statement-memo.js";
import { currentRequestChecks, type RequestCheckMemo } from "./request-check-memo.js";
import { snapshotReadStatement } from "./snapshot-read.js";
import {
  acquireTenantConnection,
  tenantConnectionAcquireBudgetMaxMs,
} from "./connection-acquire.js";
import { requestAnswerTimeLeftMs } from "./request-acquire-budget.js";

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
/** The statement limit `transactionLimits` sets, in milliseconds. */
const statementLimitMs = 5000;
/** A read's statement is never given less than this; less could not finish anyway. */
const statementLimitFloorMs = 50;
/** The limit is narrowed again only when it would come down by more than this. */
const statementLimitStepMs = 250;
/** A read past the time it may work in all: no statement sent, the read answers busy. */
const answerTimeSpent = Object.freeze({
  sqlState: "57014",
  constraint: null,
  table: null,
  closed: false,
});

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
  ): Promise<T> => {
    const checks = mode === "ReadWrite" ? currentRequestChecks() : undefined;
    return checks === undefined ? runNow(mode, action) : runWhenNeeded(checks, action);
  };
  const runNow = <T>(
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
  /**
   * WP-2423 M35 (third step): inside one request's verified checks a transaction begins only when
   * its first statement must reach the database; a check answered in full from the request's
   * earlier check (request-check-memo) takes no connection and sends nothing. Once begun it is an
   * ordinary transaction: limits and scope with BEGIN, COMMIT once the action ends, ROLLBACK when
   * it fails.
   */
  const runWhenNeeded = async <T>(
    checks: RequestCheckMemo,
    action: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> => {
    const opening = openWhenNeeded(connections, fixedScope);
    const state = transactionState(opening.client, "ReadWrite", fixedScope, checks);
    let value: T;
    try {
      value = await action(state.transaction);
      await state.beforeCommit();
      value = state.settle(value);
    } catch (error) {
      let reported: unknown = error;
      try {
        state.report(error);
      } catch (thrown) {
        reported = thrown;
      }
      state.close();
      await opening.finish({ error: reported });
      throw reported;
    }
    state.close();
    await opening.finish();
    return value;
  };
  const execute = <T>(
    mode: "ReadWrite" | "Snapshot",
    action: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> => {
    const shared = mode === "ReadWrite" ? together.getStore() : undefined;
    if (shared === undefined || shared.closed || (shared.pool !== null && shared.pool !== pool))
      return run(mode, action);
    const checks = currentRequestChecks();
    return shared.join(
      pool,
      fixedScope,
      () => (checks === undefined ? openShared(shared) : openSharedWhenNeeded(shared, checks)),
      action,
    );
  };
  /** As openShared, begun only with its first statement that must reach the database. */
  const openSharedWhenNeeded = (shared: TogetherSlot, checks: RequestCheckMemo): Promise<void> => {
    const opening = openWhenNeeded(connections, fixedScope);
    const state = transactionState(opening.client, "ReadWrite", fixedScope, checks);
    shared.state = state;
    shared.finished = (async () => {
      let failure: { readonly error: unknown } | undefined;
      try {
        await shared.done;
        shared.beforeCommit();
        await state.beforeCommit();
        state.settle(undefined);
      } catch (error) {
        try {
          state.report(error);
        } catch (reported) {
          failure = { error: reported };
        }
      }
      state.close();
      await opening.finish(failure);
      if (failure !== undefined) throw failure.error;
    })();
    shared.finished.catch(() => undefined);
    return Promise.resolve();
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
            shared.beforeCommit();
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
  /** How many statements that may write this transaction has sent. */
  writes(): number;
  /** The scope settings written last (sent with the next statement, or before COMMIT). */
  scope(): readonly (readonly [string, string | null])[];
  /** The scope settings to hold before COMMIT, written as the caller's last. */
  restoreScope(scope: readonly (readonly [string, string | null])[]): void;
  /** While true, a statement that may write is refused and fails the transaction. */
  refuseWrites(refuse: boolean): void;
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

/**
 * WP-2423 M35 (third step): a client whose transaction begins (connection, BEGIN with its limits
 * and scope) with its first statement. `finish` commits a begun transaction (or rolls it back with
 * the given error) and waits for that; with nothing begun it does nothing.
 */
function openWhenNeeded(
  connections: Pick<Pool, "connect">,
  scope: TenantDatabaseScope,
): {
  readonly client: { query(sql: string, values?: unknown[]): Promise<unknown> };
  finish(failure?: { readonly error: unknown }): Promise<void>;
} {
  let begun: Promise<{ query(sql: string, values?: unknown[]): Promise<unknown> }> | null = null;
  let finished: Promise<unknown> | null = null;
  let end: (failure?: { readonly error: unknown }) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    end = (failure) => (failure === undefined ? resolve() : reject(failure.error));
  });
  done.catch(() => undefined);
  const begin = () =>
    new Promise<{ query(sql: string, values?: unknown[]): Promise<unknown> }>(
      (opened, failedToOpen) => {
        let started = false;
        finished = withTenantContextTransaction(
          connections,
          scope,
          async (client) => {
            started = true;
            opened(client);
            await done;
          },
          "ReadWrite",
          transactionLimits,
        ).catch((error: unknown) => {
          if (!started) failedToOpen(error);
          throw error;
        });
        finished.catch(() => undefined);
      },
    );
  return Object.freeze({
    client: Object.freeze({
      async query(sql: string, values?: unknown[]) {
        begun ??= begin();
        return (await begun).query(sql, values);
      },
    }),
    async finish(failure?: { readonly error: unknown }) {
      end(failure);
      if (finished === null) return;
      try {
        await finished;
      } catch (error) {
        // The action's own failure is the answer; a commit failure only when it succeeded.
        if (failure === undefined) throw error;
      }
    },
  });
}

function transactionState(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  mode: "ReadWrite" | "Snapshot",
  fixedScope: TenantDatabaseScope,
  checks: RequestCheckMemo | undefined = mode === "ReadWrite" ? currentRequestChecks() : undefined,
): TransactionState {
  let active = true;
  let failed = false;
  let conflicted = false;
  let conflictDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
  let failureDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
  let concurrent = false;
  let pending = 0;
  // The statement limit in force (`transactionLimits`, narrowed for a read near its answer time).
  let statementLimit = statementLimitMs;
  const scopeSettings = (scope: TenantDatabaseScope) => ({
    "bop.brand_id": scope.brandId,
    "bop.store_id": typeof scope.storeId === "string" ? scope.storeId : "",
  });
  // The scope settings withTenantContextTransaction installed before this callback; repeats
  // of them, and of locks this transaction already holds, are answered without a round trip.
  const memo = createTransactionStatementMemo(scopeSettings(fixedScope));
  // WP-2423 M35 (third step, request-check-memo): until the transaction's first statement that
  // may write or lock (`fenced`), an owner's stable read may be answered from this request's
  // earlier check (`borrowed`); before that statement each borrowed read is sent again for real.
  let fenced = mode !== "ReadWrite" || checks === undefined;
  let writes = 0;
  let writesRefused = false;
  let openFailure: unknown = null;
  const borrowed: {
    readonly key: string;
    readonly sql: string;
    readonly values: readonly unknown[];
    readonly scope: readonly (readonly [string, string | null])[];
    readonly rows: string;
  }[] = [];
  const plain = (value: unknown) =>
    value === null || ["string", "number", "boolean"].includes(typeof value);
  const checkKey = (
    sql: string,
    values: readonly unknown[],
    scope: readonly (readonly [string, string | null])[],
  ) =>
    values.every(plain)
      ? JSON.stringify([scope.map(([, value]) => value), sql.trim(), values])
      : null;
  const rowsOf = (result: unknown) => JSON.stringify((result as { rows?: unknown } | null)?.rows);
  /** Sends every borrowed read again under its own scope; any change fails the transaction. */
  const materialize = async () => {
    const restore = memo.scope();
    for (const read of borrowed.splice(0)) {
      memo.useScope(
        Object.fromEntries(read.scope.filter((pair): pair is [string, string] => pair[1] !== null)),
      );
      const settings = memo.pending();
      if (settings !== null) {
        await client.query(settings.sql, [...settings.values]);
        memo.observe(settings.sql, settings.values);
      }
      const result = await client.query(read.sql, [...read.values]);
      memo.observe(read.sql, read.values, result, true);
      checks?.record(read.key, read.sql, result);
      if (rowsOf(result) !== read.rows) {
        // Changed since this request's check: decided again on what is current now.
        conflicted = true;
        throw Object.assign(new Error("verified check changed"), { code: "40001" });
      }
    }
    memo.useScope(
      Object.fromEntries(restore.filter((pair): pair is [string, string] => pair[1] !== null)),
    );
  };
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
      let kind: ReturnType<typeof statementKind> | null = null;
      let recordAs: string | null = null;
      if (pending === 0) {
        const planned = memo.plan(statement, values, marked.stable);
        if (planned.kind === "Answer") return planned.result;
        settings = planned.settings;
        kind = statementKind(statement, values, marked.stable);
        if (kind === "Write" && writesRefused) {
          // runTogether: another runner's scope already wrote in this one transaction.
          failed = true;
          throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
        }
        if (checks !== undefined) {
          if (!fenced && kind === "Read" && marked.stable) {
            const scope = memo.scope();
            const key = checkKey(statement, values, scope);
            const answered = key === null ? null : checks.answer(key);
            if (key !== null && answered !== null) {
              borrowed.push({ key, sql: statement, values, scope, rows: rowsOf(answered) });
              memo.observe(statement, values, answered, true);
              return answered;
            }
            recordAs = key;
          }
        }
      }
      // WP-2423 (guest-table-open-and-busy-reads): a read bounded by its answer time sends no
      // statement once that time is spent, and none that may run past it (the limit is narrowed
      // to what is left; a command has no answer time and keeps the 5 s limit).
      const answerLeft = requestAnswerTimeLeftMs();
      if (answerLeft !== undefined && answerLeft <= 0) {
        failed = true;
        failureDiagnostic ??= answerTimeSpent;
        throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED", answerTimeSpent);
      }
      const narrowedMs =
        answerLeft !== undefined && answerLeft < statementLimit - statementLimitStepMs
          ? Math.max(statementLimitFloorMs, Math.floor(answerLeft))
          : null;
      pending += 1;
      try {
        if (narrowedMs !== null) {
          await client.query("SELECT set_config('statement_timeout',$1,true)", [`${narrowedMs}ms`]);
          statementLimit = narrowedMs;
        }
        if (kind === "Lock" || kind === "Write") {
          // The write fence: borrowed reads are sent again for real before it.
          if (!fenced) {
            fenced = true;
            if (borrowed.length > 0) {
              await materialize();
              settings = memo.pending();
            }
          }
          // The request never answers what this statement may have changed.
          if (kind === "Write") {
            writes += 1;
            checks?.wrote(statement);
          }
        }
        // The scope settings written since the last statement that ran, sent only now.
        if (settings !== null) {
          await client.query(settings.sql, [...settings.values]);
          memo.observe(settings.sql, settings.values);
        }
        const result = await client.query(statement, [...values]);
        memo.observe(statement, values, result, marked.stable);
        if (recordAs !== null && !fenced) checks?.record(recordAs, statement, result);
        return result;
      } catch (error) {
        memo.forget();
        failed = true;
        // A transaction that could not begin keeps the runner's own error (acquire, setup).
        if (error instanceof TenantContextDatabaseError) {
          openFailure ??= error;
          throw error;
        }
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
    writes: () => writes,
    scope: () => memo.scope(),
    restoreScope: (scope) =>
      memo.useScope(
        Object.fromEntries(scope.filter((pair): pair is [string, string] => pair[1] !== null)),
      ),
    refuseWrites: (refuse) => {
      writesRefused = refuse;
    },
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
      if (openFailure !== null) throw openFailure;
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
      if (openFailure !== null) throw openFailure;
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
  /**
   * v15 hotfix review: the runner scope whose run wrote, and the scope that run wrote last.
   * Deferred constraint triggers run at the one COMMIT under the scope then held, so it is the
   * writer's; a run under another runner's scope may read but never write too.
   */
  writer: { readonly key: string; scope: readonly (readonly [string, string | null])[] } | null;
  /** Restores the writer's scope as the last written, just before COMMIT. */
  beforeCommit(): void;
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
    writer: null,
    beforeCommit() {
      if (slot.writer !== null) slot.state?.restoreScope(slot.writer.scope);
    },
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
      const key = JSON.stringify([scope.brandId, scope.storeId ?? null]);
      const before = state.writes();
      state.refuseWrites(slot.writer !== null && slot.writer.key !== key);
      try {
        return state.settle(await action(state.transaction));
      } catch (error) {
        return state.report(error);
      } finally {
        state.refuseWrites(false);
        if (state.writes() > before) {
          if (slot.writer === null) slot.writer = { key, scope: state.scope() };
          else slot.writer.scope = state.scope();
        }
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
