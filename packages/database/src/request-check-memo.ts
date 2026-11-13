import { AsyncLocalStorage } from "node:async_hooks";
import { withoutRowLock } from "./transaction-statement-memo.js";

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
 * - A stable row-locking read that is not answered from here is a write fence of its own, so row
 *   locks are taken in the order the code asks for them (review of the third step).
 * - When a read answered from here comes back different at the fence, the transaction has written
 *   and locked nothing; it runs once more as an ordinary transaction (every read sent for real),
 *   unless something else in the request wrote since it began (then the retryable conflict
 *   stands), so staff are never refused because another phone changed the table mid-request.
 * - A read-only transaction is never sent again: what it answered from here is at most as old as
 *   this request's first read of it (and at most `maxAgeMs`, default 3 s, above the 2 s staff round
 *   budget). Every such answer must be read again for real (with or without a row lock) before
 *   the request's next write (`unverifiedChecks`, which the staff round acceptance holds empty),
 *   so no decision that reaches a write rests on it alone.
 */
export interface RequestCheckMemo {
  answer(key: string): object | null;
  record(key: string, sql: string, result: unknown): void;
  /** A statement that may write ran (or was sent): forget what it may have changed. */
  wrote(sql: string): void;
  /** How many statements that may write the request has sent so far. */
  writes(): number;
  /**
   * The fact was read for real (sent, or sent again at a fence), with or without a row lock and
   * under whichever scope settings: a later read of it is the fresh one.
   */
  reread(sql: string, values: readonly unknown[]): void;
  /** A transaction ended having answered these checks from here, never sending them again. */
  unverified(reads: readonly { readonly sql: string; readonly values: readonly unknown[] }[]): void;
  /**
   * The checks a read-only transaction answered from earlier in the request that a later write of
   * the request followed before any transaction read them again for real (the statement's first
   * line each): a decision that reached a write may have rested on the older answer. A check read
   * only after the request's last write feeds no write of it and is not listed.
   */
  unverifiedChecks(): readonly string[];
}

const ownerSchema = /\b((?:bop|rms|platform)_[a-z0-9_]+|security)\s*\.\s*"?[a-z_]/giu;

/** The owner schemas a statement names, or null when it names none. */
export function statementSchemas(sql: string): ReadonlySet<string> | null {
  const found = new Set<string>();
  for (const match of sql.matchAll(ownerSchema)) found.add((match[1] ?? "").toLowerCase());
  return found.size === 0 ? null : found;
}

/** A fact read: its statement without a trailing row-locking clause, and its values. */
function factOf(sql: string, values: readonly unknown[]): string {
  return JSON.stringify([withoutRowLock(sql), values]);
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
  const maxAgeMs = options.maxAgeMs ?? 3_000;
  let written = 0;
  /** Answered by a read-only transaction, not read for real since. */
  const open = new Map<string, string>();
  /** ...and then a write of the request came: it may have rested on the older answer. */
  const reachedWrite = new Set<string>();
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
      written += 1;
      for (const line of open.values()) reachedWrite.add(line);
      open.clear();
      const schemas = statementSchemas(sql);
      if (schemas === null) return entries.clear();
      for (const [key, entry] of entries)
        if (entry.schemas === null || [...entry.schemas].some((schema) => schemas.has(schema)))
          entries.delete(key);
    },
    writes: () => written,
    reread(sql: string, values: readonly unknown[]) {
      if (open.size > 0) open.delete(factOf(sql, values));
    },
    unverified(reads: readonly { readonly sql: string; readonly values: readonly unknown[] }[]) {
      for (const read of reads)
        open.set(
          factOf(read.sql, read.values),
          (read.sql.trim().split("\n")[0] ?? "").replace(/\s+/gu, " ").slice(0, 120),
        );
    },
    unverifiedChecks: () => Object.freeze([...reachedWrite]),
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
