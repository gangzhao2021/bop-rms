import { describe, expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";
import {
  refundAlertsDue,
  refundClockMs,
  refundWarningText,
  refundWarnings,
  refundWarningTier,
} from "./refund-deadline-warning.js";

const now = Date.parse("2026-10-17T13:50:00.000Z");
const at = (secondsFromNow: number) => new Date(now + secondsFromNow * 1000).toISOString();

describe("WP-2423 warn before an unaccepted paid order is refunded", () => {
  it("warns from 5 minutes, escalates at 2 minutes and 30 seconds, and stops at the refund", () => {
    expect(refundWarningTier(5 * 60_000 + 1)).toBeNull();
    expect(refundWarningTier(5 * 60_000)).toBe("warning");
    expect(refundWarningTier(2 * 60_000 + 1)).toBe("warning");
    expect(refundWarningTier(2 * 60_000)).toBe("urgent");
    expect(refundWarningTier(30_001)).toBe("urgent");
    expect(refundWarningTier(30_000)).toBe("final");
    expect(refundWarningTier(0)).toBeNull();
  });

  it("says it in plain words with the order number staff know", () => {
    expect(refundWarningText("9", 2 * 60_000)).toBe(
      "Order 9 will be refunded automatically in 2 min unless someone accepts it.",
    );
    expect(refundWarningText("9", 90_000)).toBe(
      "Order 9 will be refunded automatically in 2 min unless someone accepts it.",
    );
    expect(refundWarningText("9", 30_000)).toBe(
      "Order 9 will be refunded automatically in less than a minute unless someone accepts it.",
    );
    expect(
      findInternalText([refundWarningText("9", 240_000), refundWarningText("A-12", 20_000)]),
    ).toEqual([]);
  });

  it("lists only orders in their last five minutes, soonest first", () => {
    const warnings = refundWarnings(
      [
        { orderNumber: "12", acceptBy: at(600) },
        { orderNumber: "9", acceptBy: at(100) },
        { orderNumber: "10", acceptBy: at(25) },
        { orderNumber: "11", acceptBy: at(-5) },
      ],
      now,
    );
    expect(warnings.map((warning) => [warning.orderNumber, warning.tier])).toEqual([
      ["10", "final"],
      ["9", "urgent"],
    ]);
  });

  it("chimes once at 2 minutes and once at 30 seconds, and again when a deferral moves the deadline", () => {
    const alerted = new Set<string>();
    const step = (acceptBy: string, at: number) => {
      const due = refundAlertsDue(refundWarnings([{ orderNumber: "9", acceptBy }], at), alerted);
      for (const key of due.keys) alerted.add(key);
      return due;
    };
    const first = at(300);
    expect(step(first, now)).toMatchObject({ chime: false });
    expect(step(first, now).announce).toBeNull();
    expect(step(first, now + 180_000)).toMatchObject({
      chime: true,
      announce: "Order 9 will be refunded automatically in 2 min unless someone accepts it.",
    });
    expect(step(first, now + 181_000).keys).toEqual([]);
    expect(step(first, now + 270_000)).toMatchObject({ chime: true });
    // An outage hold, then the store back online: the deadline moves 15 minutes on.
    const moved = at(300 + 15 * 60);
    expect(step(moved, now + 270_000).keys).toEqual([]);
    expect(step(moved, now + 15 * 60_000 + 180_000)).toMatchObject({ chime: true });
  });

  it("ticks every second only near a refund", () => {
    expect(refundClockMs([{ orderNumber: "9", acceptBy: at(900) }], now)).toBeNull();
    expect(refundClockMs([{ orderNumber: "9", acceptBy: at(310) }], now)).toBe(1_000);
    expect(refundClockMs([{ orderNumber: "9", acceptBy: at(-1) }], now)).toBeNull();
  });
});
