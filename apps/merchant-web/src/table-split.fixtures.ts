/**
 * WP-2423 item 8 ④ (Figma "分单 / AA · v3"): table 8's bill as the server sends it, split evenly
 * in three — part 1 paid on the card machine with a 15 % tip, part 3 being paid on a guest's
 * phone, part 2 to collect. Synthetic, TEST-only amounts (13 % test tax); no guest data.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");

export function splitBillFixture(): Record<string, unknown> {
  return structuredClone({
    diningSessionReference: id(80),
    sessionPhase: "Closing",
    sessionVersion: 4,
    paymentTiming: "PayLater",
    tableLabel: "8",
    orderReference: id(81),
    rounds: [
      {
        roundNumber: 1,
        orderBatchReference: id(82),
        submissionReference: id(83),
        items: [
          {
            displayName: "Mapo tofu (TEST)",
            subtotalMinor: "4850",
            totalMinor: "5481",
            reduction: null,
          },
        ],
        subtotalMinor: "4850",
        taxMinor: "631",
        totalMinor: "5481",
        paid: false,
        orderedBy: 1,
      },
      {
        roundNumber: 2,
        orderBatchReference: id(84),
        submissionReference: id(85),
        items: [
          {
            displayName: "Har gow (TEST)",
            subtotalMinor: "3550",
            totalMinor: "4011",
            reduction: null,
          },
        ],
        subtotalMinor: "3550",
        taxMinor: "461",
        totalMinor: "4011",
        paid: false,
        orderedBy: 2,
      },
    ],
    owed: { subtotalMinor: "5600", taxMinor: "728", totalMinor: "6328" },
    consistent: true,
    settlement: null,
    split: {
      mode: "Even",
      stale: false,
      paidParts: 1,
      remainingMinor: "6328",
      parts: [
        {
          partNumber: 1,
          amountMinor: "3164",
          subtotalMinor: "2800",
          taxMinor: "364",
          roundNumbers: [1],
          payment: {
            method: "CardMachine",
            tipMinor: "420",
            roundingMinor: "0",
            totalMinor: "3584",
            tenderedMinor: null,
            changeMinor: null,
            recordedAt: "2026-10-29T00:40:00.000Z",
            recordedAfterOutage: false,
          },
          guestPaying: false,
        },
        {
          partNumber: 2,
          amountMinor: "3164",
          subtotalMinor: "2800",
          taxMinor: "364",
          roundNumbers: [1, 2],
          payment: null,
          guestPaying: false,
        },
        {
          partNumber: 3,
          amountMinor: "3164",
          subtotalMinor: "2800",
          taxMinor: "364",
          roundNumbers: [2],
          payment: null,
          guestPaying: true,
        },
      ],
    },
    writeOff: null,
    onlinePayment: null,
  });
}
