// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CurrentOrderDetails } from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import {
  buttonNamed,
  click,
  mount,
  selectValue,
  settle,
  typeInto,
} from "./dom-test-kit.fixture.js";

/**
 * Batch 64 (v15 b63, order 32): right after a refund to the guest's card, the order panel's Paid
 * section showed "Refunded to the card … −$5.00" while the totals above it still read "Total
 * $14.13", with no refund row, for 3-5 s until the page's next poll. The Paid section now tells the
 * order when a refund changes (made here, or answered by the card company on a later read), and
 * the order rereads its totals at once. Synthetic TEST data.
 */
afterEach(() => vi.useRealTimers());

const id = (n: number) => "01909964-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const order = parseCurrentOrderQueue({
  items: [
    {
      orderReference: id(32),
      orderNumber: "32",
      orderType: "DineIn",
      sourceChannel: "Web",
      submittedAt: "2026-11-25T17:15:00.000Z",
      observedAt: "2026-11-25T17:20:00.000Z",
      initialBatchReference: id(232),
      batches: [
        {
          orderBatchReference: id(232),
          sequence: 1,
          acceptanceStatus: "Accepted",
          canRequestAcceptance: false,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
        },
      ],
      canRequestAcceptance: false,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: false,
      currentPhase: "Fulfilled",
      currentVersion: 3,
    },
  ],
  nextAfterOrderReference: null,
}).items[0];

const payment = (onlineRefunds: unknown[]) => ({
  payment: {
    partNumber: null,
    method: "Online",
    roundsMinor: "1413",
    tipMinor: "0",
    roundingMinor: "0",
    totalMinor: "1413",
    takenAt: "2026-11-25T17:21:00.000Z",
    cashRefunds: [],
    cardRefunds: [],
    onlineRefunds,
    refundableMinor: onlineRefunds.length === 0 ? "1413" : "913",
  },
  canRefund: true,
});
const refund = (state: "Sending" | "Refunded") => ({
  amountMinor: "500",
  reasonCode: "CUSTOMER_REQUEST",
  requestedAt: "2026-11-25T17:23:30.112Z",
  byLabel: "You",
  state,
});

async function opened(reads: unknown[], refunded: unknown = null) {
  if (order === undefined) throw new Error("missing synthetic order");
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
  const onChanged = vi.fn();
  let read = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/merchant/orders/table-payment")
      ? new Response(JSON.stringify(reads[Math.min(read++, reads.length - 1)]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : String(url).endsWith("/merchant/orders/table-payment/online-refund") && refunded !== null
        ? new Response(JSON.stringify(refunded), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 503 }),
  );
  const { container } = await mount(
    <CurrentOrderDetails
      order={order}
      csrf={"a".repeat(43)}
      locked={false}
      onBusy={() => undefined}
      onChanged={onChanged}
      fetcher={fetcher}
    />,
  );
  await settle(20);
  return { container, onChanged, reads: () => read };
}

it("rereads the order's totals once the card company answers a refund the panel showed going back", async () => {
  const { onChanged, reads } = await opened([
    payment([refund("Sending")]),
    payment([refund("Refunded")]),
  ]);
  // Opening the order is one read, not a change.
  expect(reads()).toBe(1);
  expect(onChanged).not.toHaveBeenCalled();
  // The panel reads again a few seconds later; the refund went back: the totals are read again.
  await vi.advanceTimersByTimeAsync(3_000);
  await settle(20);
  expect(reads()).toBe(2);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("a later read that finds nothing changed does not reread the totals", async () => {
  const { onChanged, reads } = await opened([payment([refund("Sending")])]);
  await vi.advanceTimersByTimeAsync(3_000);
  await settle(20);
  expect(reads()).toBe(2);
  expect(onChanged).not.toHaveBeenCalled();
});

it("rereads the order's totals at once when a refund made here comes back already gone to the card", async () => {
  // v15 b63 order 32: the refund's own answer already said "Refunded"; Paid showed it at once.
  const { container, onChanged, reads } = await opened(
    [payment([])],
    payment([refund("Refunded")]),
  );
  expect(onChanged).not.toHaveBeenCalled();
  await click(buttonNamed(container, "Refund to the card"));
  await typeInto(container.querySelector(".table-payment__refund input"), "5.00");
  const reason = container.querySelector(".table-payment__refund select");
  await selectValue(reason, (reason as HTMLSelectElement).options[1]?.value ?? "");
  await click(buttonNamed(container, "Refund $5.00 to the card"));
  await click(buttonNamed(container, "Confirm: refund $5.00 to the card"));
  await settle(20);
  expect(container.textContent).toContain("went back to the guest's card");
  // The totals above are read again at once, not at the page's next poll.
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(reads()).toBe(1);
});
