import { expect, it } from "vitest";
import {
  elapsedText,
  guestRoundCancelHint,
  guestRoundPaymentNotice,
  paidRoundAcceptanceNotice,
  longOpenSessionMinutes,
  staffRoundPaymentNotice,
  tableCodeNotice,
  tableFloorStatus,
  tableMatchesStateFilter,
} from "./DiningSessionWorkspace.js";
import type { StaffDiningTable } from "./dining-session-client.js";

const table: StaffDiningTable = {
  tableReference: "01909988-0000-7000-8000-000000000001",
  stableLabel: "T1",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: null,
  elapsedMinutes: null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  staffRoundsAwaitingPayment: [],
  guestRoundsAwaitingPayment: [],
  roundsAwaitingAcceptance: [],
};
const now = Date.parse("2027-03-01T13:00:00.000Z");

it("WP-2423 Q11: warns on the floor when a table has no printed code or it ends within 30 days", () => {
  expect(tableCodeNotice(table, now)).toBeNull();
  expect(tableCodeNotice({ ...table, qrCodeValidUntil: null }, now)).toBe(
    "No table QR code. Ask a manager to print one.",
  );
  expect(tableCodeNotice(table, Date.parse("2027-03-20T13:00:00.000Z"))).toBe(
    "Table QR code stops working in 23 days. Ask a manager to print a new one.",
  );
  expect(tableCodeNotice(table, Date.parse("2027-04-11T13:00:00.000Z"))).toBe(
    "Table QR code stops working in 1 day. Ask a manager to print a new one.",
  );
  expect(tableCodeNotice({ ...table, lifecycle: "Draft", qrCodeValidUntil: null }, now)).toBeNull();
});

it("WP-2423 follow-up: says how long a table has been open in minutes, hours or days", () => {
  expect(elapsedText(0)).toBe("0 min");
  expect(elapsedText(59)).toBe("59 min");
  expect(elapsedText(180)).toBe("3 h");
  expect(elapsedText(200)).toBe("3 h 20 min");
  expect(elapsedText(1440)).toBe("1 day");
  expect(elapsedText(34992)).toBe("24 days");
  expect(longOpenSessionMinutes).toBe(720);
});

it("WP-2423 item 5: warns before a staff round's payment time ends, urgently in the last 10 minutes", () => {
  const payBy = "2027-03-01T13:30:00.000Z";
  const waiting = {
    ...table,
    currentDiningSessionReference: "01909988-0000-7000-8000-000000000009",
    elapsedMinutes: 20,
    staffRoundsAwaitingPayment: [{ payBy }],
  };
  expect(staffRoundPaymentNotice(table, now, "America/Toronto")).toBeNull();
  expect(staffRoundPaymentNotice(waiting, now, "America/Toronto")).toEqual({
    tier: "warning",
    text: "A round entered by staff awaits card-machine payment. Record it by 08:30; the kitchen starts once it is recorded.",
  });
  expect(
    staffRoundPaymentNotice(waiting, Date.parse(payBy) - 4 * 60_000 - 1, "America/Toronto"),
  ).toEqual({
    tier: "urgent",
    text: "5 min left: record the card-machine payment for the round entered by staff by 08:30, or it is cancelled.",
  });
  const ended = staffRoundPaymentNotice(waiting, Date.parse(payBy), "America/Toronto");
  expect(ended?.tier).toBe("urgent");
  expect(ended?.text).toContain("wasn't paid by 08:30 and is being cancelled");
  expect(ended?.text).toContain("refund it on the machine");
  const two = { ...waiting, staffRoundsAwaitingPayment: [{ payBy }, { payBy }] };
  expect(staffRoundPaymentNotice(two, now, "America/Toronto")?.text).toMatch(
    /^2 rounds entered by staff await/u,
  );
});

it("WP-2423 follow-up: a table with an open session reads as seated, never available", () => {
  const session = "01909988-0000-7000-8000-000000000009";
  const seated = { ...table, currentDiningSessionReference: session, elapsedMinutes: 200 };
  const longOpen = { ...table, currentDiningSessionReference: session, elapsedMinutes: 34992 };
  const unknown = { ...table, currentDiningSessionReference: session, elapsedMinutes: null };
  const blocked = { ...table, operationalState: "TemporarilyBlocked" as const };
  expect(tableFloorStatus(table)).toEqual({ state: "Available", label: "Available" });
  expect(tableFloorStatus(blocked)).toEqual({
    state: "Unavailable",
    label: "Temporarily unavailable",
  });
  expect(tableFloorStatus(seated)).toEqual({ state: "Seated", label: "Seated · open 3 h 20 min" });
  expect(tableFloorStatus(longOpen)).toEqual({
    state: "LongOpen",
    label: "Guests may have left · open 24 days",
  });
  expect(tableFloorStatus(unknown)).toEqual({ state: "Seated", label: "Seated" });
  expect(tableFloorStatus({ ...seated, operationalState: "TemporarilyBlocked" }).label).toBe(
    "Seated · open 3 h 20 min · Temporarily unavailable",
  );
  const tables = [table, blocked, seated, longOpen];
  const pick = (filter: string) => tables.filter((t) => tableMatchesStateFilter(t, filter));
  expect(pick("All")).toEqual(tables);
  expect(pick("Available")).toEqual([table]);
  expect(pick("Seated")).toEqual([seated, longOpen]);
  expect(pick("TemporarilyBlocked")).toEqual([blocked]);
});

it("WP-2423 abandoned payment: warns staff before an unpaid guest round is cancelled", () => {
  const payBy = "2027-03-01T13:30:00.000Z";
  const waiting: StaffDiningTable = {
    ...table,
    currentDiningSessionReference: "01909988-0000-7000-8000-000000000002",
    elapsedMinutes: 20,
    guestRoundsAwaitingPayment: [
      {
        orderReference: "01909988-0000-7000-8000-000000000003",
        orderBatchReference: "01909988-0000-7000-8000-000000000004",
        roundNumber: 1,
        payBy,
      },
    ],
  };
  expect(guestRoundPaymentNotice(table, now, "America/Toronto")).toBeNull();
  expect(guestRoundPaymentNotice(waiting, now, "America/Toronto")).toEqual({
    tier: "warning",
    text: "Round 1 isn't paid yet. The guest pays on their phone (their table page has a pay button); unpaid at 08:30, it is cancelled and nobody is charged.",
  });
  expect(
    guestRoundPaymentNotice(waiting, Date.parse(payBy) - 4 * 60_000 - 1, "America/Toronto"),
  ).toEqual({
    tier: "urgent",
    text: "5 min left: Round 1 isn't paid. Ask the guest to finish paying on their phone by 08:30, or it is cancelled.",
  });
  const ended = guestRoundPaymentNotice(waiting, Date.parse(payBy), "America/Toronto");
  expect(ended?.text).toContain("wasn't paid by 08:30 and is being cancelled");
  expect(ended?.text).not.toMatch(/[0-9a-f]{8}-/u);
  // Still listed 5 minutes after the deadline: the card provider couldn't confirm the payment, so
  // staff decide with the guest (before that it is still "being cancelled").
  expect(
    guestRoundPaymentNotice(waiting, Date.parse(payBy) + 5 * 60_000 - 1, "America/Toronto")?.text,
  ).toContain("is being cancelled");
  expect(
    guestRoundPaymentNotice(waiting, Date.parse(payBy) + 5 * 60_000, "America/Toronto"),
  ).toEqual({
    tier: "urgent",
    text: "Round 1: the card provider couldn't confirm the guest's payment (due by 08:30), so it wasn't cancelled automatically. Ask the guest whether their card was charged. If it wasn't, cancel the round; a charge that still comes through is refunded automatically.",
  });
});

it("WP-2423: warns on the table while a paid round waits for staff to accept it", () => {
  expect(paidRoundAcceptanceNotice(table, now)).toBeNull();
  const waiting = {
    ...table,
    currentDiningSessionReference: "01909988-0000-7000-8000-000000000009",
    elapsedMinutes: 30,
    roundsAwaitingAcceptance: [
      { roundNumber: 3, paidAt: "2027-03-01T12:58:00.000Z" },
      { roundNumber: 2, paidAt: "2027-03-01T12:47:00.000Z" },
    ],
  };
  expect(paidRoundAcceptanceNotice(waiting, now)).toEqual({
    tier: "urgent",
    text: "Round 2 paid 13 min ago and still not accepted · accept it on the Orders page now (and 1 more paid round)",
  });
  expect(
    paidRoundAcceptanceNotice(
      { ...waiting, roundsAwaitingAcceptance: waiting.roundsAwaitingAcceptance.slice(0, 1) },
      now,
    ),
  ).toEqual({
    tier: "ok",
    text: "Round 3 paid 2 min ago · accept it on the Orders page to send it to the kitchen",
  });
});

it("WP-2423 abandoned payment: says how to cancel an unpaid round only where the notice doesn't already", () => {
  const payBy = "2027-03-01T13:30:00.000Z";
  const round = (n: number, due: string) => ({
    orderReference: "01909988-0000-7000-8000-00000000001" + String(n),
    orderBatchReference: "01909988-0000-7000-8000-00000000002" + String(n),
    roundNumber: n,
    payBy: due,
  });
  const waiting: StaffDiningTable = {
    ...table,
    currentDiningSessionReference: "01909988-0000-7000-8000-000000000002",
    elapsedMinutes: 20,
    guestRoundsAwaitingPayment: [round(1, payBy)],
  };
  const at = (offsetMs: number) => Date.parse(payBy) + offsetMs;
  expect(guestRoundCancelHint(table, now, true)).toBeNull();
  // Still within the payment window: the notice says how to pay; the hint how to cancel.
  expect(guestRoundCancelHint(waiting, at(-60_000), true)).toBe(
    "If the guest won't pay for it, cancel it now.",
  );
  expect(guestRoundCancelHint(waiting, at(-60_000), false)).toBe(
    "If the guest won't pay for it, a manager can cancel it here or on the Orders page.",
  );
  // Being cancelled automatically: nothing to add.
  expect(guestRoundCancelHint(waiting, at(0), true)).toBeNull();
  // Unconfirmed: the notice already says "ask the guest, then cancel the round" — no repeat for a
  // manager; staff who can't cancel are told who can.
  const unconfirmed = guestRoundPaymentNotice(waiting, at(5 * 60_000), "America/Toronto");
  expect(unconfirmed?.text).toContain("If it wasn't, cancel the round");
  expect(guestRoundCancelHint(waiting, at(5 * 60_000), true)).toBeNull();
  expect(guestRoundCancelHint(waiting, at(5 * 60_000), false)).toBe(
    "Only a manager can cancel it, here or on the Orders page.",
  );
  // One unconfirmed round among later ones still being paid: the unconfirmed instruction leads.
  const mixed = {
    ...waiting,
    guestRoundsAwaitingPayment: [round(1, payBy), round(2, "2027-03-01T14:30:00.000Z")],
  };
  expect(guestRoundCancelHint(mixed, at(5 * 60_000), true)).toBeNull();
});
