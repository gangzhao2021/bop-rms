import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createGuestSessionCredentialProvider } from "@bop/identity";
import { OrderStatusProjectionError } from "@rms/ordering";
import { createApp } from "./app.js";
import {
  createCustomerContactRemovalHandler,
  CustomerContactRemovalError,
} from "./customer-contact-removal.js";
import { earlierVisitCredentials, earlierVisitInput } from "./customer-earlier-visit.js";
import { CustomerOrderStatusHandler } from "./customer-order-status.js";
import { CustomerPickupCodeHandler } from "./customer-pickup-code.js";

/**
 * WP-2423 (b11 guest-and-staff-wording): a paid pickup order kept on the phone after the guest
 * joined a table at the same Store is still that phone's: its page, pickup code and contact removal
 * answer for the kept visit, and only for a request that proved the current visit.
 */
const order = "0190ec15-0000-7000-8000-000000000001";
const credentials = createGuestSessionCredentialProvider(randomBytes(32));
const table = String(credentials.generateCredential("Session"));
const pickup = String(credentials.generateCredential("Session"));
const csrf = (session: string) => {
  const derive = credentials.deriveForegroundCsrf;
  if (derive === undefined) throw new Error("the provider derives CSRF");
  return String(derive.call(credentials, session as never));
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const forEarlierVisit = (
  input: { sessionCredential: string; csrfCredential: string; orderReference: string },
  earlier: string,
) => earlierVisitInput(credentials, input, earlier);
const headers = (visits: string | null, token = csrf(table)) => ({
  origin: "https://pilot.example",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  "x-csrf-token": token,
  cookie: `__Host-bop-guest=${table}` + (visits === null ? "" : `; __Host-bop-visits=${visits}`),
});

it("reads the earlier visits this phone keeps, never the current one or a malformed value", () => {
  expect(earlierVisitCredentials(`__Host-bop-visits=${pickup}.${table}`, table)).toEqual([pickup]);
  expect(earlierVisitCredentials(`a=b; __Host-bop-visits=${pickup}`, table)).toEqual([pickup]);
  expect(earlierVisitCredentials(`__Host-bop-visits=short`, table)).toEqual([]);
  expect(
    earlierVisitCredentials(`__Host-bop-visits=${pickup}; __Host-bop-visits=${pickup}`, table),
  ).toEqual([]);
  expect(earlierVisitCredentials(undefined, table)).toEqual([]);
});

it("uses a kept visit only for a request that proved the current one, with that visit's own CSRF", () => {
  const proved = { sessionCredential: table, csrfCredential: csrf(table), orderReference: order };
  expect(earlierVisitInput(credentials, proved, pickup)).toEqual({
    sessionCredential: pickup,
    csrfCredential: csrf(pickup),
    orderReference: order,
  });
  // The kept visit's CSRF, or any other, does not prove the current visit.
  for (const token of [csrf(pickup), "c".repeat(43)])
    expect(earlierVisitInput(credentials, { ...proved, csrfCredential: token }, pickup)).toBe(null);
  // No derivation configured: no kept visit is used.
  expect(earlierVisitInput({}, proved, pickup)).toBe(null);
});

it("the order page and its pickup code answer for the kept pickup visit; an outage is never retried as another visit", async () => {
  const denied = new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
  const read = vi.fn(async (input: { sessionCredential: string }) => {
    if (input.sessionCredential !== pickup) throw denied;
    return {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: order,
      projectedAt: "2026-11-12T12:00:00.000Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference: order,
        orderNumber: "7",
        orderType: "Pickup",
        canonicalPhase: "Ready",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-11-12T11:00:00.000Z",
        batches: [],
      },
    };
  });
  const code = vi.fn(async (input: { sessionCredential: string }) => {
    if (input.sessionCredential !== pickup) throw denied;
    return { schemaVersion: 1, status: "NotReady", orderReference: order };
  });
  const base = await listen(
    createApp({
      customerOrderStatus: new CustomerOrderStatusHandler({
        allowedOrigin: "https://pilot.example",
        port: { read: read as never, forEarlierVisit },
      }),
      customerPickupCode: new CustomerPickupCodeHandler({
        allowedOrigin: "https://pilot.example",
        port: { read: code as never, forEarlierVisit },
      }),
    }),
  );
  const get = (path: string, init: Record<string, string>) =>
    fetch(`${base}/api/v1/orders/${order}/${path}`, { headers: init });
  const status = await get("status", headers(pickup));
  expect(status.status).toBe(200);
  expect(
    ((await status.json()) as { status: { order: { orderNumber: string } } }).status.order
      .orderNumber,
  ).toBe("7");
  expect(read.mock.calls.map(([input]) => input.sessionCredential)).toEqual([table, pickup]);
  expect((await get("pickup-code", headers(pickup))).status).toBe(200);
  // Not proved, or nothing kept: as before, not this phone's order.
  expect((await get("status", headers(pickup, csrf(pickup)))).status).toBe(404);
  expect((await get("status", headers(null))).status).toBe(404);
  expect((await get("pickup-code", headers(null))).status).toBe(404);
  // An outage of the current visit's read is a retry, never answered from another visit.
  read.mockClear();
  read.mockRejectedValueOnce(new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"));
  expect((await get("status", headers(pickup))).status).toBe(503);
  expect(read).toHaveBeenCalledTimes(1);
});

it("removes the contact of an order the kept pickup visit placed", async () => {
  const port = vi.fn(async (input: { sessionCredential: string }) => {
    if (input.sessionCredential !== pickup) throw new CustomerContactRemovalError("NotFound");
    return Object.freeze({ status: "Removed" as const });
  });
  const base = await listen(
    createApp({
      customerContactRemoval: createCustomerContactRemovalHandler({
        allowedOrigin: "https://pilot.example",
        port: port as never,
        forEarlierVisit,
      }),
    }),
  );
  const remove = (init: Record<string, string>) =>
    fetch(`${base}/api/v1/orders/${order}/contact-removal`, {
      method: "POST",
      headers: init,
      body: "{}",
    });
  const removed = await remove(headers(pickup));
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ schemaVersion: 1, removal: { status: "Removed" } });
  expect(port.mock.calls.map(([input]) => input.sessionCredential)).toEqual([table, pickup]);
  expect((await remove(headers(pickup, csrf(pickup)))).status).toBe(404);
  expect((await remove(headers(null))).status).toBe(404);
  port.mockClear();
  port.mockRejectedValueOnce(new CustomerContactRemovalError("Unavailable"));
  expect((await remove(headers(pickup))).status).toBe(503);
  expect(port).toHaveBeenCalledTimes(1);
});
