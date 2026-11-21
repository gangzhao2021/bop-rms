// WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): what the guest and staff entry (the
// HTTPS process behind the front's relay) adds to an answer, bounded and written down.
//
// In a burst, staff answers reached the screens after 16-18 s while the entry's own busy answer
// was due at 14 s: its clock started only when a request reached its route, after the
// connection's TLS handshake and the time the request sat in the busy process. Staff requests
// (the merchant BFF runs here) wrote no completion line, so nothing showed where the time went.
// Now a request's answer time counts from when its connection arrived (its first request only;
// at most 5 s, as a preconnected connection may sit idle), staff reads work 2 s less here and
// answer busy 1 s after it, and every staff request writes one line with its time before the
// route and the longest stall of the process since the previous line.
import console from "node:console";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { apiRouteTemplates } from "../../apps/api/dist/http-route-templates.js";
import {
  entryArrivalCountMaxMs,
  entryArrivedAtHeader,
  entryStaffReadAnswerWithinMs,
  isStaffRequestPath,
  readAnswerMarginMs,
  requestReadAnswerWithinMs,
} from "../../apps/api/dist/request-acquire-budget.js";

const arrivals = new WeakMap();
/** Each request's own answer, so every reader of it sees the same time. */
const requestArrivals = new WeakMap();
/** Notes when each connection of `server` arrived (before its TLS handshake). */
export function noteEntryConnections(server, now = Date.now) {
  server.on("connection", (socket) => arrivals.set(socket, now()));
  return server;
}
/**
 * When `request`'s connection arrived, for its first request (later requests on a kept connection
 * arrive when they are read); never more than 5 s before `now`. Undefined: not known.
 */
export function requestArrivedAt(request, now = Date.now()) {
  if (request !== null && typeof request === "object" && requestArrivals.has(request))
    return requestArrivals.get(request);
  const found = connectionArrivedAt(request, now);
  if (request !== null && typeof request === "object") requestArrivals.set(request, found);
  return found;
}
function connectionArrivedAt(request, now) {
  const socket = request?.socket;
  // A TLS connection is read through the TLS socket over the one that arrived (Node's own field).
  const raw = socket !== undefined && arrivals.has(socket) ? socket : socket?._parent;
  const at = raw === undefined || raw === null ? undefined : arrivals.get(raw);
  if (at === undefined) return undefined;
  arrivals.delete(raw);
  return Math.max(at, now - entryArrivalCountMaxMs);
}
/**
 * A read's work time and the margin after it for its busy answer at the entry: staff reads are
 * answered here (no second hop), guest reads go on to the Store's API (one more second).
 */
export function entryReadTiming(method, url) {
  return isStaffRequestPath(url)
    ? {
        answerWithinMs: entryStaffReadAnswerWithinMs(method, url),
        busyAnswerMarginMs: readAnswerMarginMs,
      }
    : {
        answerWithinMs: requestReadAnswerWithinMs(method, url),
        busyAnswerMarginMs: 2 * readAnswerMarginMs,
      };
}

const budgetKey = Symbol.for("bop.database.request-acquire-budget");
/** The rush turned the current request away and no real fault met it (the shared budget). */
export function requestTurnedAwayByRush() {
  try {
    const budget = globalThis[budgetKey]?.getStore();
    return budget?.shed === true && budget.faulted !== true;
  } catch {
    return false;
  }
}

const routePattern = /^\/[A-Za-z0-9/_:-]{1,120}$/u;
let loopDelay = null;
/**
 * One line per staff request when its answer is done: its route template (never an id), status,
 * result, time in all and before its route, and the longest stall of this process since the
 * previous line. A busy answer the rush caused is a wait (level 40, HTTP_RETRY_LATER).
 */
export function createStaffRequestCompletionLog({
  write = (line) => console.log(line),
  now = Date.now,
  arrivedAt = requestArrivedAt,
  /** The event the entry emits on a response its read timer answered busy. */
  answeredBusyEvent,
} = {}) {
  if (loopDelay === null) {
    loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
  }
  const histogram = loopDelay;
  return (request, response, next) => {
    const reached = now();
    const arrived = arrivedAt(request, reached) ?? reached;
    let rushed = false;
    let done = false;
    // WP-2423 (logs-and-transaction-time): a screen that left before its answer was written
    // (`left`: the connection closed first) is logged as the client closing (499), never as the
    // 200 it was not sent.
    const complete = (left = false) => {
      if (done) return;
      done = true;
      const status = left && !response.headersSent ? 499 : response.statusCode;
      const result = left
        ? "HTTP_CLIENT_CLOSED"
        : status === 503 && rushed
          ? "HTTP_RETRY_LATER"
          : status >= 500
            ? "HTTP_SERVER_ERROR"
            : status >= 400
              ? "HTTP_CLIENT_ERROR"
              : "HTTP_SUCCESS";
      const route = request.route?.path;
      let stall = null;
      try {
        stall = Math.round(histogram.max / 1e6);
        histogram.reset();
      } catch {
        // No stall figure on this line; the answer is logged all the same.
      }
      try {
        write(
          JSON.stringify({
            level: result === "HTTP_RETRY_LATER" ? 40 : 30,
            time: new Date(now()).toISOString(),
            event: "merchant_request_completed",
            ...(typeof route === "string" && routePattern.test(route) ? { route } : {}),
            statusCode: status,
            resultCode: result,
            durationMs: Math.max(0, now() - arrived),
            beforeRouteMs: Math.max(0, reached - arrived),
            ...(Number.isFinite(stall) ? { longestStallMs: stall } : {}),
          }),
        );
      } catch {
        // Observability never changes an answer.
      }
    };
    // Read while the request's own budget is current (the answer is written inside it).
    const end = response.end;
    response.end = function (...args) {
      rushed ||= requestTurnedAwayByRush();
      return Reflect.apply(end, this, args);
    };
    if (answeredBusyEvent !== undefined)
      response.once(answeredBusyEvent, () => {
        rushed = true;
      });
    response.once("finish", () => complete(false));
    response.once("close", () => complete(response.writableFinished !== true));
    next();
  };
}

const safeAnswerCode = /^(?:[a-z][a-z0-9_]{0,63}|[A-Z][A-Z0-9_]{0,63})$/u;
/**
 * v15 batch 39 (b40): the guest payment routes this entry answers itself (a table's bill and its
 * payment, a checkout's reconciliation and handoff) never reached api.log, successes included,
 * so a 503 a guest saw left no line anywhere. One line per such request when its answer is done:
 * its route template (`template`; never an id, a cookie or a token), status, result, time, and
 * the code of an error answer (the public code it sent, never its values).
 */
export function createGuestPaymentRequestCompletionLog({
  template,
  write = (line) => console.log(line),
  now = Date.now,
  arrivedAt = requestArrivedAt,
}) {
  return (request, response, next) => {
    const route = template(request.method, request.path);
    if (route === null) return next();
    const reached = now();
    const arrived = arrivedAt(request, reached) ?? reached;
    let answerCode;
    const json = response.json;
    response.json = function (body) {
      try {
        const code = body?.error?.code ?? body?.code;
        if (typeof code === "string" && safeAnswerCode.test(code)) answerCode = code;
      } catch {
        // No code on this line; the answer is sent all the same.
      }
      return Reflect.apply(json, this, [body]);
    };
    let done = false;
    const complete = (left = false) => {
      if (done) return;
      done = true;
      const status = left && !response.headersSent ? 499 : response.statusCode;
      const result = left
        ? "HTTP_CLIENT_CLOSED"
        : status >= 500
          ? "HTTP_SERVER_ERROR"
          : status >= 400
            ? "HTTP_CLIENT_ERROR"
            : "HTTP_SUCCESS";
      try {
        write(
          JSON.stringify({
            level: status >= 500 ? 50 : 30,
            time: new Date(now()).toISOString(),
            event: "guest_payment_request_completed",
            route,
            statusCode: status,
            resultCode: result,
            durationMs: Math.max(0, now() - arrived),
            ...(status >= 400 && answerCode !== undefined ? { answerCode } : {}),
          }),
        );
      } catch {
        // Observability never changes an answer.
      }
    };
    response.once("finish", () => complete(false));
    response.once("close", () => complete(response.writableFinished !== true));
    next();
  };
}

/**
 * WP-2423 (rush-connection-hold, v15 2026-11-14): the guest request on its way to the Store's API
 * says when its connection reached this entry (`entryArrivedAtHeader`), so the API counts the
 * read's answer time from the same instant and answers busy a second before this entry would. A
 * value the guest sent is never passed on.
 */
export function withEntryArrival(headers, arrivedAt) {
  const next = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== entryArrivedAtHeader),
  );
  return Number.isSafeInteger(arrivedAt)
    ? { ...next, [entryArrivedAtHeader]: String(arrivedAt) }
    : next;
}

const guestRoutes = apiRouteTemplates
  .filter((template) => template.startsWith("/bff/") || template.startsWith("/api/"))
  .map((template) => ({
    template,
    pattern: new RegExp(
      "^" +
        template
          .split("/")
          .map((part) =>
            part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
          )
          .join("/") +
        "$",
      "u",
    ),
  }));
/** The API route template a guest request's path matches (never the path itself). */
export function guestRouteTemplate(url) {
  const path = String(url ?? "").split(/[?#]/u, 1)[0] ?? "";
  return guestRoutes.find((route) => route.pattern.test(path))?.template ?? "unmatched";
}
/**
 * WP-2423 (rush-connection-hold): one line for each guest read this entry itself answered busy at
 * its time (the Store's API had not answered by then), with the API route it was for, so the busy
 * answers guests saw can be counted by route beside api.log. A wait, not a fault: level 40.
 */
export function logEntryGuestBusyAnswer(
  request,
  { write = (line) => console.log(line), now = Date.now, arrivedAt = requestArrivedAt } = {},
) {
  try {
    const at = now();
    const arrived = arrivedAt(request, at) ?? at;
    write(
      JSON.stringify({
        level: 40,
        time: new Date(at).toISOString(),
        event: "entry_request_answered_busy",
        route: guestRouteTemplate(request.originalUrl ?? request.url),
        statusCode: 503,
        resultCode: "HTTP_RETRY_LATER",
        durationMs: Math.max(0, at - arrived),
      }),
    );
  } catch {
    // Observability never changes an answer.
  }
}
