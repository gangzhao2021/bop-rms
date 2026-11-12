import { AsyncLocalStorage } from "node:async_hooks";

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-SPEED, third step): one staff round runs its table guest through
 * about thirty owner checks (the guest's session, its table place, the table, the Brand and Store),
 * each one the same owner-marked stable reads (`-- bop:stable-read`) in a transaction of its own.
 * Inside one request those checks are answered from the check this request already made, up to
 * the write fences:
 *
 * - Only owner-marked stable reads, only in a read-write transaction that has not yet written,
 *   taken a lock or called an owner function (a "clean" transaction), and only within one
 *   request's scope (`withVerifiedChecks`), never across requests or for snapshot reads.
 * - Before such a transaction sends its first statement that may write or lock (its write fence),
 *   every read it was answered from here is sent again for real, in order and under its own scope,
 *   and must return the same rows; otherwise the transaction fails as a retryable conflict (and
 *   the fresh rows replace the remembered ones). So a transaction that writes decides on facts
 *   current under its own locks, exactly as before; only read-only checks are answered from
 *   earlier in the same request.
 * - Any statement of the request that may write forgets what it remembered of the schemas it
 *   names (all of it when it names none), so the request never reads its own writes stale.
 * - An answer is at most `maxAgeMs` old (default 10 s).
 */
export interface RequestCheckMemo {
  answer(key: string): object | null;
  record(key: string, sql: string, result: unknown): void;
  /** A statement that may write ran (or was sent): forget what it may have changed. */
  wrote(sql: string): void;
}

const ownerSchema = /\b((?:bop|rms|platform)_[a-z0-9_]+|security)\s*\.\s*"?[a-z_]/giu;

/** The owner schemas a statement names, or null when it names none. */
export function statementSchemas(sql: string): ReadonlySet<string> | null {
  const found = new Set<string>();
  for (const match of sql.matchAll(ownerSchema)) found.add((match[1] ?? "").toLowerCase());
  return found.size === 0 ? null : found;
}

const copyResult = (result: unknown): object => {
  const value = result as { rows?: unknown };
  return Object.freeze({
    ...(result as object),
    rows: Array.isArray(value.rows)
      ? value.rows.map((row: unknown) =>
          row !== null && typeof row === "object" ? { ...(row as object) } : row,
        )
      : value.rows,
  });
};

export function createRequestCheckMemo(
  options: { readonly maxAgeMs?: number; readonly now?: () => number } = {},
): RequestCheckMemo {
  const maxAgeMs = options.maxAgeMs ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { readonly result: object; readonly at: number; readonly schemas: ReadonlySet<string> | null }
  >();
  return Object.freeze({
    answer(key: string) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (now() - entry.at > maxAgeMs) {
        entries.delete(key);
        return null;
      }
      return copyResult(entry.result);
    },
    record(key: string, sql: string, result: unknown) {
      if (result === null || typeof result !== "object") return;
      entries.set(key, { result: copyResult(result), at: now(), schemas: statementSchemas(sql) });
    },
    wrote(sql: string) {
      const written = statementSchemas(sql);
      if (written === null) return entries.clear();
      for (const [key, entry] of entries)
        if (entry.schemas === null || [...entry.schemas].some((schema) => written.has(schema)))
          entries.delete(key);
    },
  });
}

// One store for every copy of this module in the process (the pilot loads the built runner while
// some compositions load the source), as runTogether's.
const storeKey = Symbol.for("bop.database.verifiedChecks");
const store: AsyncLocalStorage<RequestCheckMemo> = ((globalThis as Record<symbol, unknown>)[
  storeKey
] ??= new AsyncLocalStorage<RequestCheckMemo>()) as AsyncLocalStorage<RequestCheckMemo>;

/** The current request's check memo, or undefined outside `withVerifiedChecks`. */
export function currentRequestChecks(): RequestCheckMemo | undefined {
  return store.getStore();
}

/**
 * Runs one request's `work` so that its owner checks are answered from the check it already made,
 * up to each transaction's write fence (see RequestCheckMemo). A call inside another keeps the
 * outer request's memo.
 */
export function withVerifiedChecks<T>(
  work: () => Promise<T>,
  options: { readonly maxAgeMs?: number; readonly now?: () => number } = {},
): Promise<T> {
  if (store.getStore() !== undefined) return work();
  return store.run(createRequestCheckMemo(options), work);
}
