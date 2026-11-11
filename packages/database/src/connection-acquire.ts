import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
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

function acquireFailed(error: unknown): TenantContextDatabaseError {
  return new TenantContextDatabaseError(
    "TENANT_DATABASE_ACQUIRE_FAILED",
    tenantContextDatabaseDiagnostic(error),
  );
}

const outOfTime = Symbol("out of time");

/**
 * WP-2423 (outage-reads-and-retry, v15 2026-11-11): the acquire budget is the request's, not each
 * acquire's. A guest's cart read takes several transactions one after another (the session, the
 * table's records, the cart, the menu facts); each could wait the whole 10 s, so in a rush the
 * slowest answers took 15-19 s, past the 15 s phones and staff screens wait, and the guest saw
 * "couldn't load" instead of "busy, try again". An HTTP entry runs each request inside
 * `runWithRequestAcquireBudget`: the time all its acquires spend waiting together is bounded, and
 * once it is spent the next acquire answers "busy" at once. Only waiting counts: a long command
 * whose connections come at once (listing a whole menu) is never cut short. The store is
 * process-wide (one per process, whichever copy of this module the entry and the API load).
 */
interface RequestAcquireBudget {
  remainingMs: number;
}
const requestBudgetKey = Symbol.for("bop.database.request-acquire-budget");
function requestBudgets(): AsyncLocalStorage<RequestAcquireBudget> {
  const holder = globalThis as { [requestBudgetKey]?: AsyncLocalStorage<RequestAcquireBudget> };
  holder[requestBudgetKey] ??= new AsyncLocalStorage<RequestAcquireBudget>();
  return holder[requestBudgetKey];
}
/** Runs `work` with every connection acquire in it sharing one waiting budget of `budgetMs`. */
export function runWithRequestAcquireBudget<T>(budgetMs: number, work: () => T): T {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) return work();
  const outer = requestBudgets().getStore();
  // A nested request (none today) never gets more than what is left of the outer one.
  if (outer !== undefined && outer.remainingMs <= budgetMs) return work();
  return requestBudgets().run({ remainingMs: budgetMs }, work);
}
/** What is left of the current request's acquire budget, or undefined outside a request. */
export function remainingRequestAcquireBudgetMs(): number | undefined {
  return requestBudgets().getStore()?.remainingMs;
}

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
  const request = requestBudgets().getStore();
  // The request has already waited all it may: busy, try again (nothing has been sent).
  if (request !== undefined && request.remainingMs <= 0)
    throw new TenantContextDatabaseError(
      "TENANT_DATABASE_ACQUIRE_FAILED",
      Object.freeze({ sqlState: "08006", constraint: null, table: null, closed: false }),
    );
  const startedAt = now();
  const deadline =
    startedAt + (request === undefined ? budget : Math.min(budget, request.remainingMs));
  try {
    return await acquireUntil(pool, deadline, retries, now, sleep, random);
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
      throw new TenantContextDatabaseError(
        "TENANT_DATABASE_ACQUIRE_FAILED",
        Object.freeze({ sqlState: "08006", constraint: null, table: null, closed: false }),
      );
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
