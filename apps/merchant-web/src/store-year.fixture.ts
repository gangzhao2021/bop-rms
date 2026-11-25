import { vi } from "vitest";

/**
 * Batch 64: staff screens write a date of this year without its year ("Thu, Oct 15 04:30"). Tests
 * whose fixtures are dated in 2026 pin the clock's "now" to that year (only Date; it keeps running),
 * so they read the same in 2027. Call in beforeEach, or at the start of one test; undo with
 * vi.useRealTimers().
 */
export function pinFixtureYear(now = "2026-11-25T17:00:00.000Z"): void {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(now), shouldAdvanceTime: true });
}
