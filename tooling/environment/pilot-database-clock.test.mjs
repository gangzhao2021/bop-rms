import { afterEach, expect, it, vi } from "vitest";
import {
  alignProcessClockToDatabase,
  measureDatabaseClockOffset,
  resetProcessClockForTest,
  synchronizeProcessClock,
} from "./pilot-database-clock.mjs";

const SystemDate = globalThis.Date;
const databaseAt = (differenceMs) => async () => ({
  rows: [{ now: String(SystemDate.now() + differenceMs) }],
});
afterEach(() => resetProcessClockForTest());

it("measures the difference from the quickest read, never ahead of the database", async () => {
  const offset = await measureDatabaseClockOffset(databaseAt(-500));
  expect(offset).toBeLessThanOrEqual(-500);
  expect(offset).toBeGreaterThan(-600);
});

it("moves every way of reading the time to the database's clock", async () => {
  const report = vi.fn();
  await alignProcessClockToDatabase(databaseAt(-500), { report });
  expect(report.mock.calls[0][0].event).toBe("pilot_clock_aligned");
  const system = SystemDate.now();
  expect(Date.now() - system).toBeLessThanOrEqual(-400);
  expect(new Date().getTime() - SystemDate.now()).toBeLessThanOrEqual(-400);
  expect(new Date("2026-11-03T00:00:00.000Z").toISOString()).toBe("2026-11-03T00:00:00.000Z");
  expect(new Date()).toBeInstanceOf(SystemDate);
  expect(Date.parse("2026-11-03T00:00:00.000Z")).toBe(1793664000000);
  expect(Date.UTC(2026, 10, 3)).toBe(1793664000000);
  expect(typeof Date()).toBe("string");
});

it("never goes back when the difference shrinks", async () => {
  await alignProcessClockToDatabase(databaseAt(0));
  const before = Date.now();
  await synchronizeProcessClock(databaseAt(-500), () => undefined);
  expect(Date.now()).toBeGreaterThanOrEqual(before);
  expect(Date.now()).toBeLessThan(before + 100);
});

it("reports a wrong clock once and does not follow it", async () => {
  const report = vi.fn();
  await alignProcessClockToDatabase(databaseAt(60_000), { report });
  expect(Math.abs(Date.now() - SystemDate.now())).toBeLessThan(100);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0][0].event).toBe("INTERNAL_CLOCK_SKEW_TOO_LARGE");
});

it("keeps working when the database can't be read", async () => {
  await alignProcessClockToDatabase(async () => {
    throw new Error("down");
  });
  expect(Math.abs(Date.now() - SystemDate.now())).toBeLessThan(100);
});
