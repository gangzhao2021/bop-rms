/**
 * Batch 54 (v15 b53 live, table-total-note-after-by-dish-pay): a table paying at the end whose
 * guests left, in the shapes v15 read for TM2's L53 WO4 (TEST), order 52. Two guests each ordered
 * Beef noodles (TEST) ($14.13 and $14.12 with tax); staff pressed Start checkout; guest A paid
 * their own dish online; staff then recorded "Guests left without paying the rest" (a
 * GUEST_LEFT_UNPAID write-off: priced 2825, captured 1413, written off 1412).
 *
 * Plain data only (type imports): the api HTTP test composes it with the real read and handler
 * from source, and the customer browser spec serves it through the same handler on a local server.
 */
import type { CustomerDiningSessionFacts } from "../src/customer-dining-session-read.js";
import type { readDiningTableBill } from "../src/merchant-dining-table-checkout.js";

type Order = NonNullable<CustomerDiningSessionFacts["order"]>;
type TableBill = Awaited<ReturnType<typeof readDiningTableBill>>;

/**
 * open-after-one-dish: guest A paid their dish, the rest is still owed (before staff act).
 * by-dish-written-off: then staff wrote off the rest (order 52).
 * parts-written-off: staff split the bill in 3 equal parts; 1 was paid, then the rest written off.
 * nothing-paid-written-off: the guests left before anyone paid; the whole bill written off.
 * Batch 55 (v15 b54 live, TM2):
 * one-round-nothing-paid-written-off: order 59, one round ($14.13), nobody paid, all written off.
 * half-split-written-off: order 67, staff split evenly in 2; part 1 ($14.13) was paid, and the
 *   bill read tied that part to round 1 (round 1 paid); then the rest ($14.12) written off.
 */
export type GuestBillScenario =
  | "open-after-one-dish"
  | "by-dish-written-off"
  | "parts-written-off"
  | "nothing-paid-written-off"
  | "one-round-nothing-paid-written-off"
  | "half-split-written-off";

const id = (n: number) => "0198b054-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const cad = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
const sentAt = "2026-11-22T16:06:00.000Z";
const allRounds = [
  { batch: id(0x30), item: id(0x31), totalMinor: 1413n, taxMinor: 163n, mine: true },
  { batch: id(0x40), item: id(0x41), totalMinor: 1412n, taxMinor: 162n, mine: false },
] as const;
const roundsOf = (scenario: GuestBillScenario): readonly (typeof allRounds)[number][] =>
  scenario === "one-round-nothing-paid-written-off" ? allRounds.slice(0, 1) : allRounds;
/** What the table paid, payment by payment. */
const paidOf = (scenario: GuestBillScenario): bigint[] =>
  scenario === "open-after-one-dish" ||
  scenario === "by-dish-written-off" ||
  scenario === "half-split-written-off"
    ? [1413n]
    : scenario === "parts-written-off"
      ? [942n]
      : [];

/** The table bill as staff checkout reads it (readDiningTableBill), the fields the guest uses. */
function tableBill(scenario: GuestBillScenario): TableBill {
  const byDishPaid = scenario === "open-after-one-dish" || scenario === "by-dish-written-off";
  const rounds = roundsOf(scenario);
  const paidMinor = paidOf(scenario).reduce<bigint>((sum, amount) => sum + amount, 0n);
  const owedMinor = rounds.reduce<bigint>((sum, round) => sum + round.totalMinor, 0n) - paidMinor;
  return {
    rounds: rounds.map((round, index) => ({
      roundNumber: index + 1,
      orderReference: id(1),
      orderBatchReference: round.batch,
      submissionReference: id(0x50 + index),
      items: [
        {
          orderItemReference: round.item,
          quantity: 1,
          displayName: "Beef noodles (TEST)",
          subtotalMinor: "1250",
          totalMinor: String(round.totalMinor),
          reduction: null,
        },
      ],
      subtotalMinor: "1250",
      taxMinor: String(round.taxMinor),
      totalMinor: String(round.totalMinor),
      taxRoundingMinor: "0",
      // By dish, guest A's own round was paid in full; a fixed part of 3 pays no round on its
      // own, but v15 tied order 67's part 1 of 2 to round 1 (its slice was all of round 1).
      paid: (byDishPaid || scenario === "half-split-written-off") && round.mine,
      orderedBy: null,
      fromTableLabel: null,
      liveOrderedAt: null,
    })),
    owed: { totalMinor: String(owedMinor) },
    taxRoundingMinor: "0",
    split:
      scenario === "nothing-paid-written-off" || scenario === "one-round-nothing-paid-written-off"
        ? null
        : {
            mode:
              scenario === "parts-written-off" || scenario === "half-split-written-off"
                ? "Even"
                : "ByGuests",
            stale: false,
            paidInFull: false,
          },
    writeOff:
      scenario === "open-after-one-dish"
        ? null
        : { amountMinor: String(owedMinor), decidedAt: "2026-11-22T16:08:33.000Z" },
  } as unknown as TableBill;
}

/**
 * Batch 55 review: Payment's write-off record of this bill (priced, captured before it, written
 * off), as v15 holds it; null while the bill is open. The visit restore reads it once the table
 * closed (session phase Closed).
 */
export function guestBillWriteOff(scenario: GuestBillScenario): {
  readonly reasonCode: "GUEST_LEFT_UNPAID";
  readonly pricedOrderTotalMinor: bigint;
  readonly capturedOrderAllocationMinor: bigint;
  readonly writtenOffMinor: bigint;
} | null {
  if (scenario === "open-after-one-dish") return null;
  const priced = roundsOf(scenario).reduce<bigint>((sum, round) => sum + round.totalMinor, 0n);
  const captured = paidOf(scenario).reduce<bigint>((sum, amount) => sum + amount, 0n);
  return {
    reasonCode: "GUEST_LEFT_UNPAID",
    pricedOrderTotalMinor: priced,
    capturedOrderAllocationMinor: captured,
    writtenOffMinor: priced - captured,
  };
}

/**
 * The guest read's facts for this table (customer-dining-session-read's reader output), with the
 * table bill's own facts left to `customerTableBillFacts` so the real mapping runs.
 */
export function guestBillClosedByStaffFacts(scenario: GuestBillScenario): {
  readonly facts: Omit<CustomerDiningSessionFacts, "order"> & {
    readonly order: Omit<Order, "tableBill">;
  };
  readonly bill: TableBill;
} {
  const paid = paidOf(scenario);
  const rounds = roundsOf(scenario);
  const nothingPaid =
    scenario === "nothing-paid-written-off" || scenario === "one-round-nothing-paid-written-off";
  return {
    bill: tableBill(scenario),
    facts: {
      diningSessionReference: id(0x20),
      tableLabel:
        scenario === "one-round-nothing-paid-written-off"
          ? "L54 GB2 (TEST)"
          : scenario === "half-split-written-off"
            ? "L54 GB5 (TEST)"
            : "L53 WO4 (TEST)",
      checkedAt: "2026-11-22T16:09:00.000Z",
      paymentTiming: "PayLater",
      order: {
        orderNumber:
          scenario === "one-round-nothing-paid-written-off"
            ? "59"
            : scenario === "half-split-written-off"
              ? "67"
              : "52",
        batches: rounds.map((round) => ({
          orderBatchReference: round.batch,
          submittedAt: sentAt,
          items: [
            {
              orderItemReference: round.item,
              displayName: "Beef noodles (TEST)",
              quantity: 1,
              lineTotal: cad(round.totalMinor),
            },
          ],
        })),
        authorship: new Map(rounds.map((round) => [round.batch, round.mine])),
        delivery: new Map(
          rounds.map((round) => [
            round.item,
            { phase: "Fulfilled" as never, deliveredQuantity: 1 },
          ]),
        ),
        paymentOutcomes: new Map(),
        paymentDeadlines: new Map(),
        payLaterRounds: new Set(rounds.map((round) => round.batch)),
        // A part of a split settles no round on its own (the bill was not paid in full).
        settledRounds: new Set(),
        tableSettlement: paid.length === 0 ? null : { tipMinor: 0n, roundingMinor: 0n },
        splitParts: nothingPaid
          ? null
          : {
              count:
                scenario === "parts-written-off"
                  ? 3
                  : scenario === "half-split-written-off"
                    ? 2
                    : null,
              paid: 1,
            },
        unpaidCancellations: new Set(),
        staffCancellations: new Map(),
        itemCancellations: [],
        itemPrices: new Map(
          rounds.map((round) => [round.item, { subtotal: cad(1250n), tax: cad(round.taxMinor) }]),
        ),
        payments: paid.map((amountMinor) => ({
          status: "Succeeded" as const,
          amount: cad(amountMinor),
        })),
        refunds: { confirmedMinor: 0n, pendingMinor: 0n },
      },
    },
  };
}

/** What v15 sent for order 52 after the write-off (GET /api/v1/dine-in/session, summary). */
export const liveWrittenOffSummaryWithoutClosedByStaff = {
  paid: { amountMinor: "1413", currencyCode: "CAD" },
  refunded: { amountMinor: "0", currencyCode: "CAD" },
  refundPending: { amountMinor: "0", currencyCode: "CAD" },
  due: { amountMinor: "0", currencyCode: "CAD" },
  splitParts: { count: null, paid: 1 },
  bill: {
    items: { amountMinor: "2500", currencyCode: "CAD" },
    takenOff: { amountMinor: "0", currencyCode: "CAD" },
    pointsUsed: { amountMinor: "0", currencyCode: "CAD" },
    subtotal: { amountMinor: "2500", currencyCode: "CAD" },
    tax: { amountMinor: "325", currencyCode: "CAD" },
    total: { amountMinor: "2825", currencyCode: "CAD" },
  },
  tableTip: { amountMinor: "0", currencyCode: "CAD" },
  cashRounding: { amountMinor: "0", currencyCode: "CAD" },
  ordered: {
    subtotal: { amountMinor: "2500", currencyCode: "CAD" },
    tax: { amountMinor: "325", currencyCode: "CAD" },
    total: { amountMinor: "2825", currencyCode: "CAD" },
  },
} as const;

type PaymentView = import("../src/dining-table-online-payment.js").DiningTableOnlinePaymentView;
/**
 * Batch 56 (v15 b55 live, L55 CB2 order 76 and L55 CB3 order 80): the guest table-payment view
 * (createDiningTableOnlinePayments' read) once staff closed the rest of a bill one guest paid
 * part of on their phone — by dish (ByGuests part 1: their Beef noodles) or part 1 of staff's even
 * split in 2 — as v15 holds it: split plan part 1, captured 1413, tip 0; the rest (1412) written
 * off. `payer`: the phone that paid (its own captured payment); otherwise another guest's phone.
 */
export function guestOwnPaymentView(
  scenario: "by-dish-written-off" | "half-split-written-off",
  payer: boolean,
  sessionPhase: "Closing" | "Closed" = "Closing",
): PaymentView {
  const byDish = scenario === "by-dish-written-off";
  const dish = { displayName: "Beef noodles (TEST)", quantity: 1, shared: false };
  const paidPart = {
    partNumber: 1,
    amountMinor: "1413",
    subtotalMinor: "1250",
    taxMinor: "163",
    roundNumbers: [1],
    dishes: byDish ? [dish] : [],
    payment: {
      method: "Online" as const,
      tipMinor: "0",
      roundingMinor: "0",
      totalMinor: "1413",
      tenderedMinor: null,
      changeMinor: null,
      recordedAt: "2026-11-24T00:34:40.000Z",
      recordedAfterOutage: false,
    },
    guestPaying: false,
    ...(byDish ? { choice: "Mine" as const } : {}),
  };
  const restPart = {
    partNumber: 2,
    amountMinor: "1412",
    subtotalMinor: "1250",
    taxMinor: "162",
    roundNumbers: [2],
    dishes: [],
    payment: null,
    guestPaying: false,
  };
  return {
    bill: {
      diningSessionReference: id(0x20),
      sessionPhase,
      sessionVersion: 7,
      paymentTiming: "PayLater",
      // The same table as the guest table read of this scenario.
      tableLabel: guestBillClosedByStaffFacts(scenario).facts.tableLabel,
      orderReference: id(1),
      rounds: allRounds.map((round, index) => ({
        roundNumber: index + 1,
        orderReference: id(1),
        orderBatchReference: round.batch,
        submissionReference: id(0x50 + index),
        items: [
          {
            orderItemReference: round.item,
            quantity: 1,
            displayName: "Beef noodles (TEST)",
            subtotalMinor: "1250",
            totalMinor: String(round.totalMinor),
            reduction: null,
          },
        ],
        subtotalMinor: "1250",
        taxMinor: String(round.taxMinor),
        totalMinor: String(round.totalMinor),
        taxRoundingMinor: "0",
        paid: round.mine,
        orderedBy: null,
        fromTableLabel: null,
        liveOrderedAt: null,
      })),
      taxRoundingMinor: "0",
      owed: { subtotalMinor: "1250", taxMinor: "162", totalMinor: "1412" },
      consistent: true,
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      settlement: null,
      split: {
        mode: byDish ? "ByGuests" : "Even",
        stale: false,
        paidInFull: false,
        dishChoices: [],
        parts: byDish ? [paidPart] : [paidPart, restPart],
        paidParts: 1,
        remainingMinor: "1412",
      },
      writeOff: { amountMinor: "1412", decidedAt: "2026-11-24T00:35:10.000Z" },
      onlinePayment: null,
    } as unknown as PaymentView["bill"],
    attempt: null,
    lastOwnDeclined: null,
    paidByMe: payer && byDish ? [1] : [],
    choices: null,
    ownPayments: payer
      ? [
          {
            partNumber: 1,
            samePlan: true,
            roundsMinor: "1413",
            tipMinor: "0",
            totalMinor: "1413",
            paidAt: "2026-11-24T00:34:40.000Z",
          },
        ]
      : [],
  };
}
