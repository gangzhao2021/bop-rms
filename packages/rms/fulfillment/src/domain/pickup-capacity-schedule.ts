import { parseFulfillmentInstant, type FulfillmentInstant } from "./pickup-fulfillment.js";

/**
 * WP-2423 (DEC-PICKUP-CAPACITY-SCHEDULE): Fulfillment's rolling pickup capacity schedule. Pure.
 *
 * Pickup is ASAP: a checkout takes capacity from the one slot that contains "now", so the Store's
 * slots must cover every instant ahead without gaps or overlaps. Slots follow the Store's local
 * hours (one per local hour, so a daylight-saving day has 23 or 25 of them) and are also cut at
 * every published pickup opening/closing time and business-day start, so each slot lies wholly
 * inside or outside pickup service and inside one business date.
 *
 * Slots exist outside pickup hours too: online ordering is refused there by the Store's open gate,
 * but a paper order taken during an outage is entered when the system returns, even after closing
 * (WP-2423 Q7), and that entry takes pickup capacity like any other order.
 *
 * The schedule reaches the last cut before the horizon, so each run adds whole slots at the far end.
 *
 * Slots and their capacity versions are append-only. Existing slots are never moved; new slots
 * only fill time no slot covers. When hours or the capacity policy change, a future slot nobody
 * has reserved receives a new capacity version; a slot with any reservation keeps its version.
 *
 * Capacity is set per cell (the time between two cuts): a cell's capacity is the policy rate for
 * its service, in proportion to its length. Normally one slot fills a cell and takes all of it.
 * Where earlier runs left several slots in one cell (few-minute "slivers" cut at the horizon
 * before 2026-10-18), the cell's capacity is shared among them so the cell's total stays at the
 * policy instead of rounding up per sliver: shares follow length, counted from the start of the
 * cell so a slot's share depends only on its own bounds and does not change as time passes, and
 * every slot keeps at least 1 (an ASAP checkout during a sliver is never refused while the hour
 * has room; only a cell holding more slots than its capacity exceeds it, by 1 a slot). Reserved
 * slots keep their version; when they hold more than their share, the largest unreserved shares
 * in the cell give it up (down to 1). The current cell and a cell reaching past the horizon are
 * left as they are; a slot crossing a cut keeps the per-slot rule.
 */
export interface PickupCapacityPolicy {
  /** Pickup orders per hour while the Store's published hours offer pickup. */
  readonly servicePerHour: number;
  /** Orders per hour outside those hours (paper orders entered after an outage only). */
  readonly outsideServicePerHour: number;
}

export interface PickupCapacityExistingSlot {
  readonly slotReference: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** Latest capacity version; 0 when the slot has none yet. */
  readonly configVersion: number;
  readonly capacityLimit: number | null;
  /** Any hold, allocation or ASAP commitment ever taken on this slot. */
  readonly reserved: boolean;
}

export interface PickupCapacityScheduleInput {
  readonly observedAt: string;
  readonly horizonUntil: string;
  readonly timeZone: string;
  readonly serviceWindows: readonly Readonly<{ startsAt: string; endsAt: string }>[];
  readonly businessDays: readonly Readonly<{
    businessDate: string;
    startsAt: string;
    endsAt: string;
  }>[];
  readonly existingSlots: readonly PickupCapacityExistingSlot[];
  readonly policy: PickupCapacityPolicy;
}

export interface PickupCapacitySlotPlan {
  readonly startsAt: FulfillmentInstant;
  readonly endsAt: FulfillmentInstant;
  readonly businessDate: string;
  readonly capacityLimit: number;
}

export interface PickupCapacityRepublication {
  readonly slotReference: string;
  readonly configVersion: number;
  readonly previousVersion: number;
  readonly capacityLimit: number;
}

export interface PickupCapacitySchedulePlan {
  readonly create: readonly PickupCapacitySlotPlan[];
  readonly republish: readonly PickupCapacityRepublication[];
  /** End of the gap-free coverage from observedAt once the plan is applied. */
  readonly coveredUntil: FulfillmentInstant;
}

export class PickupCapacityScheduleError extends Error {
  constructor(readonly code: "PICKUP_CAPACITY_SCHEDULE_INPUT_INVALID") {
    super("pickup capacity schedule input is invalid");
    this.name = "PickupCapacityScheduleError";
  }
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
/** At most this far ahead (two months) and this many new slots in one plan. */
const MAXIMUM_HORIZON = 62 * 24 * HOUR;
const MAXIMUM_CREATED = 4_000;

/** A slot's place in its cell; fixedLimit is the capacity a reserved or current slot keeps. */
interface Member {
  readonly start: number;
  readonly end: number;
  readonly fixedLimit: number | null;
  target: number;
}

function fail(): never {
  throw new PickupCapacityScheduleError("PICKUP_CAPACITY_SCHEDULE_INPUT_INVALID");
}

function instant(value: unknown): number {
  try {
    return Date.parse(parseFulfillmentInstant(value));
  } catch {
    return fail();
  }
}

function iso(value: number): FulfillmentInstant {
  return parseFulfillmentInstant(new Date(value).toISOString());
}

function rate(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100_000)
    return fail();
  return value;
}

/** Capacity of a slot: the hourly rate for its service, in proportion to its length, at least 1. */
export function pickupSlotCapacityLimit(
  durationMilliseconds: number,
  inService: boolean,
  policy: PickupCapacityPolicy,
): number {
  const perHour = inService ? rate(policy.servicePerHour) : rate(policy.outsideServicePerHour);
  if (!Number.isSafeInteger(durationMilliseconds) || durationMilliseconds <= 0) return fail();
  return Math.max(1, Math.ceil((perHour * durationMilliseconds) / HOUR));
}

/** Instants in (from, until] where the Store's local clock reads a whole hour. */
function localHourStarts(timeZone: string, from: number, until: number): number[] {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return fail();
  }
  const result: number[] = [];
  // Every IANA offset in use is a multiple of 15 minutes, so local hours start on UTC quarters.
  for (let at = Math.floor(from / QUARTER) * QUARTER + QUARTER; at <= until; at += QUARTER) {
    if (at <= from) continue;
    const parts = Object.fromEntries(
      format
        .formatToParts(new Date(at))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    if (parts.minute === "00" && parts.second === "00") result.push(at);
  }
  return result;
}

/** End of gap-free coverage from `from` by the given slots (`from` itself when uncovered). */
export function pickupCapacityCoverageEnd(
  slots: readonly Readonly<{ startsAt: string; endsAt: string }>[],
  from: string,
): FulfillmentInstant {
  let end = instant(from);
  const ordered = slots
    .map((slot) => [instant(slot.startsAt), instant(slot.endsAt)] as const)
    .sort((left, right) => left[0] - right[0]);
  for (const [start, stop] of ordered) {
    if (start > end) break;
    if (stop > end) end = stop;
  }
  return iso(end);
}

export function planPickupCapacitySchedule(
  input: PickupCapacityScheduleInput,
): PickupCapacitySchedulePlan {
  const observedAt = instant(input.observedAt);
  const horizonUntil = instant(input.horizonUntil);
  if (horizonUntil <= observedAt || horizonUntil - observedAt > MAXIMUM_HORIZON) return fail();
  rate(input.policy?.servicePerHour);
  rate(input.policy?.outsideServicePerHour);

  const windows = input.serviceWindows
    .map((window) => [instant(window.startsAt), instant(window.endsAt)] as const)
    .sort((left, right) => left[0] - right[0]);
  windows.forEach(([start, end], index) => {
    const previous = windows[index - 1];
    if (end <= start || (previous !== undefined && start < previous[1])) fail();
  });
  const days = input.businessDays.map(
    (day) => [day.businessDate, instant(day.startsAt), instant(day.endsAt)] as const,
  );
  days.forEach(([date, start, end], index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || end <= start) fail();
    const previous = days[index - 1];
    if (previous !== undefined && start !== previous[2]) fail();
  });
  const firstDay = days[0],
    lastDay = days[days.length - 1];
  if (
    firstDay === undefined ||
    lastDay === undefined ||
    firstDay[1] > observedAt ||
    lastDay[2] < horizonUntil
  )
    return fail();

  const existing = input.existingSlots.map((slot) => {
    const start = instant(slot.startsAt),
      end = instant(slot.endsAt);
    if (
      end <= start ||
      typeof slot.slotReference !== "string" ||
      !Number.isSafeInteger(slot.configVersion) ||
      slot.configVersion < 0 ||
      typeof slot.reserved !== "boolean" ||
      (slot.configVersion === 0) !== (slot.capacityLimit === null)
    )
      return fail();
    return { ...slot, start, end };
  });
  const overlapsService = (start: number, end: number) =>
    windows.some(([windowStart, windowEnd]) => windowStart < end && start < windowEnd);
  const desiredLimit = (start: number, end: number) =>
    pickupSlotCapacityLimit(end - start, overlapsService(start, end), input.policy);

  // Cut points: local hours, pickup opening/closing times and business-day starts. An opening or
  // closing time less than a minute from a local hour or business-day start (hours that end at
  // 23:59:59 meaning end of day) is not a cut of its own: it would leave a sliver of a slot with a
  // capacity of 1. The neighbouring slot keeps the service it overlaps. A window edge at the
  // horizon is where the Store calendar was clipped to it, not an opening or closing time: cutting
  // there would add a few-minute slot at the far end on every run while pickup is open.
  const fixedCuts = [
    ...localHourStarts(input.timeZone, observedAt - HOUR, horizonUntil + HOUR),
    ...days.map(([, start]) => start),
  ];
  const cuts = new Set<number>(fixedCuts.filter((at) => at > observedAt && at <= horizonUntil));
  for (const [start, end] of windows)
    for (const at of [start, end])
      if (at !== horizonUntil && !fixedCuts.some((fixed) => Math.abs(fixed - at) < MINUTE))
        cuts.add(at);
  const orderedCuts = [...cuts]
    .filter((at) => at > observedAt && at <= horizonUntil)
    .sort((a, b) => a - b);

  // Gaps no existing slot covers, from observedAt to the horizon.
  const covered = existing
    .filter((slot) => slot.end > observedAt && slot.start < horizonUntil)
    .map((slot) => [slot.start, slot.end] as const)
    .sort((left, right) => left[0] - right[0]);
  const gaps: [number, number][] = [];
  let cursor = observedAt;
  for (const [start, end] of covered) {
    if (start > cursor) gaps.push([cursor, Math.min(start, horizonUntil)]);
    cursor = Math.max(cursor, end);
    if (cursor >= horizonUntil) break;
  }
  if (cursor < horizonUntil) gaps.push([cursor, horizonUntil]);

  const businessDateAt = (at: number) => {
    const day = days.find(([, start, end]) => start <= at && at < end);
    return day === undefined ? fail() : day[0];
  };
  const newSlots: [number, number][] = [];
  for (const [gapStart, gapEnd] of gaps) {
    let start = gapStart;
    for (const cut of orderedCuts) {
      if (cut <= start) continue;
      if (cut >= gapEnd) break;
      newSlots.push([start, cut]);
      start = cut;
    }
    // The far end stops at the last cut: a later run extends it by whole slots, never by the
    // few minutes since the previous run.
    if (gapEnd > start && (gapEnd < horizonUntil || cuts.has(horizonUntil)))
      newSlots.push([start, gapEnd]);
  }
  if (newSlots.length > MAXIMUM_CREATED) return fail();

  // Cells: from the last cut at or before observedAt through every cut up to the horizon. A
  // window edge at observedAt is where the calendar was clipped, not an opening time.
  const cellCuts = [
    ...fixedCuts.filter((at) => at <= observedAt).slice(-1),
    ...orderedCuts.filter((at) => !(at === observedAt && !fixedCuts.includes(at))),
  ].sort((a, b) => a - b);
  const cellIndexOf = (at: number) => {
    let found = -1;
    cellCuts.forEach((cut, index) => {
      if (cut <= at) found = index;
    });
    return found;
  };
  const cells = new Map<number, { members: Member[]; regular: boolean }>();
  const leftAsIs = new Set<Member>();
  const memberOf = new Map<object, Member>();
  const enrol = (key: object, start: number, end: number, fixedLimit: number | null) => {
    const index = cellIndexOf(start);
    const cellEnd = cellCuts[index + 1];
    const member: Member = { start, end, fixedLimit, target: desiredLimit(start, end) };
    memberOf.set(key, member);
    // A slot crossing a cut (an older schedule, or hours that changed after it was laid) keeps
    // the per-slot rule, and so does every slot sharing a cell with it.
    for (let next = index + 1; (cellCuts[next] ?? Infinity) < end; next += 1) {
      const crossed = cells.get(next) ?? { members: [], regular: true };
      crossed.regular = false;
      cells.set(next, crossed);
    }
    if (index < 0) return;
    // A cell reaching past the horizon is not complete yet; it is shared once a run lays its end.
    if (cellEnd === undefined) {
      leftAsIs.add(member);
      return;
    }
    const cell = cells.get(index) ?? { members: [], regular: true };
    if (end > cellEnd) cell.regular = false;
    cell.members.push(member);
    cells.set(index, cell);
  };
  const fixedOf = (slot: (typeof existing)[number]) =>
    slot.start <= observedAt || slot.start >= horizonUntil || slot.reserved
      ? (slot.capacityLimit ?? 0)
      : null;
  for (const slot of existing) enrol(slot, slot.start, slot.end, fixedOf(slot));
  const newKeys = newSlots.map(([start, end]) => {
    const key = {};
    enrol(key, start, end, null);
    return key;
  });
  for (const [index, cell] of cells) {
    if (!cell.regular) continue;
    const cellStart = cellCuts[index] ?? fail(),
      cellEnd = cellCuts[index + 1] ?? fail();
    // The current cell was shared while it was ahead.
    if (cellStart <= observedAt) {
      cell.members.forEach((member) => leftAsIs.add(member));
      continue;
    }
    shareCell(
      cellStart,
      cellEnd,
      cell.members.sort((left, right) => left.start - right.start),
    );
  }
  function shareCell(cellStart: number, cellEnd: number, members: Member[]) {
    const budget = desiredLimit(cellStart, cellEnd);
    const length = cellEnd - cellStart;
    // Shares counted from the start of the cell, so each depends only on the slot's own bounds.
    const upTo = (at: number) => Math.ceil((budget * (at - cellStart)) / length);
    for (const member of members) member.target = upTo(member.end) - upTo(member.start);
    // At least 1 each, taken back from the largest shares (the latest on a tie).
    let excess = 0;
    for (const member of members)
      if (member.target < 1) {
        excess += 1 - member.target;
        member.target = 1;
      }
    const giveBack = (amount: number, eligible: (member: Member) => boolean) => {
      while (amount > 0) {
        const largest = members.reduce<Member | undefined>(
          (best, member) =>
            eligible(member) &&
            member.target > 1 &&
            (best === undefined || member.target >= best.target)
              ? member
              : best,
          undefined,
        );
        if (largest === undefined) return;
        largest.target -= 1;
        amount -= 1;
      }
    };
    giveBack(excess, () => true);
    // Reserved slots keep what they hold; unreserved ones give up anything held beyond a share.
    const held = members.reduce(
      (sum, member) => (member.fixedLimit === null ? sum : sum + member.fixedLimit - member.target),
      0,
    );
    giveBack(held, (member) => member.fixedLimit === null);
  }

  const create: PickupCapacitySlotPlan[] = newSlots.map(([start, end], index) =>
    Object.freeze({
      startsAt: iso(start),
      endsAt: iso(end),
      businessDate: businessDateAt(start),
      capacityLimit: memberOf.get(newKeys[index] ?? fail())?.target ?? fail(),
    }),
  );

  // Future slots nobody reserved follow the current hours and policy; reserved ones never change.
  const republish: PickupCapacityRepublication[] = [];
  for (const slot of existing) {
    if (slot.start <= observedAt || slot.start >= horizonUntil || slot.reserved) continue;
    const member = memberOf.get(slot) ?? fail();
    if (leftAsIs.has(member)) continue;
    const limit = member.target;
    if (slot.capacityLimit === limit) continue;
    republish.push(
      Object.freeze({
        slotReference: slot.slotReference,
        configVersion: slot.configVersion + 1,
        previousVersion: slot.configVersion,
        capacityLimit: limit,
      }),
    );
  }

  return Object.freeze({
    create: Object.freeze(create),
    republish: Object.freeze(republish),
    coveredUntil: pickupCapacityCoverageEnd(
      [...existing.map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt })), ...create],
      input.observedAt,
    ),
  });
}
