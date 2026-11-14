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

it("WP-2423 store-service-controls (v15 M30 live check): a Pickup-only pause names Pickup and says table ordering is still open", async () => {
  const { pausedServices, pauseLineText } = await import("./PauseOrderingControl.js");
  const { setLanguageForTest } = await import("./i18n/i18n.js");
  const enabled = ["DineIn", "Pickup"];
  const until = "2026-11-06T13:23:00.000Z";
  const now = Date.parse("2026-11-06T13:00:00.000Z");
  const pickup = pausedServices(["Pickup"], enabled);
  expect(pickup).toEqual({ paused: "Pickup ordering", open: "Table ordering" });
  expect(pauseLineText(until, pickup, "America/Toronto", now, false)).toBe(
    "Pickup ordering paused until 08:23 · Table ordering still open",
  );
  expect(
    pauseLineText(until, pickup, "America/Toronto", Date.parse("2026-11-06T13:19:00.000Z"), true),
  ).toBe("Pickup ordering starts again at 08:23 (in 4 min). Table ordering is still open.");
  // Every service the Store offers (or all of them) is "Ordering", as before.
  expect(pausedServices(null, enabled)).toBeNull();
  expect(pausedServices(["DineIn", "Pickup"], enabled)).toBeNull();
  expect(pausedServices(["Pickup"], ["Pickup"])).toBeNull();
  expect(pauseLineText(until, null, "America/Toronto", now, false)).toBe(
    "Ordering paused until 08:23",
  );
  expect(pausedServices(["Delivery", "DineIn"], ["DineIn", "Pickup", "Delivery"])).toEqual({
    paused: "Table and delivery ordering",
    open: "Pickup ordering",
  });
  setLanguageForTest("zh-Hans");
  try {
    expect(
      pauseLineText(until, pausedServices(["Pickup"], enabled), "America/Toronto", now, false),
    ).toBe("自取点单已暂停，到 08:23 · 堂食点单照常");
  } finally {
    setLanguageForTest("en");
  }
});
