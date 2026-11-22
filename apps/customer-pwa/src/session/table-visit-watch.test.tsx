// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DiningSessionClientError,
  type DiningSessionClient,
  type DiningSessionView,
} from "../dining/dining-session-client.js";
import {
  getCustomerCsrfCredential,
  getEndedTable,
  setCustomerCsrfCredential,
  setEmptyTable,
  setMovedTableLabel,
} from "./customer-transaction-context.js";
import { tableVisitWatchMs, useTableVisitEndWatch } from "./table-visit-watch.js";
import {
  getTableCheckout,
  noteTableCheckingOut,
  resetTableCheckout,
} from "../dining/table-checkout-state.js";

// Batch 47 (v15 b46 live): Menu (and a dish page, search, Cart) left open while staff closed and
// cleaned the table kept offering + until a reload. These tabs read the table as Your table does;
// when it says the phone is no longer seated, the restore read says how the visit ended.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const store = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const restoreAnswer = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const noCartCheck = async () => null;
function Watch(props: {
  readonly active: boolean;
  readonly pathname: string;
  readonly client: DiningSessionClient;
  /** Batch 48: the real browser cart read when "browser"; none by default. */
  readonly cart?: "browser";
}) {
  useTableVisitEndWatch({
    active: props.active,
    pathname: props.pathname,
    client: props.client,
    ...(props.cart === "browser" ? {} : { cartCheck: noCartCheck }),
  });
  return null;
}

let container: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetcher);
  setCustomerCsrfCredential("A".repeat(43));
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCustomerCsrfCredential("D".repeat(43));
  setCustomerCsrfCredential(null);
  setEmptyTable(null);
  setMovedTableLabel(null);
  resetTableCheckout();
});
const settle = async () => {
  for (let step = 0; step < 10; step += 1) await act(async () => Promise.resolve());
};

it("an open tab ends the visit within one table read after staff close the table", async () => {
  let closed = false;
  const view = { tableLabel: "E46 N (TEST)" } as unknown as DiningSessionView;
  const load = vi.fn(async () => {
    if (closed) throw new DiningSessionClientError("not-joined");
    return view;
  });
  fetcher.mockResolvedValue(
    restoreAnswer({ schemaVersion: 1, emptyTable: { tableLabel: "E46 N (TEST)", store } }),
  );
  act(() => root.render(<Watch active pathname="/menu" client={{ load }} />));
  await settle();
  // Opened: read at once; the table is open, so the restore read is not asked.
  expect(load).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  closed = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs);
  });
  await settle();
  expect(load).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(getCustomerCsrfCredential()).toBeNull();
  expect(getEndedTable()).toEqual({ kind: "Empty", tableLabel: "E46 N (TEST)", store });
});

it("a merged table's read (409 moved) shows where the party went", async () => {
  const load = vi.fn(async (): Promise<DiningSessionView> => {
    throw new DiningSessionClientError("moved", "E46 A (TEST)", true);
  });
  fetcher.mockResolvedValue(
    restoreAnswer({
      schemaVersion: 1,
      movedTable: { tableLabel: "E46 A (TEST)", merged: true, store },
    }),
  );
  act(() => root.render(<Watch active pathname="/cart" client={{ load }} />));
  await settle();
  expect(getEndedTable()).toEqual({
    kind: "Moved",
    tableLabel: "E46 A (TEST)",
    merged: true,
    nothingOrdered: false,
    store,
  });
});

it("a phone that never sat at a table, or a busy table read, changes nothing and is not read every 15 s", async () => {
  const load = vi.fn(async (): Promise<DiningSessionView> => {
    throw new DiningSessionClientError("not-joined");
  });
  // The restore read says the visit goes on (it only looks at the menu).
  fetcher.mockResolvedValue(restoreAnswer({ schemaVersion: 1, csrfToken: "A".repeat(43) }));
  act(() => root.render(<Watch active pathname="/menu" client={{ load }} />));
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs * 3);
  });
  await settle();
  expect(load).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(getCustomerCsrfCredential()).toBe("A".repeat(43));
  expect(getEndedTable()).toBeNull();
  // It joins a table (a new credential): read again.
  act(() => setCustomerCsrfCredential("B".repeat(43)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs);
  });
  await settle();
  expect(load).toHaveBeenCalledTimes(2);

  // A table read the Store couldn't answer is not "the table closed".
  const busy = vi.fn(async (): Promise<DiningSessionView> => {
    throw new DiningSessionClientError("unavailable");
  });
  fetcher.mockClear();
  act(() => root.render(<Watch active pathname="/cart" client={{ load: busy }} />));
  await settle();
  expect(busy).toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("reads nothing while inactive (Your table reads for itself) or with no visit", async () => {
  const load = vi.fn(async (): Promise<DiningSessionView> => {
    throw new DiningSessionClientError("not-joined");
  });
  act(() => root.render(<Watch active={false} pathname="/menu" client={{ load }} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs * 2);
  });
  expect(load).not.toHaveBeenCalled();
  setCustomerCsrfCredential(null);
  act(() => root.render(<Watch active pathname="/menu" client={{ load }} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs * 2);
  });
  expect(load).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

// Batch 48 (v15 b47 live, guest-open-page-after-close leftOpen (d)): a joined guest's Menu kept
// + while the table was checking out or paid in full. The cart read, in v15's 409 shape, says the
// table is checking out; the table read says whether its bill is paid; a 200 after staff's
// Cancel checkout gives + back. Cart reads its own cart, so the watch reads none there.
it("Menu learns from the cart read that the table is checking out, then paid, then reopened", async () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  let due = "1413";
  const load = vi.fn(
    async () =>
      ({
        tableLabel: "G47 P (TEST)",
        orderNumber: "21",
        checkedAt: new Date().toISOString(),
        paymentTiming: "PayLater",
        rounds: [{ roundNumber: 1 }],
        summary: {
          paid: money(due === "0" ? "1413" : "0"),
          refunded: money("0"),
          refundPending: money("0"),
          due: money(due),
        },
      }) as unknown as DiningSessionView,
  );
  let cart: "checking-out" | "open" = "checking-out";
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  fetcher.mockImplementation(async (input) => {
    expect(String(input)).toBe("/bff/customer/cart");
    return cart === "checking-out"
      ? json(409, {
          schemaVersion: 1,
          error: {
            code: "cart_table_checking_out",
            messageKey: "customer.cart.table_checking_out",
          },
        })
      : json(200, { schemaVersion: 1, cart: null });
  });
  act(() => root.render(<Watch active pathname="/menu" client={{ load }} cart="browser" />));
  await settle();
  expect(load).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(getTableCheckout()).toEqual({ paid: false, payLater: true });
  // The guest paid the whole table; staff have not closed it yet.
  due = "0";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs);
  });
  await settle();
  expect(getTableCheckout()).toEqual({ paid: true, payLater: true });
  // (Another table, nothing paid) staff pressed Cancel checkout: the cart answers again.
  cart = "open";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs);
  });
  await settle();
  expect(getTableCheckout()).toBeNull();
  // On Cart the page reads its own cart every 4 s: the watch reads only the table there.
  fetcher.mockClear();
  act(() => root.render(<Watch active pathname="/cart" client={{ load }} cart="browser" />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(tableVisitWatchMs);
  });
  await settle();
  expect(fetcher).not.toHaveBeenCalled();
});

// Batch 48 review: on Cart the page's own cart read says the table is checking out. That answer
// (participation, selection and catalog) is often slower than the table read; a paid table still
// says its bill is paid at once, from the table read already made, not 15 s later.
it("Cart's checking-out answer after the table read still says at once that the bill is paid", async () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const load = vi.fn(
    async () =>
      ({
        tableLabel: "G48 P (TEST)",
        paymentTiming: "PayLater",
        rounds: [{ roundNumber: 1 }],
        summary: {
          paid: money("1413"),
          refunded: money("0"),
          refundPending: money("0"),
          due: money("0"),
        },
      }) as unknown as DiningSessionView,
  );
  act(() => root.render(<Watch active pathname="/cart" client={{ load }} />));
  await settle();
  expect(load).toHaveBeenCalledTimes(1);
  expect(getTableCheckout()).toBeNull();
  // Cart's own read answers 409 cart_table_checking_out after the table read finished.
  act(() => noteTableCheckingOut(true));
  expect(getTableCheckout()).toEqual({ paid: true, payLater: true });
  expect(load).toHaveBeenCalledTimes(1);
});
