import {
  DiningSessionError,
  parseDiningInstant,
  parseDiningReference,
  type DiningInstant,
  type DiningReference,
} from "./dining-session.js";

/**
 * DEC-DINING-STAFF-CALL (WP-2423 Q28, 2026-10-25): a seated guest asks staff to come to the table
 * from their own phone. They choose a reason and write nothing (no free text, so no health or
 * personal facts are recorded). A Dining Session has at most one open call; it closes when staff
 * answer it or a guest at the table withdraws it, and is no longer shown once the Session ends.
 * At most `diningStaffCallMaximumPerWindow` calls per Session in any `diningStaffCallWindowMs`.
 */
export const diningStaffCallWindowMs = 30 * 60_000;
export const diningStaffCallMaximumPerWindow = 6;

export const diningStaffCallReasons = ["Question", "TableNeeds", "OrderProblem"] as const;
export type DiningStaffCallReason = (typeof diningStaffCallReasons)[number];

export type DiningStaffCallClosureKind = "Answered" | "Withdrawn";

export interface DiningStaffCall {
  readonly callReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly participantReference: DiningReference;
  readonly reason: DiningStaffCallReason;
  readonly calledAt: DiningInstant;
}

export interface DiningStaffCallClosure {
  readonly callReference: DiningReference;
  readonly kind: DiningStaffCallClosureKind;
  readonly closedAt: DiningInstant;
}

/** A guest's request at their own table: the Session and participant come from their binding. */
export interface DiningStaffCallGuestCommand {
  readonly operationReference: DiningReference;
  readonly tenantReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly participantReference: DiningReference;
  readonly observedAt: DiningInstant;
}

export interface DiningStaffCallAnswerCommand {
  readonly operationReference: DiningReference;
  readonly callReference: DiningReference;
  readonly actorReference: DiningReference;
  readonly observedAt: DiningInstant;
}

export type DiningStaffCallRefusal =
  /** Not a seated participant of an Active Session (left, closed, or never joined). */
  | "NotSeated"
  /** The Session's calls for the current window are used up. */
  | "TooManyCalls";

function invalid(): never {
  throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}

const guestReferences = [
  "operationReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "participantReference",
] as const;

export function parseDiningStaffCallGuestCommand(value: unknown): DiningStaffCallGuestCommand {
  const raw = closed(value, [...guestReferences, "observedAt"]);
  const references = Object.fromEntries(
    guestReferences.map((key) => [key, parseDiningReference(raw[key])]),
  ) as Record<(typeof guestReferences)[number], DiningReference>;
  return Object.freeze({ ...references, observedAt: parseDiningInstant(raw.observedAt) });
}

export function parseDiningStaffCallAnswerCommand(value: unknown): DiningStaffCallAnswerCommand {
  const raw = closed(value, [
    "operationReference",
    "callReference",
    "actorReference",
    "observedAt",
  ]);
  return Object.freeze({
    operationReference: parseDiningReference(raw.operationReference),
    callReference: parseDiningReference(raw.callReference),
    actorReference: parseDiningReference(raw.actorReference),
    observedAt: parseDiningInstant(raw.observedAt),
  });
}

export function parseDiningStaffCallReason(value: unknown): DiningStaffCallReason {
  return diningStaffCallReasons.includes(value as DiningStaffCallReason)
    ? (value as DiningStaffCallReason)
    : invalid();
}

/** The intent each operation reference is bound to, so a replay with other content is refused. */
export function diningStaffCallIntent(
  command: DiningStaffCallGuestCommand,
  action:
    | { readonly kind: "Call"; readonly reason: DiningStaffCallReason }
    | {
        readonly kind: "Withdraw";
        readonly callReference: DiningReference;
      },
): string {
  return action.kind === "Call"
    ? `StaffCall:${command.diningSessionReference}:${command.participantReference}:${action.reason}`
    : `StaffCallWithdraw:${command.diningSessionReference}:${action.callReference}`;
}
export function diningStaffCallAnswerIntent(command: DiningStaffCallAnswerCommand): string {
  return `StaffCallAnswer:${command.callReference}:${command.actorReference}`;
}

/** The Session's calls in the window ending now, from its append-only call history. */
function recentCalls(calledAt: readonly string[], observedAt: DiningInstant): number[] {
  const now = Date.parse(observedAt);
  return calledAt
    .map((value) => Date.parse(parseDiningInstant(value)))
    .map((at) => (at > now ? invalid() : at))
    .filter((at) => now - at < diningStaffCallWindowMs)
    .sort((a, b) => a - b);
}

export function evaluateDiningStaffCallBudget(input: {
  readonly calledAt: readonly string[];
  readonly observedAt: DiningInstant;
}): "Admitted" | "TooManyCalls" {
  return recentCalls(input.calledAt, input.observedAt).length >= diningStaffCallMaximumPerWindow
    ? "TooManyCalls"
    : "Admitted";
}

/** The earliest instant another call is admitted, given the window's history. */
export function diningStaffCallAvailableAt(input: {
  readonly calledAt: readonly string[];
  readonly observedAt: DiningInstant;
}): DiningInstant {
  const recent = recentCalls(input.calledAt, input.observedAt);
  if (recent.length < diningStaffCallMaximumPerWindow) return input.observedAt;
  const oldestCounted = recent[recent.length - diningStaffCallMaximumPerWindow] as number;
  return parseDiningInstant(new Date(oldestCounted + diningStaffCallWindowMs).toISOString());
}
