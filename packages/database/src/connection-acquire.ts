import type { Pool, PoolClient } from "pg";
import { TenantContextDatabaseError, tenantContextDatabaseDiagnostic } from "./tenant-context.js";

/**
 * WP-2423 M68 (a), DEC-DATABASE-RESILIENCE (docs/spec/design/database-resilience.md): a request
 * that finds no database connection for a moment (every pooled connection busy, the role's
 * connection limit reached, the database restarting) tries again a few times with jitter before
 * the guest or staff member is told the system is busy. Every attempt stays inside the one
 * acquire budget the pool already gives a request (`connectionTimeoutMillis`: 5 s for entries,
 * 2 s for workers), so the request deadline is unchanged and a stuck database still fails fast.
 * Nothing has been sent when a connection is still being acquired, so a retry cannot repeat work.
 */
export interface TenantConnectionAcquirePolicy {
  /** Total time for every attempt together, in milliseconds (the pool's acquire limit). */
  readonly budgetMs: number;
  /** Further attempts after the first; default 3. */
  readonly retries?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** First pause before a retry; each further pause doubles, with jitter of 0.5–1.5×. */
export const tenantConnectionRetryBaseMs = 50;
/** No retry is started with less than this left of the budget: it could not finish in time. */
export const tenantConnectionRetryMinimumMs = 100;

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

export async function acquireTenantConnection(
  pool: Pick<Pool, "connect">,
  policy: TenantConnectionAcquirePolicy,
): Promise<PoolClient> {
  const budget = policy.budgetMs;
  const retries = policy.retries ?? 3;
  if (
    !Number.isInteger(budget) ||
    budget < 1 ||
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 5
  )
    throw new TenantContextDatabaseError("TENANT_DATABASE_SCOPE_INVALID");
  const now = policy.now ?? Date.now;
  const sleep =
    policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = policy.random ?? Math.random;
  const deadline = now() + budget;
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
      const pause = Math.round(tenantConnectionRetryBaseMs * 2 ** attempt * (0.5 + random()));
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
