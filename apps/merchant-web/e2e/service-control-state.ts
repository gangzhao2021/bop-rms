/**
 * WP-2423 store-service-controls (v15 M30, batch 5): Home, Orders, Pickup and the kitchen board
 * read the Store's pause state (`GET /merchant/service-control`) for whoever may pause ordering.
 * A Store with nothing paused, as the BFF answers it.
 */
export function notPausedServiceControl(storeReference: string, timeZone = "America/Toronto") {
  return {
    hours: {
      configurationSource: "StoreOverride",
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveUntil: null,
      businessDayStartLocalTime: "04:00:00",
      weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
        isoWeekday: index + 1,
        intervals: [],
      })),
      exceptions: [],
    },
    screenId: "STORE-HOURS-SERVICE",
    storeReference,
    configurationReference: storeReference,
    timeZone,
    enabledServiceModes: ["DineIn"],
    observedAt: new Date().toISOString(),
    expectedVersion: 0,
    activePauses: [],
  };
}
