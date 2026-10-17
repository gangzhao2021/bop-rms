import {
  DiningSessionError,
  parseDiningInstant,
  parseDiningReference,
  type DiningInstant,
  type DiningReference,
  type DiningSession,
} from "./dining-session.js";

/**
 * DEC-DINING-GUEST-INVITATION (2026-10-17; Handoff 6.11 and 87.4.1): the current Order Host of an
 * Active Dining Session invites the next guest from their own phone. Each invitation is the
 * Session's next one-time join code (the same capability staff issue: bound to Store, Table and
 * Session, 15 minutes, invalidated by a successful join, regeneration, Session closure or Table
 * reassignment). A Session has exactly one current code, so at most one invitation is outstanding;
 * issuing one replaces any earlier code, whoever issued it.
 *
 * Issuance budget: at most `diningGuestInvitationMaximumPerWindow` guest-issued codes per Dining
 * Session in any `diningGuestInvitationWindowMs` window. Staff issuance is not counted, so a
 * table that reaches the limit is still served by staff. The join-failure budget (87.4.2:
 * 5 / 10 minutes / Session) is unchanged and still applies to every code.
 */
export const diningGuestInvitationWindowMs = 10 * 60_000;
export const diningGuestInvitationMaximumPerWindow = 10;

export type DiningGuestInvitationRefusal =
  /** The guest is not the current Host of an Active Session at an available Table. */
  | "NotHost"
  /** The Table changed (moved) since its current code was issued; staff issue the next one. */
  | "TableChanged"
  /** The Session's guest issuance budget for the current window is used up. */
  | "TooManyInvitations";

export interface DiningGuestInvitationCommand {
  readonly operationReference: DiningReference;
  readonly tenantReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly participantReference: DiningReference;
  readonly observedAt: DiningInstant;
}

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

const commandReferences = [
  "operationReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "participantReference",
] as const;

export function parseDiningGuestInvitationCommand(value: unknown): DiningGuestInvitationCommand {
  const raw = closed(value, [...commandReferences, "observedAt"]);
  const references = Object.fromEntries(
    commandReferences.map((key) => [key, parseDiningReference(raw[key])]),
  ) as Record<(typeof commandReferences)[number], DiningReference>;
  return Object.freeze({ ...references, observedAt: parseDiningInstant(raw.observedAt) });
}

/** The intent an operation reference is bound to: one Host, one Session. */
export function diningGuestInvitationIntent(command: DiningGuestInvitationCommand): string {
  return `GuestInvitation:${command.diningSessionReference}:${command.participantReference}`;
}

/**
 * Who may invite: only the current Host (6.11), as a current Active participant of this Active
 * Session. Other participants manage only their own items and ask the Host or staff.
 */
export function evaluateDiningGuestInvitationAuthority(input: {
  readonly command: DiningGuestInvitationCommand;
  readonly session: DiningSession;
  readonly participantStatus: "Active" | "Left";
}): "Allowed" | "NotHost" {
  const { command, session } = input;
  if (
    session.diningSessionReference !== command.diningSessionReference ||
    session.brandReference !== command.brandReference ||
    session.storeReference !== command.storeReference
  )
    return invalid();
  return session.phase === "Active" &&
    input.participantStatus === "Active" &&
    session.hostParticipantReference === command.participantReference
    ? "Allowed"
    : "NotHost";
}

/** Guest issuance budget, from the Session's own append-only invitation history. */
export function evaluateDiningGuestInvitationBudget(input: {
  readonly issuedAt: readonly string[];
  readonly observedAt: DiningInstant;
}): "Admitted" | "TooManyInvitations" {
  const now = Date.parse(input.observedAt);
  let recent = 0;
  for (const value of input.issuedAt) {
    const at = Date.parse(parseDiningInstant(value));
    if (at > now) return invalid();
    if (now - at < diningGuestInvitationWindowMs) recent++;
  }
  return recent >= diningGuestInvitationMaximumPerWindow ? "TooManyInvitations" : "Admitted";
}

/** The earliest instant another guest invitation is admitted, given the window's history. */
export function diningGuestInvitationAvailableAt(input: {
  readonly issuedAt: readonly string[];
  readonly observedAt: DiningInstant;
}): DiningInstant {
  const now = Date.parse(input.observedAt);
  const recent = input.issuedAt
    .map((value) => Date.parse(parseDiningInstant(value)))
    .filter((at) => at <= now && now - at < diningGuestInvitationWindowMs)
    .sort((a, b) => a - b);
  if (recent.length < diningGuestInvitationMaximumPerWindow) return input.observedAt;
  const oldestCounted = recent[recent.length - diningGuestInvitationMaximumPerWindow] as number;
  return parseDiningInstant(new Date(oldestCounted + diningGuestInvitationWindowMs).toISOString());
}
