// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { formatClockTime } from "../journey/format.js";
import type { CustomerOrderStatusClient } from "../order-status/order-status-controller.js";
import { EntryContextPage } from "./EntryContextPage.js";
import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryScreenState,
} from "./types.js";

// M105 B.3 (v15 batch 5): a phone that paid pickup order 13 at Test Merchant 2 scanned DEMO Store's
// pickup code and was shown order 13 under DEMO's code; then Test Merchant 2's own code, which
// went back to the kept visit, showed a fresh "Ready to order" without order 13.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const TM2 = "0190aa21-0000-7000-8000-0000000000b2";
const DEMO = "0190aa21-0000-7000-8000-0000000000d1";
const order13 = Object.freeze({
  orderReference: "0190aa21-0000-7000-8000-0000000000c1",
  orderNumber: "13",
  orderType: "Pickup" as const,
});
const pickupAt = (
  publicStoreReference: string,
  storeDisplayName: string,
  extra: Partial<CustomerEntryEstablishedContext> = {},
): CustomerEntryEstablishedContext => ({
  brandDisplayName: storeDisplayName,
  storeDisplayName,
  publicStoreReference,
  publicTableReference: null,
  channel: "Pickup",
  operatingState: "Open",
  availableServiceModes: ["Pickup"],
  locale: "en-CA",
  contextExpiresAt: "2026-11-11T20:00:00.000Z",
  csrfToken: "A".repeat(43),
  ...extra,
});
const client = (
  state: CustomerEntryScreenState,
  extra: Partial<CustomerEntryClient> = {},
): CustomerEntryClient => ({
  hasEntry: true,
  start: vi.fn(async () => state),
  retry: vi.fn(async () => state),
  startNew: vi.fn(async () => state),
  ...extra,
});
// The kept order's own status read, as the phone can still make it before the new Store starts.
const payBy = "2026-11-11T19:30:00.000Z";
const statusOf = (sources: object) => ({
  order: { orderType: "Pickup", canonicalPhase: "Submitted", batches: [] },
  sources: { checkedAt: "2026-11-11T19:05:00.000Z", kitchen: null, payments: [], ...sources },
});
// Paid: nothing is due any more.
const paid = statusOf({});
const unpaid = statusOf({
  paymentsDue: [{ orderBatchReference: "x", payBy, lastAttempt: "Open" }],
});
const reads = (load: () => Promise<unknown>): CustomerOrderStatusClient => ({
  load: vi.fn(load),
  subscribe: () => () => undefined,
});
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
async function open(props: Parameters<typeof EntryContextPage>[0]) {
  // The order's payment read is not part of this: it never answers.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => undefined)),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<EntryContextPage storeProfile={null} {...props} />} />
          <Route path="/menu" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await Promise.resolve();
    });
  return container;
}

it("another Store's pickup code opens that Store at once, and names the order kept elsewhere", async () => {
  const demo = client(
    { kind: "Established", context: pickupAt(DEMO, "DEMO Café") },
    { leavesPickupVisit: true },
  );
  const page = await open({
    client: demo,
    orderStatusClient: reads(async () => paid),
    currentOrder: order13,
    restoredStore: { publicStoreReference: TM2, storeDisplayName: "Test Merchant 2" },
  });
  const text = page.textContent ?? "";
  expect(text).not.toContain("Your order 13");
  expect(text).toContain("Pickup from DEMO Café");
  expect(text).toContain(
    "Your order at Test Merchant 2 is kept on this phone. Scan Test Merchant 2’s pickup QR code again to go back to it.",
  );
  expect(demo.start).toHaveBeenCalledTimes(1);
});

it("the same Store's pickup code still offers its order first", async () => {
  const same = client({ kind: "Established", context: pickupAt(TM2, "Test Merchant 2") });
  const page = await open({
    client: same,
    currentOrder: order13,
    restoredStore: { publicStoreReference: TM2, storeDisplayName: "Test Merchant 2" },
  });
  expect(page.textContent).toContain("Your order 13");
  expect(same.start).not.toHaveBeenCalled();
});

it("the kept Store's code shows the kept order at once, and Order more goes to its menu", async () => {
  const established = vi.fn();
  const kept = client({
    kind: "Established",
    context: pickupAt(TM2, "Test Merchant 2", { resumed: true }),
    currentOrder: order13,
  });
  const page = await open({ client: kept, onEstablished: established });
  expect(page.textContent).toContain("Your order 13");
  expect(page.textContent).toContain("View order 13");
  expect(page.textContent).not.toContain("Ready to order");
  // The menu is that Store's: its visit already went on.
  expect(established).toHaveBeenCalledWith(
    expect.objectContaining({ publicStoreReference: TM2, channel: "Pickup" }),
  );
  const more = [...page.querySelectorAll("button")].find((b) => b.textContent === "Order more");
  expect(more).toBeDefined();
  await act(async () => {
    more?.click();
  });
  expect(page.querySelector('[data-testid="where"]')?.textContent).toBe("/menu");
  expect(kept.startNew).not.toHaveBeenCalled();
});

it("another Store's code with the kept order still unpaid warns first, with its time and a way to pay", async () => {
  const demo = client(
    { kind: "Established", context: pickupAt(DEMO, "DEMO Café") },
    { leavesPickupVisit: true },
  );
  const page = await open({
    client: demo,
    orderStatusClient: reads(async () => unpaid),
    currentOrder: order13,
    restoredStore: { publicStoreReference: TM2, storeDisplayName: "Test Merchant 2" },
  });
  const time = formatClockTime(payBy);
  expect(page.textContent).toContain("Your order 13");
  expect(page.textContent).toContain(
    `Not paid yet. Pay by ${time}, or it is cancelled and you won’t be charged.`,
  );
  const pay = [...page.querySelectorAll("a")].find((a) => a.textContent === "Finish paying");
  expect(pay?.getAttribute("href")).toBe(`/orders/${order13.orderReference}`);
  // DEMO's visit has not started: paying still happens on Test Merchant 2's visit.
  expect(demo.start).not.toHaveBeenCalled();
  const onward = [...page.querySelectorAll("button")].find(
    (b) => b.textContent === "Order from the QR code you just scanned",
  );
  expect(onward).toBeDefined();
  await act(async () => {
    onward?.click();
  });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await Promise.resolve();
    });
  expect(demo.start).toHaveBeenCalledTimes(1);
  expect(demo.startNew).not.toHaveBeenCalled();
  const text = page.textContent ?? "";
  expect(text).toContain("Pickup from DEMO Café");
  // The warning stays on the page the guest goes on with.
  expect(text).toContain(
    `Your order at Test Merchant 2 isn’t paid yet. Pay by ${time}, or it is cancelled and you won’t be charged. Scan Test Merchant 2’s pickup QR code again to pay for it.`,
  );
});

it("another Store's code whose kept order can't be read shows that order first, never guessing it is paid", async () => {
  const demo = client(
    { kind: "Established", context: pickupAt(DEMO, "DEMO Café") },
    { leavesPickupVisit: true },
  );
  const page = await open({
    client: demo,
    orderStatusClient: reads(async () => {
      throw new Error("offline");
    }),
    currentOrder: order13,
    restoredStore: { publicStoreReference: TM2, storeDisplayName: "Test Merchant 2" },
  });
  expect(page.textContent).toContain("Your order 13");
  expect(page.textContent).not.toContain("Not paid yet");
  expect(demo.start).not.toHaveBeenCalled();
});
