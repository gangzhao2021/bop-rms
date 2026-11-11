import {
  TenantContextDatabaseError,
  tenantContextDatabaseDiagnostic,
} from "../../packages/database/dist/tenant-context.js";
import { stableReadStatement } from "../../packages/database/dist/transaction-statement-memo.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** Read by merchantFailureKind and the request reporter, as the transaction runner sets it. */
const databaseFailure = Symbol.for("bop.database.failure");
const retryableSqlStates = new Set(["55P03", "40001", "40P01"]);
/**
 * WP-2423 item 10: what failed, as the transaction runner says it (code and safe identifiers, never
 * message text), so a missing grant reads as a fault with its SQLSTATE and table, a lock as busy.
 */
const databaseError = (diagnostic) =>
  new TenantContextDatabaseError(
    retryableSqlStates.has(diagnostic.sqlState ?? "")
      ? "TENANT_DATABASE_TRANSACTION_CONFLICT"
      : "TENANT_DATABASE_TRANSACTION_FAILED",
    diagnostic,
  );
/** The work's own error (a refusal stays one) carries the failed query's diagnostic along. */
function withFailure(error, diagnostic) {
  if (
    diagnostic !== null &&
    error !== null &&
    typeof error === "object" &&
    Object.isExtensible(error) &&
    Object.getOwnPropertyDescriptor(error, databaseFailure) === undefined
  )
    Object.defineProperty(error, databaseFailure, { value: diagnostic, enumerable: false });
  return error;
}

/** Exception reads need one snapshot; current permission readers retain row locks. */
export function createInternalExceptionSnapshotTransactions(resources) {
  const binding = resources.publicProfile.binding;
  // The snapshot's own guard: a statement that is not a read, an expired binding, another scope.
  const fail = () => {
    throw Error("INTERNAL_EXCEPTION_SNAPSHOT_UNAVAILABLE");
  };
  const active = () => isPilotRuntime() && resources.now() < binding.validUntil;
  if (
    binding.brandReference !== resources.scope.brandReference ||
    binding.storeReference !== resources.scope.storeReference
  )
    return fail();
  return Object.freeze({
    run: async (work) => {
      if (!active()) return fail();
      let client;
      try {
        client = await resources.database.acquire();
      } catch (error) {
        throw new TenantContextDatabaseError(
          "TENANT_DATABASE_ACQUIRE_FAILED",
          tenantContextDatabaseDiagnostic(error),
        );
      }
      let open = false,
        pending = 0,
        failed = false,
        /** The first failed query's diagnostic; null when only the guard refused. */
        diagnostic = null;
      /** A statement of the host itself (BEGIN, scope, COMMIT): its failure is the database's. */
      const own = async (sql, values) => {
        try {
          return await client.query(sql, values);
        } catch (error) {
          failed = true;
          diagnostic ??= tenantContextDatabaseDiagnostic(error);
          throw databaseError(diagnostic);
        }
      };
      try {
        await own("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await own(
          "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='5s'",
        );
        await own(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [binding.tenantReference, binding.brandReference, binding.storeReference],
        );
        open = true;
        const tx = Object.freeze({
          query: async (sql, values) => {
            // WP-2423 M35: an owner's stable read starts with its marker comment; the statement
            // after it is what is checked.
            const statement = stableReadStatement(sql).sql;
            if (
              !open ||
              !active() ||
              typeof sql !== "string" ||
              !/^\s*(SELECT\b|WITH RECURSIVE\b|SET LOCAL\b|LOCK TABLE [a-z_][a-z0-9_.]*(?:,[a-z_][a-z0-9_.]*)* IN (?:ROW )?SHARE MODE$)/iu.test(
                statement,
              ) ||
              statement.includes(";") ||
              (/^\s*WITH\b/iu.test(statement) &&
                /\b(INSERT|UPDATE|DELETE|MERGE|CALL|COPY|ALTER|DROP|CREATE|TRUNCATE)\b/iu.test(
                  statement,
                )) ||
              !Array.isArray(values)
            ) {
              failed = true;
              return fail();
            }
            pending++;
            try {
              return await client.query(sql, [...values]);
            } catch (error) {
              failed = true;
              diagnostic ??= tenantContextDatabaseDiagnostic(error);
              throw databaseError(tenantContextDatabaseDiagnostic(error));
            } finally {
              pending--;
            }
          },
        });
        let result;
        try {
          result = await work(tx);
        } catch (error) {
          // Whatever the work made of it: its own error, with what failed riding along.
          throw withFailure(error, diagnostic);
        }
        open = false;
        // A failure the work swallowed is still the transaction's: nothing it read is trusted.
        if (failed)
          throw diagnostic === null
            ? Error("INTERNAL_EXCEPTION_SNAPSHOT_UNAVAILABLE")
            : databaseError(diagnostic);
        if (pending !== 0 || !active()) return fail();
        await own("COMMIT");
        return result;
      } catch (error) {
        open = false;
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        open = false;
        client.release();
      }
    },
  });
}
