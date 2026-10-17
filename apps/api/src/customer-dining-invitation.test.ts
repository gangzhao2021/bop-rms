import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerDiningInvitationError,
  CustomerDiningInvitationHandler,
  type createCustomerDiningInvitation,
} from "./customer-dining-invitation.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
const origin = "https://pilot.example";
const key = "01902423-0000-7000-8000-000000000001";
type Port = ReturnType<typeof createCustomerDiningInvitation>;

async function setup(port: Partial<Record<keyof Port, unknown>>, enabled = true) {
  const read = vi.fn(port.read as Port["read"]);
  const issue = vi.fn(port.issue as Port["issue"]);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerDiningInvitation: new CustomerDiningInvitationHandler({
              allowedOrigin: origin,
              port: { read, issue },
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1/dine-in/invitation";
  const headers = {
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bop-guest=" + "s".repeat(43),
    "x-csrf-token": "c".repeat(43),
  };
  return {
    read,
    issue,
    get: (extra: Record<string, string> = {}) => fetch(url, { headers: { ...headers, ...extra } }),
    post: (extra: Record<string, string> = {}, body = "{}") =>
      fetch(url, {
        method: "POST",
        body,
        headers: {
          ...headers,
          origin,
          "content-type": "application/json",
          "idempotency-key": key,
          ...extra,
        },
      }),
  };
}

it("tells the guest whether they may invite, from their own Guest Session only", async () => {
  const f = await setup({ read: async () => ({ canInvite: true }) });
  const response = await f.get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ schemaVersion: 1, invitation: { canInvite: true } });
  expect(f.read).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
  });
  // A cross-site request, a missing CSRF credential or a query never reaches the owner.
  expect((await f.get({ "sec-fetch-site": "cross-site" })).status).toBe(400);
  expect((await f.get({ "x-csrf-token": "short" })).status).toBe(400);
  expect(f.read).toHaveBeenCalledTimes(1);
});

it("issues a six-digit code once per request key and never echoes it again", async () => {
  const f = await setup({
    issue: async () => ({
      status: "Issued",
      code: "482913",
      expiresAt: "2026-10-17T18:15:00.000Z",
    }),
  });
  const response = await f.post();
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    invitation: { status: "Issued", code: "482913", expiresAt: "2026-10-17T18:15:00.000Z" },
  });
  expect(f.issue).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    operationReference: key,
  });
  // Mutations need the exact origin, a request key and an empty body.
  expect((await f.post({ origin: "https://evil.example" })).status).toBe(400);
  expect((await f.post({ "idempotency-key": "not-a-key" })).status).toBe(400);
  expect((await f.post({}, JSON.stringify({ table: "T4" }))).status).toBe(400);
  expect(f.issue).toHaveBeenCalledTimes(1);
});

it("maps refusals to stable public codes without internal detail", async () => {
  const cases = [
    [
      { status: "AlreadyIssued" },
      200,
      { schemaVersion: 1, invitation: { status: "AlreadyIssued" } },
    ],
    [{ status: "NotHost" }, 403, "dining_invitation_not_host"],
    [{ status: "TableChanged" }, 409, "dining_invitation_table_changed"],
  ] as const;
  for (const [result, status, body] of cases) {
    const f = await setup({ issue: async () => result });
    const response = await f.post();
    expect(response.status).toBe(status);
    const json = (await response.json()) as { error?: { code: string } };
    if (typeof body === "string") expect(json.error?.code).toBe(body);
    else expect(json).toEqual(body);
  }
  const retryAt = new Date(Date.now() + 90_000).toISOString();
  const limited = await setup({ issue: async () => ({ status: "TooManyInvitations", retryAt }) });
  const response = await limited.post();
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(89);
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: {
      code: "dining_invitation_rate_limited",
      messageKey: "customer.dining.invitation.rate_limited",
    },
    retryAt,
  });
});

it("answers not joined, invalid and unavailable uniformly", async () => {
  for (const [code, status] of [
    ["NotJoined", 404],
    ["Invalid", 400],
    ["Unavailable", 503],
  ] as const) {
    const f = await setup({
      read: async () => {
        throw new CustomerDiningInvitationError(code);
      },
      issue: async () => {
        throw new CustomerDiningInvitationError(code);
      },
    });
    expect((await f.get()).status).toBe(status);
    expect((await f.post()).status).toBe(status);
  }
  const f = await setup({}, false);
  expect((await f.get()).status).toBe(503);
  expect((await f.post()).status).toBe(503);
});
