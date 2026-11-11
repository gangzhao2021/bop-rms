import { AsyncLocalStorage } from "node:async_hooks";

/** The longest a phone or staff screen waits for an answer (connection-acquire's budget cap). */
export const requestAnswerWindowMs = 15_000;

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
/**
 * WP-2423 (outage-reads-and-retry review) — the budget bounds only the waits that decide whether
 * the answer comes in time, and never stops a command half way:
 *  - once a transaction of the request has committed a write (`committedWrite`), its later
 *    acquires wait their own full budget as before, so a command that began changing things
 *    finishes slowly rather than stopping after some of its transactions committed;
 *  - work that outlives the answer (the response finished, `ended`), or runs past the 15 s the
 *    clients wait (`startedAt`: a stream's revalidation timer, a follow-through started inside the
 *    request), is no longer bounded by it either.
 * The same shape is kept by apps/api/src/request-acquire-budget.ts (the store is shared).
 */
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
/** The current request's budget while it still bounds acquires (see RequestAcquireBudget). */
export function boundingRequestAcquireBudget(): RequestAcquireBudget | undefined {
  const budget = requestBudgets().getStore();
  if (
    budget === undefined ||
    budget.ended === true ||
    budget.committedWrite === true ||
    !(Date.now() - budget.startedAt < requestAnswerWindowMs)
  )
    return undefined;
  return budget;
}
/** Runs `work` with every connection acquire in it sharing one waiting budget of `budgetMs`. */
export function runWithRequestAcquireBudget<T>(budgetMs: number, work: () => T): T {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) return work();
  const outer = boundingRequestAcquireBudget();
  // A nested request (none today) never gets more than what is left of the outer one.
  if (outer !== undefined && outer.remainingMs <= budgetMs) return work();
  return requestBudgets().run(
    { remainingMs: budgetMs, startedAt: Date.now(), ended: false, committedWrite: false },
    work,
  );
}
/** What is left of the current request's acquire budget, or undefined when none bounds it. */
export function remainingRequestAcquireBudgetMs(): number | undefined {
  return boundingRequestAcquireBudget()?.remainingMs;
}
/** The answer was sent: what the request started and still runs waits its own budgets. */
export function endRequestAcquireBudget(): void {
  const budget = requestBudgets().getStore();
  if (budget !== undefined) budget.ended = true;
}
/** True while a transaction must say whether it wrote (a request budget still bounds acquires). */
export function requestAcquireBudgetWatchesWrites(): boolean {
  return boundingRequestAcquireBudget() !== undefined;
}
/** A transaction of this request committed a write: its later acquires wait their full budget. */
export function noteRequestCommittedWrite(): void {
  const budget = requestBudgets().getStore();
  if (budget !== undefined) budget.committedWrite = true;
}
