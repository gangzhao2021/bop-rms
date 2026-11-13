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
  /**
   * WP-2423 (guest-table-open-and-busy-reads, v15 2026-11-12): for a read (GET/HEAD), the instant
   * by which its database work must be done. The waiting budget alone let a burst read wait 10 s
   * and then work 7-13 s more (cart, menu and staff answers 17-23 s, past the 15 s the clients
   * wait). Past it no further connection is taken and no further statement is sent, so the read
   * answers "busy, try again" while the phone or screen still listens. A command has none: its
   * work is never cut by the clock, only its waiting.
   */
  readonly answerBy?: number;
  /**
   * WP-2423 (reads-under-burst, v15 2026-11-13): this request was turned away by the rush itself
   * (no connection within its wait, or its answer time ran out), not by a fault. Its busy answer is
   * logged as a wait (level 40, HTTP_RETRY_LATER), and it is never read again inside the request.
   */
  shed?: boolean;
  /**
   * WP-2423 (reads-under-burst): a read already answered "busy" (its whole answer time ran out) or
   * whose phone or screen went away before it was answered. Nothing more of it reaches the
   * database: no connection is taken and no statement sent, so an abandoned read stops adding to
   * the rush. A command is never cut.
   */
  cut?: boolean;
}
/** How long a read may work in all before it answers busy (inside the clients' 15 s). */
export const requestReadAnswerMs = 12_000;
const requestBudgetKey = Symbol.for("bop.database.request-acquire-budget");
function requestBudgets(): AsyncLocalStorage<RequestAcquireBudget> {
  const holder = globalThis as { [requestBudgetKey]?: AsyncLocalStorage<RequestAcquireBudget> };
  holder[requestBudgetKey] ??= new AsyncLocalStorage<RequestAcquireBudget>();
  return holder[requestBudgetKey];
}
/** The current request's budget while it still bounds acquires (see RequestAcquireBudget). */
export function boundingRequestAcquireBudget(): RequestAcquireBudget | undefined {
  const budget = requestBudgets().getStore();
  if (budget?.cut === true && budget.answerBy !== undefined && budget.committedWrite !== true)
    return budget;
  if (
    budget === undefined ||
    budget.ended === true ||
    budget.committedWrite === true ||
    !(Date.now() - budget.startedAt < requestAnswerWindowMs)
  )
    return undefined;
  return budget;
}
/**
 * Runs `work` with every connection acquire in it sharing one waiting budget of `budgetMs`; a read
 * also passes `answerWithinMs`, the time its database work may take in all (see `answerBy`).
 */
export function runWithRequestAcquireBudget<T>(
  budgetMs: number,
  work: () => T,
  options: { readonly answerWithinMs?: number } = {},
): T {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) return work();
  const outer = boundingRequestAcquireBudget();
  // A nested request (none today) never gets more than what is left of the outer one.
  if (outer !== undefined && outer.remainingMs <= budgetMs) return work();
  const startedAt = Date.now();
  const within = options.answerWithinMs;
  return requestBudgets().run(
    {
      remainingMs: budgetMs,
      startedAt,
      ended: false,
      committedWrite: false,
      ...(within !== undefined && Number.isFinite(within) && within >= 0
        ? { answerBy: startedAt + within }
        : {}),
    },
    work,
  );
}
/**
 * For a read still bounded by its request: the milliseconds left before it must answer (zero or
 * less once the time is spent). Undefined for a command, outside a request, or once unbounded.
 */
export function requestAnswerTimeLeftMs(): number | undefined {
  const budget = boundingRequestAcquireBudget();
  const answerBy = budget?.answerBy;
  if (answerBy === undefined) return undefined;
  return budget?.cut === true ? 0 : answerBy - Date.now();
}
/** The rush turned this request away (see `shed`): its busy answer is a wait, not a fault. */
export function noteRequestShed(): void {
  const budget = requestBudgets().getStore();
  if (budget !== undefined) budget.shed = true;
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
