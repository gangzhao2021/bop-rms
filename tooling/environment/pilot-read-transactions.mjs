import { AsyncLocalStorage } from "node:async_hooks";
import {
  createTransactionStatementMemo,
  stableReadStatement,
} from "../../packages/database/dist/transaction-statement-memo.js";
import { tenantContextScopeStatement } from "../../packages/database/dist/tenant-context.js";
import {
  noteRequestShed,
  requestAnswerTimeLeftMs,
} from "../../packages/database/dist/connection-acquire.js";

/**
 * WP-2423 (rush-connection-hold, v15 2026-11-14): the read snapshot the current work is inside, if
 * any. In every rush wave the API's whole pool sat "idle in transaction" for 10-20 s: a guest cart
 * read checks its lines in one snapshot (a connection held) and, for each line, the stock read
 * asked the same pool for a second connection, which only the snapshots waiting for theirs could
 * give back. Nothing was answered until the 10 s acquire budget ran out. A read started inside an
 * open snapshot of the same database and Store now runs in that snapshot (a savepoint of it), on
 * the connection already held: one connection per read, whatever it nests.
 */
const openSnapshots = new AsyncLocalStorage();
/** What a failed read answers: the owners read it as "couldn't read", never its detail. */
const unavailable = () => new Error("INTERNAL_INVENTORY_READ_UNAVAILABLE");
/** A connection sitting in the snapshot sending nothing is let go by the database after this. */
const snapshotLimits =
  "SET LOCAL lock_timeout = '2s'; SET LOCAL idle_in_transaction_session_timeout = '5s'";

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
  const scopeKey = JSON.stringify([resources.scope.brandReference, resources.scope.storeReference]);
  /** The nested read `work`, in a savepoint of the open snapshot `open` (one at a time). */
  const nested = (open, work) => {
    const turn = open.turn.then(async () => {
      const name = "bop_read_" + (open.savepoints += 1);
      await open.own("SAVEPOINT " + name);
      try {
        const result = await work({ query: open.query });
        await open.own("RELEASE SAVEPOINT " + name);
        return result;
      } catch {
        // Its own failure only: the snapshot goes on as it was before the nested read.
        await open.own("ROLLBACK TO SAVEPOINT " + name).catch(() => (open.broken = true));
        open.forget();
        throw unavailable();
      }
    });
    open.turn = turn.catch(() => undefined);
    return turn;
  };
  return {
    async run(work) {
      const open = openSnapshots.getStore();
      if (
        open !== undefined &&
        open.active &&
        !open.broken &&
        open.database === resources.database &&
        open.scopeKey === scopeKey
      )
        return nested(open, work);
      const connection = await resources.database.acquire();
      let failed = false;
      const state = {
        active: true,
        broken: false,
        database: resources.database,
        scopeKey,
        savepoints: 0,
        turn: Promise.resolve(),
        own: (sql) => connection.query(sql),
        query: null,
        forget: () => undefined,
      };
      try {
        // WP-2423 M35: BEGIN, its limits and (review of the third step) the scope in one
        // simple-protocol round trip; the scope text only as the runner's checked UUIDs.
        const scopeText = inlineScope(resources.scope);
        await connection.query(
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; " +
            snapshotLimits +
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
          // WP-2423 (rush-connection-hold): a read past its answer time sends nothing more: it
          // answers "busy, try again" while the phone still listens (as the runner's reads do).
          const answerLeft = requestAnswerTimeLeftMs();
          if (answerLeft !== undefined && answerLeft <= 0) {
            noteRequestShed();
            throw unavailable();
          }
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
        state.query = query;
        state.forget = () => memo.forget();
        // The connection is held from here until it is given back (connection-hold): a second
        // one is never waited for while it is.
        const holding = resources.database.hold ?? ((held) => held());
        const result = await holding(() => openSnapshots.run(state, () => work({ query })));
        state.active = false;
        await state.turn;
        await connection.query("COMMIT");
        return result;
      } catch {
        failed = true;
        await connection.query("ROLLBACK").catch(() => undefined);
        throw unavailable();
      } finally {
        state.active = false;
        connection.release(failed);
      }
    },
  };
}
