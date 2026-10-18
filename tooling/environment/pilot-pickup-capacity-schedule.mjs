import console from "node:console";
import {
  createPostgresPublishedStoreServiceCalendarReader,
  expandStoreServiceCalendar,
} from "../../packages/rms/store/src/index.ts";
import { createPostgresPickupCapacityScheduleStore } from "../../packages/rms/fulfillment/src/index.ts";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

/**
 * WP-2423 DEC-PICKUP-CAPACITY-SCHEDULE: the pilot's rolling pickup capacity schedule. The
 * coordinator reads the Store's current published hours through the Store's own proof
 * (publication, live gate, digest), lays them out ahead with the Store's calendar expansion, and
 * hands the result to Fulfillment, which owns the slots. Nothing reads another domain's tables.
 *
 * - Horizon: 14 days ahead (never beyond the published configuration's end).
 * - Every 5 minutes, and at once after a start, so a restart or an outage catches up from "now";
 *   an hours change reaches unreserved future slots within 5 minutes.
 * - Idempotent: a run over a complete schedule writes nothing.
 */
export const pickupCapacityHorizonMs = 14 * 24 * 60 * 60 * 1000;
export const pickupCapacityIntervalMs = 5 * 60 * 1000;

/**
 * Pilot decision (DEC-PICKUP-CAPACITY-SCHEDULE): the Store's published configuration names no
 * capacity configuration and the platform has no capacity configuration source yet, so this
 * labelled default applies. 20 pickup orders an hour while pickup is open is the limit the
 * internal test has used since 2026-09-20; outside pickup hours online ordering is closed and the
 * only orders are paper orders entered after an outage, which must never be refused for capacity
 * (100 an hour). A Store that names a capacity configuration is refused, never given this default.
 */
export const pilotDefaultPickupCapacityPolicy = Object.freeze({
  policyCode: "PILOT_DEFAULT_PICKUP_CAPACITY_V1",
  servicePerHour: 20,
  outsideServicePerHour: 100,
});

export function resolvePickupCapacityPolicy(calendar) {
  if (calendar.capacityConfigurationReference !== null)
    throw Error("PICKUP_CAPACITY_POLICY_UNAVAILABLE");
  return pilotDefaultPickupCapacityPolicy;
}

/** The Store's pickup hours from now to the horizon, as Fulfillment schedule input. */
export function pickupScheduleInput(calendar, now, horizonMs = pickupCapacityHorizonMs) {
  const end = Math.min(
    Date.parse(now) + horizonMs,
    calendar.effectiveUntil === null ? Infinity : Date.parse(calendar.effectiveUntil),
  );
  if (!(end > Date.parse(now))) throw Error("PICKUP_CAPACITY_CONFIGURATION_ENDED");
  const until = new Date(end).toISOString();
  const expanded = expandStoreServiceCalendar({
    timeZone: calendar.timeZone,
    businessDayStartLocalTime: calendar.businessDayStartLocalTime,
    weeklySchedule: calendar.weeklySchedule,
    exceptions: calendar.exceptions,
    serviceMode: "Pickup",
    from: now,
    until,
  });
  const policy = resolvePickupCapacityPolicy(calendar);
  return {
    observedAt: now,
    horizonUntil: until,
    timeZone: calendar.timeZone,
    // A Store that does not offer pickup still records paper orders after an outage.
    serviceWindows: calendar.enabledServiceModes.includes("Pickup") ? expanded.windows : [],
    businessDays: expanded.businessDays,
    policy: {
      servicePerHour: policy.servicePerHour,
      outsideServicePerHour: policy.outsideServicePerHour,
    },
  };
}

export function createPickupCapacityScheduleDispatcher({
  resources,
  intervalMs = pickupCapacityIntervalMs,
  horizonMs = pickupCapacityHorizonMs,
  readCalendar = (tx, now) =>
    createPostgresPublishedStoreServiceCalendarReader(resources.operating)(tx, now),
  schedule = createPostgresPickupCapacityScheduleStore(resources.transactions, resources.scope),
  allowed = () => isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil,
  log = (entry) => console.log(JSON.stringify(entry)),
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || !Number.isSafeInteger(horizonMs))
    throw Error("PICKUP_CAPACITY_SCHEDULE_CONFIG_INVALID");
  let nextDueAt = 0;
  return Object.freeze({
    async runOnce() {
      const now = resources.now();
      if (Date.parse(now) < nextDueAt) return 0;
      if (!allowed()) throw Error("INTERNAL_PICKUP_CAPACITY_SCHEDULE_UNAVAILABLE");
      const calendar = await resources.transactions.run((tx) => readCalendar(tx, now));
      const result = await schedule.apply({
        ...pickupScheduleInput(calendar, now, horizonMs),
        generateReference: resources.credentials.reference,
      });
      nextDueAt = Date.parse(now) + intervalMs;
      if (result.created + result.republished + result.keptReserved > 0)
        log({
          event: "pickup_capacity_schedule_applied",
          created: result.created,
          republished: result.republished,
          keptReserved: result.keptReserved,
          coveredUntil: result.coveredUntil,
          configurationVersion: calendar.configurationVersion,
        });
      return result.created + result.republished;
    },
    stop: async () => "drained",
  });
}

export function createInternalPickupCapacityScheduleWorkload(resources, onSnapshot) {
  return createOutboxWorkload({
    dispatcher: createPickupCapacityScheduleDispatcher({ resources }),
    pollIntervalMs: 60_000,
    drainDeadlineMs: 25_000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}

/** For the operations monitor: how far ahead pickup capacity is set up without a gap. */
export async function readInternalPickupCapacityHorizon(
  resources,
  store = createPostgresPickupCapacityScheduleStore(resources.transactions, resources.scope),
) {
  const now = new Date(resources.now()).toISOString();
  const coverage = await store.coverage(now);
  return { observedAt: now, coveredMs: Date.parse(coverage.coveredUntil) - Date.parse(now) };
}
