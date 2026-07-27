import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { StructuredLogDestination } from "@bop-rms/observability";
import { createApp } from "./app.js";
import { createApiRuntimeLogger } from "./server.js";

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

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

describe("WP-0040 API composition-root logging", () => {
  it("uses centralized JSON configuration and the API event allowlist", () => {
    const records: string[] = [];
    const destination: StructuredLogDestination = {
      write: (message) => records.push(String(message)),
    };
    const logger = createApiRuntimeLogger(destination);

    logger.info({ event: "listening", port: 3100, resultCode: "SUCCESS" });

    expect(JSON.parse(records.join(""))).toMatchObject({
      environment: "test",
      event: "listening",
      module: "api-runtime",
      port: 3100,
      resultCode: "SUCCESS",
      service: "bop-rms-api",
    });
  });

  it("logs only the closed WP-0041 HTTP completion fields", async () => {
    const records: string[] = [];
    const destination: StructuredLogDestination = {
      write: (message) => records.push(String(message)),
    };
    const logger = createApiRuntimeLogger(destination);
    const times = [1_000, 1_027];
    const origin = await listen(
      createApp({
        nowMilliseconds: () => times.shift() ?? 1_027,
        requestLogger: logger,
      }),
    );

    const response = await fetch(`${origin}/person@example.test?token=secret&allergy=peanut`, {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-correlation-id": "raw-correlation-secret",
        "x-request-id": "raw-request-secret",
      },
    });
    await response.arrayBuffer();

    const serialized = records.join("");
    const record = JSON.parse(serialized) as Record<string, unknown>;
    expect(record).toMatchObject({
      correlationId: response.headers.get("x-correlation-id"),
      durationMs: 27,
      environment: "test",
      event: "http_request_completed",
      module: "api-runtime",
      requestId: response.headers.get("x-request-id"),
      resultCode: "HTTP_CLIENT_ERROR",
      service: "bop-rms-api",
      statusCode: 404,
    });
    expect(Object.keys(record).sort()).toEqual(
      [
        "correlationId",
        "durationMs",
        "environment",
        "event",
        "level",
        "module",
        "requestId",
        "resultCode",
        "service",
        "statusCode",
        "time",
      ].sort(),
    );
    for (const canary of [
      "person@example.test",
      "token",
      "allergy",
      "peanut",
      "Bearer",
      "cookie",
      "session",
      "raw-correlation-secret",
      "raw-request-secret",
    ])
      expect(serialized).not.toContain(canary);
  });

  it("isolates request logger failure from HTTP completion", async () => {
    const origin = await listen(
      createApp({
        requestLogger: {
          info() {
            throw new Error("synthetic sink failure");
          },
        },
      }),
    );

    const response = await fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "healthy" });
  });
});
