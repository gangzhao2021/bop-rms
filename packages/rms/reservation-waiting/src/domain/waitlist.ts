import {
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  ReservationError,
  type ReservationCode,
  type ReservationInstant,
  type ReservationReference,
} from "./reservation.js";

export type WaitlistStatus =
  "Waiting" | "CheckedIn" | "Called" | "Ready" | "Seated" | "Missed" | "Cancelled" | "Expired";
export type WaitlistNotificationStatus =
  "NotRequested" | "Pending" | "Delivered" | "Failed" | "Unavailable";

export interface WaitEstimate {
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly calculatedAt: ReservationInstant;
  readonly calculationVersion: ReservationCode;
}

export interface WaitlistContactSnapshot {
  readonly displayName: string;
  readonly contactState: "Verified" | "Unverified" | "Unavailable";
  readonly contactSummary: string;
}

export interface WaitlistEntry {
  readonly waitlistEntryReference: ReservationReference;
  readonly tenantReference: ReservationReference;
  readonly brandReference: ReservationReference;
  readonly storeReference: ReservationReference;
  readonly status: WaitlistStatus;
  readonly joinMode: "Remote" | "WalkIn";
  readonly partySize: number;
  readonly contact: WaitlistContactSnapshot;
  readonly areaPreferenceCode: ReservationCode | null;
  readonly seatingConstraintCodes: readonly ReservationCode[];
  readonly joinedAt: ReservationInstant;
  readonly checkedInAt: ReservationInstant | null;
  readonly calledAt: ReservationInstant | null;
  readonly responseDeadline: ReservationInstant | null;
  readonly readyAt: ReservationInstant | null;
  readonly readyExpiresAt: ReservationInstant | null;
  readonly readyExtensionUsed: boolean;
  readonly maxWaitExpiresAt: ReservationInstant;
  readonly quotedEstimate: WaitEstimate;
  readonly currentEstimate: WaitEstimate;
  readonly priorityKind: "Default" | "Policy" | "ManagerOverride";
  readonly priorityReasonCode: ReservationCode | null;
  readonly priorityReference: ReservationReference | null;
  readonly priorityExpiresAt: ReservationInstant | null;
  readonly notificationRequestReference: ReservationReference | null;
  readonly notificationStatus: WaitlistNotificationStatus;
  readonly diningSessionReference: ReservationReference | null;
  readonly terminalReasonCode: ReservationCode | null;
  readonly revisionNumber: number;
  readonly aggregateVersion: number;
  readonly createdAt: ReservationInstant;
  readonly observedAt: ReservationInstant;
}

export interface WaitEstimateRevision {
  readonly estimateRevisionReference: ReservationReference;
  readonly waitlistEntryReference: ReservationReference;
  readonly previousEstimate: WaitEstimate;
  readonly revisedEstimate: WaitEstimate;
  readonly reasonCode: ReservationCode;
  readonly revisedByActorReference: ReservationReference;
  readonly revisedAt: ReservationInstant;
}

export interface WaitlistEntryRevision {
  readonly revisionReference: ReservationReference;
  readonly waitlistEntryReference: ReservationReference;
  readonly revisionNumber: number;
  readonly reasonCode: ReservationCode;
  readonly previousSnapshot: WaitlistEntry;
  readonly revisedSnapshot: WaitlistEntry;
  readonly revisedByActorReference: ReservationReference;
  readonly revisedAt: ReservationInstant;
}

export interface WaitPriorityRevision {
  readonly priorityRevisionReference: ReservationReference;
  readonly waitlistEntryReference: ReservationReference;
  readonly previousKind: WaitlistEntry["priorityKind"];
  readonly revisedKind: WaitlistEntry["priorityKind"];
  readonly reasonCode: ReservationCode;
  readonly revisedByActorReference: ReservationReference;
  readonly revisedAt: ReservationInstant;
}

const fail = (): never => {
  throw new ReservationError("RESERVATION_INPUT_INVALID");
};
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;

function closed(value: unknown, keys: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof ReservationError) throw error;
    return fail();
  }
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return fail();
  return value as number;
}

export function parseWaitEstimate(value: unknown): WaitEstimate {
  const raw = closed(value, [
    "minimumMinutes",
    "maximumMinutes",
    "calculatedAt",
    "calculationVersion",
  ]);
  const minimumMinutes = positive(raw.minimumMinutes, 10080);
  const maximumMinutes = positive(raw.maximumMinutes, 10080);
  if (maximumMinutes < minimumMinutes) return fail();
  return Object.freeze({
    minimumMinutes,
    maximumMinutes,
    calculatedAt: parseReservationInstant(raw.calculatedAt),
    calculationVersion: parseReservationCode(raw.calculationVersion),
  });
}

function parseContact(value: unknown): WaitlistContactSnapshot {
  const raw = closed(value, ["displayName", "contactState", "contactSummary"]);
  if (
    typeof raw.displayName !== "string" ||
    !safe.test(raw.displayName) ||
    raw.displayName.trim() !== raw.displayName ||
    !["Verified", "Unverified", "Unavailable"].includes(raw.contactState as string) ||
    typeof raw.contactSummary !== "string" ||
    !safe.test(raw.contactSummary) ||
    raw.contactSummary.trim() !== raw.contactSummary ||
    /https?:\/\//iu.test(raw.contactSummary)
  )
    return fail();
  return Object.freeze({
    displayName: raw.displayName,
    contactState: raw.contactState as WaitlistContactSnapshot["contactState"],
    contactSummary: raw.contactSummary,
  });
}

export function createWaitlistEntry(value: unknown): WaitlistEntry {
  const raw = closed(value, [
    "waitlistEntryReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "status",
    "joinMode",
    "partySize",
    "contact",
    "areaPreferenceCode",
    "seatingConstraintCodes",
    "joinedAt",
    "checkedInAt",
    "calledAt",
    "responseDeadline",
    "readyAt",
    "readyExpiresAt",
    "readyExtensionUsed",
    "maxWaitExpiresAt",
    "quotedEstimate",
    "currentEstimate",
    "priorityKind",
    "priorityReasonCode",
    "priorityReference",
    "priorityExpiresAt",
    "notificationRequestReference",
    "notificationStatus",
    "diningSessionReference",
    "terminalReasonCode",
    "revisionNumber",
    "aggregateVersion",
    "createdAt",
    "observedAt",
  ]);
  if (
    ![
      "Waiting",
      "CheckedIn",
      "Called",
      "Ready",
      "Seated",
      "Missed",
      "Cancelled",
      "Expired",
    ].includes(raw.status as string) ||
    !["Remote", "WalkIn"].includes(raw.joinMode as string) ||
    !Array.isArray(raw.seatingConstraintCodes) ||
    raw.seatingConstraintCodes.length > 16 ||
    typeof raw.readyExtensionUsed !== "boolean" ||
    !["Default", "Policy", "ManagerOverride"].includes(raw.priorityKind as string) ||
    !["NotRequested", "Pending", "Delivered", "Failed", "Unavailable"].includes(
      raw.notificationStatus as string,
    )
  )
    return fail();
  const status = raw.status as WaitlistStatus;
  const joinedAt = parseReservationInstant(raw.joinedAt);
  const createdAt = parseReservationInstant(raw.createdAt);
  const observedAt = parseReservationInstant(raw.observedAt);
  const maxWaitExpiresAt = parseReservationInstant(raw.maxWaitExpiresAt);
  const optionalInstant = (candidate: unknown) =>
    candidate === null ? null : parseReservationInstant(candidate);
  const optionalReference = (candidate: unknown) =>
    candidate === null ? null : parseReservationReference(candidate);
  const optionalCode = (candidate: unknown) =>
    candidate === null ? null : parseReservationCode(candidate);
  const checkedInAt = optionalInstant(raw.checkedInAt);
  const calledAt = optionalInstant(raw.calledAt);
  const responseDeadline = optionalInstant(raw.responseDeadline);
  const readyAt = optionalInstant(raw.readyAt);
  const readyExpiresAt = optionalInstant(raw.readyExpiresAt);
  const priorityReasonCode = optionalCode(raw.priorityReasonCode);
  const priorityReference = optionalReference(raw.priorityReference);
  const priorityExpiresAt = optionalInstant(raw.priorityExpiresAt);
  const notificationRequestReference = optionalReference(raw.notificationRequestReference);
  const diningSessionReference = optionalReference(raw.diningSessionReference);
  const terminalReasonCode = optionalCode(raw.terminalReasonCode);
  const constraints = raw.seatingConstraintCodes.map(parseReservationCode).sort();
  const quotedEstimate = parseWaitEstimate(raw.quotedEstimate);
  const currentEstimate = parseWaitEstimate(raw.currentEstimate);
  const terminal = ["Cancelled", "Expired"].includes(status);
  if (
    new Set(constraints).size !== constraints.length ||
    Date.parse(maxWaitExpiresAt) <= Date.parse(joinedAt) ||
    Date.parse(createdAt) > Date.parse(joinedAt) ||
    Date.parse(quotedEstimate.calculatedAt) > Date.parse(observedAt) ||
    Date.parse(currentEstimate.calculatedAt) > Date.parse(observedAt) ||
    (raw.joinMode === "WalkIn" && status === "Waiting") ||
    (["CheckedIn", "Ready", "Seated"].includes(status) && checkedInAt === null) ||
    (calledAt === null) !== (responseDeadline === null) ||
    (["Called", "Ready", "Missed", "Seated"].includes(status) && calledAt === null) ||
    (calledAt !== null &&
      responseDeadline !== null &&
      Date.parse(responseDeadline) <= Date.parse(calledAt)) ||
    (readyAt === null) !== (readyExpiresAt === null) ||
    (["Ready", "Seated"].includes(status) && readyAt === null) ||
    (readyAt !== null &&
      readyExpiresAt !== null &&
      Date.parse(readyExpiresAt) <= Date.parse(readyAt)) ||
    (status === "Seated") !== (diningSessionReference !== null) ||
    terminal !== (terminalReasonCode !== null) ||
    (raw.priorityKind === "Default" &&
      (priorityReasonCode !== null || priorityReference !== null || priorityExpiresAt !== null)) ||
    (raw.priorityKind !== "Default" &&
      (priorityReasonCode === null || priorityReference === null || priorityExpiresAt === null)) ||
    (priorityExpiresAt !== null && Date.parse(priorityExpiresAt) <= Date.parse(observedAt)) ||
    (notificationRequestReference === null) !== (raw.notificationStatus === "NotRequested")
  )
    return fail();
  return Object.freeze({
    waitlistEntryReference: parseReservationReference(raw.waitlistEntryReference),
    tenantReference: parseReservationReference(raw.tenantReference),
    brandReference: parseReservationReference(raw.brandReference),
    storeReference: parseReservationReference(raw.storeReference),
    status,
    joinMode: raw.joinMode as WaitlistEntry["joinMode"],
    partySize: positive(raw.partySize, 1000),
    contact: parseContact(raw.contact),
    areaPreferenceCode:
      raw.areaPreferenceCode === null ? null : parseReservationCode(raw.areaPreferenceCode),
    seatingConstraintCodes: Object.freeze(constraints),
    joinedAt,
    checkedInAt,
    calledAt,
    responseDeadline,
    readyAt,
    readyExpiresAt,
    readyExtensionUsed: raw.readyExtensionUsed,
    maxWaitExpiresAt,
    quotedEstimate,
    currentEstimate,
    priorityKind: raw.priorityKind as WaitlistEntry["priorityKind"],
    priorityReasonCode,
    priorityReference,
    priorityExpiresAt,
    notificationRequestReference,
    notificationStatus: raw.notificationStatus as WaitlistNotificationStatus,
    diningSessionReference,
    terminalReasonCode,
    revisionNumber: positive(raw.revisionNumber),
    aggregateVersion: positive(raw.aggregateVersion),
    createdAt,
    observedAt,
  });
}

export function transitionWaitlistEntry(
  currentInput: WaitlistEntry,
  action:
    | "CheckIn"
    | "Call"
    | "MarkReady"
    | "MarkMissed"
    | "RestoreWaiting"
    | "RestoreCheckedIn"
    | "Cancel"
    | "Expire"
    | "ExtendReady"
    | "RecordSeated",
  input: {
    readonly observedAt: ReservationInstant;
    readonly reasonCode: ReservationCode | null;
    readonly deadline: ReservationInstant | null;
    readonly eligibleAt: ReservationInstant | null;
    readonly notificationRequestReference: ReservationReference | null;
    readonly diningSessionReference: ReservationReference | null;
  },
) {
  const current = createWaitlistEntry(currentInput);
  const next: Record<string, unknown> = { ...current, observedAt: input.observedAt };
  if (action === "CheckIn" && current.status === "Waiting") {
    next.status = "CheckedIn";
    next.checkedInAt = input.observedAt;
  } else if (
    action === "Call" &&
    ["Waiting", "CheckedIn"].includes(current.status) &&
    input.deadline !== null &&
    input.notificationRequestReference !== null &&
    Date.parse(input.deadline) > Date.parse(input.observedAt)
  ) {
    next.status = "Called";
    next.calledAt = input.observedAt;
    next.responseDeadline = input.deadline;
    next.notificationRequestReference = input.notificationRequestReference;
    next.notificationStatus = "Pending";
  } else if (
    action === "MarkReady" &&
    current.status === "Called" &&
    current.responseDeadline !== null &&
    input.deadline !== null &&
    Date.parse(input.observedAt) <= Date.parse(current.responseDeadline) &&
    Date.parse(input.deadline) > Date.parse(input.observedAt)
  ) {
    next.status = "Ready";
    next.checkedInAt ??= input.observedAt;
    next.readyAt = input.observedAt;
    next.readyExpiresAt = input.deadline;
  } else if (
    action === "MarkMissed" &&
    current.status === "Called" &&
    current.responseDeadline !== null &&
    input.reasonCode !== null &&
    Date.parse(input.observedAt) >= Date.parse(current.responseDeadline)
  ) {
    next.status = "Missed";
  } else if (
    ["RestoreWaiting", "RestoreCheckedIn"].includes(action) &&
    current.status === "Missed" &&
    input.reasonCode !== null
  ) {
    next.status = action === "RestoreWaiting" ? "Waiting" : "CheckedIn";
    next.calledAt = null;
    next.responseDeadline = null;
    next.notificationRequestReference = null;
    next.notificationStatus = "NotRequested";
    if (action === "RestoreCheckedIn") next.checkedInAt = input.observedAt;
    else next.checkedInAt = null;
  } else if (
    action === "Cancel" &&
    !["Seated", "Cancelled", "Expired"].includes(current.status) &&
    input.reasonCode !== null
  ) {
    next.status = "Cancelled";
    next.terminalReasonCode = input.reasonCode;
  } else if (
    action === "Expire" &&
    !["Seated", "Cancelled", "Expired"].includes(current.status) &&
    input.reasonCode !== null &&
    input.eligibleAt !== null &&
    Date.parse(input.observedAt) >= Date.parse(input.eligibleAt)
  ) {
    next.status = "Expired";
    next.terminalReasonCode = input.reasonCode;
  } else if (
    action === "ExtendReady" &&
    current.status === "Ready" &&
    !current.readyExtensionUsed &&
    current.readyExpiresAt !== null &&
    input.deadline !== null &&
    input.reasonCode !== null &&
    Date.parse(input.deadline) > Date.parse(current.readyExpiresAt)
  ) {
    next.readyExpiresAt = input.deadline;
    next.readyExtensionUsed = true;
  } else if (
    action === "RecordSeated" &&
    current.status === "Ready" &&
    input.diningSessionReference !== null
  ) {
    next.status = "Seated";
    next.diningSessionReference = input.diningSessionReference;
  } else return fail();
  next.aggregateVersion = current.aggregateVersion + 1;
  return createWaitlistEntry(next);
}

export function reviseWaitlistEntry(
  currentInput: WaitlistEntry,
  candidateInput: WaitlistEntry,
  evidence: {
    readonly revisionReference: ReservationReference;
    readonly reasonCode: ReservationCode;
    readonly actorReference: ReservationReference;
    readonly observedAt: ReservationInstant;
  },
): { readonly entry: WaitlistEntry; readonly revision: WaitlistEntryRevision } {
  const current = createWaitlistEntry(currentInput);
  const candidate = createWaitlistEntry(candidateInput);
  if (["Seated", "Cancelled", "Expired"].includes(current.status)) return fail();
  const preserved = [
    "waitlistEntryReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "status",
    "joinMode",
    "joinedAt",
    "checkedInAt",
    "calledAt",
    "responseDeadline",
    "readyAt",
    "readyExpiresAt",
    "readyExtensionUsed",
    "maxWaitExpiresAt",
    "quotedEstimate",
    "currentEstimate",
    "priorityKind",
    "priorityReasonCode",
    "priorityReference",
    "priorityExpiresAt",
    "notificationRequestReference",
    "notificationStatus",
    "diningSessionReference",
    "terminalReasonCode",
    "createdAt",
  ] as const;
  if (
    preserved.some((key) => JSON.stringify(candidate[key]) !== JSON.stringify(current[key])) ||
    candidate.revisionNumber !== current.revisionNumber + 1 ||
    candidate.aggregateVersion !== current.aggregateVersion + 1 ||
    candidate.observedAt !== evidence.observedAt
  )
    return fail();
  return Object.freeze({
    entry: candidate,
    revision: Object.freeze({
      revisionReference: evidence.revisionReference,
      waitlistEntryReference: current.waitlistEntryReference,
      revisionNumber: candidate.revisionNumber,
      reasonCode: evidence.reasonCode,
      previousSnapshot: current,
      revisedSnapshot: candidate,
      revisedByActorReference: evidence.actorReference,
      revisedAt: evidence.observedAt,
    }),
  });
}

export function reviseWaitEstimate(
  currentInput: WaitlistEntry,
  candidateInput: WaitlistEntry,
  evidence: {
    readonly estimateRevisionReference: ReservationReference;
    readonly reasonCode: ReservationCode;
    readonly actorReference: ReservationReference;
    readonly observedAt: ReservationInstant;
  },
): { readonly entry: WaitlistEntry; readonly revision: WaitEstimateRevision } {
  const current = createWaitlistEntry(currentInput);
  const candidate = createWaitlistEntry(candidateInput);
  if (["Seated", "Cancelled", "Expired"].includes(current.status)) return fail();
  const expected = createWaitlistEntry({
    ...current,
    currentEstimate: candidate.currentEstimate,
    aggregateVersion: current.aggregateVersion + 1,
    observedAt: evidence.observedAt,
  });
  if (JSON.stringify(expected) !== JSON.stringify(candidate)) return fail();
  return Object.freeze({
    entry: candidate,
    revision: Object.freeze({
      estimateRevisionReference: evidence.estimateRevisionReference,
      waitlistEntryReference: current.waitlistEntryReference,
      previousEstimate: current.currentEstimate,
      revisedEstimate: candidate.currentEstimate,
      reasonCode: evidence.reasonCode,
      revisedByActorReference: evidence.actorReference,
      revisedAt: evidence.observedAt,
    }),
  });
}

export function reviseWaitPriority(
  currentInput: WaitlistEntry,
  candidateInput: WaitlistEntry,
  evidence: {
    readonly priorityRevisionReference: ReservationReference;
    readonly reasonCode: ReservationCode;
    readonly actorReference: ReservationReference;
    readonly observedAt: ReservationInstant;
  },
): { readonly entry: WaitlistEntry; readonly revision: WaitPriorityRevision } {
  const current = createWaitlistEntry(currentInput);
  const candidate = createWaitlistEntry(candidateInput);
  if (["Seated", "Cancelled", "Expired"].includes(current.status)) return fail();
  const expected = createWaitlistEntry({
    ...current,
    priorityKind: candidate.priorityKind,
    priorityReasonCode: candidate.priorityReasonCode,
    priorityReference: candidate.priorityReference,
    priorityExpiresAt: candidate.priorityExpiresAt,
    aggregateVersion: current.aggregateVersion + 1,
    observedAt: evidence.observedAt,
  });
  if (
    JSON.stringify(expected) !== JSON.stringify(candidate) ||
    candidate.priorityKind === "Default" ||
    candidate.priorityReasonCode !== evidence.reasonCode
  )
    return fail();
  return Object.freeze({
    entry: candidate,
    revision: Object.freeze({
      priorityRevisionReference: evidence.priorityRevisionReference,
      waitlistEntryReference: current.waitlistEntryReference,
      previousKind: current.priorityKind,
      revisedKind: candidate.priorityKind,
      reasonCode: evidence.reasonCode,
      revisedByActorReference: evidence.actorReference,
      revisedAt: evidence.observedAt,
    }),
  });
}

export function recordWaitlistNotificationOutcome(
  currentInput: WaitlistEntry,
  candidateInput: WaitlistEntry,
  observedAt: ReservationInstant,
) {
  const current = createWaitlistEntry(currentInput);
  const candidate = createWaitlistEntry(candidateInput);
  if (
    current.notificationRequestReference === null ||
    current.notificationStatus !== "Pending" ||
    !["Delivered", "Failed", "Unavailable"].includes(candidate.notificationStatus)
  )
    return fail();
  const expected = createWaitlistEntry({
    ...current,
    notificationStatus: candidate.notificationStatus,
    aggregateVersion: current.aggregateVersion + 1,
    observedAt,
  });
  if (JSON.stringify(expected) !== JSON.stringify(candidate)) return fail();
  return candidate;
}

export function orderEligibleWaitlistEntries(
  entriesInput: readonly WaitlistEntry[],
  capability: {
    readonly minimumPartySize: number;
    readonly maximumPartySize: number;
    readonly areaCode: ReservationCode;
    readonly supportedConstraintCodes: readonly ReservationCode[];
    readonly checkedInFirst: boolean;
    readonly observedAt: ReservationInstant;
  },
) {
  const minimumPartySize = positive(capability.minimumPartySize, 1000);
  const maximumPartySize = positive(capability.maximumPartySize, 1000);
  if (maximumPartySize < minimumPartySize) return fail();
  const areaCode = parseReservationCode(capability.areaCode);
  const observedAt = parseReservationInstant(capability.observedAt);
  const supported = new Set(capability.supportedConstraintCodes.map(parseReservationCode));
  if (supported.size !== capability.supportedConstraintCodes.length) return fail();
  const entries = entriesInput.map(createWaitlistEntry);
  if (new Set(entries.map((entry) => entry.waitlistEntryReference)).size !== entries.length)
    return fail();
  const priorityRank = (entry: WaitlistEntry) => {
    const active =
      entry.priorityExpiresAt !== null &&
      Date.parse(entry.priorityExpiresAt) > Date.parse(observedAt);
    if (!active) return 2;
    return entry.priorityKind === "ManagerOverride" ? 0 : 1;
  };
  const arrivalRank = (entry: WaitlistEntry) => {
    if (!capability.checkedInFirst) return 0;
    return entry.checkedInAt === null ? 1 : 0;
  };
  return Object.freeze(
    entries
      .filter(
        (entry) =>
          ["Waiting", "CheckedIn", "Called", "Ready"].includes(entry.status) &&
          entry.partySize >= minimumPartySize &&
          entry.partySize <= maximumPartySize &&
          (entry.areaPreferenceCode === null || entry.areaPreferenceCode === areaCode) &&
          entry.seatingConstraintCodes.every((code) => supported.has(code)),
      )
      .sort(
        (left, right) =>
          priorityRank(left) - priorityRank(right) ||
          arrivalRank(left) - arrivalRank(right) ||
          Date.parse(left.joinedAt) - Date.parse(right.joinedAt) ||
          left.waitlistEntryReference.localeCompare(right.waitlistEntryReference),
      )
      .map((entry) => entry.waitlistEntryReference),
  );
}

export function calculateDeterministicWaitEstimate(input: {
  readonly availableInMinutes: number;
  readonly compatibleEntriesAhead: number;
  readonly standardTurnMinutes: number;
  readonly cleaningBufferMinutes: number;
  readonly reservationPressureMinutes: number;
  readonly holdPressureMinutes: number;
  readonly calculatedAt: ReservationInstant;
  readonly calculationVersion: ReservationCode;
}): WaitEstimate {
  const nonnegative = (value: unknown, maximum = 10080) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
      return fail();
    return value as number;
  };
  const available = nonnegative(input.availableInMinutes);
  const ahead = nonnegative(input.compatibleEntriesAhead, 1000);
  const turn = positive(input.standardTurnMinutes, 1440);
  const cleaning = nonnegative(input.cleaningBufferMinutes, 1440);
  const reservationPressure = nonnegative(input.reservationPressureMinutes, 1440);
  const holdPressure = nonnegative(input.holdPressureMinutes, 1440);
  const minimumMinutes = available + ahead * turn;
  const maximumMinutes = minimumMinutes + cleaning + reservationPressure + holdPressure;
  if (!Number.isSafeInteger(maximumMinutes) || maximumMinutes > 10080) return fail();
  return Object.freeze({
    minimumMinutes: Math.max(1, minimumMinutes),
    maximumMinutes: Math.max(1, maximumMinutes),
    calculatedAt: parseReservationInstant(input.calculatedAt),
    calculationVersion: parseReservationCode(input.calculationVersion),
  });
}
