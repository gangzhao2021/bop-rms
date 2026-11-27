import { describe, expect, it } from "vitest";
import { nextStoreBoundaryMs, storeServicePhase, takesNewOrders } from "./store-service.js";
import type { StoreProfile } from "./store-profile-client.js";

// 18:00:00 in Toronto (EST) on 2026-11-06.
const at = Date.parse("2026-11-06T23:00:00.000Z");
const profile = (hours: Partial<NonNullable<StoreProfile["hours"]>>): StoreProfile => ({
  storeDisplayName: "Synthetic Store",
  timeZone: "America/Toronto",
  address: {
    addressLines: ["1 Synthetic Street"],
    locality: "Toronto",
    regionCode: "ON",
    postalCode: "M5V 0A1",
    countryCode: "CA",
  },
  phone: null,
  hours: {
    status: "Open",
    todayHours: [],
    closesAt: "22:00:00",
    opensAt: null,
    localDate: "2026-11-06",
    todayKind: null,
    lastOrdersAt: "21:30:00",
    pausedUntil: null,
    ordersStopped: false,
    nextOpening: null,
    upcoming: [],
    ...hours,
  },
});

describe("WP-2423 store-service-controls (v15 M30/M34) guest service phase", () => {
  it("is open, then counts down the last 30 minutes, then follows the Store's stopped answer", () => {
    expect(storeServicePhase(profile({}), at)).toEqual({ phase: "Open", minutesLeft: null });
    expect(storeServicePhase(profile({ lastOrdersAt: "18:25:00" }), at)).toEqual({
      phase: "Soon",
      minutesLeft: 25,
    });
    expect(storeServicePhase(profile({ ordersStopped: true }), at).phase).toBe("Stopped");
    expect(
      storeServicePhase(profile({ status: "Paused", pausedUntil: "18:45:00" }), at).phase,
    ).toBe("Paused");
    expect(storeServicePhase(profile({ status: "Closed" }), at).phase).toBe("Closed");
    expect(storeServicePhase(null, at).phase).toBe("Unknown");
  });
  it("blocks new orders only when the Store said so", () => {
    expect(["Unknown", "Open", "Soon"].every((p) => takesNewOrders(p as never))).toBe(true);
    expect(["Stopped", "Paused", "Closed"].some((p) => takesNewOrders(p as never))).toBe(false);
  });
  it("reads again one second after the next boundary within a minute, else on the minute", () => {
    expect(nextStoreBoundaryMs(profile({}), at)).toBeNull();
    expect(nextStoreBoundaryMs(profile({ status: "Paused", pausedUntil: "18:00:20" }), at)).toBe(
      21_000,
    );
    // The countdown starts 30 minutes before last orders.
    expect(nextStoreBoundaryMs(profile({ lastOrdersAt: "18:30:40" }), at)).toBe(41_000);
  });
});
