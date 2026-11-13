import type { Pool, PoolClient } from "pg";
import {
  boundingRequestAcquireBudget,
  noteRequestFault,
  noteRequestShed,
  requestAnswerTimeLeftMs,
} from "./request-acquire-budget.js";
import { TenantContextDatabaseError, tenantContextDatabaseDiagnostic } from "./tenant-context.js";

/**
 * WP-2423 M68 (a), DEC-DATABASE-RESILIENCE (docs/spec/design/database-resilience.md): a request
 * that finds no database connection for a moment (every pooled connection in this process busy,
 * the role's connection limit reached, the database restarting) tries again with jitter before the
 * guest or staff member is told the system is busy. Each attempt waits in the pool's own queue
 * only for the pool's short per-attempt limit (`connectionTimeoutMillis`, which also bounds a new
 * connection's handshake), and attempts go on until the request's acquire budget is spent: 10 s in
 * an entry, inside the 15 s the phones and staff screens wait for an answer, leaving one
 * statement's 5 s limit for the work. A worker keeps one attempt's 2 s: it tries again on its next
 * cycle. Nothing has been sent while a connection is still being acquired, so a retry cannot
 * repeat work.
 */
export interface TenantConnectionAcquirePolicy {
  /** Total time for every attempt together, in milliseconds (the request's acquire budget). */
  readonly budgetMs: number;
  /** At most this many further attempts; the budget is the real bound. Default 20. */
  readonly retries?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** First pause before a retry; each further pause doubles up to the cap, with jitter 0.5–1.5×. */
export const tenantConnectionRetryBaseMs = 50;
export const tenantConnectionRetryCapMs = 800;
/** No retry is started with less than this left of the budget: it could not finish in time. */
export const tenantConnectionRetryMinimumMs = 100;
/** The longest acquire budget a request may be given (the clients' own 15 s answer limit). */
export const tenantConnectionAcquireBudgetMaxMs = 15_000;

/**
 * Failures that pass by themselves: the pool's own wait ran out, a socket was lost or refused, the
 * server is starting or shutting down (57P01–57P03), or too many connections are open (53300) or
 * the server is short of resources (53xxx). Configuration failures (bad password 28xxx, unknown
 * database 3D000) do not pass by waiting and are answered at once.
 */
const poolTimeoutMessages: ReadonlySet<string> = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
]);
export function isTransientConnectionAcquireFailure(error: unknown): boolean {
  try {
    const message =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "message")?.value
        : undefined;
    if (typeof message === "string" && poolTimeoutMessages.has(message)) return true;
    const state = tenantContextDatabaseDiagnostic(error).sqlState;
    if (state === null) return false;
    return (
      state.startsWith("08") ||
      state.startsWith("53") ||
      ["57P01", "57P02", "57P03"].includes(state)
    );
  } catch {
    return false;
  }
}

/** Set on an acquire failure whose last attempt met a full pool or too many connections. */
const rushCause = Symbol.for("bop.database.acquire-rush");
function isRushAcquireFailure(error: unknown): boolean {
  if (!(error instanceof TenantContextDatabaseError)) return false;
  return Object.getOwnPropertyDescriptor(error, rushCause)?.value === true;
}
function acquireFailed(error: unknown, rush: boolean): TenantContextDatabaseError {
  const failed = new TenantContextDatabaseError(
    "TENANT_DATABASE_ACQUIRE_FAILED",
    tenantContextDatabaseDiagnostic(error),
  );
  if (rush) Object.defineProperty(failed, rushCause, { value: true });
  return failed;
}

/**
 * b12 review: what the pool is doing, to tell the rush from a database that cannot be reached.
 * The pool's own counts include clients still connecting, so the clients it has handed out are
 * counted from its public `acquire` and `release` events (once per pool).
 */
interface PoolLoad {
  out: number;
  /**
   * WP-2423 (rush-reads-and-orders-changes): when a client last came back from its work without
   * an error (the database answered it). Null: never yet.
   */
  answeredAt: number | null;
}
/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): how recently the database must have
 * answered this pool's work for a wait that ran out to count as the rush. In a rush the database is
 * slow but answering: requests finish every moment, and a new connection's handshake or a queue
 * wait runs out only because everything is waiting. A database that hangs or cannot be reached
 * answers nothing, so within this window its failures are faults again.
 */
export const tenantConnectionAnsweringWindowMs = 5_000;
const poolLoads = new WeakMap<object, PoolLoad>();
type WatchedPool = Pick<Pool, "connect"> & {
  readonly on?: (event: string, listener: (error?: unknown) => void) => unknown;
  readonly totalCount?: unknown;
  /** The pool's own options (`max`: the most connections it may open). */
  readonly options?: unknown;
};
/**
 * Starts counting the clients this pool hands out. Called where the pool is made or first given
 * to a runner, before any client is taken, so the count is exact; the first acquire calls it too.
 */
export function watchTenantConnectionPool(pool: object): void {
  watchPoolLoad(pool as WatchedPool);
}
function watchPoolLoad(pool: WatchedPool): PoolLoad | undefined {
  try {
    const known = poolLoads.get(pool);
    if (known !== undefined) return known;
    if (typeof pool.on !== "function") return undefined;
    const load: PoolLoad = { out: 0, answeredAt: null };
    poolLoads.set(pool, load);
    pool.on("acquire", () => {
      load.out += 1;
    });
    pool.on("release", (error?: unknown) => {
      load.out = Math.max(0, load.out - 1);
      // A client returned without an error: its work was answered by the database.
      if (error === undefined || error === null || error === false) load.answeredAt = Date.now();
    });
    return load;
  } catch {
    return undefined;
  }
}
/**
 * The rush: every connection the pool may open is open and handed out to other work, so this
 * request waited in the pool's queue. Not the rush: a pool with free room or idle connections, or
 * one whose connections are still being opened (a database that hangs or cannot be reached).
 */
function poolFullOfWork(pool: WatchedPool, load: PoolLoad | undefined): boolean {
  try {
    const options = pool.options;
    const max =
      options !== null && typeof options === "object"
        ? (options as { readonly max?: unknown }).max
        : undefined;
    const total = pool.totalCount;
    return (
      load !== undefined &&
      typeof max === "number" &&
      typeof total === "number" &&
      max > 0 &&
      total >= max &&
      load.out >= max
    );
  } catch {
    return false;
  }
}
/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): the database is busy, not gone: other
 * work holds this pool's connections now, and the database answered some of it within the last
 * few seconds. Live, burst reads that found no connection were still logged as faults (level 50):
 * a slot freed in the rush was reopened, and the new connection's handshake to a database busy
 * with 57 others ran out ("Connection terminated due to connection timeout"), or the request's
 * wait ended while that slot was still opening, so the pool was not "full of work" at that moment.
 * A database that hangs or cannot be reached answers nothing, so it stays a fault.
 */
function poolBusyAndAnswering(load: PoolLoad | undefined, now: number): boolean {
  return (
    load !== undefined &&
    load.out > 0 &&
    load.answeredAt !== null &&
    now - load.answeredAt <= tenantConnectionAnsweringWindowMs
  );
}
/**
 * The rush, by the failed attempt: a wait ran out (the pool's own queue wait, or a new
 * connection's handshake) while the pool was full of work or the database was busy answering
 * other work, or the server has too many connections (53300). Every other failure is a fault: a
 * refusal, or a wait that ran out with nothing answered (the database host hung or unreachable).
 */
function isRushAttemptFailure(error: unknown, full: boolean, answering: boolean): boolean {
  try {
    const message =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "message")?.value
        : undefined;
    if (message === "timeout exceeded when trying to connect") return full || answering;
    if (message === "Connection terminated due to connection timeout") return answering;
    return tenantContextDatabaseDiagnostic(error).sqlState === "53300";
  } catch {
    return false;
  }
}

const outOfTime = Symbol("out of time");

export {
  endRequestAcquireBudget,
  noteRequestFault,
  noteRequestShed,
  noteRequestCommittedWrite,
  remainingRequestAcquireBudgetMs,
  requestAnswerTimeLeftMs,
  requestReadAnswerMs,
  requestAcquireBudgetWatchesWrites,
  runWithRequestAcquireBudget,
} from "./request-acquire-budget.js";

export async function acquireTenantConnection(
  pool: WatchedPool,
  policy: TenantConnectionAcquirePolicy,
): Promise<PoolClient> {
  const budget = policy.budgetMs;
  const retries = policy.retries ?? 20;
  if (
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > tenantConnectionAcquireBudgetMaxMs ||
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 50
  )
    throw new TenantContextDatabaseError("TENANT_DATABASE_SCOPE_INVALID");
  const now = policy.now ?? Date.now;
  const sleep =
    policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = policy.random ?? Math.random;
  const request = boundingRequestAcquireBudget();
  // A read past the time it may work in all, like one that waited all it may: busy, try again.
  const answerLeft = request === undefined ? undefined : requestAnswerTimeLeftMs();
  // The request has already waited all it may: busy, try again (nothing has been sent).
  if (request !== undefined && (request.remainingMs <= 0 || (answerLeft ?? 1) <= 0)) {
    noteRequestShed();
    throw new TenantContextDatabaseError(
      "TENANT_DATABASE_ACQUIRE_FAILED",
      Object.freeze({ sqlState: "08006", constraint: null, table: null, closed: false }),
    );
  }
  const startedAt = now();
  const deadline =
    startedAt +
    (request === undefined
      ? budget
      : Math.min(budget, request.remainingMs, answerLeft ?? Number.POSITIVE_INFINITY));
  try {
    return await acquireUntil(pool, watchPoolLoad(pool), deadline, retries, now, sleep, random);
  } catch (error) {
    // WP-2423 (reads-under-burst): every connection was busy with other work until the request's
    // wait ran out (the pool's own queue, or too many connections): the rush. Anything else (a
    // refusal, a database that hangs or cannot be reached) is a fault (b12 review).
    if (request !== undefined) {
      if (isRushAcquireFailure(error)) noteRequestShed();
      else noteRequestFault();
    }
    throw error;
  } finally {
    if (request !== undefined) request.remainingMs -= Math.max(0, now() - startedAt);
  }
}

async function acquireUntil(
  pool: WatchedPool,
  load: PoolLoad | undefined,
  deadline: number,
  retries: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): Promise<PoolClient> {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = pool.connect();
    try {
      const won = await Promise.race([
        pending,
        new Promise<typeof outOfTime>((resolve) => {
          timer = setTimeout(() => resolve(outOfTime), Math.max(remaining, 0));
        }),
      ]);
      if (won !== outOfTime) return won;
      // The budget ran out with this attempt still queued: a connection it gets later goes
      // straight back to the pool, and the request is answered "busy, try again" now.
      pending.then(
        (late) => late.release(),
        () => undefined,
      );
      const queued = new TenantContextDatabaseError(
        "TENANT_DATABASE_ACQUIRE_FAILED",
        Object.freeze({ sqlState: "08006", constraint: null, table: null, closed: false }),
      );
      // The rush only when the pool was full of other work or the database was answering it; a
      // connect that hangs with nothing answered is a fault.
      if (poolFullOfWork(pool, load) || poolBusyAndAnswering(load, Date.now()))
        Object.defineProperty(queued, rushCause, { value: true });
      throw queued;
    } catch (error) {
      if (error instanceof TenantContextDatabaseError) throw error;
      const step = Math.min(tenantConnectionRetryBaseMs * 2 ** attempt, tenantConnectionRetryCapMs);
      const pause = Math.round(step * (0.5 + random()));
      if (
        attempt >= retries ||
        !isTransientConnectionAcquireFailure(error) ||
        deadline - now() - pause < tenantConnectionRetryMinimumMs
      )
        throw acquireFailed(
          error,
          isRushAttemptFailure(
            error,
            poolFullOfWork(pool, load),
            poolBusyAndAnswering(load, Date.now()),
          ),
        );
      await sleep(pause);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
