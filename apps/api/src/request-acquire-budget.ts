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
/** The longest a phone or staff screen waits for an answer (the database package's own window). */
export const requestAnswerWindowMs = 15_000;
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
const longerReadAnswers: readonly {
  readonly path: string;
  readonly prefix: boolean;
  readonly ms: number;
}[] = Object.freeze([
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
  /** The rush turned the request away (no connection in time, answer time spent): a wait. */
  shed?: boolean;
  /** A read answered busy or abandoned by its client: nothing more of it reaches the database. */
  cut?: boolean;
  /** A real fault met the request: it is logged as a fault even if it was later turned away. */
  faulted?: boolean;
}
/**
 * WP-2423 (reads-under-burst, v15 2026-11-13): the whole answer of a read, not only its database
 * work, arrives inside the 15 s the phones and staff screens wait. Under a burst, reads whose
 * database work was done in 12 s still answered after 15-18 s (and 20-26 s at the phone): the
 * time went to the process itself (one busy event loop serving 400 requests, menu reads the
 * heaviest) and to the second hop for guest requests. A read that has not started its answer
 * by its answer time plus this margin answers "busy, try again" (503 + Retry-After 5) at once,
 * and whatever it was still doing is cut (see `cut`). The guest/staff entry in front of the API
 * gives its own answer a further second for the hop.
 */
export const readAnswerMarginMs = 1_000;
/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): staff reads answered by the guest and
 * staff entry itself (the merchant BFF runs in that process, behind the TLS relay). In a burst
 * their answers reached the screens after 16-18 s, past the 15 s every staff screen waits before
 * it gives up: the entry's own clock started only once a request reached its route, after the
 * connection's TLS handshake and the time the request sat in the busy entry, and its busy answer
 * came at 12 s + 2 s. Staff reads there now work 2 s less (10 s, or their screen's longer time
 * less 2 s) and answer busy 1 s after it (no second hop), counted from when the connection
 * arrived: what the busy entry and the relay still add fits inside the screen's wait.
 */
export const entryStaffReadShortfallMs = 2_000;
/** A connection's time before its first request counts only up to this (a preconnect may idle). */
export const entryArrivalCountMaxMs = 5_000;
/** The staff (merchant BFF) answer time of a read at the entry; undefined for a command. */
export function entryStaffReadAnswerWithinMs(
  method: string | undefined,
  url: string | undefined,
): number | undefined {
  const within = requestReadAnswerWithinMs(method, url);
  return within === undefined ? undefined : within - entryStaffReadShortfallMs;
}
/** Whether `url` is a staff (merchant BFF) request. */
export function isStaffRequestPath(url: string | undefined): boolean {
  const path = (url ?? "").split(/[?#]/u, 1)[0] ?? "";
  return path === "/merchant" || path.startsWith("/merchant/");
}
/** The 503 body of a guest read cut at its answer time: the phones read an unknown 503 as busy. */
export const readAnswerBusyBody = Object.freeze({
  schemaVersion: 1,
  error: Object.freeze({ code: "service_busy", messageKey: "common.service_busy" }),
  code: "SERVICE_BUSY",
});
/**
 * b12 review: the staff screens' busy body. The merchant clients know "busy, ask again" only as
 * `{ error: "retry_later" }` (apps/api/src/merchant-bff-http.ts `failed`): the workspace asks for
 * its session again (Owner 2026-11-04) and the refund screens read again, where any other 503 body
 * would end the workspace start as "unavailable".
 */
export const merchantReadAnswerBusyBody = Object.freeze({ error: "retry_later" });
/** The busy body the surface of `url` understands: staff (/merchant/...) or guest. */
export function readAnswerBusyBodyFor(url: string | undefined): object {
  return isStaffRequestPath(url) ? merchantReadAnswerBusyBody : readAnswerBusyBody;
}
const requestBudgetKey = Symbol.for("bop.database.request-acquire-budget");
function requestBudgets(): AsyncLocalStorage<RequestAcquireBudget> {
  const holder = globalThis as { [requestBudgetKey]?: AsyncLocalStorage<RequestAcquireBudget> };
  holder[requestBudgetKey] ??= new AsyncLocalStorage<RequestAcquireBudget>();
  return holder[requestBudgetKey];
}
/** The budget each answered request ran under, for its completion line (kept with the answer). */
const budgetsByResponse = new WeakMap<object, RequestAcquireBudget>();
/** True when the rush turned this response's request away (logged as a wait, not a fault). */
export function requestShedFor(response: object): boolean {
  const budget = budgetsByResponse.get(response);
  return budget?.shed === true && budget.faulted !== true;
}
/**
 * True when the rush turned the current request away (no connection in time, time spent) and no
 * real fault met it (b12 review: a database that cannot be reached stays a fault).
 */
export function requestWasShed(): boolean {
  const budget = requestBudgets().getStore();
  return budget?.shed === true && budget.faulted !== true;
}

interface AnsweringResponse {
  once(event: "finish" | "close", listener: () => void): unknown;
  readonly headersSent?: boolean;
  readonly writableEnded?: boolean;
  readonly writableFinished?: boolean;
}

/**
 * Runs one request's handling inside its own waiting budget (an outer one is kept). Once its
 * response has finished, what the request started and still runs (a timer, a follow-through) is
 * no longer bounded by it (WP-2423 outage-reads-and-retry review). A read whose client went away
 * before its answer, or that answered busy at its answer time, is cut instead: nothing more of it
 * reaches the database (reads-under-burst). A command is never cut.
 */
export function withRequestAcquireBudget<T>(
  work: () => T,
  options: {
    readonly response?: AnsweringResponse;
    readonly budgetMs?: number;
    /** A read's whole work time (`requestReadAnswerMs` for GET/HEAD); none for a command. */
    readonly answerWithinMs?: number | undefined;
    /**
     * WP-2423 (reads-under-burst): a read that has not started its answer by its answer time plus
     * this margin is answered busy by `answerBusy` and cut. Omitted: no such answer.
     */
    readonly busyAnswerMarginMs?: number;
    readonly answerBusy?: () => void;
    readonly setTimer?: (work: () => void, ms: number) => { cancel(): void };
    /**
     * WP-2423 (rush-reads-and-orders-changes): when the request's connection arrived, if earlier
     * than now (its handshake and its wait in a busy process count against its answer time).
     */
    readonly arrivedAt?: number;
  } = {},
): T {
  if (requestBudgets().getStore() !== undefined) return work();
  const now = Date.now();
  const arrivedAt = options.arrivedAt;
  const startedAt =
    arrivedAt !== undefined && Number.isFinite(arrivedAt) && arrivedAt < now ? arrivedAt : now;
  const within = options.answerWithinMs;
  const read = within !== undefined && Number.isFinite(within) && within >= 0;
  const budget: RequestAcquireBudget = {
    remainingMs: options.budgetMs ?? requestAcquireBudgetMs,
    startedAt,
    ended: false,
    committedWrite: false,
    ...(read ? { answerBy: startedAt + within } : {}),
  };
  const response = options.response;
  if (response !== undefined) budgetsByResponse.set(response, budget);
  let timer: { cancel(): void } | undefined;
  const margin = options.busyAnswerMarginMs;
  const answerBusy = options.answerBusy;
  if (
    read &&
    response !== undefined &&
    answerBusy !== undefined &&
    margin !== undefined &&
    Number.isFinite(margin) &&
    margin >= 0
  ) {
    const schedule =
      options.setTimer ??
      ((callback: () => void, ms: number) => {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
    timer = schedule(
      () => {
        // An answer under way, a finished one or a read that already wrote: left to finish.
        if (
          budget.ended ||
          budget.committedWrite ||
          response.headersSent === true ||
          response.writableEnded === true
        )
          return;
        budget.shed = true;
        budget.cut = true;
        try {
          answerBusy();
        } catch {
          // The busy answer could not be written (the client went away): the read is cut anyway.
        }
      },
      Math.max(0, within + margin - (now - startedAt)),
    );
  }
  response?.once("finish", () => {
    timer?.cancel();
    budget.ended = true;
  });
  response?.once("close", () => {
    timer?.cancel();
    // A read whose client left before its answer: nothing more of it is worth a connection.
    if (read && response.writableFinished !== true && !budget.committedWrite) budget.cut = true;
    else budget.ended = true;
  });
  return requestBudgets().run(budget, work);
}

/**
 * For a read still bounded by its request: the milliseconds left before it must answer; undefined
 * for a command, outside a request, or once its answer was sent. Zero once it was cut.
 */
export function requestAnswerTimeLeftMs(): number | undefined {
  const budget = requestBudgets().getStore();
  if (budget === undefined || budget.answerBy === undefined) return undefined;
  // Past the 15 s the clients wait, what the request still runs is unbounded, cut or not (b12
  // review: never starved for good), as packages/database/src/request-acquire-budget.ts.
  if (!(Date.now() - budget.startedAt < requestAnswerWindowMs)) return undefined;
  if (budget.cut === true) return 0;
  if (budget.ended) return undefined;
  return budget.answerBy - Date.now();
}

/**
 * WP-2423 (reads-under-burst): the busy answer of a read cut at its answer time, and nothing after
 * it: the handler that is still working may try to answer later, and that answer goes nowhere
 * (it would otherwise throw "headers already sent" into the handler, or be written after the end).
 */
export function sendReadAnswerBusy(
  response: {
    statusCode: number;
    setHeader(name: string, value: string): unknown;
    end(chunk?: unknown, ...rest: unknown[]): unknown;
    write?(chunk: unknown, ...rest: unknown[]): unknown;
    writeHead?(...rest: unknown[]): unknown;
  },
  /** The request's URL: a staff read (/merchant/...) answers the body staff screens know. */
  url?: string,
): void {
  response.statusCode = 503;
  response.setHeader("Retry-After", "5");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(readAnswerBusyBodyFor(url)));
  const ignored = function (this: unknown) {
    return this;
  };
  Object.defineProperties(response, {
    setHeader: { value: ignored, configurable: true, writable: true },
    writeHead: { value: ignored, configurable: true, writable: true },
    write: { value: () => true, configurable: true, writable: true },
    end: { value: ignored, configurable: true, writable: true },
  });
}

/**
 * WP-2423 (reads-under-burst): a read shared by several requests (the same public menu asked for
 * by many phones at once) runs within its own waiting budget and answer time, apart from the
 * request that happened to start it: that phone going away (its read cut) must not cut it for the
 * others, and each of them still answers within its own time.
 */
export function runDetachedRead<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  return requestBudgets().run(
    {
      remainingMs: requestAcquireBudgetMs,
      startedAt,
      ended: false,
      committedWrite: false,
      answerBy: startedAt + requestReadAnswerMs,
    },
    work,
  );
}
