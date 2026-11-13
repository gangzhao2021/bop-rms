import { afterEach, it, expect, vi } from "vitest";
import { recoverCustomerSession, restoreCustomerSession } from "./session-bootstrap.js";
import {
  getCustomerCsrfCredential,
  getCheckoutSessionReference,
  getEndedVisitReceiptAccess,
  setCustomerCsrfCredential,
  setEndedVisitReceiptAccess,
  getMovedTableLabel,
  setMovedTableLabel,
  getSettledTableLabel,
  setSettledTable,
  getSettledTableReceiptCsrf,
  isCustomerSessionRestoreUnavailable,
  setCustomerSessionRestoreUnavailable,
} from "./customer-transaction-context.js";
afterEach(() => {
  setCustomerSessionRestoreUnavailable(false);
  setCustomerCsrfCredential(null);
  setEndedVisitReceiptAccess(null);
  setMovedTableLabel(null);
  setSettledTable(null);
});
const response = (
  value: unknown = { schemaVersion: 1, csrfToken: "B".repeat(43) },
  cache = "no-store",
) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": cache },
  });
it("restores only in memory with same-origin cookie, no-store and bounded foreground fetch", async () => {
  const fetcher = vi.fn().mockResolvedValue(response());
  expect(await restoreCustomerSession(fetcher)).toBe(true);
  expect(getCustomerCsrfCredential()).toBe("B".repeat(43));
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/customer/session/csrf",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "x-bop-session-bootstrap": "1" },
    }),
  );
});
it("rejects caching, extra fields and oversized responses", async () => {
  for (const r of [
    response(undefined, "public"),
    response({ schemaVersion: 1, csrfToken: "B".repeat(43), secret: "x" }),
    response({ csrfToken: "x".repeat(2000) }),
  ]) {
    expect(await restoreCustomerSession(vi.fn().mockResolvedValue(r))).toBe(false);
    expect(getCustomerCsrfCredential()).toBeNull();
  }
});
it("never overwrites a changed session during an in-flight bootstrap", async () => {
  const fetcher = vi.fn().mockImplementation(async () => {
    setCustomerCsrfCredential("C".repeat(43));
    return response();
  });
  expect(await restoreCustomerSession(fetcher)).toBe(false);
  expect(getCustomerCsrfCredential()).toBe("C".repeat(43));
});
it("uses an existing foreground context and handles unavailable backend without credential persistence", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("unavailable"));
  expect(await restoreCustomerSession(fetcher)).toBe(false);
  setCustomerCsrfCredential("C".repeat(43));
  expect(await restoreCustomerSession(fetcher)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const menuContext = {
  publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
  channel: "DineIn",
  locale: "en-CA",
  brandDisplayName: "DEMO Brand",
  storeDisplayName: "DEMO Store",
};
it("restores public menu context with the same successful foreground session", async () => {
  const established = vi.fn();
  expect(
    await restoreCustomerSession(
      vi
        .fn()
        .mockResolvedValue(response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext })),
      established,
    ),
  ).toBe(true);
  expect(established).toHaveBeenCalledWith(menuContext);
});
it("rejects malformed or private context and never restores it after a session change", async () => {
  for (const context of [
    null,
    { ...menuContext, channel: "Delivery" },
    { ...menuContext, privateReference: "hidden" },
    { ...menuContext, publicStoreReference: "invalid" },
  ]) {
    const established = vi.fn();
    expect(
      await restoreCustomerSession(
        vi
          .fn()
          .mockResolvedValue(
            response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext: context }),
          ),
        established,
      ),
    ).toBe(false);
    expect(established).not.toHaveBeenCalled();
    expect(getCustomerCsrfCredential()).toBeNull();
  }
  const established = vi.fn();
  expect(
    await restoreCustomerSession(
      vi.fn().mockImplementation(async () => {
        setCustomerCsrfCredential("C".repeat(43));
        return response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext });
      }),
      established,
    ),
  ).toBe(false);
  expect(established).not.toHaveBeenCalled();
});

it("restores only the server checkout reference in memory without replaying Payment", async () => {
  const checkoutSessionReference = "0190fa21-0000-7000-8000-000000000002";
  const fetcher = vi.fn().mockResolvedValue(
    response({
      schemaVersion: 1,
      csrfToken: "B".repeat(43),
      menuContext,
      checkoutSessionReference,
    }),
  );
  expect(await restoreCustomerSession(fetcher)).toBe(true);
  expect(getCheckoutSessionReference()).toBe(checkoutSessionReference);
  expect(fetcher).toHaveBeenCalledTimes(1);
  setCustomerCsrfCredential(null);
  expect(getCheckoutSessionReference()).toBeNull();
});
it("rejects invalid recovery references before installing any session state", async () => {
  for (const checkoutSessionReference of [null, "invalid", 3, { secret: "hidden" }]) {
    expect(
      await restoreCustomerSession(
        vi
          .fn()
          .mockResolvedValue(
            response({ schemaVersion: 1, csrfToken: "B".repeat(43), checkoutSessionReference }),
          ),
      ),
    ).toBe(false);
    expect(getCustomerCsrfCredential()).toBeNull();
    expect(getCheckoutSessionReference()).toBeNull();
  }
});

it("WP-2423 Q10: restores the Session's current order and rejects malformed or private fields", async () => {
  const currentOrder = {
    orderReference: "0190fa21-0000-7000-8000-000000000003",
    orderNumber: "12",
    orderType: "Pickup",
  };
  const onOrder = vi.fn();
  expect(
    await restoreCustomerSession(
      vi
        .fn()
        .mockResolvedValue(
          response({ schemaVersion: 1, csrfToken: "B".repeat(43), currentOrder, menuContext }),
        ),
      undefined,
      onOrder,
    ),
  ).toBe(true);
  expect(onOrder).toHaveBeenCalledWith(currentOrder);
  for (const malformed of [
    { ...currentOrder, orderNumber: "0" },
    { ...currentOrder, orderType: "Delivery" },
    { ...currentOrder, guestSessionReference: "hidden" },
    { orderReference: currentOrder.orderReference },
  ]) {
    setCustomerCsrfCredential(null);
    const rejected = vi.fn();
    expect(
      await restoreCustomerSession(
        vi
          .fn()
          .mockResolvedValue(
            response({ schemaVersion: 1, csrfToken: "B".repeat(43), currentOrder: malformed }),
          ),
        undefined,
        rejected,
      ),
    ).toBe(false);
    expect(rejected).not.toHaveBeenCalled();
    expect(getCustomerCsrfCredential()).toBeNull();
  }
});

it("treats a first visit or an ended visit (204, no usable Guest Session) as nothing to restore", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 204, headers: { "cache-control": "no-store" } }),
    );
  expect(await restoreCustomerSession(fetcher)).toBe(false);
  expect(getCustomerCsrfCredential()).toBeNull();
});

it("WP-2423 (v15 3cd0f8dd M5): keeps an ended visit's receipt access apart, restoring nothing else", async () => {
  const order = {
    orderReference: "018f8a00-0000-7000-8000-000000000016",
    orderNumber: "22",
    orderType: "DineIn",
  };
  const fetcher = vi.fn().mockResolvedValue(
    response({
      schemaVersion: 1,
      endedVisit: {
        csrfToken: "C".repeat(43),
        order,
        receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
      },
    }),
  );
  const menu = vi.fn(),
    current = vi.fn();
  expect(await restoreCustomerSession(fetcher, menu, current)).toBe(false);
  expect(getCustomerCsrfCredential()).toBeNull();
  expect(menu).not.toHaveBeenCalled();
  expect(current).not.toHaveBeenCalled();
  const before = Date.parse("2026-10-18T18:00:00.000Z");
  expect(getEndedVisitReceiptAccess(order.orderReference, before)?.csrfToken).toBe("C".repeat(43));
  // Only for that order, only until its bound, and gone once a new visit starts.
  expect(getEndedVisitReceiptAccess("018f8a00-0000-7000-8000-000000000017", before)).toBeNull();
  expect(
    getEndedVisitReceiptAccess(order.orderReference, Date.parse("2026-10-18T18:01:49.437Z")),
  ).toBeNull();
  setCustomerCsrfCredential("D".repeat(43));
  expect(getEndedVisitReceiptAccess(order.orderReference, before)).toBeNull();
});

it("v15 2026-10-30: keeps where a moved party sits, restoring nothing to act with", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(response({ schemaVersion: 1, movedTable: { tableLabel: "DEMO-02" } }));
  const menu = vi.fn();
  expect(await restoreCustomerSession(fetcher, menu)).toBe(false);
  expect(getCustomerCsrfCredential()).toBeNull();
  expect(menu).not.toHaveBeenCalled();
  expect(getMovedTableLabel()).toBe("DEMO-02");
  // Joining a table (a new visit token) forgets it.
  setCustomerCsrfCredential("D".repeat(43));
  expect(getMovedTableLabel()).toBeNull();
  setCustomerCsrfCredential(null);
  // Anything but a plain table label is ignored.
  for (const movedTable of [{ tableLabel: "<b>" }, { tableLabel: "T7", extra: 1 }, "T7", null]) {
    fetcher.mockResolvedValue(response({ schemaVersion: 1, movedTable }));
    expect(await restoreCustomerSession(fetcher)).toBe(false);
    expect(getMovedTableLabel()).toBeNull();
  }
});

it("keeps that a guest's table was settled, with the value that reads its receipt", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    response({
      schemaVersion: 1,
      settledTable: { tableLabel: "DEMO-02", csrfToken: "C".repeat(43) },
    }),
  );
  const menu = vi.fn();
  expect(await restoreCustomerSession(fetcher, menu)).toBe(false);
  // Nothing to order or pay with.
  expect(getCustomerCsrfCredential()).toBeNull();
  expect(menu).not.toHaveBeenCalled();
  expect(getSettledTableLabel()).toBe("DEMO-02");
  expect(getSettledTableReceiptCsrf()).toBe("C".repeat(43));
  // A new visit forgets it.
  setCustomerCsrfCredential("D".repeat(43));
  expect(getSettledTableLabel()).toBeNull();
  expect(getSettledTableReceiptCsrf()).toBeNull();
  setCustomerCsrfCredential(null);
  // Anything malformed is ignored.
  for (const settledTable of [
    { tableLabel: "<b>", csrfToken: "C".repeat(43) },
    { tableLabel: "T7", csrfToken: "short" },
    { tableLabel: "T7" },
    { tableLabel: "T7", csrfToken: "C".repeat(43), extra: 1 },
    "T7",
    null,
  ]) {
    fetcher.mockResolvedValue(response({ schemaVersion: 1, settledTable }));
    expect(await restoreCustomerSession(fetcher)).toBe(false);
    expect(getSettledTableLabel()).toBeNull();
  }
});

// M02 (v15 07b7a1b7): a reloaded table page stays at its own table.
it("M02: restores a dine-in visit's table and joined state, only at a table and well formed", async () => {
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "DineIn",
    locale: "en-CA",
    brandDisplayName: "Lane Brand",
    storeDisplayName: "Lane Dessert",
  };
  const visit = { publicTableReference: "0190fa21-0000-7000-8000-000000000009", joined: true };
  const onVisit = vi.fn();
  expect(
    await restoreCustomerSession(
      vi
        .fn()
        .mockResolvedValue(
          response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext, visit }),
        ),
      undefined,
      undefined,
      onVisit,
    ),
  ).toBe(true);
  expect(onVisit).toHaveBeenCalledWith(visit);
  for (const body of [
    { menuContext, visit: { ...visit, joined: "yes" } },
    { menuContext, visit: { ...visit, extra: 1 } },
    { menuContext: { ...menuContext, channel: "Pickup" }, visit },
  ]) {
    setCustomerCsrfCredential(null);
    const rejected = vi.fn();
    expect(
      await restoreCustomerSession(
        vi
          .fn()
          .mockResolvedValue(response({ schemaVersion: 1, csrfToken: "B".repeat(43), ...body })),
        undefined,
        undefined,
        rejected,
      ),
    ).toBe(false);
    expect(rejected).not.toHaveBeenCalled();
    expect(getCustomerCsrfCredential()).toBeNull();
  }
});

it("M104 B.2: restores this visit's earlier orders under the latest, and refuses a malformed list", async () => {
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
  const restore = (body: object, onOrder = vi.fn()) =>
    restoreCustomerSession(
      vi
        .fn()
        .mockResolvedValue(
          response({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext, ...body }),
        ),
      undefined,
      onOrder,
    );
  const onOrder = vi.fn();
  expect(await restore({ currentOrder, earlierOrders: [earlier] }, onOrder)).toBe(true);
  expect(onOrder).toHaveBeenCalledWith({ ...currentOrder, earlier: [earlier] });
  for (const body of [
    { currentOrder, earlierOrders: [] },
    { currentOrder, earlierOrders: [{ ...earlier, orderNumber: "0" }] },
    { earlierOrders: [earlier] },
  ]) {
    setCustomerCsrfCredential(null);
    expect(await restore(body)).toBe(false);
  }
});

it("WP-2423 (rush-reads-and-orders-changes): a restore the store could not answer leaves the visit unknown, never ended, and is asked again", async () => {
  // v15 2026-11-13: the restore of a pickup guest who reloaded in a rush was answered busy (or
  // not in 5 s); the page read that as no visit and Checkout said the session had ended.
  const busy = new Response(JSON.stringify({ schemaVersion: 1 }), {
    status: 503,
    headers: { "retry-after": "5", "content-type": "application/json" },
  });
  expect(await restoreCustomerSession(vi.fn().mockResolvedValue(busy))).toBe(false);
  expect(getCustomerCsrfCredential()).toBeNull();
  expect(isCustomerSessionRestoreUnavailable()).toBe(true);
  // No answer in time (the request timed out or the network failed) is the same: not known.
  setCustomerSessionRestoreUnavailable(false);
  expect(await restoreCustomerSession(vi.fn().mockRejectedValue(new Error("timeout")))).toBe(false);
  expect(isCustomerSessionRestoreUnavailable()).toBe(true);
  // Asked again (once, however many ask), with the longer wait of a read in a rush.
  const fetcher = vi.fn().mockResolvedValue(response());
  await Promise.all([recoverCustomerSession(fetcher), recoverCustomerSession(fetcher)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(getCustomerCsrfCredential()).toBe("B".repeat(43));
  expect(isCustomerSessionRestoreUnavailable()).toBe(false);
  // With the credential back nothing is asked again.
  await recoverCustomerSession(fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("WP-2423 (rush-reads-and-orders-changes): the store's own answer settles it: no visit is no visit", async () => {
  setCustomerSessionRestoreUnavailable(true);
  const none = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  await recoverCustomerSession(none);
  expect(none).toHaveBeenCalledTimes(1);
  expect(getCustomerCsrfCredential()).toBeNull();
  expect(isCustomerSessionRestoreUnavailable()).toBe(false);
  // Nothing more to ask: the store said there is no visit.
  await recoverCustomerSession(none);
  expect(none).toHaveBeenCalledTimes(1);
  // A refusal (401) is an answer too.
  setCustomerSessionRestoreUnavailable(false);
  expect(
    await restoreCustomerSession(vi.fn().mockResolvedValue(new Response(null, { status: 401 }))),
  ).toBe(false);
  expect(isCustomerSessionRestoreUnavailable()).toBe(false);
});
