import { AsyncLocalStorage } from "node:async_hooks";

/**
 * WP-2423 (outage-reads-and-retry, v15 2026-11-11): every request answered here shares one
 * database-connection waiting budget across all its transactions, so in a rush a guest or staff
 * screen is told "busy, try again" (503 with Retry-After) within the 15 s it waits, instead of the
 * request running past it. The budget itself is kept and spent by the connection acquire in
 * packages/database/src/connection-acquire.ts (`runWithRequestAcquireBudget`); this is the same
 * process-wide store under the same key, because the API does not depend on that package.
 */
export const requestAcquireBudgetMs = 10_000;
/** The shape packages/database/src/request-acquire-budget.ts keeps and spends (shared store). */
interface RequestAcquireBudget {
  remainingMs: number;
  readonly startedAt: number;
  ended: boolean;
  committedWrite: boolean;
}
const requestBudgetKey = Symbol.for("bop.database.request-acquire-budget");
function requestBudgets(): AsyncLocalStorage<RequestAcquireBudget> {
  const holder = globalThis as { [requestBudgetKey]?: AsyncLocalStorage<RequestAcquireBudget> };
  holder[requestBudgetKey] ??= new AsyncLocalStorage<RequestAcquireBudget>();
  return holder[requestBudgetKey];
}
/**
 * Runs one request's handling inside its own waiting budget (an outer one is kept). Once its
 * response has finished or closed, what the request started and still runs (a timer, a
 * follow-through) is no longer bounded by it (WP-2423 outage-reads-and-retry review).
 */
export function withRequestAcquireBudget<T>(
  work: () => T,
  options: {
    readonly response?: { once(event: "finish" | "close", listener: () => void): unknown };
    readonly budgetMs?: number;
  } = {},
): T {
  if (requestBudgets().getStore() !== undefined) return work();
  const budget: RequestAcquireBudget = {
    remainingMs: options.budgetMs ?? requestAcquireBudgetMs,
    startedAt: Date.now(),
    ended: false,
    committedWrite: false,
  };
  const end = () => {
    budget.ended = true;
  };
  options.response?.once("finish", end);
  options.response?.once("close", end);
  return requestBudgets().run(budget, work);
}
