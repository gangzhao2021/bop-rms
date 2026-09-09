import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { guestSessionCookie } from "@bop/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerCartBindingHandler,
  customerCartBindingRoutes,
  type CustomerCartBindingPort,
} from "./customer-cart-binding.js";
const origin = "https://customer.example.test";
const op = "018f5800-0000-7000-8000-000000000001";
const other = "018f5800-0000-7000-8000-000000000002";
const oldSession = "A".repeat(43),
  oldCsrf = "B".repeat(43),
  candidate = "C".repeat(43),
  csrf = "D".repeat(43),
  proof = "E".repeat(43);
const main = `__Host-bop-guest=${oldSession}`;
const staged = (operation = op) => `__Host-bop-guest-candidate-${operation}=${candidate}`;
const now = () => "2026-09-08T12:00:00.000Z";
const prepared = (operation = op) => ({
  status: "Prepared",
  operationReference: operation,
  sessionCredential: candidate,
  csrfCredential: csrf,
  recoveryProof: proof,
  expiresAt: "2026-09-08T12:05:00.000Z",
});
const activated = (operation = op) => ({
  status: "Activated",
  operationReference: operation,
  sessionCredential: candidate,
  csrfCredential: csrf,
  cookie: guestSessionCookie,
});
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
function port() {
  return {
    prepare: vi
      .fn<CustomerCartBindingPort["prepare"]>()
      .mockImplementation(async (input) => prepared(input.operationReference)),
    activate: vi
      .fn<CustomerCartBindingPort["activate"]>()
      .mockImplementation(async (input) => activated(input.operationReference)),
    complete: vi
      .fn<CustomerCartBindingPort["complete"]>()
      .mockImplementation(async (input) => activated(input.operationReference)),
  };
}
async function listen(service?: CustomerCartBindingPort) {
  const server = createServer(
    createApp(
      service === undefined
        ? {}
        : {
            customerCartBinding: new CustomerCartBindingHandler({
              allowedOrigin: origin,
              port: service,
              now,
            }),
          },
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
async function post(
  server: number,
  action: keyof typeof customerCartBindingRoutes,
  body: unknown = {},
  overrides: Record<string, string | string[]> = {},
  query = "",
): Promise<Response> {
  // Native HTTP preserves deliberately invalid/duplicate fetch metadata; fetch normalizes it.
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: server,
        path: customerCartBindingRoutes[action] + query,
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
          "idempotency-key": op,
          "x-csrf-token": oldCsrf,
          cookie: main,
          ...overrides,
        },
      },
      (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, values] of Object.entries(response.headers)) {
            if (values === undefined) continue;
            for (const value of Array.isArray(values) ? values : [values])
              headers.append(name, value);
          }
          resolve(new Response(text, { status: response.statusCode ?? 500, headers }));
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}
describe("same-origin binding credential transport", () => {
  it("stages only a candidate HttpOnly cookie and keeps Session credentials out of JSON", async () => {
    const service = port();
    const response = await post(await listen(service), "prepare");
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      `${staged()}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ]);
    const body = await response.json();
    expect(body).toEqual({
      status: "Prepared",
      operationReference: op,
      candidateCsrfToken: csrf,
      recoveryProof: proof,
      expiresAt: prepared().expiresAt,
    });
    expect(JSON.stringify(body)).not.toContain(candidate);
    expect(service.prepare).toHaveBeenCalledWith({
      operationReference: op,
      sessionCredential: oldSession,
      csrfCredential: oldCsrf,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("keeps distinct operation cookies for concurrent preparation responses", async () => {
    const server = await listen(port());
    const responses = await Promise.all([
      post(server, "prepare"),
      post(server, "prepare", {}, { "idempotency-key": other }),
    ]);
    expect(responses[0]?.headers.get("set-cookie")).toContain(staged(op));
    expect(responses[1]?.headers.get("set-cookie")).toContain(staged(other));
  });
  it("activates from the exact staged credential and clears only that stage", async () => {
    const service = port();
    const response = await post(
      await listen(service),
      "activate",
      { candidateCsrfToken: csrf, recoveryProof: proof },
      { cookie: `${main}; ${staged()}; ${staged(other)}` },
    );
    expect(response.status).toBe(200);
    expect(service.activate).toHaveBeenCalledWith({
      operationReference: op,
      sessionCredential: oldSession,
      csrfCredential: oldCsrf,
      candidateSessionCredential: candidate,
      candidateCsrfCredential: csrf,
      recoveryProof: proof,
    });
    expect(response.headers.getSetCookie()).toEqual([
      `__Host-bop-guest=${candidate}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      `__Host-bop-guest-candidate-${op}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    expect(await response.json()).toEqual({
      status: "Activated",
      operationReference: op,
      csrfToken: csrf,
    });
  });
  it.each([`${main}; ${staged()}`, `__Host-bop-guest=${candidate}`])(
    "completes when success headers were lost or already applied",
    async (cookie) => {
      const service = port();
      const response = await post(
        await listen(service),
        "complete",
        {},
        { cookie, "x-csrf-token": csrf },
      );
      expect(response.status).toBe(200);
      expect(service.complete).toHaveBeenCalledWith({
        operationReference: op,
        sessionCredential: candidate,
        csrfCredential: csrf,
      });
    },
  );
  it("never selects another operation's staged cookie", async () => {
    const service = port();
    const response = await post(
      await listen(service),
      "activate",
      { candidateCsrfToken: csrf, recoveryProof: proof },
      { cookie: `${main}; ${staged(other)}` },
    );
    expect(response.status).toBe(400);
    expect(service.activate).not.toHaveBeenCalled();
  });
  it.each([
    { origin: "https://evil.example.test" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-mode": "navigate" },
    { "content-type": "text/plain" },
    { "idempotency-key": "invalid" },
    { "x-csrf-token": "invalid" },
    { "x-csrf-token": [oldCsrf, oldCsrf] },
    { origin: [origin, origin] },
    { "content-type": ["application/json", "application/json"] },
    { cookie: `${main}; ${main}` },
    { cookie: `${main}; ${staged()}; ${staged()}` },
  ])("rejects invalid request headers before effects", async (headers) => {
    const service = port();
    const response = await post(await listen(service), "prepare", {}, headers);
    expect(response.status).toBe(400);
    expect(service.prepare).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it.each([null, [], { cartReference: op }, { sessionCredential: candidate }])(
    "rejects nonempty or malformed preparation bodies",
    async (body) => {
      const service = port();
      const response = await post(await listen(service), "prepare", body);
      expect(response.status).toBe(400);
      expect(service.prepare).not.toHaveBeenCalled();
    },
  );
  it("rejects URL query input", async () => {
    const service = port();
    expect((await post(await listen(service), "prepare", {}, {}, "?retry=1")).status).toBe(400);
    expect(service.prepare).not.toHaveBeenCalled();
  });
  it.each(["operation", "expired", "secret", "sameCredential"])(
    "validates preparation %s before setting cookies",
    async (kind) => {
      const service = port();
      const value = prepared();
      service.prepare.mockResolvedValue(
        kind === "operation"
          ? { ...value, operationReference: other }
          : kind === "expired"
            ? { ...value, expiresAt: now() }
            : kind === "secret"
              ? { ...value, secret: "synthetic" }
              : { ...value, csrfCredential: candidate },
      );
      const response = await post(await listen(service), "prepare");
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(JSON.stringify(await response.json())).not.toContain(candidate);
    },
  );
  it.each(["operation", "credential", "cookie"])(
    "denies substituted completion %s",
    async (kind) => {
      const service = port();
      const value = activated();
      service.complete.mockResolvedValue(
        kind === "operation"
          ? { ...value, operationReference: other }
          : kind === "credential"
            ? { ...value, sessionCredential: oldSession }
            : { ...value, cookie: { ...guestSessionCookie, httpOnly: false } },
      );
      const response = await post(
        await listen(service),
        "complete",
        {},
        { cookie: `${main}; ${staged()}`, "x-csrf-token": csrf },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );
  it("retains cookies and bounds a failed activation", async () => {
    const service = port();
    service.activate.mockRejectedValue(new Error("synthetic restricted failure"));
    const response = await post(
      await listen(service),
      "activate",
      { candidateCsrfToken: csrf, recoveryProof: proof },
      { cookie: `${main}; ${staged()}` },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "cart_binding_unavailable", messageKey: "customer.cart.binding_unavailable" },
    });
  });
  it("stays unavailable without application composition", async () => {
    const response = await post(await listen(), "prepare");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    "http://customer.example.test",
    "https://customer.example.test/",
    "https://user@customer.example.test",
  ])("requires an exact HTTPS origin", (allowedOrigin) => {
    expect(() => new CustomerCartBindingHandler({ allowedOrigin, port: port(), now })).toThrow();
  });
});
