import {
  TenantContextDatabaseError,
  tenantContextDatabaseDiagnostic,
} from "../../packages/database/dist/tenant-context.js";
import {
  createTransactionStatementMemo,
  deepCopiedAnswer,
  snapshotStableRead,
  stableReadStatement,
  withoutRowLock,
} from "../../packages/database/dist/transaction-statement-memo.js";
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
        // Batch 37 (v15 b36: Home waited ~0.8 s for this read): in this snapshot, which only
        // reads, a statement repeated with the same values under the same scope settings answers
        // as it did, as in the shared snapshot reads (snapshotStableRead): the scope settings and
        // shared locks the owners take again for every case, and their identical reads. Never a
        // read whose answer changes by itself; any failure forgets everything.
        const memo = createTransactionStatementMemo({
          "bop.tenant_id": binding.tenantReference,
          "bop.brand_id": binding.brandReference,
          "bop.store_id": binding.storeReference,
        });
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
            // A read with a trailing row lock too: this snapshot only reads, so once this
            // transaction holds the rows' locks a repeat reads the same rows.
            const stable = snapshotStableRead(
              withoutRowLock(statement),
              values,
              stableReadStatement(sql).stable,
            );
            if (pending === 0) {
              const answered = memo.answer(statement, values, stable);
              if (answered !== null) return deepCopiedAnswer(answered);
            }
            pending++;
            try {
              const result = await client.query(sql, [...values]);
              // A WITH query passed the guard above, so it writes nothing; unless it names a
              // setting or a lock it changes nothing the memo holds (the memo itself would forget
              // its reads on any WITH, which is right where a WITH may write).
              if (
                !/^\s*WITH\b/iu.test(statement) ||
                /set_config|advisory|\block\b/iu.test(statement)
              )
                memo.observe(statement, values, result, stable);
              return result;
            } catch (error) {
              memo.forget();
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
