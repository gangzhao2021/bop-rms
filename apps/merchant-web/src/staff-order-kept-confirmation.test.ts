import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  keptConfirmationOf,
  keptRecordedPaymentOf,
  paidNoteFrom,
} from "./staff-order-kept-confirmation.js";

// Batch 67 (v15 b66 live): what the language switch keeps of a sent round's or a paid order's
// confirmation is checked before it is shown again, and its texts are said in the new language.
const placed = {
  status: "Placed",
  orderReference: "01909979-0000-7000-8000-000000000014",
  orderBatchReference: "01909979-0000-7000-8000-000000000015",
  orderNumber: "20",
  orderVersion: 4,
  orderMinor: "2300",
  tipMinor: "0",
  totalMinor: "2300",
  payBy: null,
  payLater: true,
  recordedAfterOutage: false,
  tableLabel: "T4",
  paperPayment: null,
};
const kept = {
  phase: "Sent",
  placed,
  lines: [{ key: "a" }],
  tip: "0",
  customTip: "",
  tender: "CardMachine",
  paper: false,
  changeDue: null,
  paid: null,
  removed: { kind: "Guest", lines: [{ name: "Gyoza", unsellable: true }] },
  sentGuest: [
    {
      name: "Gyoza",
      options: "",
      quantity: 2,
      estimateMinor: "1400",
      unsellable: false,
      phoneNumber: 3,
      phoneLeft: false,
    },
  ],
};
const line = (value: unknown): value is { key: string } =>
  typeof (value as { key?: unknown } | null)?.key === "string";

afterEach(() => setLanguageForTest("en"));

it("b67: a kept confirmation comes back as it was shown, and only a whole one", () => {
  const back = keptConfirmationOf(JSON.parse(JSON.stringify(kept)), line);
  expect(back?.phase).toBe("Sent");
  expect(back?.placed.orderNumber).toBe("20");
  expect(back?.sentGuest).toEqual(kept.sentGuest);
  expect(back?.removed).toEqual(kept.removed);
  // The paper payment's outcome is never kept or brought back.
  expect(back?.placed).not.toHaveProperty("paperPayment");
  for (const broken of [
    { ...kept, phase: "Building" },
    { ...kept, phase: "Charge" },
    // A round on the table's bill is "Sent"; a paid order is never shown as one.
    { ...kept, phase: "Paid" },
    { ...kept, placed: { ...placed, totalMinor: "2.30" } },
    { ...kept, lines: [{}] },
    { ...kept, sentGuest: [{ ...kept.sentGuest[0], estimateMinor: 14 }] },
    { ...kept, paid: { kind: "Recorded" } },
    { ...kept, tender: "Crypto" },
    null,
    "x",
  ])
    expect(keptConfirmationOf(broken, line)).toBeNull();
  expect(
    keptConfirmationOf(
      { ...kept, phase: "Paid", placed: { ...placed, payLater: false, payBy: "2026-11-27" } },
      line,
    )?.phase,
  ).toBe("Paid");
});

it("b67: the paid line is said again in the language now on screen", () => {
  const source = {
    kind: "Recorded",
    recordedAfterOutage: false,
    acceptance: "Accepted",
    cash: null,
  } as const;
  const english = paidNoteFrom(source, false);
  setLanguageForTest("zh-Hans");
  const chinese = paidNoteFrom(source, false);
  expect(chinese).not.toBe(english);
  expect(chinese).toMatch(/[一-鿿]/u);
  expect(paidNoteFrom({ kind: "AlreadyPaid", orderNumber: "21", paper: false }, false)).toContain(
    "21",
  );
});

it("b67: a counter order recorded from its list keeps its paid panel, and only a whole one", () => {
  const recorded = {
    orderReference: "01909979-0000-7000-8000-000000000046",
    orderNumber: "21",
    payment: {
      status: "Recorded",
      amountMinor: "1413",
      recordingReason: "AtCounter",
      takenAt: "2026-11-27T15:00:00.000Z",
      acceptance: "Accepted",
      cash: null,
    },
  };
  expect(keptRecordedPaymentOf(JSON.parse(JSON.stringify(recorded)))).toEqual(recorded);
  expect(
    keptRecordedPaymentOf({ ...recorded, payment: { ...recorded.payment, amountMinor: 14.13 } }),
  ).toBeNull();
  expect(keptRecordedPaymentOf({ orderNumber: "21" })).toBeNull();
});
