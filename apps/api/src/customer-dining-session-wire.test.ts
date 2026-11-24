import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { CustomerDiningSessionHandler } from "./customer-dining-session.js";
import {
  composeCustomerDiningSession,
  customerRoundPaymentRefunds,
  customerTableBillFacts,
  type CustomerDiningSessionView,
  type CustomerMoney,
} from "./customer-dining-session-read.js";
import {
  guestBillClosedByStaffFacts,
  guestBillPayments,
  guestPhoneSession,
  guestTableRefundedMinor,
  liveWrittenOffSummaryWithoutClosedByStaff,
  type GuestBillScenario,
} from "../test-support/guest-bill-closed-by-staff.js";

/**
 * Batch 54 (v15 b53 live): the guest read built `summary.closedByStaff` for a bill staff wrote
 * off, but the HTTP reply never carried it, so every guest phone said the table had paid in one
 * payment while $14.12 of $28.25 was written off. The page's tests passed on a mocked read. These
 * tests go through the real read composition and the real HTTP app, with no mock of either.
 */
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

async function serve(view: () => CustomerDiningSessionView) {
  const server = createServer(
    createApp({
      customerDiningSession: new CustomerDiningSessionHandler({
        allowedOrigin: "https://pilot.example",
        port: { read: async () => view() },
      }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1/dine-in/session",
    {
      headers: {
        "sec-fetch-site": "same-origin",
        cookie: "__Host-bop-guest=" + "s".repeat(43),
        "x-csrf-token": "c".repeat(43),
      },
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: Record<string, unknown> }).session;
}

/** The guest read for a scenario, through the real bill mapping and composition. */
function guestRead(
  scenario: GuestBillScenario,
  tableRefunds: Parameters<typeof guestBillClosedByStaffFacts>[1] = "None",
) {
  const { facts, bill } = guestBillClosedByStaffFacts(scenario, tableRefunds);
  return composeCustomerDiningSession({
    ...facts,
    order: { ...facts.order, tableBill: customerTableBillFacts(bill) },
  });
}

describe("batch 54: a bill staff closed reaches the guest phone as closed", () => {
  it("order 52 (by dish, one dish paid, the rest written off) is sent as v15 sent it, plus closedByStaff", async () => {
    const session = await serve(() => guestRead("by-dish-written-off"));
    // Every other line is what v15 answered live; the read's closedByStaff is no longer dropped.
    expect(session.summary).toEqual({
      ...liveWrittenOffSummaryWithoutClosedByStaff,
      closedByStaff: true,
    });
  });

  it("a part-paid split and a bill nobody paid are sent closed; a bill still owed is not", async () => {
    const parts = (await serve(() => guestRead("parts-written-off"))).summary as Record<
      string,
      unknown
    >;
    expect(parts).toMatchObject({
      closedByStaff: true,
      paid: { amountMinor: "942" },
      due: { amountMinor: "0" },
      splitParts: { count: 3, paid: 1 },
    });
    const nothing = (await serve(() => guestRead("nothing-paid-written-off"))).summary as Record<
      string,
      unknown
    >;
    expect(nothing).toMatchObject({
      closedByStaff: true,
      paid: { amountMinor: "0" },
      due: { amountMinor: "0" },
    });
    expect(nothing).not.toHaveProperty("splitParts");
    const open = (await serve(() => guestRead("open-after-one-dish"))).summary as Record<
      string,
      unknown
    >;
    expect(open).not.toHaveProperty("closedByStaff");
    expect(open).toMatchObject({ due: { amountMinor: "1412" }, splitParts: { count: null } });
  });
});

/**
 * Every field the guest read can carry, each present. A field added to the read's type and not
 * here fails the typecheck; one here the HTTP reply does not send fails the test below. A field
 * the reply leaves out on purpose must be listed in `notSent` with the reason.
 */
type Every<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> };
type View = CustomerDiningSessionView;
type Round = View["rounds"][number];
type Item = Round["items"][number];
type Summary = NonNullable<View["summary"]>;
const cad = (amountMinor: bigint): CustomerMoney => ({ amountMinor, currencyCode: "CAD" });
const bill = {
  items: cad(2500n),
  takenOff: cad(0n),
  pointsUsed: cad(0n),
  subtotal: cad(2500n),
  tax: cad(325n),
  total: cad(2825n),
};
const everyItem: Every<Item> = {
  displayName: "Beef noodles (TEST)",
  quantity: 1,
  servedQuantity: 0,
  cancelled: true,
  lineTotal: cad(1413n),
  priceBeforeTax: cad(1250n),
  beingRemade: true,
  takenOff: true,
  soldOut: true,
  progress: "Waiting",
  orderAgain: { sellableReference: "s", optionSelections: [] },
};
const everyRound: Every<Round> = {
  roundNumber: 1,
  orderedBy: "You",
  submittedAt: "2026-11-22T16:06:00.000Z",
  status: "Served",
  payment: "OnTableBill",
  cancelsAt: null,
  storeCancellationReason: null,
  waitingReason: "FirstOrder",
  stoppedBeforePaying: true,
  tea: true,
  fromTable: "H6",
  charge: true,
  awaitingStore: true,
  items: [everyItem],
  subtotal: cad(1250n),
  tax: cad(163n),
  itemsTotal: cad(1413n),
  bill,
  refunded: cad(1n),
  refundPending: cad(1n),
  paymentRefund: { state: "Partly", yourPaidAfterRefunds: cad(613n) },
};
const everySummary: Every<Summary> = {
  paid: cad(1413n),
  paidAfterRefunds: cad(613n),
  refunded: cad(0n),
  refundPending: cad(0n),
  due: cad(0n),
  closedByStaff: true,
  splitParts: { count: null, paid: 1 },
  pointsUsed: cad(1n),
  takenOff: cad(1n),
  taxRounding: cad(1n),
  bill,
  teaCharge: { perGuest: cad(150n), guests: 2, name: "Tea" },
  tableTip: cad(0n),
  cashRounding: cad(0n),
  ordered: { subtotal: cad(2500n), tax: cad(325n), total: cad(2825n) },
};
const everyView: Every<Omit<View, "summary" | "rounds">> & Pick<View, "rounds" | "summary"> = {
  tableLabel: "L53 WO4 (TEST)",
  orderNumber: "52",
  checkedAt: "2026-11-22T16:09:00.000Z",
  paymentTiming: "PayLater",
  startedByGuest: true,
  movedFromTableLabel: "L53 WO3 (TEST)",
  rounds: [everyRound],
  summary: everySummary,
};
/** Read fields the reply never sends, each with its reason (none today). */
const notSent: Readonly<Record<string, string>> = {};

describe("batch 54: the guest table reply sends every field the read builds", () => {
  it("top level, rounds, items and the summary carry each read field", async () => {
    const session = await serve(() => everyView);
    const missing = (path: string, read: object, sent: unknown) =>
      Object.keys(read)
        .filter((key) => notSent[path + key] === undefined)
        .filter((key) => !(sent !== null && typeof sent === "object" && Object.hasOwn(sent, key)))
        .map((key) => path + key);
    const round = (session.rounds as Record<string, unknown>[])[0];
    const item = (round?.items as Record<string, unknown>[] | undefined)?.[0];
    expect([
      ...missing("", everyView, session),
      ...missing("rounds[].", everyRound, round),
      ...missing("rounds[].items[].", everyItem, item),
      ...missing("summary.", everySummary, session.summary),
    ]).toEqual([]);
  });
});

describe("batch 55: the v15 b54 shapes the guest pages read after a staff close", () => {
  const payments = (session: Record<string, unknown>) =>
    (session.rounds as { payment: string }[]).map((round) => round.payment);
  it("order 59: one round, nothing paid, written off: closed, paid 0, the round on the bill", async () => {
    const session = await serve(() => guestRead("one-round-nothing-paid-written-off"));
    expect(payments(session)).toEqual(["OnTableBill"]);
    const summary = session.summary as Record<string, unknown>;
    expect(summary.closedByStaff).toBe(true);
    expect(summary.paid).toEqual({ amountMinor: "0", currencyCode: "CAD" });
    expect(summary.due).toEqual({ amountMinor: "0", currencyCode: "CAD" });
    expect(summary.splitParts).toBeUndefined();
  });
  it("order 67: part 1 of 2 paid is tied to round 1, which the read sends as Paid", async () => {
    const session = await serve(() => guestRead("half-split-written-off"));
    expect(payments(session)).toEqual(["Paid", "OnTableBill"]);
    const summary = session.summary as Record<string, unknown>;
    expect(summary.closedByStaff).toBe(true);
    expect(summary.paid).toEqual({ amountMinor: "1413", currencyCode: "CAD" });
    expect(summary.splitParts).toEqual({ count: 2, paid: 1 });
  });
  it("order 55 (by dish, as order 52): round 1 Paid, round 2 still on the bill", async () => {
    expect(payments(await serve(() => guestRead("by-dish-written-off")))).toEqual([
      "Paid",
      "OnTableBill",
    ]);
  });
});

// Batch 58 (v15 b57 live, L57R A and L57R B): after staff refunded part 1's phone payment, part
// of it or all of it, every phone's Table total still said "Paid $14.13". Through the real read
// composition and HTTP reply: the table says what it paid after refunds, and nothing else of who.
describe("batch 58: the table's paid figure after staff refunded a phone payment", () => {
  it("a part refund and a full refund send what the table paid after refunds", async () => {
    const partial = (await serve(() => guestRead("half-split-written-off", "Partial")))
      .summary as Record<string, unknown>;
    expect(partial.paid).toEqual({ amountMinor: "1413", currencyCode: "CAD" });
    // $5.00 back and $3.00 on its way count; the $2.00 the Provider refused moved nothing.
    expect(partial.paidAfterRefunds).toEqual({ amountMinor: "613", currencyCode: "CAD" });
    const full = (await serve(() => guestRead("by-dish-written-off", "Full"))).summary as Record<
      string,
      unknown
    >;
    expect(full.paidAfterRefunds).toEqual({ amountMinor: "0", currencyCode: "CAD" });
    // The dish refunds and their pending line are not the table's refunds: unchanged.
    expect([full.refunded, full.refundPending]).toEqual([
      { amountMinor: "0", currencyCode: "CAD" },
      { amountMinor: "0", currencyCode: "CAD" },
    ]);
    // Never who was refunded or a refund's reason or reference.
    expect(JSON.stringify(full)).not.toMatch(/re_|reason|CUSTOMER_REQUEST|onlinePayment/iu);
  });
  it("no refund: the reply is as before, with no paid-after-refunds figure", async () => {
    const summary = (await serve(() => guestRead("half-split-written-off"))).summary as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(summary, "paidAfterRefunds")).toBe(false);
  });
  // Batch 59 (v15 b58 live, L58R B): all of part 1 went back; every phone's reply says one of
  // the 2 parts was given back in full (never whose), so no page says the table paid it.
  it("batch 59: a part given back in full is sent with the split; a part only partly, not", async () => {
    const full = (await serve(() => guestRead("half-split-written-off", "Full"))).summary as Record<
      string,
      unknown
    >;
    expect(full.paidAfterRefunds).toEqual({ amountMinor: "0", currencyCode: "CAD" });
    expect(full.splitParts).toEqual({ count: 2, paid: 1, refunded: 1 });
    expect(JSON.stringify(full)).not.toMatch(/re_|reason|CUSTOMER_REQUEST|onlinePayment/iu);
    const partial = (await serve(() => guestRead("half-split-written-off", "Partial")))
      .summary as Record<string, unknown>;
    expect(partial.splitParts).toEqual({ count: 2, paid: 1 });
  });
});

// Batch 60 (v15 b58/b59 known limit): guests paid by dish (phone A round 1, $14.13; phone B round
// 2, $14.12, one settlement each with one line per round, as v15 records them) and staff then gave
// back all or some of A's payment. Each round sent "Paid" while the table said "Paid after refunds".
// Through Payment's settlement shapes, the real per-round mapping, composition and HTTP reply.
describe("batch 60: a round paid by dish says what staff gave back of its payment", () => {
  const read = (
    scenario: GuestBillScenario,
    refunds: NonNullable<Parameters<typeof guestBillClosedByStaffFacts>[1]>,
    payer: boolean,
  ) => {
    const { facts, bill } = guestBillClosedByStaffFacts(scenario, refunds);
    const { plan, settlements } = guestBillPayments(scenario);
    const roundPaymentRefunds = customerRoundPaymentRefunds(
      plan,
      settlements,
      new Map([[settlements[0]?.settlementReference ?? "", guestTableRefundedMinor(refunds)]]),
      guestPhoneSession(payer),
    );
    return composeCustomerDiningSession({
      ...facts,
      order: {
        ...facts.order,
        tableBill: customerTableBillFacts(bill),
        ...(roundPaymentRefunds.size === 0 ? {} : { roundPaymentRefunds }),
      },
    });
  };
  const rounds = (session: Record<string, unknown>) =>
    (session.rounds as { payment: string; paymentRefund?: unknown }[]).map((round) => [
      round.payment,
      round.paymentRefund,
    ]);
  it("all of A's payment back: round 1 refunded in full on both phones, round 2 still paid", async () => {
    for (const payer of [true, false])
      expect(rounds(await serve(() => read("by-dish-both-paid", "Full", payer)))).toEqual([
        ["Paid", { state: "Full" }],
        ["Paid", undefined],
      ]);
  });
  it("part of A's payment back ($5.00 back, $3.00 on its way): A reads $6.13; B no amount", async () => {
    expect(rounds(await serve(() => read("by-dish-both-paid", "Partial", true)))).toEqual([
      [
        "Paid",
        { state: "Partly", yourPaidAfterRefunds: { amountMinor: "613", currencyCode: "CAD" } },
      ],
      ["Paid", undefined],
    ]);
    const other = await serve(() => read("by-dish-both-paid", "Partial", false));
    expect(rounds(other)).toEqual([
      ["Paid", { state: "Partly" }],
      ["Paid", undefined],
    ]);
    expect(JSON.stringify(other.rounds)).not.toMatch(/613|800|yourPaid/u);
  });
  it("staff closed the rest after A paid by dish: only A's round carries the refund", async () => {
    expect(rounds(await serve(() => read("by-dish-written-off", "Partial", true)))).toEqual([
      [
        "Paid",
        { state: "Partly", yourPaidAfterRefunds: { amountMinor: "613", currencyCode: "CAD" } },
      ],
      ["OnTableBill", undefined],
    ]);
  });
  it("staff's even split pays no round: no round carries a refund", async () => {
    expect(rounds(await serve(() => read("half-split-written-off", "Full", true)))).toEqual([
      ["Paid", undefined],
      ["OnTableBill", undefined],
    ]);
  });
});
