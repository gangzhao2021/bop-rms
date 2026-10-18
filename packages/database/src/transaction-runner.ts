import type { Pool } from "pg";
import {
  TenantContextDatabaseError,
  tenantContextDatabaseDiagnostic,
  withTenantContextTransaction,
  type TenantDatabaseScope,
} from "./tenant-context.js";
import { createTransactionStatementMemo } from "./transaction-statement-memo.js";
import { snapshotReadStatement } from "./snapshot-read.js";

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
  const execute = <T>(
    mode: "ReadWrite" | "Snapshot",
    action: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> =>
    withTenantContextTransaction(
      pool,
      fixedScope,
      async (client) => {
        try {
          // One round trip for the three limits (a parameterless multi-statement simple query).
          await client.query(transactionLimits);
        } catch (error) {
          throw new TenantContextDatabaseError(
            "TENANT_DATABASE_TRANSACTION_FAILED",
            tenantContextDatabaseDiagnostic(error),
          );
        }
        let active = true;
        let failed = false;
        let conflicted = false;
        let conflictDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
        let failureDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
        let concurrent = false;
        let pending = 0;
        // The scope settings withTenantContextTransaction installed before this callback; repeats
        // of them, and of locks this transaction already holds, are answered without a round trip.
        const memo = createTransactionStatementMemo({
          "bop.brand_id": fixedScope.brandId,
          "bop.store_id": typeof fixedScope.storeId === "string" ? fixedScope.storeId : "",
        });
        try {
          const result = await action(
            Object.freeze({
              async query(sql: string, values: readonly unknown[]) {
                if (!active)
                  throw new TenantContextDatabaseError(
                    "TENANT_DATABASE_TRANSACTION_FAILED",
                    tenantContextDatabaseDiagnostic(undefined, true),
                  );
                if (pending > 0 && refuseConcurrentQueries()) {
                  failed = true;
                  concurrent = true;
                  throw new TenantContextDatabaseError(
                    "TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY",
                  );
                }
                let statement = sql;
                if (mode === "Snapshot") {
                  const planned = snapshotReadStatement(sql);
                  if (planned.kind === "Answer") return planned.result;
                  statement = planned.sql;
                }
                if (pending === 0) {
                  const answered = memo.answer(statement, values);
                  if (answered !== null) return answered;
                }
                pending += 1;
                try {
                  const result = await client.query(statement, [...values]);
                  memo.observe(statement, values);
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
            }),
          );
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
        } catch (error) {
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
          if (failed && failureDiagnostic !== null)
            attachFailureDiagnostic(error, failureDiagnostic);
          throw error;
        } finally {
          active = false;
        }
      },
      mode,
    );
  return Object.freeze<DatabaseTransactionRunner>({
    run: (action) => execute("ReadWrite", action),
    runSnapshot: (action) => execute("Snapshot", action),
  });
}
