import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterCurrentOrderItems,
  orderAmountNote,
  orderRowNoteShownEverywhere,
  refundedByWay,
} from "./CurrentOrderQueuePage.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { stillOpenOnTheFloor } from "./orders-earlier-days.js";
import { StaffRoundPaymentAction } from "./StaffRoundPaymentAction.js";
import { orderWhen, unbrokenWhen } from "./StoreTime.js";

/**
 * Batch 67 (polish backlog items 3, 6, 8 and 22; v15 b65 and b66 live, TEST-only data): the Orders
 * and Counter rows say the same thing on every row and at every width, and an order whose table is
 * still open stays in the default Orders list after the business day starts.
 */
const id = (n: number) => "0190a64b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

afterEach(() => setLanguageForTest("en"));

describe("b67 item 3: a part-refunded table order's note shows wherever the fully refunded one does", () => {
  const order = (paid: Record<string, string>, checkingOut?: true) =>
    ({
      orderType: "DineIn",
      paidOnline: null,
      counter: null,
      batches: [],
      tableBill: {
        totalMinor: "1413",
        paid: { amountMinor: "1601", method: "Online", ...paid },
        ...(checkingOut ? { checkingOut } : {}),
      },
    }) as never;

  it("shows a part refund at every width, still said as part refunded", () => {
    const part = order({ refundedMinor: "500" }, true);
    expect(orderAmountNote(part)).toBe("Part refunded at the table · guest's phone");
    expect(orderRowNoteShownEverywhere(part)).toBe(true);
    expect(orderRowNoteShownEverywhere(order({ refundedMinor: "500" }))).toBe(true);
    // Part still on its way back is part of the refund too.
    expect(orderRowNoteShownEverywhere(order({ refundPendingMinor: "500" }, true))).toBe(true);
    // Nothing went back: how it was paid stays in the panel on phones, as before.
    expect(orderAmountNote(order({}, true))).toBe("Paid at the table · guest's phone");
    expect(orderRowNoteShownEverywhere(order({}, true))).toBe(false);
  });
});

describe("b67 item 6: the date and time of a refund never part across lines", () => {
  it("keeps 11月27日周五 01:32 as one piece in Chinese and Fri, Nov 27 01:32 in English", () => {
    setLanguageForTest("zh-Hans");
    const when = orderWhen("2026-11-27T06:32:00.000Z", "America/Toronto", "2026-11-26");
    expect(when).toBe("11月27日周五 01:32");
    const kept = unbrokenWhen(when);
    // No ordinary space, and a word joiner beside every Chinese character.
    expect(kept).not.toMatch(/ /u);
    expect(kept).toBe("11\u2060月\u206027\u2060日\u2060周\u2060五\u00a001:32");
    // It reads the same once the joiners are taken out.
    expect(kept.replace(/\u2060/gu, "").replace(/\u00a0/gu, " ")).toBe(when);
    setLanguageForTest("en");
    const english = orderWhen("2026-11-27T06:32:00.000Z", "America/Toronto", "2026-11-26");
    expect(unbrokenWhen(english)).toBe(english.replace(/ /gu, "\u00a0"));
    expect(unbrokenWhen("01:32")).toBe("01:32");
  });

  it("says a counter cash refund before 04:00 with its date and time kept together", () => {
    setLanguageForTest("zh-Hans");
    const record = {
      accepted: [],
      handedOver: [],
      payments: [],
      cancellations: [],
      refunds: [
        {
          method: "Cash",
          amountMinor: "367",
          by: "You",
          approvedBy: null,
          at: "2026-11-27T06:32:00.000Z",
          cashGivenBackMinor: "365",
          reasonCode: "CUSTOMER_REQUEST",
        },
      ],
      writeOff: null,
      paidOnlineByGuest: false,
    } as never;
    const rows = refundedByWay(record, 365n, [], (at) =>
      orderWhen(at, "America/Toronto", "2026-11-26"),
    );
    const label = rows?.[0]?.label ?? "";
    // The words and reason keep their own break points; the date and time are one piece.
    expect(label.startsWith("已退现金 · ")).toBe(true);
    expect(label.endsWith(" · 11\u2060月\u206027\u2060日\u2060周\u2060五\u00a001:32")).toBe(true);
    expect(label.replace(/\u2060/gu, "").replace(/\u00a0/gu, " ")).toMatch(
      / · 11月27日周五 01:32$/u,
    );
  });
});

describe("b67 item 8: every Counter Sent, not paid yet row's button reads Take payment", () => {
  it("never adds the amount on the counter row (its title says it), even once it was read", () => {
    const button = (counterStyle: boolean) =>
      renderToStaticMarkup(
        <StaffRoundPaymentAction
          subject="order"
          label="Take payment"
          counterStyle={counterStyle}
          csrf="csrf"
          orderReference={id(1)}
          orderBatchReference={id(2)}
          amountDueMinor="1413"
          payBy="2026-11-27T06:50:00.000Z"
          recordedAfterOutage={false}
          onRecorded={() => undefined}
        />,
      );
    expect(button(true)).toContain(">Take payment</button>");
    expect(button(true)).not.toContain("$14.13");
    // Elsewhere (a table round on Orders) the button keeps its amount.
    expect(button(false)).toContain("Take payment · $14.13");
  });
});

describe("b67 item 22: an order whose table is still open stays in the default Orders list", () => {
  const filters = {
    orderNumber: "",
    type: "All",
    channel: "All",
    phase: "All",
    day: "Today" as const,
    today: "2026-11-27",
  };
  const order = (n: number, overrides: Record<string, unknown>) =>
    ({
      orderReference: id(n),
      orderNumber: String(n),
      orderType: "DineIn",
      sourceChannel: "Qr",
      counter: null,
      businessDate: "2026-11-26",
      listedBusinessDate: "2026-11-26",
      heldStock: null,
      earlierOpenPickup: false,
      awaitingPayment: false,
      acceptanceHold: null,
      batches: [],
      tableBill: null,
      currentPhase: "Fulfilled",
      ...overrides,
    }) as never;
  const paid = { amountMinor: "1601", method: "Online" };
  const shown = (items: never[]) =>
    filterCurrentOrderItems(items, filters).map(
      (item) => (item as { orderNumber: string }).orderNumber,
    );

  it("keeps a still-seated paid table, an unpaid open table and a payment still awaited", () => {
    const seatedPaid = order(24, { tableBill: { totalMinor: "1413", paid, checkingOut: true } });
    const openUnpaid = order(25, { tableBill: { totalMinor: "1413", paid: null } });
    const awaited = order(26, { orderType: "Pickup", sourceChannel: "Pos", awaitingPayment: true });
    expect(shown([seatedPaid, openUnpaid, awaited])).toEqual(["24", "25", "26"]);
    expect(stillOpenOnTheFloor(seatedPaid)).toBe(true);
  });

  it("leaves a closed table to its day (Filter > All days still lists it)", () => {
    const closed = order(30, { tableBill: { totalMinor: "1413", paid } });
    const merged = order(31, {
      tableBill: { totalMinor: "0", paid: null, mergedInto: { tableLabel: "A1", paid: true } },
    });
    const writtenOff = order(32, {
      tableBill: { totalMinor: "1413", paid: null, writtenOffMinor: "1413" },
    });
    const finishedPickup = order(33, { orderType: "Pickup", sourceChannel: "Pos" });
    const today = order(34, { businessDate: "2026-11-27", listedBusinessDate: "2026-11-27" });
    const items = [closed, merged, writtenOff, finishedPickup, today];
    expect(shown(items)).toEqual(["34"]);
    // Nothing is dropped: every day lists every order.
    expect(filterCurrentOrderItems(items, { ...filters, day: "All" })).toHaveLength(5);
  });
});
