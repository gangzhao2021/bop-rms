import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerDiningJoinHandler,
  customerDiningJoinRoute,
  type CustomerDiningJoinPort,
} from "./customer-dining-join.js";
import type { CustomerDiningJoinRequestContext } from "./customer-dining-join-composition.js";
const origin = "https://customer.example.test";
const op = "018f5800-0000-7000-8000-000000000001";
const admission = "018f5800-0000-7000-8000-000000000003";
const oldSession = "A".repeat(43),
  oldCsrf = "B".repeat(43);
const main = `__Host-bop-guest=${oldSession}`;
const result = { status: "Joined", operationReference: op, admissionReference: admission };
const context: CustomerDiningJoinRequestContext = { abuse: { admit: async () => "Admitted" } };
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
  return { join: vi.fn<CustomerDiningJoinPort["join"]>().mockResolvedValue(result) };
}
async function listen(
  service?: CustomerDiningJoinPort,
  resolveRequestContext: (
    request: Request,
  ) => Promise<CustomerDiningJoinRequestContext | null> = async () => context,
) {
  const server = createServer(
    createApp(
      service === undefined
        ? {}
        : {
            customerDiningJoin: new CustomerDiningJoinHandler({
              allowedOrigin: origin,
              port: service,
              resolveRequestContext,
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
  body: unknown = { joinCredential: "123456" },
  overrides: Record<string, string | string[]> = {},
  query = "",
): Promise<Response> {
  // Native HTTP preserves deliberately invalid/duplicate fetch metadata; fetch normalizes it.
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: server,
        path: customerDiningJoinRoute + query,
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

describe("same-origin Dining Join transport", () => {
  it.each(["123456", "000000", "AAAAAAAAAAAAAAAAAAAAAA"])(
    "forwards canonical framing %s and emits no Cookie",
    async (joinCredential) => {
      const service = port();
      const resolve = vi.fn(async (request: Request) => {
        expect(request.originalUrl).toBe(customerDiningJoinRoute);
        return context;
      });
      const response = await post(await listen(service, resolve), { joinCredential });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(service.join).toHaveBeenCalledWith(
        {
          operationReference: op,
          sessionCredential: oldSession,
          csrfCredential: oldCsrf,
          joinCredential,
        },
        context,
      );
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    },
  );
  it.each([
    {},
    null,
    [],
    { joinCredential: 123456 },
    { joinCredential: "１２３４５６" },
    { joinCredential: "12345" },
    { joinCredential: " 123456" },
    { joinCredential: "A".repeat(43) },
    { joinCredential: "A".repeat(21) + "B" },
    { joinCredential: "A".repeat(21) + "=" },
    { joinCredential: "123456", abuse: "Admitted" },
    { joinCredential: "123456", storeReference: admission },
  ])("denies malformed or expanded body %# before context", async (body) => {
    const service = port(),
      resolve = vi.fn(async () => context);
    const response = await post(await listen(service, resolve), body);
    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(service.join).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it.each([
    { origin: "https://other.example.test" },
    { origin: [origin, origin] },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": ["same-origin", "same-origin"] },
    { "sec-fetch-mode": "navigate" },
    { "sec-fetch-mode": ["cors", "cors"] },
    { "content-type": "text/plain" },
    { "content-type": ["application/json", "application/json"] },
    { "idempotency-key": "invalid" },
    { "idempotency-key": [op, op] },
    { "x-csrf-token": oldSession },
    { "x-csrf-token": [oldCsrf, oldCsrf] },
    { cookie: main + "; " + main },
    { cookie: "unrelated=value" },
  ])("denies invalid headers %#", async (headers) => {
    const service = port(),
      resolve = vi.fn(async () => context);
    const response = await post(await listen(service, resolve), undefined, headers);
    expect(response.status).toBe(400);
    expect(service.join).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  it("denies URL query without resolving context", async () => {
    const service = port();
    expect((await post(await listen(service), undefined, {}, "?credential=private")).status).toBe(
      400,
    );
    expect(service.join).not.toHaveBeenCalled();
  });
  it.each([null, "throw"])("requires request context %s", async (value) => {
    const service = port();
    const response = await post(
      await listen(service, async () => {
        if (value === "throw") throw new Error("private");
        return null;
      }),
    );
    expect(response.status).toBe(503);
    expect(service.join).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: { code: "dining_join_unavailable", messageKey: "customer.dining.join_unavailable" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it.each([
    { ...result, operationReference: admission },
    { ...result, admissionReference: "private" },
    { ...result, status: "AlreadyApplied" },
    { ...result, sessionCredential: oldSession },
    null,
  ])("rejects substituted or expanded owner response %#", async (value) => {
    const service = port();
    service.join.mockResolvedValue(value);
    const response = await post(await listen(service));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).not.toContain(oldSession);
  });
  it("bounds owner failure without reflecting credentials", async () => {
    const service = port();
    service.join.mockRejectedValue(new Error(oldSession));
    const response = await post(await listen(service));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(oldSession);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it("keeps concurrent request contexts distinct", async () => {
    const contexts: CustomerDiningJoinRequestContext[] = [];
    const service = port();
    const server = await listen(service, async () => {
      const current = { abuse: { admit: async () => "Admitted" as const } };
      contexts.push(current);
      await Promise.resolve();
      return current;
    });
    const responses = await Promise.all([post(server), post(server)]);
    expect(responses.map((value) => value.status)).toEqual([200, 200]);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(service.join.mock.calls.map((call) => call[1])).toEqual(contexts);
  });
  it("is unavailable without runtime injection", async () => {
    const response = await post(await listen());
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it.each([
    "http://customer.example.test",
    origin + "/",
    origin + "?x=1",
    "https://user@customer.example.test",
  ])("rejects inexact allowed origin %s", (allowedOrigin) => {
    expect(
      () =>
        new CustomerDiningJoinHandler({
          allowedOrigin,
          port: port(),
          resolveRequestContext: async () => context,
        }),
    ).toThrow();
  });
});
