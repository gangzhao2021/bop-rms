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
interface RequestAcquireBudget {
  remainingMs: number;
}
const requestBudgetKey = Symbol.for("bop.database.request-acquire-budget");
function requestBudgets(): AsyncLocalStorage<RequestAcquireBudget> {
  const holder = globalThis as { [requestBudgetKey]?: AsyncLocalStorage<RequestAcquireBudget> };
  holder[requestBudgetKey] ??= new AsyncLocalStorage<RequestAcquireBudget>();
  return holder[requestBudgetKey];
}
/** Runs one request's handling inside its own waiting budget (an outer one is kept). */
export function withRequestAcquireBudget<T>(work: () => T, budgetMs = requestAcquireBudgetMs): T {
  if (requestBudgets().getStore() !== undefined) return work();
  return requestBudgets().run({ remainingMs: budgetMs }, work);
}
