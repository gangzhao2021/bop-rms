import type { AddressInfo } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizationCookie,
  platformAuthorizationCookie,
  workforceAuthorizationCookie,
  parseRawBrowserCredential,
} from "@bop/identity";
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
import * as brandRuntime from "./merchant-brand-administration-runtime.js";
import type { MerchantBrandAdministrationHttpOptions } from "./merchant-brand-administration-http.js";

const runtimes: ReturnType<typeof createApiServerRuntime>[] = [];

function merchantRequest(
  root: string,
  headers: Record<string, string> = {},
  path = "/merchant/login",
  options: { method?: string; body?: string } = {},
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const request = httpRequest(
      `${root}${path}`,
      { headers, method: options.method ?? "GET" },
      (response) => {
        response.on("error", reject);
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
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

  it("requires TLS and explicit Brand authentication before exposing the Brand application", () => {
    expect(() =>
      createApiServerRuntime({ brandApplication: (_request, _response, next) => next() }),
    ).toThrow("BRAND_APPLICATION_CONFIGURATION_INVALID");
    expect(() =>
      createApiServerRuntime({
        brandApplication: (_request, _response, next) => next(),
        tls: { key: "controlled", cert: "controlled" },
      }),
    ).toThrow("BRAND_APPLICATION_CONFIGURATION_INVALID");
    expect(() =>
      createApiServerRuntime({ tls: { key: "controlled", cert: "controlled" } }),
    ).toThrow("API_TLS_CONFIGURATION_INVALID");
  });

  it("serves the application and current API on one real TLS listener and drains it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bop-brand-tls-"));
    const keyFile = join(directory, "key.pem"),
      certificateFile = join(directory, "certificate.pem");
    let runtime: ReturnType<typeof createApiServerRuntime> | undefined;
    try {
      // Ephemeral synthetic TLS material, never a provisioned user certificate.
      await promisify(execFile)(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=Controlled local test",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-addext",
          "basicConstraints=critical,CA:FALSE",
          "-keyout",
          keyFile,
          "-out",
          certificateFile,
        ],
        { timeout: 30000, maxBuffer: 65536 },
      );
      const unavailable = async (): Promise<never> => {
        throw new Error("Controlled source unavailable");
      };
      const configured = {
        brandReference: null,
        exactOrigin: "https://127.0.0.1",
        acceptedHost: "127.0.0.1",
        authorizationOrigin: "https://identity.invalid",
        logoutUrl:
          "https://identity.invalid/logout?client_id=synthetic&logout_uri=https%3A%2F%2F127.0.0.1%2Fapp%2Forganization%2Fbrands",
        clock: { now: () => new Date().toISOString() },
        service: {
          start: unavailable,
          callback: unavailable,
          bootstrap: unavailable,
          authorize: unavailable,
          logout: unavailable,
          rotate: unavailable,
        },
      } as MerchantBrandAdministrationHttpOptions;
      runtime = createApiServerRuntime({
        port: 0,
        logger: logger().logger,
        tls: {
          key: await readFile(keyFile, "utf8"),
          cert: await readFile(certificateFile, "utf8"),
        },
        brandAdministration: configured,
        brandApplication: (request, response, next) => {
          if (request.path !== "/app/organization/brands") return next();
          response.type("html").send("<!doctype html><title>Controlled Brand entry</title>");
        },
      });
      runtimes.push(runtime);
      await runtime.listen();
      const address = runtime.server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing controlled TLS address");
      const get = (path: string) =>
        new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
          (resolve, reject) => {
            // Verification bypass is limited to this generated local test certificate.
            const request = httpsRequest(
              { hostname: "127.0.0.1", port: address.port, path, rejectUnauthorized: false },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (value) => {
                  body += String(value);
                });
                response.on("end", () =>
                  resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
                );
                response.on("error", reject);
              },
            );
            request.on("error", reject);
            request.end();
          },
        );
      const page = await get("/app/organization/brands");
      expect(page.status).toBe(200);
      expect(page.body).toContain("Controlled Brand entry");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");
      expect(page.headers["cache-control"]).toBe("no-store");
      expect((await get("/health")).status).toBe(200);
      expect((await get("/merchant/organization/brands/session")).status).toBe(403);
      await runtime.shutdown("SIGTERM");
      expect(runtime.server.listening).toBe(false);
    } finally {
      if (runtime?.server.listening) await runtime.shutdown("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous Merchant runtime inputs before constructing either dependency", () => {
    expect(() =>
      createApiServerRuntime({
        port: 0,
        merchantBff: {} as never,
        merchantRuntime: {} as never,
      }),
    ).toThrow("MERCHANT_RUNTIME_CONFIGURATION_CONFLICT");
  });

  it("rejects ambiguous Brand runtime inputs before constructing either dependency", () => {
    expect(() =>
      createApiServerRuntime({
        port: 0,
        brandAdministration: {} as never,
        brandAdministrationRuntime: {} as never,
      }),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_CONFIGURATION_CONFLICT");
  });
  it.each(["handler", "runtime"] as const)(
    "rejects concrete Workforce combined with a supplied Brand %s",
    (kind) => {
      expect(() =>
        createApiServerRuntime({
          port: 0,
          brandCognitoAdministrationRuntime: {} as never,
          ...(kind === "handler"
            ? { brandAdministration: {} as never }
            : { brandAdministrationRuntime: {} as never }),
        }),
      ).toThrow("BRAND_ADMINISTRATION_RUNTIME_CONFIGURATION_CONFLICT");
    },
  );
  it("rejects incomplete concrete Workforce startup before opening a server", () => {
    expect(() =>
      createApiServerRuntime({ port: 0, brandCognitoAdministrationRuntime: {} as never }),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
  });

  it("rejects ambiguous Platform authentication inputs before constructing either dependency", () => {
    expect(() =>
      createApiServerRuntime({
        port: 0,
        platformAuthentication: {} as never,
        platformAuthenticationRuntime: {} as never,
      }),
    ).toThrow("PLATFORM_AUTHENTICATION_RUNTIME_CONFIGURATION_CONFLICT");
  });

  it.each(["handler", "runtime"] as const)(
    "rejects concrete Cognito combined with a supplied Platform %s",
    (kind) => {
      expect(() =>
        createApiServerRuntime({
          port: 0,
          platformCognitoAuthenticationRuntime: {} as never,
          ...(kind === "handler"
            ? { platformAuthentication: {} as never }
            : { platformAuthenticationRuntime: {} as never }),
        }),
      ).toThrow("PLATFORM_AUTHENTICATION_RUNTIME_CONFIGURATION_CONFLICT");
    },
  );

  it("rejects incomplete concrete Cognito startup before opening a server", () => {
    expect(() =>
      createApiServerRuntime({ port: 0, platformCognitoAuthenticationRuntime: {} as never }),
    ).toThrow("PLATFORM_AUTHENTICATION_RUNTIME_UNAVAILABLE");
  });

  it("rejects competing Template handlers before constructing concrete Identity", () => {
    expect(() =>
      createApiServerRuntime({
        platformTemplateAdministration: {} as never,
        platformCognitoAuthenticationRuntime: { enableTemplateAdministration: true } as never,
      }),
    ).toThrow("PLATFORM_TEMPLATE_ADMINISTRATION_RUNTIME_CONFIGURATION_CONFLICT");
  });

  it("mounts only explicitly configured Template transport with fixed purpose routes", async () => {
    const query = vi.fn(async () => {
      throw new Error("controlled unavailable source");
    });
    const command = vi.fn(async () => {
      throw new Error("unexpected command");
    });
    const runtime = createApiServerRuntime({
      port: 0,
      logger: logger().logger,
      platformTemplateAdministration: {
        exactOrigin: "https://platform.invalid",
        acceptedHost: "platform.invalid",
        administration: { query, command },
      },
    });
    runtimes.push(runtime);
    await runtime.listen();
    const headers = {
      host: "platform.invalid",
      origin: "https://platform.invalid",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `__Host-bop-platform=${"p".repeat(43)}`,
      "x-bop-csrf": "c".repeat(43),
    };
    const request = { action: "List", after: null, limit: 20 };
    const result = await merchantRequest(origin(runtime), headers, "/platform/templates/query", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(result.status).toBe(503);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(query).toHaveBeenCalledExactlyOnceWith({
      sessionCookie: "p".repeat(43),
      csrf: "c".repeat(43),
      request,
    });
    expect(command).not.toHaveBeenCalled();
    expect((await merchantRequest(origin(runtime), headers, "/platform/tenants")).status).toBe(404);
    const unconfigured = createApiServerRuntime({ port: 0, logger: logger().logger });
    runtimes.push(unconfigured);
    await unconfigured.listen();
    expect(
      (
        await merchantRequest(origin(unconfigured), headers, "/platform/templates/query", {
          method: "POST",
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(404);
  });

  it("mounts isolated Platform authentication without granting a Tenant entry or Merchant session", async () => {
    const start = vi.fn(async () => ({
      authorizationUrl: "https://synthetic-platform-idp.invalid/authorize",
      cookie: {
        value: parseRawBrowserCredential("a".repeat(43)),
        descriptor: platformAuthorizationCookie,
        clear: false as const,
      },
    }));
    const unexpected = async (): Promise<never> => {
      throw new Error("unexpected controlled Platform service call");
    };
    const runtime = createApiServerRuntime({
      port: 0,
      logger: logger().logger,
      platformAuthentication: {
        exactOrigin: "https://platform.invalid",
        acceptedHost: "platform.invalid",
        authorizationOrigin: "https://synthetic-platform-idp.invalid",
        logoutUrl:
          "https://synthetic-platform-idp.invalid/logout?client_id=synthetic&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants",
        clock: { now: () => "2026-10-06T12:00:00.000Z" },
        service: {
          start,
          callback: unexpected,
          bootstrap: unexpected,
          startStepUp: unexpected,
          logout: unexpected,
        },
      },
    });
    runtimes.push(runtime);
    await runtime.listen();
    const headers = {
      host: "platform.invalid",
      "sec-fetch-site": "same-origin",
      origin: "https://platform.invalid",
    };
    const login = await merchantRequest(origin(runtime), headers, "/platform/auth/login");
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("https://synthetic-platform-idp.invalid/authorize");
    expect(login.headers["cache-control"]).toBe("no-store");
    expect(login.headers["set-cookie"]).toEqual([
      expect.stringMatching(
        /^__Host-bop-platform-auth=[a]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u,
      ),
    ]);
    expect(start).toHaveBeenCalledExactlyOnceWith("/platform/tenants");
    expect(
      (
        await merchantRequest(
          origin(runtime),
          { ...headers, host: "foreign.invalid" },
          "/platform/auth/login",
        )
      ).status,
    ).toBe(403);
    for (const path of ["/platform/tenants", "/merchant/session"])
      expect((await merchantRequest(origin(runtime), headers, path)).status).toBe(404);
    expect(start).toHaveBeenCalledTimes(1);
    const unconfigured = createApiServerRuntime({ port: 0, logger: logger().logger });
    runtimes.push(unconfigured);
    await unconfigured.listen();
    expect(
      (await merchantRequest(origin(unconfigured), headers, "/platform/auth/login")).status,
    ).toBe(404);
  });

  it.each(["handler", "concrete"] as const)(
    "mounts the noStore Brand entry through the %s server dependency without a Store runtime",
    async (mode) => {
      const brandReference = "018fc000-0000-7000-8000-000000000004";
      const start = vi.fn(async () => ({
        authorizationUrl: "https://synthetic-idp.invalid/authorize",
        cookie: {
          value: parseRawBrowserCredential("a".repeat(43)),
          descriptor: workforceAuthorizationCookie,
          clear: false,
        },
      }));
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected controlled service call");
      };
      const configured: MerchantBrandAdministrationHttpOptions = {
          brandReference,
          exactOrigin: syntheticOrigin,
          acceptedHost: "merchant.invalid",
          authorizationOrigin: "https://synthetic-idp.invalid",
          logoutUrl:
            "https://synthetic-idp.invalid/logout?client_id=synthetic&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands",
          clock: { now: () => "2026-09-03T12:00:00.000Z" },
          service: {
            start,
            callback: unexpected,
            bootstrap: unexpected,
            authorize: unexpected,
            rotate: unexpected,
            logout: unexpected,
          },
        },
        // Server wiring seam only; concrete Identity is separately owner/native verified.
        concreteInput = {} as brandRuntime.CognitoMerchantBrandAdministrationRuntimeOptions,
        factory =
          mode === "concrete"
            ? vi
                .spyOn(brandRuntime, "createCognitoMerchantBrandAdministrationRuntime")
                .mockReturnValue(configured)
            : null;
      const runtime = createApiServerRuntime({
        port: 0,
        logger: logger().logger,
        ...(mode === "handler"
          ? { brandAdministration: configured }
          : { brandCognitoAdministrationRuntime: concreteInput }),
      });
      if (factory) {
        expect(factory).toHaveBeenCalledExactlyOnceWith(concreteInput);
        factory.mockRestore();
      }
      runtimes.push(runtime);
      await runtime.listen();
      const result = await merchantRequest(
        origin(runtime),
        {
          host: "merchant.invalid",
          "sec-fetch-site": "same-origin",
          origin: syntheticOrigin,
        },
        "/merchant/organization/brands/login",
      );
      expect(result.status).toBe(303);
      expect(result.headers.location).toBe("https://synthetic-idp.invalid/authorize");
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(start).toHaveBeenCalledExactlyOnceWith(`/app/organization/brands/${brandReference}`);
      const denied = await merchantRequest(
        origin(runtime),
        { host: "foreign.invalid", "sec-fetch-site": "same-origin" },
        "/merchant/organization/brands/login",
      );
      expect(denied.status).toBe(403);
      expect(start).toHaveBeenCalledTimes(1);
    },
  );

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
        requestAdmission: { consume: async () => ({ status: "Allowed" }) }, // Explicit synthetic policy.
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
