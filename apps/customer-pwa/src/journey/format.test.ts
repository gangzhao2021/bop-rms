import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatDateTime,
  formatMinutesUntil,
  formatMoney,
  percentOfMinor,
} from "./format.js";

describe("customer money presentation", () => {
  it.each([
    ["0", "$0.00"],
    ["1", "$0.01"],
    ["-1", "-$0.01"],
    ["1130", "$11.30"],
    [1130n, "$11.30"],
    ["-1130", "-$11.30"],
    ["9223372036854775807", "$92,233,720,368,547,758.07"],
  ])("shows CAD %s as %s without floating point", (minor, expected) => {
    expect(formatMoney(minor, "CAD")).toBe(expected);
  });
  it("keeps the ISO code for other currencies and never guesses malformed amounts", () => {
    expect(formatMoney("100", "USD")).toBe("USD 1.00");
    for (const bad of ["", "1.20", "NaN", "1e3", " 100", "001"])
      expect(formatMoney(bad, "CAD")).toBe("Amount unavailable");
    expect(formatMoney("100", "cad")).toBe("Amount unavailable");
  });
});

describe("customer time presentation", () => {
  it("formats a clock time and a date-time in the given locale", () => {
    const clock = formatClockTime("2026-09-02T17:10:00.000Z");
    expect(clock).toMatch(/\d{1,2}:\d{2}/u);
    expect(formatDateTime("2026-09-02T17:10:00.000Z")).toMatch(/2026/u);
    expect(formatClockTime("not-a-time")).toBe("");
  });
  it("describes remaining validity in whole minutes and hides it once passed", () => {
    const now = Date.parse("2026-09-02T17:00:00.000Z");
    expect(formatMinutesUntil("2026-09-02T17:04:30.000Z", now)).toBe("about 5 minutes");
    expect(formatMinutesUntil("2026-09-02T17:00:30.000Z", now)).toBe("less than a minute");
    expect(formatMinutesUntil("2026-09-02T18:30:00.000Z", now)).toBe("about 1 hour");
    expect(formatMinutesUntil("2026-09-02T16:59:00.000Z", now)).toBeNull();
  });
});

describe("tip percentages", () => {
  it("rounds half up in minor units", () => {
    expect(percentOfMinor("1299", 15)).toBe("195");
    expect(percentOfMinor("1299", 18)).toBe("234");
    expect(percentOfMinor("1299", 0)).toBe("0");
    expect(percentOfMinor("1", 15)).toBe("0");
    expect(percentOfMinor("3", 15)).toBe("0");
    expect(percentOfMinor("10", 15)).toBe("2");
    expect(percentOfMinor("-100", 15)).toBeNull();
    expect(percentOfMinor("1.5", 15)).toBeNull();
  });
});
