import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAnswerBusyBody,
  requestAnswerTimeLeftMs,
  requestShedFor,
  requestWasShed,
  runDetachedRead,
  sendReadAnswerBusy,
  withRequestAcquireBudget,
} from "./request-acquire-budget.js";
import { createRequestCorrelationMiddleware } from "./request-correlation.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(app: ReturnType<typeof express>): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The process-wide store the database package spends (the same key). */
const shared = () =>
  (
    globalThis as Record<
      symbol,
      { getStore(): { shed?: boolean; cut?: boolean; remainingMs: number } | undefined }
    >
  )[Symbol.for("bop.database.request-acquire-budget")]?.getStore();

describe("WP-2423 reads-under-burst: a read's whole answer inside the 15 s clients wait", () => {
  it("answers a read still working at its answer time busy, and cuts what it still does", async () => {
    const app = express();
    const later: { timeLeft?: number | undefined; lateAnswerThrew?: boolean } = {};
    app.use((request, response, next) =>
      withRequestAcquireBudget(next, {
        response,
        answerWithinMs: request.method === "GET" ? 120 : undefined,
        busyAnswerMarginMs: 60,
        answerBusy: () => sendReadAnswerBusy(response),
      }),
    );
    app.get("/slow", async (_request, response) => {
      // The read's own work runs on past its answer time (a busy process, a slow owner read).
      await pause(400);
      later.timeLeft = requestAnswerTimeLeftMs();
      try {
        response.status(200).json({ late: true });
      } catch {
        later.lateAnswerThrew = true;
      }
    });
    app.post("/slow", async (_request, response) => {
      await pause(400);
      response.status(200).json({ done: true });
    });
    const base = await listen(app);
    const started = Date.now();
    const busy = await fetch(base + "/slow");
    const waited = Date.now() - started;
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(busy.headers.get("cache-control")).toBe("no-store");
    expect(await busy.json()).toEqual(readAnswerBusyBody);
    // Answered at its answer time plus the margin, not when the work ended.
    expect(waited).toBeLessThan(380);
    await pause(450);
    // Nothing more of it reaches the database, and its late answer goes nowhere.
    expect(later.timeLeft).toBe(0);
    expect(later.lateAnswerThrew).toBeUndefined();
    // A command is never answered for it: it ends its work and answers itself.
    const command = await fetch(base + "/slow", { method: "POST" });
    expect(command.status).toBe(200);
  });

  it("leaves an answer already started, or a read that wrote, to finish", async () => {
    const timers: (() => void)[] = [];
    const setTimer = (work: () => void) => {
      timers.push(work);
      return { cancel: () => undefined };
    };
    const response = Object.assign(new (await import("node:events")).EventEmitter(), {
      headersSent: true,
      writableEnded: false,
      writableFinished: false,
    });
    let answered = 0;
    withRequestAcquireBudget(() => undefined, {
      response,
      answerWithinMs: 100,
      busyAnswerMarginMs: 0,
      answerBusy: () => (answered += 1),
      setTimer,
    });
    timers.splice(0).forEach((fire) => fire());
    expect(answered).toBe(0);
    const wrote = Object.assign(new (await import("node:events")).EventEmitter(), {
      headersSent: false,
      writableEnded: false,
      writableFinished: false,
    });
    withRequestAcquireBudget(
      () => {
        const budget = shared() as { committedWrite?: boolean } | undefined;
        if (budget) budget.committedWrite = true;
      },
      {
        response: wrote,
        answerWithinMs: 100,
        busyAnswerMarginMs: 0,
        answerBusy: () => (answered += 1),
        setTimer,
      },
    );
    timers.splice(0).forEach((fire) => fire());
    expect(answered).toBe(0);
  });

  it("cuts a read whose phone or screen went away before its answer, never a command", async () => {
    const { EventEmitter } = await import("node:events");
    const read = Object.assign(new EventEmitter(), { writableFinished: false });
    let left: number | undefined;
    await withRequestAcquireBudget(
      async () => {
        read.emit("close");
        left = requestAnswerTimeLeftMs();
      },
      { response: read, answerWithinMs: 12_000 },
    );
    expect(left).toBe(0);
    const command = Object.assign(new EventEmitter(), { writableFinished: false });
    let commandLeft: number | undefined | null = null;
    let cut: boolean | undefined;
    await withRequestAcquireBudget(
      async () => {
        command.emit("close");
        commandLeft = requestAnswerTimeLeftMs();
        cut = shared()?.cut;
      },
      { response: command },
    );
    expect(commandLeft).toBeUndefined();
    expect(cut).toBeUndefined();
  });

  it("runs a read shared by many phones in its own time, never cut by the phone that started it", async () => {
    const { EventEmitter } = await import("node:events");
    const first = Object.assign(new EventEmitter(), { writableFinished: false });
    const seen = await withRequestAcquireBudget(
      async () => {
        first.emit("close");
        const own = requestAnswerTimeLeftMs();
        const shared = await runDetachedRead(async () => requestAnswerTimeLeftMs());
        return { own, shared };
      },
      { response: first, answerWithinMs: 12_000 },
    );
    expect(seen.own).toBe(0);
    expect(seen.shared).toBeGreaterThan(11_000);
    expect(seen.shared).toBeLessThanOrEqual(12_000);
  });

  it("logs a 503 the rush caused as a wait (HTTP_RETRY_LATER), and a route's own fault as an error", async () => {
    const entries: { statusCode: number; resultCode: string }[] = [];
    const app = express();
    app.use(
      createRequestCorrelationMiddleware({ logger: { info: (entry) => entries.push(entry) } }),
    );
    let shedSeen = false;
    app.get("/rush", (_request, response) => {
      // The database package notes it: no connection came within the request's wait.
      const budget = shared();
      if (budget) budget.shed = true;
      shedSeen = requestWasShed();
      response.status(503).json({ error: "busy" });
    });
    app.get("/fault", (_request, response) => {
      response.status(503).json({ error: "broken" });
    });
    const base = await listen(app);
    await fetch(base + "/rush");
    await fetch(base + "/fault");
    await pause(20);
    expect(shedSeen).toBe(true);
    expect(entries.map((entry) => [entry.statusCode, entry.resultCode])).toEqual([
      [503, "HTTP_RETRY_LATER"],
      [503, "HTTP_SERVER_ERROR"],
    ]);
    expect(requestShedFor({})).toBe(false);
  });
});
