import { expect, it } from "vitest";
import { billRoundNumber } from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import { tableBillRoundNumbers } from "./table-checkout-client.js";

// b40 review (v15 b39 live, L39 M3 merged into L39 M2): every staff screen numbers a merged
// table's rounds as its bill does; a round waiting for staff OK follows the bill's rounds.
const id = (n: number) => "0190a420-0000-7000-8000-" + n.toString(16).padStart(12, "0");

it("a round waiting for staff OK follows the bill's rounds, in the order it was held", () => {
  const numbers = tableBillRoundNumbers({
    rounds: [
      { roundNumber: 1, orderBatchReference: id(51) },
      { roundNumber: 2, orderBatchReference: id(52) },
      { roundNumber: 3, orderBatchReference: id(62) },
    ] as never,
    waitingRounds: [
      { orderBatchReference: id(72), heldAt: "2026-11-21T06:40:00.000Z" },
      { orderBatchReference: id(71), heldAt: "2026-11-21T06:35:00.000Z" },
    ] as never,
  });
  expect([...numbers]).toEqual([
    [id(51), 1],
    [id(52), 2],
    [id(62), 3],
    [id(71), 4],
    [id(72), 5],
  ]);
});

const row = (n: number, tableBill: unknown) => ({
  orderReference: id(n),
  orderNumber: "T-" + String(n),
  orderType: "DineIn",
  sourceChannel: "Qr",
  submittedAt: "2026-11-21T06:20:00.000Z",
  observedAt: "2026-11-21T06:30:00.000Z",
  initialBatchReference: id(50 + n),
  batches: [
    {
      orderBatchReference: id(50 + n),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  tableBill,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  currentPhase: "InProgress",
  currentVersion: 2,
});
const numbers = [
  { orderBatchReference: id(51), roundNumber: 1 },
  { orderBatchReference: id(52), roundNumber: 2 },
];

it("Orders reads each round's number on a merged bill, for the host and the merged-in order", () => {
  const read = (value: ReturnType<typeof row>) =>
    parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null }).items[0];
  const host = read(row(1, { totalMinor: "2826", paid: null, billRoundNumbers: numbers }));
  const mergedIn = read(
    row(2, {
      totalMinor: "0",
      paid: null,
      mergedInto: { tableLabel: "L39 M2 (TEST)", paid: false },
      billRoundNumbers: numbers,
    }),
  );
  if (host === undefined || mergedIn === undefined) throw new Error("no rows");
  const first = (order: typeof host) => order.batches[0] as (typeof host.batches)[number];
  // Each order's own first round: "round 1" twice before; now 1 and 2, as on the bill.
  expect(first(host).sequence).toBe(1);
  expect(first(mergedIn).sequence).toBe(1);
  expect(billRoundNumber(host, first(host))).toBe(1);
  expect(billRoundNumber(mergedIn, first(mergedIn))).toBe(2);
  expect(mergedIn.tableBill?.mergedInto?.tableLabel).toBe("L39 M2 (TEST)");
  // Not merged: the order's own number.
  const [plain] = parseCurrentOrderQueue({
    items: [row(3, { totalMinor: "1413", paid: null })],
    nextAfterOrderReference: null,
  }).items;
  if (plain === undefined) throw new Error("no row");
  expect(billRoundNumber(plain, { orderBatchReference: id(53), sequence: 1 })).toBe(1);
});

it("refuses bill round numbers that would show two rounds under one number", () => {
  const read = (billRoundNumbers: unknown) => () =>
    parseCurrentOrderQueue({
      items: [row(1, { totalMinor: "2826", paid: null, billRoundNumbers })],
      nextAfterOrderReference: null,
    });
  expect(
    read([
      { orderBatchReference: id(51), roundNumber: 1 },
      { orderBatchReference: id(52), roundNumber: 1 },
    ]),
  ).toThrow();
  expect(read([{ orderBatchReference: id(51), roundNumber: 0 }])).toThrow();
  expect(read([{ orderBatchReference: "not-a-reference", roundNumber: 1 }])).toThrow();
});
