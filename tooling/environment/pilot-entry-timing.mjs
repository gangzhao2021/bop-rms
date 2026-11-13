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
import {
  entryArrivalCountMaxMs,
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
    const complete = () => {
      if (done) return;
      done = true;
      const status = response.statusCode;
      const result =
        status === 503 && rushed
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
    response.once("finish", complete);
    response.once("close", complete);
    next();
  };
}
