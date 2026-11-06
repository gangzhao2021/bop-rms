import { expect, it } from "vitest";
import { pauseEndingWarningMs, pauseExtendedUntil, pauseLimitMs } from "./PauseOrderingControl.js";

it("WP-2423 store-service-controls (v15 M30): 15 more minutes, never past 4 hours from now", () => {
  const now = Date.parse("2026-11-06T23:00:00.000Z");
  expect(pauseEndingWarningMs).toBe(5 * 60_000);
  expect(pauseLimitMs).toBe(4 * 60 * 60_000);
  expect(pauseExtendedUntil("2026-11-06T23:04:00.000Z", now)).toBe("2026-11-06T23:19:00.000Z");
  expect(pauseExtendedUntil("2026-11-07T02:45:00.000Z", now)).toBe("2026-11-07T03:00:00.000Z");
  expect(pauseExtendedUntil("2026-11-07T02:46:00.000Z", now)).toBeNull();
});
