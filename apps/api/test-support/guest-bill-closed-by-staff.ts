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
 * Batch 56 (v15 b55 live, TM2 L55 CB3, orders 80 and 87):
 * half-split-open: the same even split of 2 with part 1 ($14.13) paid, before staff closed
 *   anything: the bill read still ties part 1 to round 1 (round 1 paid, round 2 on the bill).
 * half-split-paid: then part 2 ($14.12) was paid too; the bill is paid in full.
 * Batch 57 (v15 b56 live, TM2 L56P D, order 101):
 * whole-table-paid-online: one phone paid "The whole table" ($28.25) online, no split, no tip;
 *   the bill is paid in full by that one payment (the table's settlement, method Online).
 * Batch 60 (b58/b59 known limit; v15's by-dish settlements, e.g. TM2 L53 orders: one settlement
 * per guest, one line per round, part 1 1413 for round 1 and part 2 1412 for round 2):
 * by-dish-both-paid: phone A paid its own dish (round 1, $14.13), phone B paid its own (round 2,
 *   $14.12): the bill is paid in full by dish, nothing written off.
 */
export type GuestBillScenario =
  | "open-after-one-dish"
  | "by-dish-written-off"
  | "parts-written-off"
  | "nothing-paid-written-off"
  | "one-round-nothing-paid-written-off"
  | "half-split-written-off"
  | "half-split-open"
  | "half-split-paid"
  | "whole-table-paid-online"
  | "by-dish-both-paid";

const id = (n: number) => "0198b054-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const cad = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
const sentAt = "2026-11-22T16:06:00.000Z";
const allRounds = [
  { batch: id(0x30), item: id(0x31), totalMinor: 1413n, taxMinor: 163n, mine: true },
  { batch: id(0x40), item: id(0x41), totalMinor: 1412n, taxMinor: 162n, mine: false },
] as const;
const roundsOf = (scenario: GuestBillScenario): readonly (typeof allRounds)[number][] =>
  scenario === "one-round-nothing-paid-written-off" ? allRounds.slice(0, 1) : allRounds;
const evenHalves = (scenario: GuestBillScenario) =>
  scenario === "half-split-written-off" ||
  scenario === "half-split-open" ||
  scenario === "half-split-paid";
/** No write-off: the bill is still open, or paid in full. */
const notWrittenOff = (scenario: GuestBillScenario) =>
  scenario === "open-after-one-dish" ||
  scenario === "half-split-open" ||
  scenario === "half-split-paid" ||
  scenario === "whole-table-paid-online" ||
  scenario === "by-dish-both-paid";
/** Every round paid: by both parts of the split, or by one payment for the whole table. */
const paidInFull = (scenario: GuestBillScenario) =>
  scenario === "half-split-paid" ||
  scenario === "whole-table-paid-online" ||
  scenario === "by-dish-both-paid";
/** What the table paid, payment by payment. */
const paidOf = (scenario: GuestBillScenario): bigint[] =>
  scenario === "half-split-paid" || scenario === "by-dish-both-paid"
    ? [1413n, 1412n]
    : scenario === "whole-table-paid-online"
      ? [2825n]
      : scenario === "open-after-one-dish" ||
          scenario === "by-dish-written-off" ||
          evenHalves(scenario)
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
      paid: paidInFull(scenario) || ((byDishPaid || evenHalves(scenario)) && round.mine),
      orderedBy: null,
      fromTableLabel: null,
      liveOrderedAt: null,
    })),
    owed: { totalMinor: String(owedMinor) },
    taxRoundingMinor: "0",
    split:
      scenario === "nothing-paid-written-off" ||
      scenario === "one-round-nothing-paid-written-off" ||
      scenario === "whole-table-paid-online"
        ? null
        : {
            mode: scenario === "parts-written-off" || evenHalves(scenario) ? "Even" : "ByGuests",
            stale: false,
            paidInFull: scenario === "half-split-paid" || scenario === "by-dish-both-paid",
          },
    writeOff: notWrittenOff(scenario)
      ? null
      : { amountMinor: String(owedMinor), decidedAt: "2026-11-22T16:08:33.000Z" },
  } as unknown as TableBill;
}

/** Batch 60: the guest Sessions of the two phones (A paid part 1; B is the other phone). */
export const guestPhoneSession = (payer: boolean) => id(payer ? 0x60 : 0x61);

/**
 * Batch 60: Payment's records of this table's payments, in the settlement store's read shapes
 * (listSplitPlans / listByOrders), so the real `customerRoundPaymentRefunds` ties staff's refunds
 * to the rounds those payments paid. By dish: one settlement per guest, one line per round (as on
 * v15); staff's even split: part 1's slice is round 1 (as v15 recorded order 67); the whole table:
 * one settlement with a line per round.
 */
export function guestBillPayments(scenario: GuestBillScenario): {
  readonly plan:
    | {
        readonly splitPlanReference: string;
        readonly mode: "Even" | "ByGuests";
        readonly guestParts: readonly {
          readonly partNumber: number;
          readonly guestSessionReference: string | null;
          readonly withdrawn: null;
        }[];
      }
    | undefined;
  readonly settlements: readonly {
    readonly settlementReference: string;
    readonly part: { readonly splitPlanReference: string; readonly partNumber: number } | null;
    readonly totalMinor: bigint;
    readonly tipMinor: bigint;
    readonly lines: readonly {
      readonly orderBatchReference: string;
      readonly roundMinor: bigint;
      readonly tipMinor: bigint;
      readonly roundingMinor: bigint;
    }[];
  }[];
} {
  const plan = id(0x70);
  const paid = paidOf(scenario);
  if (paid.length === 0) return { plan: undefined, settlements: [] };
  if (scenario === "whole-table-paid-online")
    return {
      plan: undefined,
      settlements: [
        {
          settlementReference: id(0x80),
          part: null,
          totalMinor: 2825n,
          tipMinor: 0n,
          lines: allRounds.map((round) => ({
            orderBatchReference: round.batch,
            roundMinor: round.totalMinor,
            tipMinor: 0n,
            roundingMinor: 0n,
          })),
        },
      ],
    };
  const even = scenario === "parts-written-off" || evenHalves(scenario);
  return {
    plan: {
      splitPlanReference: plan,
      mode: even ? "Even" : "ByGuests",
      guestParts: even
        ? []
        : paid.map((_, index) => ({
            partNumber: index + 1,
            guestSessionReference: guestPhoneSession(index === 0),
            withdrawn: null,
          })),
    },
    settlements: paid.map((amountMinor, index) => ({
      settlementReference: id(0x80 + index),
      part: { splitPlanReference: plan, partNumber: index + 1 },
      totalMinor: amountMinor,
      tipMinor: 0n,
      lines: [
        {
          orderBatchReference: allRounds[index]?.batch ?? allRounds[0].batch,
          roundMinor: amountMinor,
          tipMinor: 0n,
          roundingMinor: 0n,
        },
      ],
    })),
  };
}

/** Batch 59: what staff gave back of the table's payments, refused refunds left out. */
export function guestTableRefundedMinor(kind: GuestOwnRefunds): bigint {
  return guestOwnRefunds(kind)
    .filter((refund) => refund.status !== "Failed")
    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n);
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
  if (notWrittenOff(scenario)) return null;
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
export function guestBillClosedByStaffFacts(
  scenario: GuestBillScenario,
  /**
   * Batch 58 (v15 b57 live, L57R A/B): what staff refunded of the table's payments, as the read
   * sums Payment's refund records of the table (readCustomerTablePayments); absent: nothing.
   */
  tableRefunds: GuestOwnRefunds = "None",
): {
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
            : scenario === "whole-table-paid-online"
              ? "L56P D (TEST)"
              : scenario === "by-dish-both-paid"
                ? "L60 BD (TEST)"
                : evenHalves(scenario)
                  ? "L55 CB3 (TEST)"
                  : "L53 WO4 (TEST)",
      checkedAt: "2026-11-22T16:09:00.000Z",
      paymentTiming: "PayLater",
      order: {
        orderNumber:
          scenario === "one-round-nothing-paid-written-off"
            ? "59"
            : scenario === "half-split-written-off"
              ? "67"
              : scenario === "whole-table-paid-online"
                ? "101"
                : scenario === "by-dish-both-paid"
                  ? "66"
                  : evenHalves(scenario)
                    ? "80"
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
        // A part of a split settles no round on its own (the bill was not paid in full); once
        // every part is paid, the settlements settle every round.
        settledRounds: new Set(paidInFull(scenario) ? rounds.map((round) => round.batch) : []),
        tableSettlement:
          paid.length === 0
            ? null
            : {
                tipMinor: 0n,
                roundingMinor: 0n,
                ...(() => {
                  const refundedMinor = guestOwnRefunds(tableRefunds)
                    .filter((refund) => refund.status !== "Failed")
                    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n);
                  return refundedMinor === 0n ? {} : { refundedMinor };
                })(),
              },
        splitParts:
          nothingPaid || scenario === "whole-table-paid-online"
            ? null
            : {
                count: scenario === "parts-written-off" ? 3 : evenHalves(scenario) ? 2 : null,
                paid: paid.length,
                // Batch 59 (v15 b58 live, L58R B): all of part 1 went back, so the read counts
                // that part as given back in full (readCustomerTablePayments, by settlement).
                ...(tableRefunds === "Full" ? { refunded: 1 } : {}),
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
type OwnRefund = NonNullable<PaymentView["ownPayments"]>[number]["refunds"][number];
/**
 * Batch 57 (WP-2423 Q36): refunds staff made of the payer's own phone payment (1413), in the
 * shapes Payment records them (rms_payment.dining_table_online_refund and _outcome, as on v15):
 * "Partial" — $5.00 back to the card (v15's 2026-11-11 FOOD_ISSUE refund: the Provider answered
 * Succeeded 44 ms after the request), $3.00 still on its way (no Provider answer yet, as the
 * sender leaves one the Provider calls "pending") and $2.00 the Provider refused (Failed, no
 * Provider refund: nothing moved); "Full" — the whole payment back (v15's 2026-11-03 refund of all
 * of a part, 890 of 890). Batch 61 (v15 b60 live, TM2 orders 49, 51 and 56): "Eight" — $8.00 of
 * the $14.13 back to the card, the Provider answering Succeeded (Payment amount 800, outcome
 * Succeeded/800), so the payer paid $6.13 after it.
 */
export type GuestOwnRefunds = "None" | "Partial" | "Full" | "Eight";
export function guestOwnRefunds(kind: GuestOwnRefunds): readonly OwnRefund[] {
  if (kind === "None") return [];
  if (kind === "Eight")
    return [
      {
        amountMinor: "800",
        status: "Refunded",
        requestedAt: "2026-11-24T22:51:12.408Z",
        answeredAt: "2026-11-24T22:51:12.512Z",
      },
    ];
  if (kind === "Full")
    return [
      {
        amountMinor: "1413",
        status: "Refunded",
        requestedAt: "2026-11-24T00:40:03.609Z",
        answeredAt: "2026-11-24T00:40:03.643Z",
      },
    ];
  return [
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
  ];
}
/**
 * Batch 56 (v15 b55 live, L55 CB2 order 76 and L55 CB3 order 80): the guest table-payment view
 * (createDiningTableOnlinePayments' read) once staff closed the rest of a bill one guest paid
 * part of on their phone — by dish (ByGuests part 1: their Beef noodles) or part 1 of staff's even
 * split in 2 — as v15 holds it: split plan part 1, captured 1413, tip 0; the rest (1412) written
 * off. `payer`: the phone that paid (its own captured payment); otherwise another guest's phone.
 * Batch 57 (v15 b56 live, L56 SRL1 order 88): `half-split-open` is the same even split before
 * staff closed anything: part 1 paid on a phone, part 2 ($14.12) still to pay, nothing written off.
 */
export function guestOwnPaymentView(
  scenario:
    "by-dish-written-off" | "half-split-written-off" | "half-split-open" | "by-dish-both-paid",
  payer: boolean,
  sessionPhase: "Closing" | "Closed" = "Closing",
  refunds: GuestOwnRefunds = "None",
): PaymentView {
  // Batch 60: both guests paid their own dish (B, the other phone, paid part 2 for round 2).
  const bothPaid = scenario === "by-dish-both-paid";
  const byDish = scenario === "by-dish-written-off" || bothPaid;
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
    dishes: bothPaid ? [dish] : [],
    payment: bothPaid
      ? { ...paidPart.payment, totalMinor: "1412", recordedAt: "2026-11-24T00:35:02.000Z" }
      : null,
    guestPaying: false,
    ...(bothPaid ? { choice: "Mine" as const } : {}),
  };
  // Batch 61: what staff gave back of the table's payments (all of it of A's part 1), as the bill
  // read sums Payment's refunds of the table (readDiningTableBill's refundedMinor).
  const tableRefunded = guestTableRefundedMinor(refunds);
  return {
    bill: {
      diningSessionReference: id(0x20),
      sessionPhase,
      sessionVersion: 7,
      ...(tableRefunded === 0n ? {} : { refundedMinor: tableRefunded.toString() }),
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
        paid: round.mine || bothPaid,
        orderedBy: null,
        fromTableLabel: null,
        liveOrderedAt: null,
      })),
      taxRoundingMinor: "0",
      owed: bothPaid
        ? { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" }
        : { subtotalMinor: "1250", taxMinor: "162", totalMinor: "1412" },
      consistent: true,
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      settlement: null,
      split: {
        mode: byDish ? "ByGuests" : "Even",
        stale: false,
        paidInFull: bothPaid,
        dishChoices: [],
        parts: byDish && !bothPaid ? [paidPart] : [paidPart, restPart],
        paidParts: bothPaid ? 2 : 1,
        remainingMinor: bothPaid ? "0" : "1412",
      },
      writeOff:
        scenario === "half-split-open" || bothPaid
          ? null
          : { amountMinor: "1412", decidedAt: "2026-11-24T00:35:10.000Z" },
      onlinePayment: null,
    } as unknown as PaymentView["bill"],
    attempt: null,
    lastOwnDeclined: null,
    paidByMe: byDish ? (payer ? [1] : bothPaid ? [2] : []) : [],
    choices: null,
    ownPayments: !payer
      ? bothPaid
        ? [
            {
              partNumber: 2,
              samePlan: true,
              roundsMinor: "1412",
              tipMinor: "0",
              totalMinor: "1412",
              paidAt: "2026-11-24T00:35:02.000Z",
              refunds: [],
            },
          ]
        : []
      : [
          {
            partNumber: 1,
            samePlan: true,
            roundsMinor: "1413",
            tipMinor: "0",
            totalMinor: "1413",
            paidAt: "2026-11-24T00:34:40.000Z",
            refunds: guestOwnRefunds(refunds),
          },
        ],
  };
}

/**
 * Batch 57 (v15 b56 live, TM2 L56P D, order 101): the guest table-payment view of a table one
 * phone paid in full ("The whole table", $28.25 online, no tip): the table's settlement, method
 * Online, captured 2825; no split, nothing written off. While open (Closing) the pay panel shows
 * the whole-table receipt; once staff closed the table (Closed) the settled receipt reads it.
 */
export function guestWholeTablePaidView(sessionPhase: "Closing" | "Closed"): PaymentView {
  const { facts } = guestBillClosedByStaffFacts("whole-table-paid-online");
  return {
    bill: {
      diningSessionReference: id(0x20),
      sessionPhase,
      sessionVersion: 6,
      paymentTiming: "PayLater",
      tableLabel: facts.tableLabel,
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
        paid: true,
        orderedBy: null,
        fromTableLabel: null,
        liveOrderedAt: null,
      })),
      taxRoundingMinor: "0",
      owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
      consistent: true,
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      settlement: {
        method: "Online",
        roundsMinor: "2825",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "2825",
        tenderedMinor: null,
        changeMinor: null,
        recordedAt: "2026-11-24T05:12:40.000Z",
        recordedAfterOutage: false,
      },
      split: null,
      writeOff: null,
      onlinePayment: null,
    } as unknown as PaymentView["bill"],
    attempt: null,
    lastOwnDeclined: null,
    paidByMe: [],
    choices: null,
    ownPayments: [],
  };
}
