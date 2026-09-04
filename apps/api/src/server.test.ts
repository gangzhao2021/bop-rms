import type { AddressInfo } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationCookie } from "@bop/identity";
import type {
  CoreTelemetry,
  NodeTelemetryRuntime,
  StructuredLogDestination,
} from "@bop-rms/observability";
import { HealthReadinessController } from "./health-readiness.js";
import { CustomerEntryHandler } from "./customer-entry.js";
import { CustomerQuoteHandler } from "./customer-quote.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createApiRuntimeLogger, createApiServerRuntime } from "./server.js";

const runtimes: ReturnType<typeof createApiServerRuntime>[] = [];

function merchantRequest(root: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const request = httpRequest(`${root}/merchant/login`, { headers }, (response) => {
      response.on("error", reject);
      response.resume();
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      if (runtime.server.listening) await runtime.shutdown("SIGTERM");
    }),
  );
});

describe("WP-2207 runtime dependency wiring", () => {
  const syntheticOrigin = "https://merchant.invalid";
  const cartId = "018fc000-0000-7000-8000-000000000004";
  const quotePath = `/api/v1/carts/${cartId}/quote`;
  const qrToken = `e30.e30.${Buffer.alloc(64, 7).toString("base64url")}`;
  const guest = "g".repeat(43);
  const csrf = "c".repeat(43);

  it("dispatches injected dependencies, preserves guards and isolates unconfigured runtimes", async () => {
    const establish = vi.fn(async () => ({ status: "EntryUnavailable" as const }));
    const quoteCart = vi.fn(async () => ({ status: "VersionConflict" as const }));
    const start = vi.fn(async () => ({
      authorizationUrl: "https://synthetic-idp.invalid/authorize",
      cookie: { value: "" as const, descriptor: authorizationCookie, clear: true },
    }));
    const unexpected = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected synthetic service operation");
    });
    const service: MerchantBffService = {
      start,
      callback: unexpected,
      bootstrap: unexpected,
      authorize: unexpected,
      logout: unexpected,
      switchStore: unexpected,
    };
    let sequence = 10;
    const now = () => "2026-09-03T12:00:00.000Z";
    const output = logger();
    const configured = createApiServerRuntime({
      port: 0,
      logger: output.logger,
      customerEntry: new CustomerEntryHandler({
        allowedOrigin: syntheticOrigin,
        now,
        port: { establish },
        uuidV7Factory: () => `018fc000-0000-7000-8000-${(++sequence).toString().padStart(12, "0")}`,
      }),
      customerQuote: new CustomerQuoteHandler({
        allowedOrigin: syntheticOrigin,
        now,
        port: { quoteCart },
      }),
      merchantBff: { exactOrigin: syntheticOrigin, acceptedHost: "merchant.invalid", service },
    });
    const unconfigured = createApiServerRuntime({ port: 0, logger: logger().logger });
    runtimes.push(configured, unconfigured);
    await configured.listen();
    await unconfigured.listen();

    const headers = {
      origin: syntheticOrigin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
    };
    const entry = { method: "POST", headers, body: JSON.stringify({ qrToken }) };
    const quote = {
      method: "POST",
      headers: {
        ...headers,
        cookie: `__Host-bop-guest=${guest}`,
        "x-csrf-token": csrf,
        "idempotency-key": "018fc000-0000-7000-8000-000000000090",
      },
      body: JSON.stringify({ cartVersion: 7 }),
    };
    const entryResponse = await fetch(`${origin(configured)}/bff/customer/entry`, entry);
    expect(entryResponse.status).toBe(422);
    expect(await entryResponse.json()).toMatchObject({ code: "entry_unavailable" });
    expect(entryResponse.headers.get("cache-control")).toBe("no-store");
    expect(establish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ qrToken, requestedAt: now() }),
    );

    const quoteResponse = await fetch(`${origin(configured)}${quotePath}`, quote);
    expect(quoteResponse.status).toBe(409);
    expect(await quoteResponse.json()).toMatchObject({ error: { code: "quote_version_conflict" } });
    expect(quoteResponse.headers.get("cache-control")).toBe("no-store");
    expect(quoteCart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cartReference: cartId,
        expectedCartVersion: 7,
        guestCredential: guest,
      }),
    );

    const merchantHeaders = { ...headers, host: "merchant.invalid" };
    const login = await merchantRequest(origin(configured), merchantHeaders);
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("https://synthetic-idp.invalid/authorize");
    expect(login.headers["cache-control"]).toBe("no-store");
    expect(login.headers["set-cookie"]?.join("")).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(start).toHaveBeenCalledExactlyOnceWith("/");

    for (const [path, request] of [
      ["/bff/customer/entry", entry],
      [quotePath, quote],
    ] as const) {
      for (const deniedHeaders of [
        { ...request.headers, origin: "https://other.invalid" },
        { ...request.headers, "sec-fetch-site": "cross-site" },
      ]) {
        const denied = await fetch(`${origin(configured)}${path}`, {
          ...request,
          headers: deniedHeaders,
        });
        expect(denied.status).toBe(400);
        await denied.text();
      }
      const unavailable = await fetch(`${origin(unconfigured)}${path}`, request);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("cache-control")).toBe("no-store");
      await unavailable.text();
    }
    for (const deniedHeaders of [
      { ...merchantHeaders, host: "other.invalid" },
      { ...merchantHeaders, origin: "https://other.invalid" },
      { ...merchantHeaders, "sec-fetch-site": "cross-site" },
    ]) {
      const denied = await merchantRequest(origin(configured), deniedHeaders);
      expect(denied.status).toBe(403);
    }
    const missing = await merchantRequest(origin(unconfigured));
    expect(missing.status).toBe(404);
    expect(establish).toHaveBeenCalledTimes(1);
    expect(quoteCart).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(unexpected).not.toHaveBeenCalled();

    await configured.shutdown("SIGTERM");
    await unconfigured.shutdown("SIGTERM");
    expect(configured.server.listening).toBe(false);
    expect(unconfigured.server.listening).toBe(false);
    for (const sensitive of [qrToken, guest, csrf, cartId]) {
      expect(output.records.join("")).not.toContain(sensitive);
    }
  });
});

function logger() {
  const records: string[] = [];
  const destination: StructuredLogDestination = {
    write: (message) => records.push(String(message)),
  };
  return { logger: createApiRuntimeLogger(destination), records };
}

function origin(runtime: ReturnType<typeof createApiServerRuntime>): string {
  const address = runtime.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("WP-0043 API runtime lifecycle", () => {
  it("stays not ready until listening completes and the database probe succeeds", async () => {
    const healthReadiness = new HealthReadinessController({
      databaseProbe: () => "ready",
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const output = logger();
    const runtime = createApiServerRuntime({
      healthReadiness,
      logger: output.logger,
      port: 0,
    });
    runtimes.push(runtime);

    expect(await healthReadiness.readinessSnapshot()).toMatchObject({ status: "not_ready" });

    await runtime.listen();
    const response = await fetch(`${origin(runtime)}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkedAt: "2026-07-28T00:00:00.000Z",
      dependencies: { database: { required: true, status: "ready" } },
      service: "bop-rms-api",
      status: "ready",
    });
    expect(output.records.join("")).toContain('"event":"listening"');
  });

  it("enters drain synchronously before close and makes repeated shutdown idempotent", async () => {
    const healthReadiness = new HealthReadinessController({
      databaseProbe: () => "ready",
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const output = logger();
    const runtime = createApiServerRuntime({
      healthReadiness,
      logger: output.logger,
      port: 0,
    });
    runtimes.push(runtime);
    await runtime.listen();

    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");

    expect(second).toBe(first);
    expect(healthReadiness.resourceSnapshot().lifecycleState).toBe("draining");
    expect(await healthReadiness.readinessSnapshot()).toMatchObject({ status: "not_ready" });
    await expect(first).resolves.toBeUndefined();
    expect(runtime.server.listening).toBe(false);

    const records = output.records.join("");
    expect(records.match(/"event":"shutdown_started"/gu)).toHaveLength(1);
    expect(records.match(/"event":"shutdown_complete"/gu)).toHaveLength(1);
    expect(records).not.toContain("shutdown_failed");
  });

  it("preserves the truthful unconfigured database state in the real composition root", async () => {
    const output = logger();
    const runtime = createApiServerRuntime({ logger: output.logger, port: 0 });
    runtimes.push(runtime);

    await runtime.listen();
    const response = await fetch(`${origin(runtime)}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      dependencies: { database: { required: true, status: "not_configured" } },
      status: "not_ready",
    });
  });

  it("orders WP-0044 telemetry startup and bounded shutdown around runtime intake", async () => {
    const order: string[] = [];
    const completions: unknown[] = [];
    const coreTelemetry: CoreTelemetry = {
      startOperation(operation) {
        order.push(`core-start:${operation}`);
        return {
          complete(completion) {
            completions.push({ completion, operation });
            order.push(`core-complete:${operation}`);
          },
          run: (callback) => callback(),
        };
      },
    };
    const nodeTelemetry: NodeTelemetryRuntime = {
      enabled: true,
      shutdown: async () => {
        order.push("node-shutdown");
        return "success";
      },
      start: () => order.push("node-start"),
    };
    const milliseconds = [100, 107, 200, 211];
    const runtime = createApiServerRuntime({
      coreTelemetry,
      logger: logger().logger,
      nodeTelemetry,
      nowMilliseconds: () => milliseconds.shift() ?? 211,
      port: 0,
    });
    runtimes.push(runtime);

    await runtime.listen();
    await runtime.shutdown("SIGTERM");

    expect(order).toEqual([
      "node-start",
      "core-start:api_startup",
      "core-complete:api_startup",
      "core-start:api_shutdown",
      "core-complete:api_shutdown",
      "node-shutdown",
    ]);
    expect(completions).toEqual([
      {
        completion: { durationMs: 7, resultCode: "SUCCESS" },
        operation: "api_startup",
      },
      {
        completion: { durationMs: 11, resultCode: "SUCCESS" },
        operation: "api_shutdown",
      },
    ]);
  });

  it("isolates telemetry flush timeout from completed API shutdown", async () => {
    const output = logger();
    const nodeTelemetry: NodeTelemetryRuntime = {
      enabled: true,
      shutdown: async () => "timeout",
      start: () => undefined,
    };
    const runtime = createApiServerRuntime({
      logger: output.logger,
      nodeTelemetry,
      port: 0,
    });
    runtimes.push(runtime);
    await runtime.listen();

    await expect(runtime.shutdown("SIGTERM")).resolves.toBeUndefined();

    expect(output.records.join("")).toContain('"event":"telemetry_shutdown_failed"');
    expect(output.records.join("")).toContain('"resultCode":"TELEMETRY_SHUTDOWN_FAILED"');
  });
});
