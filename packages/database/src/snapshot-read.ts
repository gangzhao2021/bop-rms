/**
 * WP-2423 (v15 2026-10-18, 55P03): staff screens poll lists (Orders, Home's count, the pickup
 * queue) every 15 s on several devices at once. Those reads reuse the owners' command readers,
 * which take each Order's disposition fence and lock its rows so a command's several statements
 * see one state. A list read therefore held every listed Order's fence and row locks until it
 * ended: reads queued behind each other and behind commands (9 lock timeouts, 1.5–2.9 s reads).
 *
 * A snapshot read runs in one REPEATABLE READ, READ ONLY transaction instead. Every statement sees
 * the same snapshot of every owner's tables, and each command commits all its owners' rows at
 * once, so the read never shows half of a command (no torn view between Ordering, Fulfillment,
 * Payment or Kitchen), without taking any lock a command or another read waits for:
 *
 * - an advisory transaction lock (`pg_advisory_xact_lock[_shared](hashtextextended(…,0))`) only
 *   orders writers; in a snapshot it is answered without a round trip;
 * - `LOCK TABLE … IN … MODE` likewise;
 * - a trailing row-locking clause (`FOR UPDATE`/`FOR NO KEY UPDATE`/`FOR SHARE`/`FOR KEY SHARE`,
 *   optionally `OF …`, `NOWAIT`, `SKIP LOCKED`) is removed: the row is read from the snapshot.
 *
 * Anything else runs unchanged; a write (or a row lock this cannot remove) fails the read with
 * 25006 instead of happening, so a snapshot read can never change data. Commands keep their
 * fences and row locks in ordinary transactions.
 */
export const snapshotReadBegin = "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY";

const advisoryLock =
  /^SELECT\s+pg_advisory_xact_lock(?:_shared)?\(\s*hashtextextended\(\s*[^()]*,\s*0\s*\)\s*\)\s*;?$/iu;
const tableLock =
  /^LOCK\s+TABLE\s+[a-z_][a-z0-9_.]*(?:\s*,\s*[a-z_][a-z0-9_.]*)*\s+IN\s+(?:ACCESS\s+SHARE|ROW\s+SHARE|ROW\s+EXCLUSIVE|SHARE\s+UPDATE\s+EXCLUSIVE|SHARE|SHARE\s+ROW\s+EXCLUSIVE|EXCLUSIVE|ACCESS\s+EXCLUSIVE)\s+MODE\s*;?$/iu;
const rowLock =
  /\s+FOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)(?:\s+OF\s+[a-z_][a-z0-9_.]*(?:\s*,\s*[a-z_][a-z0-9_.]*)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\s*;?\s*$/iu;

export type SnapshotReadStatement =
  | { readonly kind: "Answer"; readonly result: object }
  | { readonly kind: "Run"; readonly sql: string };

/** What a snapshot read does with one statement: answer it locally, or run (a rewrite of) it. */
export function snapshotReadStatement(sql: string): SnapshotReadStatement {
  const text = sql.trim();
  if (advisoryLock.test(text)) {
    const column = /pg_advisory_xact_lock_shared/iu.test(text)
      ? "pg_advisory_xact_lock_shared"
      : "pg_advisory_xact_lock";
    return {
      kind: "Answer",
      result: Object.freeze({
        command: "SELECT",
        rowCount: 1,
        rows: [Object.freeze({ [column]: "" })],
        fields: [],
      }),
    };
  }
  if (tableLock.test(text))
    return {
      kind: "Answer",
      result: Object.freeze({ command: "LOCK", rowCount: null, rows: [], fields: [] }),
    };
  // Only a single SELECT statement's own trailing clause; anything else runs as written.
  if (/^(?:SELECT|WITH)\b/iu.test(text) && !text.replace(/;\s*$/u, "").includes(";"))
    return { kind: "Run", sql: text.replace(rowLock, "") };
  return { kind: "Run", sql };
}
