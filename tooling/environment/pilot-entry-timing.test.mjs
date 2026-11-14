import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createStaffRequestCompletionLog,
  entryReadTiming,
  logEntryGuestBusyAnswer,
  noteEntryConnections,
  requestArrivedAt,
  withEntryArrival,
} from "./pilot-entry-timing.mjs";

/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): in a burst staff answers reached the
 * screens after 16-18 s, past the 15 s the screens wait, while the entry's own busy answer was
 * due at 14 s and no line showed where the rest went.
 */
describe("the entry's answer time and its staff completion line", () => {
  it("counts a request's time from when its connection arrived, for its first request only", () => {
    const server = new EventEmitter();
    let clock = 1_000_000;
    noteEntryConnections(server, () => clock);
    const raw = new EventEmitter();
    server.emit("connection", raw);
    clock += 2_500;
    // The request is read through the TLS socket over the one that arrived.
    const first = { socket: { _parent: raw } };
    expect(requestArrivedAt(first, clock)).toBe(1_000_000);
    // Asked again for the same request: the same time.
    expect(requestArrivedAt(first, clock + 10)).toBe(1_000_000);
    // A later request on the kept connection arrives when it is read (not known here).
    expect(requestArrivedAt({ socket: { _parent: raw } }, clock)).toBeUndefined();
    // A connection that sat idle (a preconnect) counts at most 5 s.
    const idle = new EventEmitter();
    server.emit("connection", idle);
    clock += 60_000;
    expect(requestArrivedAt({ socket: idle }, clock)).toBe(clock - 5_000);
  });

  it("gives staff reads answered here 10 s of work and their busy answer 1 s later; guest reads keep 12 s + 2 s", () => {
    expect(entryReadTiming("GET", "/merchant/orders/changes")).toEqual({
      answerWithinMs: 10_000,
      busyAnswerMarginMs: 1_000,
    });
    expect(entryReadTiming("GET", "/bff/customer/cart")).toEqual({
      answerWithinMs: 12_000,
      busyAnswerMarginMs: 2_000,
    });
    expect(entryReadTiming("POST", "/merchant/counter/orders").answerWithinMs).toBeUndefined();
  });

  it("writes one line per staff request: route, result, time in all and before the route", () => {
    const lines = [];
    let clock = 2_000_000;
    const log = createStaffRequestCompletionLog({
      write: (line) => lines.push(JSON.parse(line)),
      now: () => clock,
      arrivedAt: () => clock - 1_200,
      answeredBusyEvent: "busy",
    });
    const answer = (status, busy = false) => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: status,
        end: () => undefined,
      });
      const request = { route: { path: "/orders/changes" } };
      log(request, response, () => undefined);
      clock += 300;
      if (busy) response.emit("busy");
      response.end();
      response.emit("finish");
    };
    answer(200);
    answer(503, true);
    answer(503);
    expect(
      lines.map(({ level, event, route, statusCode, resultCode, durationMs, beforeRouteMs }) => ({
        level,
        event,
        route,
        statusCode,
        resultCode,
        durationMs,
        beforeRouteMs,
      })),
    ).toEqual([
      {
        level: 30,
        event: "merchant_request_completed",
        route: "/orders/changes",
        statusCode: 200,
        resultCode: "HTTP_SUCCESS",
        durationMs: 1_500,
        beforeRouteMs: 1_200,
      },
      {
        level: 40,
        event: "merchant_request_completed",
        route: "/orders/changes",
        statusCode: 503,
        resultCode: "HTTP_RETRY_LATER",
        durationMs: 1_500,
        beforeRouteMs: 1_200,
      },
      {
        level: 30,
        event: "merchant_request_completed",
        route: "/orders/changes",
        statusCode: 503,
        resultCode: "HTTP_SERVER_ERROR",
        durationMs: 1_500,
        beforeRouteMs: 1_200,
      },
    ]);
    expect(lines.every((line) => Number.isInteger(line.longestStallMs))).toBe(true);
  });
});

describe("WP-2423 (rush-connection-hold) the entry and the API count a guest read from one instant", () => {
  it("states the connection's arrival to the API and never passes on one the guest sent", () => {
    expect(
      withEntryArrival(
        { host: "x", "X-Bop-Entry-Arrived-At": "1", "x-bop-entry-arrived-at": "2" },
        1_763_080_205_000,
      ),
    ).toEqual({ host: "x", "x-bop-entry-arrived-at": "1763080205000" });
    expect(withEntryArrival({ host: "x", "x-bop-entry-arrived-at": "2" }, undefined)).toEqual({
      host: "x",
    });
  });

  it("logs each guest read it answered busy itself as a wait, with the API route it was for", () => {
    const lines = [];
    for (const url of ["/bff/customer/cart?locale=zh-Hans", "/api/v1/public/stores/s1/menu", "/x"])
      logEntryGuestBusyAnswer(
        { originalUrl: url },
        {
          write: (line) => lines.push(JSON.parse(line)),
          now: () => 1_763_080_219_000,
          arrivedAt: () => 1_763_080_205_000,
        },
      );
    expect(lines.map(({ route }) => route)).toEqual([
      "/bff/customer/cart",
      "/api/v1/public/stores/:store_public_id/menu",
      "unmatched",
    ]);
    expect(lines[0]).toEqual({
      level: 40,
      time: "2025-11-14T00:30:19.000Z",
      event: "entry_request_answered_busy",
      route: "/bff/customer/cart",
      statusCode: 503,
      resultCode: "HTTP_RETRY_LATER",
      durationMs: 14_000,
    });
    // Never the path's own references.
    expect(JSON.stringify(lines)).not.toContain("s1");
  });
});
