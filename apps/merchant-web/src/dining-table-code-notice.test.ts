import { expect, it } from "vitest";
import { tableCodeNotice } from "./DiningSessionWorkspace.js";
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
