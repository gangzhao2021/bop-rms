import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { HealthReadinessController } from "./health-readiness.js";

const servers: ReturnType<typeof createServer>[] = [];
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
async function request(
  path: string,
  init?: RequestInit,
  options: Parameters<typeof createApp>[0] = {},
) {
  const server = createServer(createApp({ now: () => "2026-07-16T00:00:00.000Z", ...options }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

function expectGeneratedCorrelationHeaders(response: Response): void {
  expect(response.headers.get("x-request-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(response.headers.get("x-correlation-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(response.headers.get("x-request-id")).not.toBe(response.headers.get("x-correlation-id"));
}

describe("API skeleton", () => {
  it("reports structured health", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expectGeneratedCorrelationHeaders(response);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      service: "bop-rms-api",
      status: "healthy",
      checkedAt: "2026-07-16T00:00:00.000Z",
    });
  });
  it("reports database as explicitly unconfigured", async () => {
    const response = await request("/ready");
    expect(response.status).toBe(503);
    expectGeneratedCorrelationHeaders(response);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      checkedAt: "2026-07-16T00:00:00.000Z",
      service: "bop-rms-api",
      status: "not_ready",
      dependencies: { database: { status: "not_configured", required: true } },
    });
  });
  it("reports ready only for an accepting runtime with a ready required dependency", async () => {
    const healthReadiness = new HealthReadinessController({
      databaseProbe: () => "ready",
      now: () => "2026-07-16T00:00:00.000Z",
    });
    healthReadiness.completeStartup();

    const response = await request("/ready", undefined, { healthReadiness });

    expect(response.status).toBe(200);
    expectGeneratedCorrelationHeaders(response);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      checkedAt: "2026-07-16T00:00:00.000Z",
      dependencies: { database: { required: true, status: "ready" } },
      service: "bop-rms-api",
      status: "ready",
    });
  });
  it("uses security headers and a non-reflective 404", async () => {
    const response = await request("/private/secret-value", {
      headers: {
        "x-correlation-id": "raw-correlation-secret",
        "x-request-id": "raw-request-secret",
      },
    });
    expectGeneratedCorrelationHeaders(response);
    expect(response.headers.get("x-request-id")).not.toBe("raw-request-secret");
    expect(response.headers.get("x-correlation-id")).not.toBe("raw-correlation-secret");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("secret-value");
    expect(body).not.toContain("raw-request-secret");
    expect(body).not.toContain("raw-correlation-secret");
  });
  it("rejects oversized JSON", async () => {
    const response = await request("/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(70_000) }),
    });
    expect(response.status).toBe(413);
    expectGeneratedCorrelationHeaders(response);
  });
  it("rejects invalid JSON without reflecting input", async () => {
    const response = await request("/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"token":"raw-secret"',
    });
    expect(response.status).toBe(400);
    expectGeneratedCorrelationHeaders(response);
    expect(JSON.stringify(await response.json())).not.toContain("raw-secret");
  });
  it("fails closed when realtime authorization is not configured", async () => {
    const response = await request("/bff/realtime", {
      headers: {
        origin: "https://merchant.example.test",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(response.status).toBe(503);
    expectGeneratedCorrelationHeaders(response);
    expect(await response.json()).toEqual({
      error: {
        code: "realtime_not_configured",
        message: "The stream is unavailable.",
      },
    });
  });
});
