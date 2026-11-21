import { describe, expect, it } from "vitest";
import { evaluateStoreOperatingStatus } from "../domain/evaluate-store-operating-status.js";

const interval = {
  startLocalTime: "11:00:00",
  endLocalTime: "22:00:00",
  endsNextDay: false,
  serviceModes: ["DineIn", "Pickup"] as const,
};
const week = Array.from({ length: 7 }, (_, index) => ({
  isoWeekday: index + 1,
  intervals: [interval],
}));
const at = "2026-11-06T23:30:00.000Z"; // 18:30 in Toronto, Friday
const evaluate = (
  temporaryClosures: {
    effectiveFrom: string;
    effectiveUntil: string;
    serviceModes: readonly ("DineIn" | "Pickup" | "Delivery")[] | null;
  }[],
) =>
  evaluateStoreOperatingStatus({
    evaluatedAt: at,
    localDate: "2026-11-06",
    localTime: "18:30:00",
    isoWeekday: 5,
    weeklySchedule: week,
    exceptions: [],
    temporaryClosures,
  });

describe("WP-2423 store-service-controls (v15 M30) paused services", () => {
  it("names a pickup-only pause and its end, while dine-in stays open", () => {
    const result = evaluate([
      {
        effectiveFrom: "2026-11-06T23:00:00.000Z",
        effectiveUntil: "2026-11-07T00:45:00.000Z",
        serviceModes: ["Pickup"],
      },
    ]);
    expect(result.state).toBe("Open");
    expect(result.availableServiceModes).toEqual(["DineIn"]);
    expect(result.pausedModes).toEqual([{ mode: "Pickup", until: "2026-11-07T00:45:00.000Z" }]);
  });
  it("follows a pause that runs straight into another, and ignores one that ended", () => {
    const result = evaluate([
      {
        effectiveFrom: "2026-11-06T22:00:00.000Z",
        effectiveUntil: "2026-11-06T23:00:00.000Z",
        serviceModes: null,
      },
      {
        effectiveFrom: "2026-11-06T23:15:00.000Z",
        effectiveUntil: "2026-11-06T23:45:00.000Z",
        serviceModes: null,
      },
      {
        effectiveFrom: "2026-11-06T23:40:00.000Z",
        effectiveUntil: "2026-11-07T00:00:00.000Z",
        serviceModes: ["Pickup"],
      },
    ]);
    expect(result.state).toBe("TemporarilyClosed");
    expect(result.pausedModes).toEqual([
      { mode: "DineIn", until: "2026-11-06T23:45:00.000Z" },
      { mode: "Pickup", until: "2026-11-07T00:00:00.000Z" },
    ]);
  });
  it("says nothing is paused when no pause holds now", () => {
    expect(evaluate([]).pausedModes).toEqual([]);
  });
});
