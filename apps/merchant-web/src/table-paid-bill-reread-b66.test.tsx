// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, until } from "./dom-test-kit.fixture.js";
import { paidBillRereadMs, TableCheckout } from "./TableCheckout.js";
import type { StaffDiningTable, StaffDiningTableSession } from "./dining-session-client.js";

/**
 * Batch 66 (v15 b65 live, TM2 S65 A/C): a Tables panel open on one screen kept "Paid / Print paid
 * bill" for about 20 s after a full refund from Orders on another screen, until the floor's own
 * 30 s read.
 */
afterEach(() => vi.useRealTimers());

const id = (n: number) => "0190a66b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);

describe("b66: an open Tables panel follows a refund made on another screen within seconds", () => {
  const table = {
    tableReference: id(70),
    stableLabel: "S65 A (TEST)",
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    blockReasonCode: null,
    aggregateVersion: 2,
    currentDiningSessionReference: id(2),
    elapsedMinutes: 30,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayLater",
    session: { phase: "Closing", version: 7, orderReference: id(3) },
    staffRoundsAwaitingPayment: [],
  } as unknown as StaffDiningTable;
  const session = {
    phase: "Closing",
    version: 7,
    orderReference: id(3),
  } as StaffDiningTableSession;
  /** S65 A as the server answers it: $14.13 and a $1.88 tip paid by phone ($16.01). */
  const bill = (refundedMinor: string | null) => ({
    diningSessionReference: id(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "S65 A (TEST)",
    orderReference: id(3),
    rounds: [
      {
        roundNumber: 1,
        orderBatchReference: id(21),
        items: [
          {
            orderItemReference: id(901),
            quantity: 1,
            displayName: "Beef noodles (TEST)",
            subtotalMinor: "1250",
            totalMinor: "1413",
          },
        ],
        subtotalMinor: "1250",
        taxMinor: "163",
        totalMinor: "1413",
        paid: true,
      },
    ],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    tips: { enabled: true, tierPercents: [10, 15, 20] },
    split: null,
    waitingRounds: [],
    writeOff: null,
    onlinePayment: null,
    settlement: {
      method: "Online",
      roundsMinor: "1413",
      tipMinor: "188",
      roundingMinor: "0",
      totalMinor: "1601",
      tenderedMinor: null,
      changeMinor: null,
      recordedAt: "2026-11-27T01:13:00.000Z",
      recordedAfterOutage: false,
    },
    ...(refundedMinor === null ? {} : { refundedMinor }),
  });

  it("turns Paid / Print paid bill into Refunded by itself, and reads the floor again once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let refunded: string | null = null;
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      reads += 1;
      return new Response(JSON.stringify(bill(refunded)), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    });
    const onChanged = vi.fn();
    const { container } = await mount(
      <TableCheckout
        table={table}
        session={session}
        csrf={csrf}
        locked={false}
        canStart
        onChanged={onChanged}
        fetcher={fetcher}
        refreshKey="floor-1"
      />,
    );
    const heading = () => container.querySelector("#table-checkout-title")?.textContent ?? "";
    await until(() => heading() === "Paid");
    expect(container.textContent).toContain("Print paid bill");

    // Nothing changed: one read of this bill, nothing else, and the floor is not read again.
    let before = reads;
    await act(async () => vi.advanceTimersByTime(paidBillRereadMs));
    await until(() => reads === before + 1);
    expect(heading()).toBe("Paid");
    expect(onChanged).not.toHaveBeenCalled();

    // Refunded in full from Orders on another screen; nobody touches this one.
    refunded = "1601";
    before = reads;
    await act(async () => vi.advanceTimersByTime(paidBillRereadMs));
    await until(() => heading() === "Refunded");
    expect(reads).toBe(before + 1);
    expect(container.textContent).not.toContain("Print paid bill");
    expect(container.textContent).not.toContain("Total paid");
    // The floor (rounds line, totals, the Tables row) is read again once, to say the same.
    expect(onChanged).toHaveBeenCalledTimes(1);

    // While the page is not on screen, it is not read.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    before = reads;
    await act(async () => vi.advanceTimersByTime(paidBillRereadMs * 3));
    expect(reads).toBe(before);
    visibility.mockRestore();
  });

  it("reads again within the floor's own 30 s read, not at it", () => {
    expect(paidBillRereadMs).toBeLessThanOrEqual(10_000);
  });
});
