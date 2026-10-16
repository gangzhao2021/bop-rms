import type { Pool } from "pg";
import {
  TenantContextDatabaseError,
  tenantContextDatabaseDiagnostic,
  withTenantContextTransaction,
  type TenantDatabaseScope,
} from "./tenant-context.js";
import { createTransactionStatementMemo } from "./transaction-statement-memo.js";

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

const transactionLimits =
  "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; " +
  "SET LOCAL idle_in_transaction_session_timeout = '5s'";

export interface DatabaseTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DatabaseTransactionRunner {
  run<T>(action: (transaction: DatabaseTransaction) => Promise<T>): Promise<T>;
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
  return Object.freeze<DatabaseTransactionRunner>({
    run: (action) =>
      withTenantContextTransaction(pool, fixedScope, async (client) => {
        try {
          // One round trip for the three limits (a parameterless multi-statement simple query).
          await client.query(transactionLimits);
        } catch {
          throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
        }
        let active = true;
        let failed = false;
        let conflicted = false;
        let conflictDiagnostic: ReturnType<typeof tenantContextDatabaseDiagnostic> | null = null;
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
                if (pending === 0) {
                  const answered = memo.answer(sql, values);
                  if (answered !== null) return answered;
                }
                pending += 1;
                try {
                  const result = await client.query(sql, [...values]);
                  memo.observe(sql, values);
                  return result;
                } catch (error) {
                  memo.forget();
                  failed = true;
                  // Lock timeout, serialization failure and deadlock leave nothing committed; the
                  // caller may rerun the whole idempotent transaction. No SQL detail is exposed.
                  const diagnostic = tenantContextDatabaseDiagnostic(error);
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
              conflicted ? conflictDiagnostic : null,
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
          throw error;
        } finally {
          active = false;
        }
      }),
  });
}
