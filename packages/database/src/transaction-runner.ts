import type { Pool } from "pg";
import {
  TenantContextDatabaseError,
  withTenantContextTransaction,
  type TenantDatabaseScope,
} from "./tenant-context.js";

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
          await client.query("SET LOCAL statement_timeout = '5s'");
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
        } catch {
          throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
        }
        let active = true;
        let failed = false;
        let conflicted = false;
        let pending = 0;
        try {
          const result = await action(
            Object.freeze({
              async query(sql: string, values: readonly unknown[]) {
                if (!active)
                  throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
                pending += 1;
                try {
                  return await client.query(sql, [...values]);
                } catch (error) {
                  failed = true;
                  // Lock timeout, serialization failure and deadlock leave nothing committed; the
                  // caller may rerun the whole idempotent transaction. No SQL detail is exposed.
                  if (retryableSqlStates.has(sqlState(error))) conflicted = true;
                  throw new TenantContextDatabaseError(
                    conflicted
                      ? "TENANT_DATABASE_TRANSACTION_CONFLICT"
                      : "TENANT_DATABASE_TRANSACTION_FAILED",
                  );
                } finally {
                  pending -= 1;
                }
              },
            }),
          );
          if (failed || pending !== 0)
            throw new TenantContextDatabaseError(
              conflicted
                ? "TENANT_DATABASE_TRANSACTION_CONFLICT"
                : "TENANT_DATABASE_TRANSACTION_FAILED",
            );
          return result;
        } catch (error) {
          // Whatever the action made of it, a conflicted transaction is reported as retryable.
          if (conflicted)
            throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_CONFLICT");
          throw error;
        } finally {
          active = false;
        }
      }),
  });
}
