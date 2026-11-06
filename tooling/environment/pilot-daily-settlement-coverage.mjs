import { isPilotStore } from "./pilot-environment.mjs";

/**
 * WP-2423 (settlement-coverage): where a Store's day-end settlement starts, the one rule the
 * settlement worker, the operations monitor and the status command share.
 *
 * - An InternalTest or hosted Store starts on its own first business day (the day its first
 *   published configuration began to govern in, `days.first()`). Nobody has to record anything.
 *   A recorded `daily-settlement-coverage.json` is an explicit record of a start: it must be valid
 *   and may never start before the Store's records. A record that starts later than the first day
 *   does not shorten coverage, so a day with online payments is never left uncompared.
 * - A real Pilot Store keeps its issued record: the file is written at issue, and coverage starts
 *   there (TEST captures before the issue are never settled). Without it the read stays unavailable
 *   (fail closed), never derived.
 *
 * Returns `{ kind: "Covered", source, scope, firstWindow, recordedBusinessDate }` with
 * `source` "Recorded" (the Pilot Store's issued record) or "StoreRecords" (the Store's first day),
 * or `{ kind: "NotYet" }` while no published configuration governs or the first day is still open.
 * Any other failure (a refused grant, the database, an unreadable record) throws: it is never
 * "not yet".
 */
export const DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS =
  "DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS";
const FIELDS = Object.freeze([
  "businessDate",
  "startsAt",
  "endsAt",
  "configurationReference",
  "configurationVersion",
  "contentDigest",
]);
export const NOT_YET = Object.freeze({ kind: "NotYet" });

/** The six recorded fields of a verified closed window, as the coverage file holds them. */
export function coverageWindowOf(window) {
  return Object.freeze({
    businessDate: window.businessDate,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    configurationReference: String(window.configurationReference),
    configurationVersion: window.configurationVersion,
    contentDigest: window.contentDigest,
  });
}

export async function resolveDailySettlementCoverage({
  installation,
  days,
  pilotStore = isPilotStore(),
}) {
  const recorded = await installation.loadRecordedDailySettlementCoverage();
  if (pilotStore) {
    if (recorded === null) throw Error("PILOT_INSTALLATION_UNAVAILABLE");
    return Object.freeze({
      kind: "Covered",
      source: "Recorded",
      scope: recorded.scope,
      firstWindow: recorded.firstWindow,
      recordedBusinessDate: recorded.firstWindow.businessDate,
    });
  }
  const window = await days.first();
  if (window === null) {
    // A recorded closed day while the Store's own first day has not closed is a start before
    // its records.
    if (recorded !== null) throw Error(DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS);
    return NOT_YET;
  }
  const firstWindow = coverageWindowOf(window);
  if (recorded !== null && recorded.firstWindow.startsAt < firstWindow.startsAt)
    throw Error(DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS);
  const binding = (await installation.loadProfile()).binding;
  return Object.freeze({
    kind: "Covered",
    source: "StoreRecords",
    scope: Object.freeze({
      tenantReference: binding.tenantReference,
      brandReference: binding.brandReference,
      storeReference: binding.storeReference,
    }),
    firstWindow,
    recordedBusinessDate: recorded?.firstWindow.businessDate ?? null,
  });
}

export const sameCoverageWindow = (a, b) => FIELDS.every((key) => a[key] === b[key]);

/**
 * WP-2423 (settlement-coverage): for the Settlement page, the instant this Store's day-end checks
 * start from. A real Pilot Store's issued record (an earlier closed day is never compared, so the
 * page never promises it will be); null for any other Store, which is covered from its own first
 * business day. A read for another Store, or a Pilot Store without its record, throws: the page
 * then claims nothing about the check.
 */
export function createDayEndCheckCoveredFrom({ installation, pilotStore = isPilotStore() }) {
  return async (scope) => {
    if (!pilotStore) return null;
    const recorded = await installation.loadRecordedDailySettlementCoverage();
    if (
      recorded === null ||
      ["tenantReference", "brandReference", "storeReference"].some(
        (key) => recorded.scope?.[key] !== scope?.[key],
      )
    )
      throw Error("PILOT_INSTALLATION_UNAVAILABLE");
    return recorded.firstWindow.startsAt;
  };
}
