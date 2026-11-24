import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, it, expect, vi } from "vitest";
import { GuestSessionError } from "@bop/identity";
import { createApp } from "./app.js";
import { createCustomerSessionBootstrapHandler } from "./customer-session-bootstrap.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function setup(enabled = true) {
  const read = vi.fn().mockResolvedValue("B".repeat(43));
  const readEndedVisit = vi
    .fn()
    .mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const readMovedTable = vi.fn().mockResolvedValue(null);
  const readSettledTable = vi.fn().mockResolvedValue(null);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerSessionBootstrap: createCustomerSessionBootstrapHandler({
              allowedOrigin: "https://store.example",
              port: { read, readEndedVisit, readMovedTable, readSettledTable },
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/customer/session/csrf`;
  const headers = {
    "sec-fetch-site": "same-origin",
    "x-bop-session-bootstrap": "1",
    origin: "https://store.example",
    cookie: "__Host-bop-guest=" + "A".repeat(43),
  };
  return {
    read,
    readEndedVisit,
    readMovedTable,
    readSettledTable,
    request: (extra: Record<string, string> = {}, suffix = "") =>
      fetch(url + suffix, { headers: { ...headers, ...extra } }),
  };
}
it("returns only no-store foreground CSRF without setting or exposing a session cookie", async () => {
  const f = await setup(),
    r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.json()).toEqual({ schemaVersion: 1, csrfToken: "B".repeat(43) });
});
it("rejects cross-origin, navigation, missing marker, duplicate cookie and query input before authentication", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://other.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none" },
    { "x-bop-session-bootstrap": "" },
    { cookie: "__Host-bop-guest=" + "A".repeat(43) + "; __Host-bop-guest=" + "A".repeat(43) },
  ])
    expect((await f.request(headers)).status).toBe(400);
  expect((await f.request({}, "?session=untrusted")).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
it("answers a first visit without a Guest Session cookie with an empty 204, issuing nothing", async () => {
  const f = await setup();
  const r = await f.request({ cookie: "" });
  expect(r.status).toBe(204);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.text()).toBe("");
  expect(f.read).not.toHaveBeenCalled();
  // Without a cookie the request-shape checks still apply first.
  expect((await f.request({ cookie: "", "sec-fetch-site": "cross-site" })).status).toBe(400);
  expect((await f.request({ cookie: "", "x-bop-session-bootstrap": "" })).status).toBe(400);
  expect((await f.request({ cookie: "other=1" })).status).toBe(204);
  expect((await f.request({ cookie: "__Host-bop-guest=short" })).status).toBe(400);
});
it("answers an ended or expired visit like a first visit: an empty 204 with no token", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const r = await f.request();
  expect(r.status).toBe(204);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.text()).toBe("");
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("WP-2423 (v15 3cd0f8dd M5): gives a visit that ended its receipt access, nothing else", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const order = {
    orderReference: "018f8a00-0000-7000-8000-000000000016",
    orderNumber: "22",
    orderType: "DineIn",
  };
  f.readEndedVisit.mockResolvedValue({
    csrfToken: "C".repeat(43),
    order,
    receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  // No csrfToken at the top level: an older page treats it as nothing to restore.
  expect(await r.json()).toEqual({
    schemaVersion: 1,
    endedVisit: {
      csrfToken: "C".repeat(43),
      order,
      receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
    },
  });
  expect(f.readEndedVisit).toHaveBeenCalledWith("A".repeat(43));
  // Malformed owner output is never passed on.
  f.readEndedVisit.mockResolvedValue({
    csrfToken: "C".repeat(43),
    order: { ...order, orderType: "Delivery" },
    receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
  });
  expect((await f.request()).status).toBe(204);
  // A visit with no order (or past the 24 h bound) has nothing to restore.
  f.readEndedVisit.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  expect((await f.request()).status).toBe(204);
});
it("v15 2026-10-30: tells a phone whose party staff moved where it sits now, nothing else", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  f.readMovedTable.mockResolvedValue({ tableLabel: "DEMO-02" });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  // No CSRF token: the phone can't act for the party until it joins the new table.
  expect(await r.json()).toEqual({ schemaVersion: 1, movedTable: { tableLabel: "DEMO-02" } });
  expect(f.readMovedTable).toHaveBeenCalledWith("A".repeat(43));
  expect(f.readEndedVisit).not.toHaveBeenCalled();
  // A label that isn't plain text, or a Session the read can't use, is nothing to restore.
  f.readMovedTable.mockResolvedValue({ tableLabel: "<b>" });
  expect((await f.request()).status).toBe(204);
  f.readMovedTable.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  expect((await f.request()).status).toBe(204);
  // A read the store could not answer says nothing about the visit: busy, ask again.
  f.readMovedTable.mockRejectedValue(new Error("down"));
  const busy = await f.request();
  expect(busy.status).toBe(503);
  expect(busy.headers.get("retry-after")).toBe("5");
});
it("thanks a guest whose table was settled, with the ended visit's read-only receipt access", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  f.readSettledTable.mockResolvedValue({ tableLabel: "DEMO-02", csrfToken: "C".repeat(43) });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  // No top-level CSRF token: nothing to order or pay with; the value only reads the receipt.
  expect(await r.json()).toEqual({
    schemaVersion: 1,
    settledTable: { tableLabel: "DEMO-02", csrfToken: "C".repeat(43) },
  });
  expect(f.readSettledTable).toHaveBeenCalledWith("A".repeat(43));
  expect(f.readEndedVisit).not.toHaveBeenCalled();
  // A moved party is told where it sits (never "settled"); a bad label or failed read is ignored.
  f.readMovedTable.mockResolvedValueOnce({ tableLabel: "DEMO-03" });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    movedTable: { tableLabel: "DEMO-03" },
  });
  // Batch 44 (v15 b43 live): the Store's published names come along for the page's header; a
  // malformed name is left out, never the whole answer.
  f.readSettledTable.mockResolvedValue({
    tableLabel: "L43W A (TEST)",
    csrfToken: "C".repeat(43),
    store: {
      brandDisplayName: "Test Merchant 2 - not production",
      storeDisplayName: "Test Merchant 2 Main - not production",
    },
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    settledTable: {
      tableLabel: "L43W A (TEST)",
      csrfToken: "C".repeat(43),
      store: {
        brandDisplayName: "Test Merchant 2 - not production",
        storeDisplayName: "Test Merchant 2 Main - not production",
      },
    },
  });
  f.readSettledTable.mockResolvedValue({
    tableLabel: "L43W A (TEST)",
    csrfToken: "C".repeat(43),
    store: { brandDisplayName: " ", storeDisplayName: "x".repeat(201) },
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    settledTable: { tableLabel: "L43W A (TEST)", csrfToken: "C".repeat(43) },
  });
  f.readSettledTable.mockResolvedValue({ tableLabel: "<b>", csrfToken: "C".repeat(43) });
  expect((await f.request()).status).toBe(204);
  f.readSettledTable.mockResolvedValue({ tableLabel: "T7", csrfToken: "short" });
  expect((await f.request()).status).toBe(204);
  f.readSettledTable.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  expect((await f.request()).status).toBe(204);
  f.readSettledTable.mockRejectedValue(new Error("down"));
  expect((await f.request()).status).toBe(503);
});

// Batch 45 (v15 b44 live): staff closed and cleaned a table where nothing was ordered; a guest's
// reload of Your table heard "no visit" (204) and was asked for a join code under "Scan the
// location QR code to begin". The restore says the visit ended with nothing ordered, and names
// the Store, with nothing to act with.
it("tells a guest whose table closed with nothing ordered that its visit ended, with the Store", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const tm2 = {
    brandDisplayName: "Test Merchant 2 - not production",
    storeDisplayName: "Test Merchant 2 Main - not production",
  };
  f.readSettledTable.mockResolvedValue({
    tableLabel: "V44 A (TEST)",
    nothingOrdered: true,
    store: tm2,
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.json()).toEqual({
    schemaVersion: 1,
    emptyTable: { tableLabel: "V44 A (TEST)", store: tm2 },
  });
  expect(f.readEndedVisit).not.toHaveBeenCalled();
  // Without readable names the answer stays; a label that isn't plain text is nothing.
  f.readSettledTable.mockResolvedValue({ tableLabel: "V44 A (TEST)", nothingOrdered: true });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    emptyTable: { tableLabel: "V44 A (TEST)" },
  });
  f.readSettledTable.mockResolvedValue({ tableLabel: "<b>", nothingOrdered: true, store: tm2 });
  expect((await f.request()).status).toBe(204);
  // Batch 55 review (v15 b54, order 59): staff closed the bill when the guests left. No receipt,
  // so no receipt access: which table, whether anything was paid first, and the Store.
  f.readSettledTable.mockResolvedValue({
    tableLabel: "L54 GB2 (TEST)",
    closedByStaff: "Nothing",
    store: tm2,
  });
  const closed = await f.request();
  expect(closed.status).toBe(200);
  expect(await closed.json()).toEqual({
    schemaVersion: 1,
    closedTable: { tableLabel: "L54 GB2 (TEST)", paid: "Nothing", store: tm2 },
  });
  f.readSettledTable.mockResolvedValue({ tableLabel: "L54 GB2 (TEST)", closedByStaff: "Some" });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    closedTable: { tableLabel: "L54 GB2 (TEST)", paid: "Some" },
  });
  f.readSettledTable.mockResolvedValue({ tableLabel: "L54 GB2 (TEST)", closedByStaff: "All" });
  expect((await f.request()).status).toBe(204);
  // Batch 56 (v15 b55 live, L55 CB3 order 80): the phone that paid part 1 ($14.13) is told what
  // it paid, with read-only access to its own payment's receipt; malformed, it is left out.
  f.readSettledTable.mockResolvedValue({
    tableLabel: "L55 CB3 (TEST)",
    closedByStaff: "Some",
    store: tm2,
    yourPayment: { amountMinor: "1413", method: "Online" },
    csrfToken: "C".repeat(43),
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    closedTable: {
      tableLabel: "L55 CB3 (TEST)",
      paid: "Some",
      store: tm2,
      yourPayment: { amountMinor: "1413", method: "Online" },
      csrfToken: "C".repeat(43),
    },
  });
  // Batch 57 (Q36): with what went back to its card; never more than it paid.
  f.readSettledTable.mockResolvedValue({
    tableLabel: "L55 CB3 (TEST)",
    closedByStaff: "Some",
    yourPayment: { amountMinor: "1413", method: "Online", refundedMinor: "800" },
    csrfToken: "C".repeat(43),
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    closedTable: {
      tableLabel: "L55 CB3 (TEST)",
      paid: "Some",
      yourPayment: { amountMinor: "1413", method: "Online", refundedMinor: "800" },
      csrfToken: "C".repeat(43),
    },
  });
  // Batch 60: and what of it is still on its way (never more than went back, never without it).
  f.readSettledTable.mockResolvedValue({
    tableLabel: "L55 CB3 (TEST)",
    closedByStaff: "Some",
    yourPayment: {
      amountMinor: "1413",
      method: "Online",
      refundedMinor: "800",
      refundPendingMinor: "300",
    },
    csrfToken: "C".repeat(43),
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    closedTable: {
      tableLabel: "L55 CB3 (TEST)",
      paid: "Some",
      yourPayment: {
        amountMinor: "1413",
        method: "Online",
        refundedMinor: "800",
        refundPendingMinor: "300",
      },
      csrfToken: "C".repeat(43),
    },
  });
  for (const yourPayment of [
    { amountMinor: "1413", method: "Online", refundedMinor: "800", refundPendingMinor: "801" },
    { amountMinor: "1413", method: "Online", refundPendingMinor: "300" },
    { amountMinor: "1413", method: "Online", refundedMinor: "800", refundPendingMinor: "0" },
    { amountMinor: "0", method: "Online" },
    { amountMinor: "14.13", method: "Online" },
    { amountMinor: "1413", method: "Cash" },
    { amountMinor: "1413", method: "Online", refundedMinor: "1414" },
    { amountMinor: "1413", method: "Online", refundedMinor: "0" },
  ]) {
    f.readSettledTable.mockResolvedValue({
      tableLabel: "L55 CB3 (TEST)",
      closedByStaff: "Some",
      yourPayment,
      csrfToken: "C".repeat(43),
    });
    expect(await (await f.request()).json()).toEqual({
      schemaVersion: 1,
      closedTable: { tableLabel: "L55 CB3 (TEST)", paid: "Some" },
    });
  }
  // A moved (or merged) party's answer names the Store too, for the page's header.
  f.readMovedTable.mockResolvedValue({ tableLabel: "V44 B (TEST)", merged: true, store: tm2 });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    movedTable: { tableLabel: "V44 B (TEST)", merged: true, store: tm2 },
  });
  f.readMovedTable.mockResolvedValue({
    tableLabel: "V44 B (TEST)",
    store: { brandDisplayName: "", storeDisplayName: "x" },
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    movedTable: { tableLabel: "V44 B (TEST)" },
  });
  // Batch 46 (v15 b45 live): a party that had ordered nothing is said so (and only as true).
  f.readMovedTable.mockResolvedValue({
    tableLabel: "E45 A (TEST)",
    merged: true,
    nothingOrdered: true,
    store: tm2,
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    movedTable: { tableLabel: "E45 A (TEST)", merged: true, nothingOrdered: true, store: tm2 },
  });
  f.readMovedTable.mockResolvedValue({ tableLabel: "E45 A (TEST)", nothingOrdered: false });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    movedTable: { tableLabel: "E45 A (TEST)" },
  });
});

it("WP-2423 (rush-reads-and-orders-changes): a Session read the store could not answer is busy, never an ended visit", async () => {
  // v15 2026-11-13: in a rush the Session read found no free connection. Identity said so
  // (`dependencyFailure`), but the answer was the ended-visit 204, so a pickup guest's checkout
  // said "Your session ended. Scan the location QR code again" and Continue stayed disabled.
  const f = await setup();
  const passing = () =>
    Object.assign(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"), {
      dependencyFailure: true,
      cause: Object.assign(new Error("acquire"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" }),
    });
  f.read.mockRejectedValue(passing());
  const r = await f.request();
  expect(r.status).toBe(503);
  expect(r.headers.get("retry-after")).toBe("5");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toEqual({ schemaVersion: 1, error: { code: "session_unavailable" } });
  // Nothing else is read for a visit that could not be read at all.
  expect(f.readMovedTable).not.toHaveBeenCalled();
  expect(f.readEndedVisit).not.toHaveBeenCalled();
  // The visit is not usable, but the ended-visit reads met the same rush: still busy, not 204.
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  f.readEndedVisit.mockRejectedValue(passing());
  const ended = await f.request();
  expect(ended.status).toBe(503);
  expect(ended.headers.get("retry-after")).toBe("5");
});

it("WP-2423 (rush-reads-and-orders-changes review): what no wait can change is nothing to restore, never busy for ever", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const order = {
    orderReference: "018f8a00-0000-7000-8000-000000000016",
    orderNumber: "22",
    orderType: "DineIn",
  };
  // Stored data the page can't be given: a malformed credential or order reference.
  f.readEndedVisit.mockResolvedValue({
    csrfToken: "short",
    order,
    receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
  });
  expect((await f.request()).status).toBe(204);
  f.readEndedVisit.mockResolvedValue({
    csrfToken: "C".repeat(43),
    order: { ...order, orderReference: "not-a-reference" },
    receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
  });
  expect((await f.request()).status).toBe(204);
  // An input refusal of the owner (an *_INVALID code) is an answer too.
  f.readEndedVisit.mockRejectedValue(
    Object.assign(new Error("ORDERING_INPUT_INVALID"), { code: "ORDERING_INPUT_INVALID" }),
  );
  expect((await f.request()).status).toBe(204);
  f.readMovedTable.mockRejectedValue(
    Object.assign(new Error("DINING_SESSION_INPUT_INVALID"), {
      code: "DINING_SESSION_INPUT_INVALID",
    }),
  );
  expect((await f.request()).status).toBe(204);
  // The same refusal over a database failure is the rush, not an answer.
  f.readMovedTable.mockRejectedValue(
    Object.assign(new Error("DINING_SESSION_INPUT_INVALID"), {
      code: "DINING_SESSION_INPUT_INVALID",
      cause: Object.assign(new Error("canceling statement"), { code: "57014", severity: "ERROR" }),
    }),
  );
  expect((await f.request()).status).toBe(503);
});
it("conceals other Session failures and fails safely without configuration", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT"));
  const r = await f.request();
  expect(r.status).toBe(401);
  expect(JSON.stringify(await r.json())).not.toContain("A".repeat(43));
  f.read.mockRejectedValue(new Error("database down"));
  expect((await f.request()).status).toBe(503);
  expect((await (await setup(false)).request()).status).toBe(503);
});

it("returns whitelisted public menu context from the authenticated bootstrap port", async () => {
  const f = await setup();
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "DineIn",
    locale: "en-CA",
    brandDisplayName: "DEMO Brand",
    storeDisplayName: "DEMO Store",
  };
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    menuContext: { ...menuContext, privateReference: "must-not-leak" },
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext });
});

it("whitelists a recovery reference and refuses malformed owner output", async () => {
  const f = await setup();
  const checkoutSessionReference = "0190fa21-0000-7000-8000-000000000002";
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    checkoutSessionReference,
    paymentOperationReference: "hidden",
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    csrfToken: "B".repeat(43),
    checkoutSessionReference,
  });
  f.read.mockResolvedValue({ csrfToken: "B".repeat(43), checkoutSessionReference: "invalid" });
  expect((await f.request()).status).toBe(503);
});

it("WP-2423 Q10: returns the Session's latest order so a reopened app can continue it", async () => {
  const f = await setup();
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "Pickup",
    locale: "en-CA",
    brandDisplayName: "DEMO Brand",
    storeDisplayName: "DEMO Store",
  };
  const currentOrder = {
    orderReference: "0190fa21-0000-7000-8000-000000000003",
    orderNumber: "12",
    orderType: "Pickup",
  };
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    currentOrder: { ...currentOrder, guestSessionReference: "must-not-leak" },
    menuContext,
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body).toEqual({ schemaVersion: 1, csrfToken: "B".repeat(43), currentOrder, menuContext });
  for (const malformed of [
    { ...currentOrder, orderNumber: "0" },
    { ...currentOrder, orderType: "Delivery" },
    { ...currentOrder, orderReference: "not-a-reference" },
  ]) {
    f.read.mockResolvedValue({ csrfToken: "B".repeat(43), currentOrder: malformed, menuContext });
    expect((await f.request()).status).toBe(503);
  }
});

it("M104 B.2: lists this visit's earlier orders under the latest, whitelisted", async () => {
  const f = await setup();
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "Pickup",
    locale: "en-CA",
    brandDisplayName: "DEMO Brand",
    storeDisplayName: "DEMO Store",
  };
  const currentOrder = {
    orderReference: "0190fa21-0000-7000-8000-000000000003",
    orderNumber: "12",
    orderType: "Pickup",
  };
  const earlier = {
    orderReference: "0190fa21-0000-7000-8000-000000000002",
    orderNumber: "11",
    orderType: "Pickup",
  };
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    currentOrder,
    earlierOrders: [{ ...earlier, createdAt: "must-not-leak" }],
    menuContext,
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    schemaVersion: 1,
    csrfToken: "B".repeat(43),
    currentOrder,
    earlierOrders: [earlier],
    menuContext,
  });
  for (const earlierOrders of [
    [],
    [{ ...earlier, orderNumber: "0" }],
    Array.from({ length: 5 }, () => earlier),
  ]) {
    f.read.mockResolvedValue({
      csrfToken: "B".repeat(43),
      currentOrder,
      earlierOrders,
      menuContext,
    });
    expect((await f.request()).status).toBe(503);
  }
});

it("M02: passes a dine-in visit's table and joined state, whitelisted, and refuses a malformed one", async () => {
  const f = await setup();
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "DineIn",
    locale: "en-CA",
    brandDisplayName: "DEMO Brand",
    storeDisplayName: "DEMO Store",
  };
  const visit = { publicTableReference: "0190fa21-0000-7000-8000-000000000009", joined: true };
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    menuContext,
    visit: { ...visit, diningSessionReference: "must-not-leak" },
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    csrfToken: "B".repeat(43),
    menuContext,
    visit,
  });
  for (const malformed of [
    { ...visit, joined: "yes" },
    { ...visit, publicTableReference: "table-1" },
  ]) {
    f.read.mockResolvedValue({ csrfToken: "B".repeat(43), menuContext, visit: malformed });
    expect((await f.request()).status).toBe(503);
  }
  // Only at a table.
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    menuContext: { ...menuContext, channel: "Pickup" },
    visit,
  });
  expect((await f.request()).status).toBe(503);
});
