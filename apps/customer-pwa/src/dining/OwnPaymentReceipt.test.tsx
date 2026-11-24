// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import {
  setCustomerCsrfCredential,
  setEmptyTable,
} from "../session/customer-transaction-context.js";
import { DiningSessionScreen, type DiningSessionState } from "./DiningSessionPage.js";
import { EndedTableCard } from "./EndedTable.js";
import {
  OwnPaymentReceiptError,
  createOwnPaymentReceiptClient,
  parseOwnPaymentReceipt,
  resetOwnPaidAtTable,
  type OwnPaymentReceiptClient,
} from "./OwnPaymentReceipt.js";
import { TableCheckoutNotice } from "../menu/TableCheckoutNotice.js";
import type { TableCheckout } from "./table-checkout-state.js";
import type { DiningRound, DiningSessionView } from "./dining-session-client.js";

// Batch 56 (v15 b55 live, guest-closed-bill-menu-cart): a guest who paid part of a bill (their
// dish by phone, L55 CB2 order 76; part 1 of staff's even split in 2, L55 CB3 order 80) and whose
// staff then closed the rest saw only the table's "Paid $14.13" — no "you paid", no method, no
// receipt — and once the table closed, nothing at all. The bodies are what the API's own-payment
// read answers for v15's records (customer-dining-table-payment.test.ts builds them).
const evenPart = {
  schemaVersion: 1,
  ownPayment: {
    tableLabel: "L54 GB5 (TEST)",
    restClosedByStaff: true,
    tablePaidInFull: false,
    payments: [
      {
        covers: "Part",
        partNumber: 1,
        partCount: 2,
        dishes: [],
        subtotalMinor: "1250",
        taxMinor: "163",
        paidForMinor: "1413",
        tipMinor: "0",
        totalMinor: "1413",
        method: "Online",
        paidAt: "2026-11-24T00:34:40.000Z",
      },
    ],
    totalMinor: "1413",
  },
};
const byDish = {
  ...evenPart,
  ownPayment: {
    ...evenPart.ownPayment,
    tableLabel: "L53 WO4 (TEST)",
    payments: [
      {
        ...evenPart.ownPayment.payments[0],
        covers: "Dishes",
        partCount: null,
        dishes: [{ displayName: "Beef noodles (TEST)", quantity: 1, shared: false }],
      },
    ],
  },
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // The pay section's own read: nothing to pay on a closed bill (its answer is not under test).
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCustomerCsrfCredential(null);
  setEmptyTable(null);
  resetOwnPaidAtTable();
  vi.unstubAllGlobals();
});
const text = () => (container.textContent ?? "").replace(/\s+/gu, " ");
async function show(node: React.ReactNode, language: "en" | "zh-Hans" = "en") {
  // A fresh page each time (the language is chosen as the page starts).
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageRoot initial={language}>
        {() => <MemoryRouter initialEntries={["/dine-in/session"]}>{node}</MemoryRouter>}
      </LanguageRoot>,
    );
  });
  // The receipt's read settles.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const payer = (body: unknown): OwnPaymentReceiptClient => ({
  read: vi.fn().mockResolvedValue(parseOwnPaymentReceipt(body)),
});
const otherGuest = (): OwnPaymentReceiptClient => ({
  read: vi.fn().mockRejectedValue(new OwnPaymentReceiptError("none")),
});

const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const noodles = (roundNumber: number, payment: DiningRound["payment"]): DiningRound => ({
  roundNumber,
  orderedBy: roundNumber === 1 ? "You" : "AnotherGuest",
  submittedAt: "2026-11-24T00:30:00.000Z",
  status: "Served",
  payment,
  cancelsAt: null,
  storeCancellationReason: null,
  items: [
    {
      displayName: "Beef noodles (TEST)",
      quantity: 1,
      servedQuantity: 1,
      cancelled: false,
      lineTotal: cad(roundNumber === 1 ? "1413" : "1412"),
    },
  ],
  itemsTotal: cad(roundNumber === 1 ? "1413" : "1412"),
});
/** The guest table read after staff closed the rest (v15 b55: paid 1413, owed 0). */
const closedTable = (
  splitParts: { count: number | null; paid: number },
  paidAfterRefunds?: string,
): DiningSessionState => ({
  status: "ready",
  refreshing: false,
  view: {
    tableLabel: "L55 CB3 (TEST)",
    orderNumber: "80",
    checkedAt: "2026-11-24T00:36:00.000Z",
    paymentTiming: "PayLater",
    rounds: [noodles(1, "Paid"), noodles(2, "OnTableBill")],
    summary: {
      paid: cad("1413"),
      ...(paidAfterRefunds === undefined ? {} : { paidAfterRefunds: cad(paidAfterRefunds) }),
      refunded: cad("0"),
      refundPending: cad("0"),
      due: cad("0"),
      tableTip: cad("0"),
      cashRounding: cad("0"),
      splitParts,
      closedByStaff: true,
    },
  } as DiningSessionView,
});

describe("batch 56: the guest who paid part of a bill staff closed keeps their own receipt", () => {
  it("while the table is open: the payer sees what they paid, how, and what it covers (en)", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    const own = payer(evenPart);
    await show(
      <DiningSessionScreen
        state={closedTable({ count: 2, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={own}
      />,
    );
    expect(own.read).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Your receipt");
    expect(text()).toContain("You paid $14.13 online on this phone.");
    expect(text()).toContain("Part 1 of 2 of your table’s bill");
    expect(text()).toContain("Subtotal before tax$12.50");
    expect(text()).toContain("Tax$1.63");
    expect(text()).toContain("Total paid by you$14.13");
    expect(text()).toContain("Paid byOnline by phone");
    expect(text()).toContain(
      "This receipt is for your payment only. Staff closed the rest of your table’s bill; it is not charged to you.",
    );
    // Never that the table paid, and no one else's part.
    const receipt = container.querySelector(".dining-session__own-payment")?.textContent ?? "";
    expect(receipt).not.toMatch(/paid in full|bill is paid|\$14\.12|Part 2/u);
    expect(text()).not.toMatch(/paid in full|bill is paid/u);
  });

  it("by dish (zh-Hans): the dishes this phone paid for", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    await show(
      <DiningSessionScreen
        state={closedTable({ count: null, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={payer(byDish)}
      />,
      "zh-Hans",
    );
    expect(text()).toContain("您的收据");
    expect(text()).toContain("您已在这部手机上在线付款 $14.13。");
    expect(text()).toContain("您付款的菜品");
    expect(text()).toContain("Beef noodles (TEST)");
    expect(text()).toContain("您实付合计$14.13");
    expect(text()).toContain("付款方式手机在线付款");
    expect(text()).toContain(
      "这张收据只包括您的付款。本桌账单的其余部分已由店员关闭，不向您收取。",
    );
    expect(text()).not.toMatch(/已全部付清|已结清/u);
  });

  it("another guest at the table sees no one's payment; a bill with nothing paid asks nothing", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    const other = otherGuest();
    await show(
      <DiningSessionScreen
        state={closedTable({ count: 2, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={other}
      />,
    );
    expect(other.read).toHaveBeenCalledTimes(1);
    expect(text()).not.toMatch(/Your receipt|You paid|Online by phone/u);
    const nothing = payer(evenPart);
    const state = closedTable({ count: 2, paid: 0 });
    if (state.status === "ready" && state.view.summary !== null)
      (state.view.summary as { paid: unknown }).paid = cad("0");
    await show(
      <DiningSessionScreen state={state} onRefresh={() => undefined} ownPaymentReceipt={nothing} />,
    );
    expect(nothing.read).not.toHaveBeenCalled();
  });

  it("once the table closed: Your table keeps the payer's receipt; other tabs link to it", async () => {
    setEmptyTable({
      tableLabel: "L55 CB3 (TEST)",
      closedByStaff: "Some",
      yourPayment: { amountMinor: "1413", csrfToken: "C".repeat(43) },
    });
    const own = payer(evenPart);
    await show(
      <DiningSessionScreen
        state={{ status: "ended-closed", tableLabel: "L55 CB3 (TEST)", paid: "Some" }}
        onRefresh={() => undefined}
        ownPaymentReceipt={own}
      />,
    );
    expect(text()).toContain("This table’s visit has ended");
    expect(text()).toContain(
      "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you.",
    );
    expect(text()).toContain("You paid $14.13 online on this phone.");
    expect(text()).toContain("Your receipt");
    expect(text()).toContain("Part 1 of 2 of your table’s bill");
    // Menu, a dish page or Cart: the line, and a link to that receipt on Your table.
    await show(
      <EndedTableCard
        ended={{
          kind: "ClosedByStaff",
          tableLabel: "L55 CB3 (TEST)",
          paid: "Some",
          store: null,
          yourPaidMinor: "1413",
        }}
      />,
      "zh-Hans",
    );
    expect(text()).toContain("您已在这部手机上在线付款 $14.13。");
    expect(container.querySelector("a")?.textContent).toBe("查看您的收据");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/dine-in/session");
  });

  it("once the table closed: another guest's phone is told how the bill ended, nothing more", async () => {
    setEmptyTable({ tableLabel: "L55 CB3 (TEST)", closedByStaff: "Some" });
    const other = otherGuest();
    await show(
      <DiningSessionScreen
        state={{ status: "ended-closed", tableLabel: "L55 CB3 (TEST)", paid: "Some" }}
        onRefresh={() => undefined}
        ownPaymentReceipt={other}
      />,
    );
    expect(other.read).not.toHaveBeenCalled();
    expect(text()).not.toMatch(/You paid|receipt/iu);
    await show(
      <EndedTableCard
        ended={{ kind: "ClosedByStaff", tableLabel: "L55 CB3 (TEST)", paid: "Some", store: null }}
      />,
    );
    expect(text()).not.toMatch(/You paid|receipt/iu);
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("batch 56: the own-payment read", () => {
  it("asks for this phone's own payment with the value given, in the guest's language", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(evenPart), { status: 200 }));
    const receipt = await createOwnPaymentReceiptClient(() => "C".repeat(43), request).read();
    expect(receipt.totalMinor).toBe("1413");
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/table-payment");
    expect(JSON.parse(String(init.body))).toEqual({ action: "OwnPayment" });
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("C".repeat(43));
  });
  it("not found or no value: nothing to show; anything else: try again", async () => {
    const none = (status: number) =>
      createOwnPaymentReceiptClient(
        () => "C".repeat(43),
        vi.fn().mockResolvedValue(new Response("{}", { status })),
      ).read();
    await expect(none(404)).rejects.toMatchObject({ code: "none" });
    await expect(none(503)).rejects.toMatchObject({ code: "unavailable" });
    await expect(createOwnPaymentReceiptClient(() => null).read()).rejects.toMatchObject({
      code: "none",
    });
    // A body with another method or a malformed amount is never shown.
    for (const bad of [
      { ownPayment: { ...evenPart.ownPayment, totalMinor: "14.13" } },
      {
        ownPayment: {
          ...evenPart.ownPayment,
          payments: [{ ...evenPart.ownPayment.payments[0], method: "Cash" }],
        },
      },
    ])
      expect(() => parseOwnPaymentReceipt(bad)).toThrow(OwnPaymentReceiptError);
  });
});

// Batch 56 review: while the table is still open after staff closed the rest (the guest usually
// still at the table), Menu, dish pages and Cart said only "what was paid stays paid … See the
// bill" to the payer, while Your table showed their receipt: two different messages.
describe("batch 56 review: the closed-bill notice while the table is still open", () => {
  const closedSome: TableCheckout = {
    paid: true,
    payLater: true,
    closedByStaff: { kind: "Parts", paid: 1, count: 2 },
  };
  const answering = (status: number, body: unknown) => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json(body, { status, headers: { "cache-control": "no-store" } }),
      );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  const asked = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/dine-in/table-payment"));

  it("the payer reads what they paid and goes to their own receipt (en, zh-Hans)", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    const fetch = answering(200, evenPart);
    await show(<TableCheckoutNotice checkout={closedSome} />);
    expect(text()).toContain(
      "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you.",
    );
    expect(text()).toContain("You paid $14.13 online on this phone.");
    expect(container.querySelector("a")?.textContent).toBe("See your receipt");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/dine-in/session");
    const [[, init]] = asked(fetch) as [[string, RequestInit]];
    expect(JSON.parse(String(init.body))).toMatchObject({ action: "OwnPayment" });
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("d".repeat(43));
    // Moving to a dish page or Cart asks nothing again: a payment on a closed bill is final.
    await show(<TableCheckoutNotice checkout={closedSome} />, "zh-Hans");
    expect(text()).toContain("您已在这部手机上在线付款 $14.13。");
    expect(container.querySelector("a")?.textContent).toBe("查看您的收据");
    expect(asked(fetch)).toHaveLength(1);
  });

  it("another guest's phone reads the bill's words and its link only; nothing paid asks nothing", async () => {
    setCustomerCsrfCredential("e".repeat(43));
    const other = answering(404, {
      schemaVersion: 1,
      error: { code: "guest_session_unavailable" },
    });
    await show(<TableCheckoutNotice checkout={closedSome} />);
    expect(asked(other)).toHaveLength(1);
    expect(text()).not.toMatch(/You paid|receipt/iu);
    expect(container.querySelector("a")?.textContent).toBe("See the bill");
    resetOwnPaidAtTable();
    const nothing = answering(200, evenPart);
    await show(
      <TableCheckoutNotice
        checkout={{ paid: true, payLater: true, closedByStaff: { kind: "Nothing" } }}
      />,
    );
    expect(asked(nothing)).toHaveLength(0);
    expect(text()).not.toMatch(/You paid/u);
    // A table still paying (staff closed nothing) asks nothing either.
    await show(
      <TableCheckoutNotice checkout={{ paid: false, payLater: true, closedByStaff: null }} />,
    );
    expect(asked(nothing)).toHaveLength(0);
  });

  it("a failed read leaves the bill's words; the next tab asks again", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    const down = answering(503, { schemaVersion: 1, error: { code: "unavailable" } });
    await show(<TableCheckoutNotice checkout={closedSome} />);
    expect(text()).not.toMatch(/You paid/u);
    expect(container.querySelector("a")?.textContent).toBe("See the bill");
    const back = answering(200, evenPart);
    await show(<TableCheckoutNotice checkout={closedSome} />);
    expect(asked(down)).toHaveLength(1);
    expect(asked(back)).toHaveLength(1);
    expect(text()).toContain("You paid $14.13 online on this phone.");
  });
});

// Batch 57 (WP-2423 Q36, b56 remaining): staff refunded part of the payer's own phone payment and
// the payer's own receipt still said only "You paid $14.13 … Total paid by you $14.13": no refund,
// no net. The bodies are what the API's own-payment read answers for Payment's refund records
// (customer-dining-table-payment.test.ts builds them from the v15 shapes): $5.00 back to the card,
// $3.00 on its way (no Provider answer yet), $2.00 refused; or all of it back.
const refundedPart = {
  ...evenPart,
  ownPayment: {
    ...evenPart.ownPayment,
    payments: [
      {
        ...evenPart.ownPayment.payments[0],
        refunds: [
          {
            amountMinor: "500",
            status: "Refunded",
            requestedAt: "2026-11-24T00:40:17.521Z",
            answeredAt: "2026-11-24T00:40:17.565Z",
          },
          {
            amountMinor: "300",
            status: "Pending",
            requestedAt: "2026-11-24T00:41:02.104Z",
            answeredAt: null,
          },
          {
            amountMinor: "200",
            status: "Failed",
            requestedAt: "2026-11-24T00:41:40.250Z",
            answeredAt: "2026-11-24T00:41:40.311Z",
          },
        ],
        refundedMinor: "800",
      },
    ],
    refundedMinor: "800",
    netMinor: "613",
  },
};
const fullyRefunded = {
  ...byDish,
  ownPayment: {
    ...byDish.ownPayment,
    payments: [
      {
        ...byDish.ownPayment.payments[0],
        refunds: [
          {
            amountMinor: "1413",
            status: "Refunded",
            requestedAt: "2026-11-24T00:40:03.609Z",
            answeredAt: "2026-11-24T00:40:03.643Z",
          },
        ],
        refundedMinor: "1413",
      },
    ],
    refundedMinor: "1413",
    netMinor: "0",
  },
};

describe("batch 57: refunds of the payer's own payment", () => {
  it("each refund is said as Payment recorded it, with what the payer paid net (en)", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    await show(
      <DiningSessionScreen
        state={closedTable({ count: 2, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={payer(refundedPart)}
      />,
    );
    // Batch 60 (v15 b59 live): what Payment confirmed went back is said as done, what is still
    // on its way as on its way (before: "After $8.00 back to your card" for both).
    expect(text()).toContain(
      "You paid $14.13 online on this phone. $5.00 went back to your card and $3.00 is on its way, so in the end you pay $6.13.",
    );
    // Batch 58 (v15 b57 live): once some went back, the rows name what was charged and what
    // was paid after refunds, never two amounts both called "paid by you".
    expect(text()).toContain("Amount charged$14.13");
    expect(text()).toContain("Refunded to your card−$5.00");
    expect(text()).toContain("On its way back to your card−$3.00");
    expect(text()).toContain("You paid after refunds$6.13");
    expect(text()).not.toContain("Total paid by you");
    expect(text()).not.toContain("Total after refunds");
    const refunds = [...container.querySelectorAll(".dining-session__own-refunds li")].map((line) =>
      (line.textContent ?? "").replace(/\s+/gu, " "),
    );
    expect(refunds).toHaveLength(3);
    expect(refunds[0]).toMatch(
      /^On .+, \$5\.00 went back to your card\. Your bank may take a few days to show it\.$/u,
    );
    expect(refunds[1]).toMatch(
      /^\$3\.00 is on its way back to your card \(sent .+\)\. Your card issuer has not confirmed it yet\.$/u,
    );
    expect(refunds[2]).toMatch(
      /^A refund of \$2\.00 sent on .+ did not go through, so nothing went back to your card\. Please ask staff\.$/u,
    );
    expect(
      container.querySelector(".dining-session__own-refunds")?.getAttribute("aria-label"),
    ).toBe("Refunds of your payment");
  });

  it("all of it back (zh-Hans), and the line Menu, dish pages and Cart say", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    await show(
      <DiningSessionScreen
        state={closedTable({ count: null, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={payer(fullyRefunded)}
      />,
      "zh-Hans",
    );
    // Batch 60 (v15 b59 live, L59W A): Payment confirmed it, so it went back (已全部退回), never
    // "goes back" (全部退回) beside the dated 已退回 line.
    expect(text()).toContain("您已在这部手机上在线付款 $14.13。这笔款项已全部退回您的卡。");
    expect(text()).not.toContain("这笔款项全部退回");
    expect(text()).toContain("付款金额$14.13");
    expect(text()).toContain("已退回您的卡−$14.13");
    expect(text()).not.toContain("正在退回");
    expect(text()).toContain("退款后实付$0.00");
    expect(text()).not.toContain("您实付合计");
    expect(container.querySelector(".dining-session__own-refunds li")?.textContent).toMatch(
      /^.+，\$14\.13 已退回您的卡。银行可能要过几天才显示。$/u,
    );
    // Once the table closed, the restore says what went back too.
    await show(
      <EndedTableCard
        ended={{
          kind: "ClosedByStaff",
          tableLabel: "L55 CB3 (TEST)",
          paid: "Some",
          store: null,
          yourPaidMinor: "1413",
          yourRefundedMinor: "800",
        }}
      />,
      "zh-Hans",
    );
    expect(text()).toContain("您已在这部手机上在线付款 $14.13。$8.00 已退回您的卡，您实付 $6.13。");
    // Batch 60: while some of it is still on its way, that part is said as on its way.
    await show(
      <EndedTableCard
        ended={{
          kind: "ClosedByStaff",
          tableLabel: "L55 CB3 (TEST)",
          paid: "Some",
          store: null,
          yourPaidMinor: "1413",
          yourRefundedMinor: "800",
          yourRefundPendingMinor: "300",
        }}
      />,
      "zh-Hans",
    );
    expect(text()).toContain(
      "您已在这部手机上在线付款 $14.13。$5.00 已退回您的卡，$3.00 正在退回，退回后您实付 $6.13。",
    );
    await show(
      <EndedTableCard
        ended={{
          kind: "ClosedByStaff",
          tableLabel: "L55 CB3 (TEST)",
          paid: "Refunded",
          store: null,
          yourPaidMinor: "1413",
          yourRefundedMinor: "1413",
        }}
      />,
    );
    expect(text()).toContain(
      "You paid $14.13 online on this phone. All of it went back to your card.",
    );
    await show(
      <EndedTableCard
        ended={{
          kind: "ClosedByStaff",
          tableLabel: "L55 CB3 (TEST)",
          paid: "Refunded",
          store: null,
          yourPaidMinor: "1413",
          yourRefundedMinor: "1413",
          yourRefundPendingMinor: "1413",
        }}
      />,
    );
    expect(text()).toContain(
      "You paid $14.13 online on this phone. All of it is on its way back to your card.",
    );
  });

  // Batch 58 (v15 b57 live, L57R A): the zh receipt's sentence said 您实付 $6.13 while the row
  // below said 您实付合计 $14.13: two different amounts both called 实付.
  it("zh-Hans after a part refund: 实付 names only what was paid after the refund", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    await show(
      <DiningSessionScreen
        state={closedTable({ count: 2, paid: 1 }, "613")}
        onRefresh={() => undefined}
        ownPaymentReceipt={payer(refundedPart)}
      />,
      "zh-Hans",
    );
    const receipt = container.querySelector(".dining-session__own-payment");
    const words = (receipt?.textContent ?? "").replace(/\s+/gu, " ");
    expect(words).toContain("$5.00 已退回您的卡，$3.00 正在退回，退回后您实付 $6.13。");
    expect(words).toContain("付款金额$14.13");
    expect(words).toContain("已退回您的卡−$5.00");
    expect(words).toContain("正在退回您的卡−$3.00");
    expect(words).toContain("退款后实付$6.13");
    // Every 实付 on the receipt is the same amount, the net.
    expect([...words.matchAll(/实付 ?(\$\d+\.\d\d)/gu)].map((match) => match[1])).toEqual([
      "$6.13",
      "$6.13",
    ]);
    // The table total says what the table paid after refunds, not the gross.
    const total = container.querySelector(".dining-session__summary");
    const totalWords = (total?.textContent ?? "").replace(/\s+/gu, " ");
    expect(totalWords).toContain("退款后已付$6.13");
    expect(totalWords).not.toContain("$14.13");
  });

  it("no refund: the receipt keeps its wording in zh-Hans and en", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    await show(
      <DiningSessionScreen
        state={closedTable({ count: 2, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={payer(evenPart)}
      />,
      "zh-Hans",
    );
    expect(text()).toContain("您实付合计$14.13");
    expect(text()).not.toContain("付款金额");
    expect(text()).not.toContain("退款后");
    expect(text()).toContain("已付款$14.13");
  });

  it("the closed-bill notice says the net; a refund read on Your table shows there next", async () => {
    setCustomerCsrfCredential("d".repeat(43));
    const fetch = vi.fn().mockImplementation(async () => Response.json(evenPart, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const checkout: TableCheckout = {
      paid: true,
      payLater: true,
      closedByStaff: { kind: "Parts", paid: 1, count: 2 },
    };
    await show(<TableCheckoutNotice checkout={checkout} />);
    expect(text()).toContain("You paid $14.13 online on this phone.");
    // Staff refund meanwhile; the guest opens Your table, whose receipt reads it afresh.
    await show(
      <DiningSessionScreen
        state={closedTable({ count: 2, paid: 1 })}
        onRefresh={() => undefined}
        ownPaymentReceipt={payer(refundedPart)}
      />,
    );
    await show(<TableCheckoutNotice checkout={checkout} />);
    expect(text()).toContain(
      "You paid $14.13 online on this phone. $5.00 went back to your card and $3.00 is on its way, so in the end you pay $6.13.",
    );
  });

  it("a refund body that does not add up is never shown; an older server's body has none", () => {
    for (const bad of [
      { ownPayment: { ...refundedPart.ownPayment, netMinor: "1413" } },
      { ownPayment: { ...refundedPart.ownPayment, refundedMinor: "1414", netMinor: "0" } },
      {
        ownPayment: {
          ...refundedPart.ownPayment,
          payments: [
            {
              ...refundedPart.ownPayment.payments[0],
              refunds: [{ amountMinor: "500", status: "Sent", requestedAt: "x", answeredAt: null }],
            },
          ],
        },
      },
    ])
      expect(() => parseOwnPaymentReceipt(bad)).toThrow(OwnPaymentReceiptError);
    const older = parseOwnPaymentReceipt(evenPart);
    expect([older.refundedMinor, older.netMinor, older.payments[0]?.refunds]).toEqual([
      "0",
      "1413",
      [],
    ]);
  });
});
