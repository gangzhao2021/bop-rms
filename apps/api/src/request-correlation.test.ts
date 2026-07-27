import { createServer, type Server } from "node:http";
import express, { type Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  correlationForEventEmittedByCommand,
  createRequestCommandCorrelation,
  createRequestCorrelationMiddleware,
  getRequestCorrelationContext,
  type RequestCorrelationContext,
} from "./request-correlation.js";

const ids = {
  requestA: "018f1f48-7b5d-7a01-8a1b-123456789abc",
  correlationA: "018f1f48-7b5d-7a02-8a1b-123456789abc",
  commandA: "018f1f48-7b5d-7a03-8a1b-123456789abc",
  requestB: "018f1f48-7b5d-7b01-8a1b-123456789abc",
  correlationB: "018f1f48-7b5d-7b02-8a1b-123456789abc",
} as const;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
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

function sequence(values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) throw new Error("UUID sequence exhausted");
    return value;
  };
}

describe("WP-0041 request-local correlation adapter", () => {
  it("creates immutable server lineage, ignores spoofed headers, and cleans request-local state", async () => {
    const app = express();
    const factory = sequence([ids.requestA, ids.correlationA, ids.commandA]);
    let capturedRequest: Request | undefined;
    let capturedContext: RequestCorrelationContext | undefined;
    app.use(createRequestCorrelationMiddleware({ uuidV7Factory: factory }));
    app.get("/proof", (request, response) => {
      capturedRequest = request;
      capturedContext = getRequestCorrelationContext(request);
      const command = createRequestCommandCorrelation(request, factory);
      response.status(202).json({
        commandFrozen: Object.isFrozen(command),
        contextFrozen: Object.isFrozen(capturedContext),
        eventContext: correlationForEventEmittedByCommand(command),
      });
    });
    const origin = await listen(app);

    const response = await fetch(`${origin}/proof`, {
      headers: {
        "x-correlation-id": "raw-correlation-secret",
        "x-request-id": "raw-request-secret",
      },
    });
    expect(response.headers.get("x-request-id")).toBe(ids.requestA);
    expect(response.headers.get("x-correlation-id")).toBe(ids.correlationA);
    expect(await response.json()).toEqual({
      commandFrozen: true,
      contextFrozen: true,
      eventContext: {
        correlationId: ids.correlationA,
        causationId: ids.commandA,
      },
    });
    expect(capturedContext).toEqual({
      requestId: ids.requestA,
      correlation: { correlationId: ids.correlationA },
    });
    const completedRequest = capturedRequest;
    if (completedRequest === undefined) throw new Error("request was not captured");
    expect(() => getRequestCorrelationContext(completedRequest)).toThrow(
      "REQUEST_CORRELATION_CONTEXT_UNAVAILABLE",
    );
  });

  it("keeps interleaved requests isolated", async () => {
    const app = express();
    app.use(
      createRequestCorrelationMiddleware({
        uuidV7Factory: sequence([ids.requestA, ids.correlationA, ids.requestB, ids.correlationB]),
      }),
    );
    const seen: RequestCorrelationContext[] = [];
    app.get("/parallel", async (request, response) => {
      const before = getRequestCorrelationContext(request);
      await new Promise((resolve) => setImmediate(resolve));
      const after = getRequestCorrelationContext(request);
      expect(after).toBe(before);
      seen.push(after);
      response.status(200).end();
    });
    const origin = await listen(app);

    const responses = await Promise.all([fetch(`${origin}/parallel`), fetch(`${origin}/parallel`)]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));

    expect(new Set(responses.map((response) => response.headers.get("x-request-id")))).toEqual(
      new Set([ids.requestA, ids.requestB]),
    );
    expect(new Set(responses.map((response) => response.headers.get("x-correlation-id")))).toEqual(
      new Set([ids.correlationA, ids.correlationB]),
    );
    expect(new Set(seen.map((context) => context.requestId))).toEqual(
      new Set([ids.requestA, ids.requestB]),
    );
    expect(new Set(seen.map((context) => context.correlation.correlationId))).toEqual(
      new Set([ids.correlationA, ids.correlationB]),
    );
  });

  it.each(["early", "failure"])("cleans context after a %s response", async (mode) => {
    const app = express();
    let capturedRequest: Request | undefined;
    app.use(
      createRequestCorrelationMiddleware({
        uuidV7Factory: sequence([ids.requestA, ids.correlationA]),
      }),
    );
    app.get(`/${mode}`, (request, response, next) => {
      capturedRequest = request;
      if (mode === "early") response.status(204).end();
      else next(new Error("synthetic failure"));
    });
    app.use(
      (
        _error: unknown,
        _request: express.Request,
        response: express.Response,
        next: express.NextFunction,
      ) => {
        void next;
        response.status(500).json({ error: { code: "internal_error" } });
      },
    );
    const origin = await listen(app);

    const response = await fetch(`${origin}/${mode}`);
    await response.arrayBuffer();

    expect(response.status).toBe(mode === "early" ? 204 : 500);
    expect(response.headers.get("x-request-id")).toBe(ids.requestA);
    expect(response.headers.get("x-correlation-id")).toBe(ids.correlationA);
    const completedRequest = capturedRequest;
    if (completedRequest === undefined) throw new Error("request was not captured");
    expect(() => getRequestCorrelationContext(completedRequest)).toThrow(
      "REQUEST_CORRELATION_CONTEXT_UNAVAILABLE",
    );
  });
});
