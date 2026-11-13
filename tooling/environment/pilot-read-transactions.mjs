import {
  createTransactionStatementMemo,
  stableReadStatement,
} from "../../packages/database/dist/transaction-statement-memo.js";
import { tenantContextScopeStatement } from "../../packages/database/dist/tenant-context.js";

/** The scope as checked set_config text (UUIDv7 only), or null to send it with parameters. */
function inlineScope(scope) {
  try {
    return tenantContextScopeStatement({
      brandId: scope.brandReference,
      storeId: scope.storeReference,
    });
  } catch {
    return null;
  }
}

export function createInternalReadTransactions(resources) {
  return {
    async run(work) {
      const connection = await resources.database.acquire();
      let failed = false;
      try {
        // WP-2423 M35: BEGIN, its limit and (review of the third step) the scope in one
        // simple-protocol round trip; the scope text only as the runner's checked UUIDs.
        const scopeText = inlineScope(resources.scope);
        await connection.query(
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '2s'" +
            (scopeText === null ? "" : "; " + scopeText),
        );
        if (scopeText === null)
          await connection.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [resources.scope.brandReference, resources.scope.storeReference],
          );
        // WP-2423 M35 (DEC-STAFF-ROUND-SPEED): as the pilot's transaction runner does, a scope
        // setting is sent only with the next statement that runs (and only when it changes it), and
        // an owner's stable read repeated in this one snapshot is answered from its first answer.
        const memo = createTransactionStatementMemo({
          "bop.brand_id": resources.scope.brandReference,
          "bop.store_id": resources.scope.storeReference,
        });
        let pending = 0;
        const query = async (sql, values) => {
          const marked = stableReadStatement(sql);
          let settings = null;
          if (pending === 0) {
            const planned = memo.plan(marked.sql, values, marked.stable);
            if (planned.kind === "Answer") return planned.result;
            settings = planned.settings;
          }
          pending += 1;
          try {
            if (settings !== null) {
              await connection.query(settings.sql, [...settings.values]);
              memo.observe(settings.sql, settings.values);
            }
            const result = await connection.query(marked.sql, [...values]);
            memo.observe(marked.sql, values, result, marked.stable);
            return result;
          } catch (error) {
            memo.forget();
            throw error;
          } finally {
            pending -= 1;
          }
        };
        const result = await work({ query });
        await connection.query("COMMIT");
        return result;
      } catch {
        failed = true;
        await connection.query("ROLLBACK").catch(() => undefined);
        throw new Error("INTERNAL_INVENTORY_READ_UNAVAILABLE");
      } finally {
        connection.release(failed);
      }
    },
  };
}
