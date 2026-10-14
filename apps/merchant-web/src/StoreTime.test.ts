import { expect, it } from "vitest";
import { friendlyStoreTime } from "./StoreTime.js";

it("writes staff-facing instants in Store-local time without raw ISO text", () => {
  const now = new Date("2026-10-14T20:00:00.000Z");
  expect(friendlyStoreTime("2026-10-14T19:00:27.165Z", "America/Toronto", now)).toBe(
    "Oct 14, 3:00 PM",
  );
  expect(friendlyStoreTime("2025-12-31T23:30:00.000Z", "America/Toronto", now)).toBe(
    "Dec 31, 2025, 6:30 PM",
  );
  expect(friendlyStoreTime("2026-10-14T19:00:27.165Z", undefined, now)).toBe("Oct 14, 7:00 PM UTC");
});
