import { createServer, request as httpRequest, type Server } from "node:http";
import type {
  CoreTelemetry,
  CoreTelemetryBackend,
  CoreTelemetryCompletion,
  StructuredLogDestination,
} from "@bop-rms/observability";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createApiCoreTelemetry, createApiRuntimeLogger } from "./server.js";
import { merchantBrandAdministrationRoutes } from "./merchant-brand-administration-http.js";
import { platformAuthenticationRoutes } from "./platform-authentication-http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

function recorder() {
  const completions: { completion: CoreTelemetryCompletion; operation: string }[] = [];
  const starts: string[] = [];
  const telemetry: CoreTelemetry = {
    startOperation(operation) {
      starts.push(operation);
      return {
        complete(completion) {
          completions.push({ completion, operation });
        },
        run: (callback) => callback(),
      };
    },
  };
  return { completions, starts, telemetry };
}

async function start(
  telemetry: CoreTelemetry,
  options: Partial<Parameters<typeof createApp>[0]> = {},
) {
  let milliseconds = 1_000;
  const server = createServer(
    createApp({
      nowMilliseconds: () => {
        milliseconds += 7;
        return milliseconds;
      },
      telemetry,
      ...options,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

describe("WP-0044 API core telemetry", () => {
  it("WP-2227 records Entry, Quote and Merchant routes through the actual runtime factory", async () => {
    const recorded: (string | undefined)[] = [];
    const failures: string[] = [];
    let discarded = 0;
    const backend: CoreTelemetryBackend = {
      start() {
        return {
          complete: (record) => recorded.push(record.attributes["http.route"]),
          discard: () => {
            discarded += 1;
          },
          run: (callback) => callback(),
        };
      },
    };
    const unavailable = async () => {
      throw new Error("synthetic service unavailable");
    };
    const merchantBff = {
      exactOrigin: "",
      acceptedHost: "",
      service: {
        start: unavailable,
        callback: unavailable,
        bootstrap: unavailable,
        authorize: unavailable,
        logout: unavailable,
        switchStore: unavailable,
      },
    };
    const origin = await start(
      createApiCoreTelemetry({ backend, onSafeFailure: (code) => failures.push(code) }),
      {
        merchantBff,
        brandApplication: (request, response, next) => {
          if (
            request.path !== "/" &&
            !request.path.startsWith("/app/organization/brands") &&
            !request.path.startsWith("/assets/")
          )
            return next();
          response.type("html").send("<!doctype html><title>Controlled application</title>");
        },
        platformAuthentication: {
          exactOrigin: "https://platform.invalid",
          acceptedHost: "platform.invalid",
          authorizationOrigin: "https://identity.invalid",
          logoutUrl:
            "https://identity.invalid/logout?client_id=synthetic&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants",
          service: {
            start: unavailable,
            callback: unavailable,
            bootstrap: unavailable,
            startStepUp: unavailable,
            logout: unavailable,
          },
          clock: { now: () => "2026-10-06T12:00:00.000Z" },
        },
        platformTemplateAdministration: {
          exactOrigin: "https://platform.invalid",
          acceptedHost: "platform.invalid",
          administration: { query: unavailable, command: unavailable },
        },
        brandAdministration: {
          brandReference: "018f0000-0000-7000-8000-000000000001",
          exactOrigin: "https://brand.invalid",
          acceptedHost: "brand.invalid",
          authorizationOrigin: "https://identity.invalid",
          logoutUrl:
            "https://identity.invalid/logout?client_id=synthetic&logout_uri=https%3A%2F%2Fbrand.invalid%2Fapp%2Forganization%2Fbrands",
          service: { ...merchantBff.service, rotate: unavailable },
          clock: { now: () => "2026-10-06T12:00:00.000Z" },
        },
      },
    );
    merchantBff.exactOrigin = origin;
    merchantBff.acceptedHost = new URL(origin).host;
    const cases = [
      ["GET", "/", "/"],
      ["GET", "/app/organization/brands", "/app/organization/brands"],
      [
        "GET",
        "/app/organization/brands/018f0000-0000-7000-8000-000000000004",
        "/app/organization/brands/:brand_reference",
      ],
      ["GET", "/assets/index-controlled.js", "/assets/:basename"],
      ["POST", "/bff/customer/entry", "/bff/customer/entry"],
      [
        "POST",
        "/api/v1/carts/018f0000-0000-7000-8000-000000000004/quote",
        "/api/v1/carts/:cart_id/quote",
      ],
      ["GET", "/merchant/login", "/merchant/login"],
      ["GET", "/merchant/callback", "/merchant/callback"],
      ["GET", "/merchant/session", "/merchant/session"],
      ...platformAuthenticationRoutes.map((route) => [
        route.endsWith("/step-up") || route.endsWith("/logout") ? "POST" : "GET",
        route,
        route,
      ]),
      ["POST", "/platform/templates/query", "/platform/templates/query"],
      ["POST", "/platform/templates/command", "/platform/templates/command"],
      ...merchantBrandAdministrationRoutes.map((route) => [
        route.includes("/configuration/") ||
        route.includes("/catalog-source/") ||
        route.endsWith("/discovery/list") ||
        route.endsWith("/discovery/select") ||
        route.endsWith("/invitation") ||
        route.endsWith("/lifecycle") ||
        route.endsWith("/rotate") ||
        route.endsWith("/logout")
          ? "POST"
          : "GET",
        route,
        route,
      ]),
      [
        "GET",
        "/merchant/store-setup/fee-context-classifications",
        "/merchant/store-setup/fee-context-classifications",
      ],
      ["POST", "/merchant/store-context", "/merchant/store-context"],
      ["POST", "/merchant/logout", "/merchant/logout"],
      [
        "POST",
        "/merchant/organization/brands/topology/draft/workspace",
        "/merchant/organization/brands/topology/draft/workspace",
      ],
      [
        "POST",
        "/merchant/organization/brands/topology/draft/save",
        "/merchant/organization/brands/topology/draft/save",
      ],
      [
        "POST",
        "/merchant/organization/brands/topology/draft/resolve",
        "/merchant/organization/brands/topology/draft/resolve",
      ],

      [
        "POST",
        "/merchant/tax-config/authoring/materials/compare",
        "/merchant/tax-config/authoring/materials/compare",
      ],
      [
        "GET",
        "/merchant/tax-config/authoring/candidates/current",
        "/merchant/tax-config/authoring/candidates/current",
      ],
      [
        "GET",
        "/merchant/tax-config/authoring/candidates/roster",
        "/merchant/tax-config/authoring/candidates/roster",
      ],
      [
        "POST",
        "/merchant/tax-config/authoring/candidates/commands",
        "/merchant/tax-config/authoring/candidates/commands",
      ],
      [
        "POST",
        "/merchant/tax-config/authoring/candidates/resolve-original",
        "/merchant/tax-config/authoring/candidates/resolve-original",
      ],
      ["GET", "/not-a-registered-route", "unmatched"],
    ] as const;
    for (const [method, path] of cases) {
      const brandRoute =
        path?.startsWith("/merchant/organization/brands/") && !path.includes("/topology/");
      const platformRoute = path.startsWith("/platform/");
      if (brandRoute || platformRoute) {
        // Explicit Host is required for the separately configured Brand origin.
        // Node fetch may replace that header with the local listener hostname.
        await new Promise<void>((resolve, reject) => {
          const request = httpRequest(
            `${origin}${path}${path === "/platform/auth/callback" ? "?code=synthetic-private-code&state=synthetic-query" : ""}`,
            {
              method,
              headers: {
                host: platformRoute ? "platform.invalid" : "brand.invalid",
                origin: platformRoute ? "https://platform.invalid" : "https://brand.invalid",
                "sec-fetch-site": "same-origin",
                ...(platformRoute && method === "POST"
                  ? { "content-type": "application/json" }
                  : {}),
              },
            },
            (response) => {
              response.resume();
              response.on("end", resolve);
            },
          );
          request.on("error", reject);
          request.end(platformRoute && method === "POST" ? "{}" : undefined);
        });
        continue;
      }
      const response = await fetch(
        `${origin}${path}${brandRoute ? "" : "?probe=synthetic-query"}`,
        {
          method,
          redirect: "manual",
          headers: {
            origin: brandRoute ? "https://brand.invalid" : origin,
            ...(brandRoute ? { host: "brand.invalid" } : {}),
            "sec-fetch-site": "same-origin",
          },
        },
      );
      await response.arrayBuffer();
    }
    expect(recorded).toEqual(cases.map(([, , template]) => template));
    expect(discarded).toBe(0);
    expect(failures).toEqual([]);
    expect(JSON.stringify(recorded)).not.toMatch(
      /018f0000|synthetic-query|not-a-registered-route/u,
    );
  });

  it("uses only registered route templates and collapses unknown paths", async () => {
    const output = recorder();
    const origin = await start(output.telemetry);

    const health = await fetch(`${origin}/health?token=raw-secret`);
    const missing = await fetch(
      `${origin}/tenant/018f1f48-7b5d-7a01-8a1b-123456789abc?email=person@example.test`,
    );
    await Promise.all([health.arrayBuffer(), missing.arrayBuffer()]);

    expect(output.starts).toEqual(["http_request", "http_request"]);
    expect(output.completions).toEqual([
      {
        completion: {
          durationMs: 7,
          resultCode: "HTTP_SUCCESS",
          routeTemplate: "/health",
        },
        operation: "http_request",
      },
      {
        completion: {
          durationMs: 7,
          resultCode: "HTTP_CLIENT_ERROR",
          routeTemplate: "unmatched",
        },
        operation: "http_request",
      },
    ]);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("018f1f48");
    expect(serialized).not.toContain("person@example.test");
  });

  it("tracks only an internal failure code and preserves bounded response disclosure", async () => {
    const output = recorder();
    const logRecords: string[] = [];
    const destination: StructuredLogDestination = {
      write: (message) => logRecords.push(String(message)),
    };
    const errorLogger = createApiRuntimeLogger(destination);
    const origin = await start(output.telemetry, {
      correlationAcceptanceHandler: () => {
        throw new Error(
          "Bearer raw-secret Cookie=session person@example.test SELECT * FROM customer",
        );
      },
      errorLogger,
    });

    const response = await fetch(`${origin}/__acceptance/request-command-event`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    });
    expect(output.completions).toEqual([
      {
        completion: {
          durationMs: 7,
          errorCode: "INTERNAL_ERROR",
          resultCode: "HTTP_SERVER_ERROR",
          routeTemplate: "/__acceptance/request-command-event",
        },
        operation: "http_request",
      },
    ]);
    expect(JSON.parse(logRecords.join(""))).toMatchObject({
      correlationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      error: {
        code: "INTERNAL_ERROR",
        stack: expect.stringContaining("[REDACTED_FRAME]"),
      },
      event: "http_request_failed",
      resultCode: "INTERNAL_ERROR",
    });
    for (const canary of [
      "Bearer",
      "raw-secret",
      "Cookie",
      "session",
      "person@example.test",
      "SELECT",
      "customer",
    ])
      expect(logRecords.join("")).not.toContain(canary);
    expect(JSON.stringify(output.completions)).not.toContain("raw-secret");
    expect(JSON.stringify(output.completions)).not.toContain("person@example.test");
  });
});
