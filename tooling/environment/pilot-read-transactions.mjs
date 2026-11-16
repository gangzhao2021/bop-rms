import { AsyncLocalStorage } from "node:async_hooks";
import {
  createTransactionStatementMemo,
  deepCopiedAnswer as copied,
  snapshotModeRead,
  snapshotStableRead,
  stableReadStatement,
} from "../../packages/database/dist/transaction-statement-memo.js";
import {
  tenantContextScopeSettingsStatement,
  tenantContextScopeStatement,
} from "../../packages/database/dist/tenant-context.js";
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

/**
 * WP-2423 M35 (staff round round trips): the snapshot is begun REPEATABLE READ, READ ONLY, and a
 * read-only REPEATABLE READ transaction can change neither once it has run a statement (its BEGIN
 * runs one): an owner's read of that mode is answered as the database would answer it.
 */
const snapshotMode = { transaction_isolation: "repeatable read", transaction_read_only: "on" };
function snapshotModeAnswer(sql) {
  const row = {};
  for (const match of sql.matchAll(
    /current_setting\('(transaction_isolation|transaction_read_only)'\)(?:\s+AS)?\s+([a-z_]+)/giu,
  ))
    row[match[2].toLowerCase()] = snapshotMode[match[1].toLowerCase()];
  return Object.freeze({ command: "SELECT", rowCount: 1, rows: [row], fields: [] });
}
/**
 * The scope settings a statement would be sent after, written into BEGIN's text (only the checked
 * UUID or empty values `tenantContextScopeSettingsStatement` accepts), or null to send them alone.
 */
function foldedSettings(settings) {
  if (settings === null) return null;
  const pairs = [];
  for (const match of settings.sql.matchAll(/set_config\('([a-z_.]+)',\$(\d+),true\)/gu))
    pairs.push([match[1], settings.values[Number(match[2]) - 1]]);
  if (pairs.length !== settings.values.length) return null;
  try {
    return tenantContextScopeSettingsStatement(pairs);
  } catch {
    return null;
  }
}

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
      // WP-2423 (logs-and-transaction-time): the savepoint is taken only once the nested read
      // sends a statement (one answered wholly from this snapshot's memo sends none), and it is
      // not released: COMMIT ends it with the snapshot, and nothing in a read-only snapshot needs
      // it gone sooner. Each was two more turns of a busy process with the snapshot open.
      let taken = false;
      open.beforeSend = async () => {
        open.beforeSend = null;
        await open.own("SAVEPOINT " + name);
        taken = true;
      };
      try {
        return await work({ query: open.query });
      } catch {
        // Its own failure only: the snapshot goes on as it was before the nested read.
        if (taken)
          await open.own("ROLLBACK TO SAVEPOINT " + name).catch(() => (open.broken = true));
        else if (open.beforeSend === null) open.broken = true;
        open.forget();
        throw unavailable();
      } finally {
        open.beforeSend = null;
      }
    });
    open.turn = turn.catch(() => undefined);
    return turn;
  };
  /** The open snapshot of this database and Store a read made now would run in, if any. */
  const joinable = () => {
    const open = openSnapshots.getStore();
    return open !== undefined &&
      open.active &&
      !open.broken &&
      open.database === resources.database &&
      open.scopeKey === scopeKey
      ? open
      : undefined;
  };
  const reads = {
    async run(work) {
      const open = joinable();
      if (open !== undefined) return nested(open, work);
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
        /** A nested read's savepoint, taken before the first statement it sends. */
        beforeSend: null,
        query: null,
        forget: () => undefined,
      };
      // WP-2423 M35 (staff round round trips): the snapshot begins with the first statement that
      // must reach the database, not before: a read answered wholly here sends nothing, and the
      // scope settings that statement runs under go with BEGIN (each dish's menu read, for one,
      // begins by leaving the Store scope for the Brand's rows: one round trip less a snapshot).
      let opening = null;
      try {
        // WP-2423 M35 (DEC-STAFF-ROUND-SPEED): as the pilot's transaction runner does, a scope
        // setting is sent only with the next statement that runs (and only when it changes it), and
        // an owner's stable read repeated in this one snapshot is answered from its first answer.
        const memo = createTransactionStatementMemo({
          "bop.brand_id": resources.scope.brandReference,
          "bop.store_id": resources.scope.storeReference,
        });
        /**
         * Begins the snapshot (once). `settings`: the scope settings the first statement is sent
         * after; returned when they still have to be sent, null when they went with BEGIN.
         */
        const open = async (settings) => {
          if (opening !== null) {
            await opening;
            return settings;
          }
          // WP-2423 M35: BEGIN, its limits and (review of the third step) the scope in one
          // simple-protocol round trip; the scope text only as the runner's checked UUIDs.
          const scopeText = inlineScope(resources.scope);
          const folded = scopeText === null ? null : foldedSettings(settings);
          opening = (async () => {
            await connection.query(
              "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; " +
                snapshotLimits +
                (scopeText === null ? "" : "; " + scopeText) +
                (folded === null ? "" : "; " + folded),
            );
            if (scopeText === null)
              await connection.query(
                "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
                [resources.scope.brandReference, resources.scope.storeReference],
              );
          })();
          await opening;
          if (folded === null) return settings;
          memo.observe(settings.sql, settings.values);
          return null;
        };
        state.own = async (sql) => {
          await open(null);
          return connection.query(sql);
        };
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
          if (snapshotModeRead(marked.sql, values ?? []))
            return snapshotModeAnswer(marked.sql.trim());
          const stable = snapshotStableRead(marked.sql, values ?? [], marked.stable);
          let settings = null;
          if (pending === 0) {
            const planned = memo.plan(marked.sql, values ?? [], stable);
            if (planned.kind === "Answer") return stable ? copied(planned.result) : planned.result;
            settings = planned.settings;
          }
          pending += 1;
          try {
            // A nested read's settings are sent after its savepoint, never with BEGIN: rolled back
            // to that savepoint, the snapshot keeps the scope it had before the nested read.
            if (opening === null) {
              if (state.beforeSend === null) settings = await open(settings);
              else await open(null);
            }
            if (state.beforeSend !== null) await state.beforeSend();
            if (settings !== null) {
              await connection.query(settings.sql, [...settings.values]);
              memo.observe(settings.sql, settings.values);
            }
            const result = await connection.query(marked.sql, [...(values ?? [])]);
            memo.observe(marked.sql, values ?? [], result, stable);
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
        // A snapshot that sent nothing was never begun: there is nothing to end.
        if (opening !== null) {
          await opening;
          await connection.query("COMMIT");
        }
        return result;
      } catch {
        failed = true;
        if (opening !== null) await connection.query("ROLLBACK").catch(() => undefined);
        throw unavailable();
      } finally {
        state.active = false;
        connection.release(failed);
      }
    },
    /**
     * WP-2423 M35 (staff round round trips): `work`'s reads in one snapshot (each in its own
     * savepoint, as any read made inside an open snapshot), instead of a snapshot each; inside an
     * open snapshot it runs in that one. `work` answers and fails as it would on its own: a read
     * that failed fails it with that read's error, never with the snapshot's.
     */
    async together(work) {
      if (joinable() !== undefined) return work();
      let outcome = null;
      await reads.run(async () => {
        try {
          outcome = { value: await work() };
        } catch (error) {
          outcome = { error };
        }
      });
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    },
  };
  return reads;
}
