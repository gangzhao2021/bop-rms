import { expect, it } from "vitest";
import {
  elapsedText,
  longOpenSessionMinutes,
  staffRoundPaymentNotice,
  tableCodeNotice,
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
