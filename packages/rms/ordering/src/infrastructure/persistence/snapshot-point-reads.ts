import type { ConsumerTransaction } from "@bop/eventing";

/**
 * Batch 37 (v15 b36, merchant Home ~2 s): a list read (the merchant Orders list) runs each listed
 * Order's owner readers one after another. Each reader sends its own point reads ("this Order's
 * acceptance", "this Order's termination", ...), ~17 statements an Order, ~1,600 for one Orders
 * page on v15; Home waited for it.
 *
 * In a read-only REPEATABLE READ snapshot every statement sees the same rows, so the rows a point
 * read would return for each listed key can be read for all keys at once and each point read
 * answered from them. The readers are unchanged: they send the same statements and check the same
 * answers. Only statements registered here, whose text matches exactly (a trailing row-locking
 * clause aside: a snapshot read takes no row locks), whose fixed values match and whose key is one
 * of the listed keys, are answered; every other statement runs as before. A batch read that
 * returns more rows than it may (`maximumRows`) answers nothing (its point reads run as before).
 *
 * Only for a read-only snapshot transaction; never across transactions.
 */
export interface SnapshotPointRead {
  /** The point read exactly as its owner sends it, without a trailing row-locking clause. */
  readonly statement: string;
  /** The key of one point read from its values; null when this prefetch does not answer it. */
  key(values: readonly unknown[]): string | null;
  /** All keys' rows in one statement; each row's key in `keyColumns`, then the point read's columns. */
  readonly batchStatement: string;
  batchValues(keys: readonly string[]): readonly unknown[];
  /** The batch row's columns that make its key (removed from the answer), joined with "|". */
  readonly keyColumns: readonly string[];
  /** The point read's own LIMIT (rows per key, in the batch's order); null when it has none. */
  readonly limit: number | null;
  /** The batch statement's own LIMIT: an answer of this many rows or more answers nothing. */
  readonly maximumRows: number;
  /**
   * The same point read is sent again for a key (an owner reads it twice): every answer is then a
   * copy of the batch's rows. Otherwise a key is answered once and a repeat runs as before.
   */
  readonly repeated?: boolean;
  /**
   * The keys answered are those the batch returned rows for (the keys asked for only select the
   * rows, as the Orders a ticket belongs to); any other key's point read runs as before.
   */
  readonly keysFromRows?: boolean;
}

const rowLockingClause =
  /\s+FOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)(?:\s+OF\s+[a-z_][a-z0-9_.]*(?:\s*,\s*[a-z_][a-z0-9_.]*)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\s*;?\s*$/iu;
const canonicalReference = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A key value the batch reads by text (`::text` of a uuid): only a canonical lower-case uuid. */
export function pointReadReference(value: unknown): string | null {
  return typeof value === "string" && canonicalReference.test(value) ? value : null;
}

/**
 * A snapshot transaction answering the registered point reads for `keys[i]` of `reads[i]` from one
 * batch read each (read when the first of its point reads arrives).
 */
export function createSnapshotPointReads(
  transaction: ConsumerTransaction,
  entries: readonly { readonly read: SnapshotPointRead; keys(): Promise<readonly string[]> }[],
): ConsumerTransaction {
  const states = entries.map((entry) => ({
    entry,
    loaded: null as Promise<Map<string, Record<string, unknown>[]> | null> | null,
  }));
  const load = (state: (typeof states)[number]) =>
    (state.loaded ??= (async () => {
      const keys = [...new Set(await state.entry.keys())].sort();
      const read = state.entry.read;
      const byKey = new Map<string, Record<string, unknown>[]>(
        read.keysFromRows === true ? [] : keys.map((key) => [key, []]),
      );
      if (keys.length === 0) return byKey;
      const result = await transaction.query(read.batchStatement, read.batchValues(keys));
      if (!Array.isArray(result.rows) || result.rows.length >= read.maximumRows) return null;
      for (const row of result.rows as readonly Record<string, unknown>[]) {
        const key = read.keyColumns.map((column) => String(row[column])).join("|");
        if (read.keysFromRows === true && !byKey.has(key)) byKey.set(key, []);
        const rows = byKey.get(key);
        // A row of a key not listed (another Batch of a listed Order): not asked for here.
        if (rows === undefined) continue;
        const answer: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row))
          if (!read.keyColumns.includes(column)) answer[column] = value;
        if (read.limit === null || rows.length < read.limit) rows.push(answer);
      }
      return byKey;
    })());
  return Object.freeze({
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]) {
      if (typeof text === "string" && Array.isArray(values)) {
        const statement = text.trim().replace(rowLockingClause, "");
        for (const state of states) {
          const read = state.entry.read;
          if (statement !== read.statement) continue;
          const key = read.key(values);
          if (key === null) break;
          const rows = (await load(state))?.get(key);
          if (rows === undefined) break;
          // Each answer's rows are the caller's own: a copy when the read is repeated, else the
          // key is answered once and the same point read sent again runs as before.
          const answer = read.repeated === true ? structuredClone(rows) : rows;
          if (read.repeated !== true) (await load(state))?.delete(key);
          return { rows: answer as unknown as readonly Row[], rowCount: answer.length };
        }
      }
      return transaction.query<Row>(text, values);
    },
  });
}
