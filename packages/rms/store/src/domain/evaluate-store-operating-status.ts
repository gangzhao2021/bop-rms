const storeServiceModes = ["DineIn", "Pickup", "Delivery"] as const;
type StoreServiceModeValue = (typeof storeServiceModes)[number];
type StoreOperatingStateValue = "Open" | "Closed" | "TemporarilyClosed";

interface StoreOperatingIntervalValue {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
  readonly serviceModes: readonly StoreServiceModeValue[];
}

interface StoreWeeklyOperatingDayValue {
  readonly isoWeekday: number;
  readonly intervals: readonly StoreOperatingIntervalValue[];
}

interface StoreOperatingExceptionValue {
  readonly localDate: string;
  readonly intervals: readonly StoreOperatingIntervalValue[];
}

interface StoreTemporaryClosureValue {
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly serviceModes: readonly StoreServiceModeValue[] | null;
}

export interface StoreOperatingEvaluation {
  readonly state: StoreOperatingStateValue;
  readonly availableServiceModes: readonly StoreServiceModeValue[];
}

function timeSeconds(value: string): number {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

function previousLocalDate(localDate: string): string {
  const [year = 0, month = 0, day = 0] = localDate.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day - 1));
  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function activeModes(
  intervals: readonly StoreOperatingIntervalValue[],
  localTime: string,
  part: "CurrentDay" | "PreviousDayTail",
): Set<StoreServiceModeValue> {
  const current = timeSeconds(localTime);
  const modes = new Set<StoreServiceModeValue>();
  for (const interval of intervals) {
    const start = timeSeconds(interval.startLocalTime);
    const end = timeSeconds(interval.endLocalTime);
    const active =
      part === "CurrentDay"
        ? interval.endsNextDay
          ? current >= start
          : current >= start && current < end
        : interval.endsNextDay && current < end;
    if (active) interval.serviceModes.forEach((mode) => modes.add(mode));
  }
  return modes;
}

function exceptionForDate(
  exceptions: readonly StoreOperatingExceptionValue[],
  localDate: string,
): StoreOperatingExceptionValue | undefined {
  return exceptions.find((exception) => exception.localDate === localDate);
}

function weeklyDay(
  weeklySchedule: readonly StoreWeeklyOperatingDayValue[],
  isoWeekday: number,
): StoreWeeklyOperatingDayValue {
  const day = weeklySchedule[isoWeekday - 1];
  if (day === undefined) throw new Error("validated weekly schedule is incomplete");
  return day;
}

function scheduledModes(input: {
  readonly localDate: string;
  readonly localTime: string;
  readonly isoWeekday: number;
  readonly weeklySchedule: readonly StoreWeeklyOperatingDayValue[];
  readonly exceptions: readonly StoreOperatingExceptionValue[];
}): Set<StoreServiceModeValue> {
  const currentException = exceptionForDate(input.exceptions, input.localDate);
  if (currentException !== undefined) {
    return activeModes(currentException.intervals, input.localTime, "CurrentDay");
  }

  const modes = activeModes(
    weeklyDay(input.weeklySchedule, input.isoWeekday).intervals,
    input.localTime,
    "CurrentDay",
  );
  const previousDate = previousLocalDate(input.localDate);
  const previousException = exceptionForDate(input.exceptions, previousDate);
  const previousIntervals =
    previousException?.intervals ??
    weeklyDay(input.weeklySchedule, input.isoWeekday === 1 ? 7 : input.isoWeekday - 1).intervals;
  for (const mode of activeModes(previousIntervals, input.localTime, "PreviousDayTail")) {
    modes.add(mode);
  }
  return modes;
}

function suppressedModes(
  closures: readonly StoreTemporaryClosureValue[],
  evaluatedAt: string,
): Set<StoreServiceModeValue> {
  const suppressed = new Set<StoreServiceModeValue>();
  const instant = Date.parse(evaluatedAt);
  for (const closure of closures) {
    if (
      instant >= Date.parse(closure.effectiveFrom) &&
      instant < Date.parse(closure.effectiveUntil)
    ) {
      (closure.serviceModes ?? storeServiceModes).forEach((mode) => suppressed.add(mode));
    }
  }
  return suppressed;
}

export function evaluateStoreOperatingStatus(input: {
  readonly evaluatedAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly isoWeekday: number;
  readonly weeklySchedule: readonly StoreWeeklyOperatingDayValue[];
  readonly exceptions: readonly StoreOperatingExceptionValue[];
  readonly temporaryClosures: readonly StoreTemporaryClosureValue[];
}): StoreOperatingEvaluation {
  const scheduled = scheduledModes(input);
  const suppressed = suppressedModes(input.temporaryClosures, input.evaluatedAt);
  const available = Object.freeze(
    storeServiceModes.filter((mode) => scheduled.has(mode) && !suppressed.has(mode)),
  );
  const state: StoreOperatingStateValue =
    available.length > 0
      ? "Open"
      : scheduled.size > 0 && [...scheduled].every((mode) => suppressed.has(mode))
        ? "TemporarilyClosed"
        : "Closed";
  return Object.freeze({ state, availableServiceModes: available });
}
