import type { Pool } from "pg";
import {
  TenantContextDatabaseError,
  withTenantContextTransaction,
  type TenantDatabaseScope,
} from "./tenant-context.js";

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
                } catch {
                  failed = true;
                  throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
                } finally {
                  pending -= 1;
                }
              },
            }),
          );
          if (failed || pending !== 0)
            throw new TenantContextDatabaseError("TENANT_DATABASE_TRANSACTION_FAILED");
          return result;
        } finally {
          active = false;
        }
      }),
  });
}
