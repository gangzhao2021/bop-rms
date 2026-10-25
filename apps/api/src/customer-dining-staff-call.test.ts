import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerDiningStaffCallError,
  CustomerDiningStaffCallHandler,
  type createCustomerDiningStaffCall,
} from "./customer-dining-staff-call.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
const origin = "https://pilot.example";
const key = "01902423-0000-7000-8000-000000000001";
const callReference = "01902423-0000-7000-8000-000000000002";
type Port = ReturnType<typeof createCustomerDiningStaffCall>;
const openView = {
  open: { callReference, reason: "Question" as const, calledAt: "2026-10-25T09:00:00.000Z" },
  recentlyClosed: null,
  nextCallAt: null,
};

async function setup(port: Partial<Port>, enabled = true) {
  const read = vi.fn(port.read ?? (async () => openView));
  const call = vi.fn(port.call ?? (async () => ({ status: "Called" as const, view: openView })));
  const withdraw = vi.fn(port.withdraw ?? (async () => "Withdrawn" as const));
  const server = createServer(
    createApp(
      enabled
        ? {
            customerDiningStaffCall: new CustomerDiningStaffCallHandler({
              allowedOrigin: origin,
              port: { read, call, withdraw },
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const headers = {
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bop-guest=" + "s".repeat(43),
    "x-csrf-token": "c".repeat(43),
  };
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        ...headers,
        origin,
        "content-type": "application/json",
        "idempotency-key": key,
        ...extra,
      },
    });
  return {
    read,
    call,
    withdraw,
    get: (extra: Record<string, string> = {}) =>
      fetch(base + "/api/v1/dine-in/staff-call", { headers: { ...headers, ...extra } }),
    ask: (body: unknown, extra?: Record<string, string>) =>
      post("/api/v1/dine-in/staff-call", body, extra),
    withdrawCall: (body: unknown) => post("/api/v1/dine-in/staff-call/withdraw", body),
  };
}

it("WP-2423 Q28: reads the table's call with the guest's own credentials, never cached", async () => {
  const t = await setup({});
  const response = await t.get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ schemaVersion: 1, staffCall: openView });
  expect(t.read).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
  });
  // Another site, a query string or a missing credential is refused before any read.
  expect((await t.get({ origin: "https://elsewhere.example" })).status).toBe(400);
  expect((await t.get({ "x-csrf-token": "short" })).status).toBe(400);
  expect(t.read).toHaveBeenCalledOnce();
});

it("WP-2423 Q28: a guest not seated at a table has nothing to call from", async () => {
  const t = await setup({
    read: async () => {
      throw new CustomerDiningStaffCallError("NotJoined");
    },
  });
  expect((await t.get()).status).toBe(404);
});

it("WP-2423 Q28: asks with a reason and the request's own key, and says when staff were already asked", async () => {
  const t = await setup({});
  const created = await t.ask({ reason: "TableNeeds" });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ schemaVersion: 1, status: "Called", staffCall: openView });
  expect(t.call).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    operationReference: key,
    reason: "TableNeeds",
  });
  // No free text and no other fields; a key is required.
  expect((await t.ask({ reason: "TableNeeds", note: "nut allergy" })).status).toBe(400);
  expect((await t.ask({ reason: "TableNeeds" }, { "idempotency-key": "x" })).status).toBe(400);
  const again = await setup({
    call: async () => ({ status: "AlreadyOpen" as const, view: openView }),
  });
  const already = await again.ask({ reason: "Question" });
  expect(already.status).toBe(200);
  expect((await already.json()).status).toBe("AlreadyOpen");
});

it("WP-2423 Q28: too many calls says when the next one is possible", async () => {
  const retryAt = new Date(Date.now() + 90_000).toISOString();
  const t = await setup({ call: async () => ({ status: "TooManyCalls" as const, retryAt }) });
  const response = await t.ask({ reason: "Question" });
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await response.json()).retryAt).toBe(retryAt);
});

it("WP-2423 Q28: withdraws the open call by its reference", async () => {
  const t = await setup({});
  const response = await t.withdrawCall({ callReference });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ schemaVersion: 1, status: "Withdrawn" });
  expect(t.withdraw).toHaveBeenCalledWith(
    expect.objectContaining({ operationReference: key, callReference }),
  );
});

it("WP-2423 Q28: says the service is unavailable when it is not configured", async () => {
  const t = await setup({}, false);
  expect((await t.get()).status).toBe(503);
});
