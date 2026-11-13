import type { Pool, PoolClient } from "pg";
import {
  boundingRequestAcquireBudget,
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
/** The request's wait ran out with its attempt still queued (no free connection in time). */
const queuedOutOfTime = Symbol.for("bop.database.acquire-queued-out-of-time");
function isRushAcquireFailure(error: unknown): boolean {
  if (!(error instanceof TenantContextDatabaseError)) return false;
  if (Object.getOwnPropertyDescriptor(error, queuedOutOfTime)?.value === true) return true;
  return Object.getOwnPropertyDescriptor(error, rushCause)?.value === true;
}
function acquireFailed(error: unknown): TenantContextDatabaseError {
  const failed = new TenantContextDatabaseError(
    "TENANT_DATABASE_ACQUIRE_FAILED",
    tenantContextDatabaseDiagnostic(error),
  );
  if (isPoolFull(error)) Object.defineProperty(failed, rushCause, { value: true });
  return failed;
}
/** The pool's own wait ran out, or the server has too many connections (53300). */
function isPoolFull(error: unknown): boolean {
  try {
    const message =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "message")?.value
        : undefined;
    if (typeof message === "string" && poolTimeoutMessages.has(message)) return true;
    return tenantContextDatabaseDiagnostic(error).sqlState === "53300";
  } catch {
    return false;
  }
}

const outOfTime = Symbol("out of time");

export {
  endRequestAcquireBudget,
  noteRequestShed,
  noteRequestCommittedWrite,
  remainingRequestAcquireBudgetMs,
  requestAnswerTimeLeftMs,
  requestReadAnswerMs,
  requestAcquireBudgetWatchesWrites,
  runWithRequestAcquireBudget,
} from "./request-acquire-budget.js";

export async function acquireTenantConnection(
  pool: Pick<Pool, "connect">,
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
    return await acquireUntil(pool, deadline, retries, now, sleep, random);
  } catch (error) {
    // WP-2423 (reads-under-burst): every connection was busy until the request's wait ran out
    // (the pool's own queue, or too many connections): the rush, not a fault.
    if (request !== undefined && isRushAcquireFailure(error)) noteRequestShed();
    throw error;
  } finally {
    if (request !== undefined) request.remainingMs -= Math.max(0, now() - startedAt);
  }
}

async function acquireUntil(
  pool: Pick<Pool, "connect">,
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
      Object.defineProperty(queued, queuedOutOfTime, { value: true });
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
        throw acquireFailed(error);
      await sleep(pause);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
