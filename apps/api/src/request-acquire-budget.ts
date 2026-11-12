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
/**
 * WP-2423 (guest-table-open-and-busy-reads, v15 2026-11-12): a read (GET/HEAD) does all its
 * database work within this time, inside the 15 s phones and staff screens wait, or answers
 * "busy, try again" (packages/database/src/request-acquire-budget.ts, `answerBy`). A command's
 * work is never cut by the clock.
 */
export const requestReadAnswerMs = 12_000;
/** The methods whose requests only read, so their work is bounded by `requestReadAnswerMs`. */
export function isReadRequestMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}
/**
 * Staff reads whose screens wait longer than 15 s, each given its screen's wait less the same 3 s
 * for the answer to arrive (b10 review). A month of reports or its CSV export reads every payment
 * and refund in the period: apps/merchant-web/src/store-reports-client.ts waits 30 s, and the
 * sole-operator, step-up and refund-approval screens wait 20 s. Cutting them at 12 s would make a
 * long period answer busy on a quiet database, and every retry the same.
 */
const longerReadAnswers: readonly { readonly path: string; readonly prefix: boolean; readonly ms: number }[] =
  Object.freeze([
    { path: "/merchant/reports", prefix: true, ms: 27_000 },
    { path: "/merchant/organization/sole-operator", prefix: false, ms: 17_000 },
    { path: "/merchant/identity/step-up", prefix: false, ms: 17_000 },
    { path: "/merchant/payments/refunds/approvals", prefix: false, ms: 17_000 },
  ]);
/**
 * A request's whole work time: undefined for a command (its work is never cut by the clock), the
 * screen's own longer time for the staff reads above, and `requestReadAnswerMs` for every other read.
 */
export function requestReadAnswerWithinMs(
  method: string | undefined,
  url: string | undefined,
): number | undefined {
  if (!isReadRequestMethod(method)) return undefined;
  const path = (url ?? "").split(/[?#]/u, 1)[0] ?? "";
  for (const entry of longerReadAnswers)
    if (path === entry.path || (entry.prefix && path.startsWith(entry.path + "/"))) return entry.ms;
  return requestReadAnswerMs;
}
/** The shape packages/database/src/request-acquire-budget.ts keeps and spends (shared store). */
interface RequestAcquireBudget {
  remainingMs: number;
  readonly startedAt: number;
  ended: boolean;
  committedWrite: boolean;
  readonly answerBy?: number;
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
    /** A read's whole work time (`requestReadAnswerMs` for GET/HEAD); none for a command. */
    readonly answerWithinMs?: number | undefined;
  } = {},
): T {
  if (requestBudgets().getStore() !== undefined) return work();
  const startedAt = Date.now();
  const within = options.answerWithinMs;
  const budget: RequestAcquireBudget = {
    remainingMs: options.budgetMs ?? requestAcquireBudgetMs,
    startedAt,
    ended: false,
    committedWrite: false,
    ...(within !== undefined && Number.isFinite(within) && within >= 0
      ? { answerBy: startedAt + within }
      : {}),
  };
  const end = () => {
    budget.ended = true;
  };
  options.response?.once("finish", end);
  options.response?.once("close", end);
  return requestBudgets().run(budget, work);
}

/**
 * For a read still bounded by its request: the milliseconds left before it must answer; undefined
 * for a command, outside a request, or once its answer was sent.
 */
export function requestAnswerTimeLeftMs(): number | undefined {
  const budget = requestBudgets().getStore();
  if (budget === undefined || budget.ended || budget.answerBy === undefined) return undefined;
  return budget.answerBy - Date.now();
}
