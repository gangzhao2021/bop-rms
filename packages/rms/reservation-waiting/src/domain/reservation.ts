export type ReservationReference = string & { readonly __reservationReference: unique symbol };
export type ReservationInstant = string & { readonly __reservationInstant: unique symbol };
export type ReservationCode = string & { readonly __reservationCode: unique symbol };
export type ReservationStatus =
  "Pending" | "Confirmed" | "CheckedIn" | "Seated" | "Cancelled" | "NoShow" | "Expired";
export type DepositOutcome = "NotRequired" | "Pending" | "Satisfied" | "Failed" | "Indeterminate";

export interface ReservationContactSnapshot {
  readonly displayName: string;
  readonly contactKind: "Email" | "Phone";
  readonly contactValue: string;
}

export interface Reservation {
  readonly reservationReference: ReservationReference;
  readonly tenantReference: ReservationReference;
  readonly brandReference: ReservationReference;
  readonly storeReference: ReservationReference;
  readonly capacityPoolReference: ReservationReference;
  readonly capacityHoldReference: ReservationReference;
  readonly capacityHoldExpiresAt: ReservationInstant;
  readonly startAt: ReservationInstant;
  readonly expectedEndAt: ReservationInstant;
  readonly partySize: number;
  readonly contact: ReservationContactSnapshot;
  readonly channel: "Staff" | "Customer";
  readonly accessibilityRequestCodes: readonly ReservationCode[];
  readonly specialRequestCode: ReservationCode | null;
  readonly depositPolicyReference: ReservationReference | null;
  readonly depositPolicyVersion: number | null;
  readonly paymentIntentReference: ReservationReference | null;
  readonly depositOutcome: DepositOutcome;
  readonly status: ReservationStatus;
  readonly revisionNumber: number;
  readonly aggregateVersion: number;
  readonly diningSessionReference: ReservationReference | null;
  readonly terminalReasonCode: ReservationCode | null;
  readonly createdAt: ReservationInstant;
  readonly observedAt: ReservationInstant;
}

export interface ReservationRevision {
  readonly revisionReference: ReservationReference;
  readonly reservationReference: ReservationReference;
  readonly revisionNumber: number;
  readonly reasonCode: ReservationCode;
  readonly critical: boolean;
  readonly previousCapacityHoldReference: ReservationReference;
  readonly replacementCapacityHoldReference: ReservationReference;
  readonly previousSnapshot: Reservation;
  readonly revisedSnapshot: Reservation;
  readonly revisedByActorReference: ReservationReference;
  readonly revisedAt: ReservationInstant;
}

export type ReservationErrorCode =
  | "RESERVATION_INPUT_INVALID"
  | "RESERVATION_TRANSITION_INVALID"
  | "RESERVATION_CAPACITY_CONFLICT"
  | "RESERVATION_DEPOSIT_CONFLICT";

export class ReservationError extends Error {
  constructor(readonly code: ReservationErrorCode) {
    super("Reservation is unavailable");
    this.name = "ReservationError";
  }
}

const fail = (code: ReservationErrorCode): never => {
  throw new ReservationError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const safeName = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
const email = /^[^\s@]{1,64}@[^\s@.]{1,190}\.[A-Za-z]{2,63}$/u;
const phone = /^\+[1-9][0-9]{7,14}$/u;

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
      return fail("RESERVATION_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("RESERVATION_INPUT_INVALID");
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof ReservationError) throw error;
    return fail("RESERVATION_INPUT_INVALID");
  }
}

export function parseReservationReference(value: unknown): ReservationReference {
  if (typeof value !== "string" || !uuid.test(value)) return fail("RESERVATION_INPUT_INVALID");
  return value as ReservationReference;
}

export function parseReservationInstant(value: unknown): ReservationInstant {
  if (typeof value !== "string" || !instant.test(value)) return fail("RESERVATION_INPUT_INVALID");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    return fail("RESERVATION_INPUT_INVALID");
  return value as ReservationInstant;
}

export function parseReservationCode(value: unknown): ReservationCode {
  if (typeof value !== "string" || !codePattern.test(value))
    return fail("RESERVATION_INPUT_INVALID");
  return value as ReservationCode;
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return fail("RESERVATION_INPUT_INVALID");
  return value as number;
}

function parseContact(value: unknown): ReservationContactSnapshot {
  const raw = closed(value, ["displayName", "contactKind", "contactValue"]);
  if (
    typeof raw.displayName !== "string" ||
    !safeName.test(raw.displayName) ||
    raw.displayName.trim() !== raw.displayName ||
    (raw.contactKind !== "Email" && raw.contactKind !== "Phone") ||
    typeof raw.contactValue !== "string" ||
    (raw.contactKind === "Email" && !email.test(raw.contactValue)) ||
    (raw.contactKind === "Phone" && !phone.test(raw.contactValue))
  )
    return fail("RESERVATION_INPUT_INVALID");
  return Object.freeze({
    displayName: raw.displayName,
    contactKind: raw.contactKind,
    contactValue:
      raw.contactKind === "Email" ? raw.contactValue.toLocaleLowerCase("en-US") : raw.contactValue,
  });
}

export function createReservation(value: unknown): Reservation {
  const raw = closed(value, [
    "reservationReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "capacityPoolReference",
    "capacityHoldReference",
    "capacityHoldExpiresAt",
    "startAt",
    "expectedEndAt",
    "partySize",
    "contact",
    "channel",
    "accessibilityRequestCodes",
    "specialRequestCode",
    "depositPolicyReference",
    "depositPolicyVersion",
    "paymentIntentReference",
    "depositOutcome",
    "status",
    "revisionNumber",
    "aggregateVersion",
    "diningSessionReference",
    "terminalReasonCode",
    "createdAt",
    "observedAt",
  ]);
  if (
    (raw.channel !== "Staff" && raw.channel !== "Customer") ||
    !Array.isArray(raw.accessibilityRequestCodes) ||
    raw.accessibilityRequestCodes.length > 16 ||
    !["NotRequired", "Pending", "Satisfied", "Failed", "Indeterminate"].includes(
      raw.depositOutcome as string,
    ) ||
    !["Pending", "Confirmed", "CheckedIn", "Seated", "Cancelled", "NoShow", "Expired"].includes(
      raw.status as string,
    )
  )
    return fail("RESERVATION_INPUT_INVALID");
  const holdExpires = parseReservationInstant(raw.capacityHoldExpiresAt);
  const startAt = parseReservationInstant(raw.startAt);
  const expectedEndAt = parseReservationInstant(raw.expectedEndAt);
  const createdAt = parseReservationInstant(raw.createdAt);
  const observedAt = parseReservationInstant(raw.observedAt);
  const attributes = raw.accessibilityRequestCodes.map(parseReservationCode).sort();
  const policy =
    raw.depositPolicyReference === null
      ? null
      : parseReservationReference(raw.depositPolicyReference);
  const policyVersion =
    raw.depositPolicyVersion === null ? null : positive(raw.depositPolicyVersion);
  const payment =
    raw.paymentIntentReference === null
      ? null
      : parseReservationReference(raw.paymentIntentReference);
  const dining =
    raw.diningSessionReference === null
      ? null
      : parseReservationReference(raw.diningSessionReference);
  const reason =
    raw.terminalReasonCode === null ? null : parseReservationCode(raw.terminalReasonCode);
  if (
    new Set(attributes).size !== attributes.length ||
    Date.parse(expectedEndAt) <= Date.parse(startAt) ||
    Date.parse(holdExpires) <= Date.parse(createdAt) ||
    (policy === null) !== (policyVersion === null) ||
    (policy === null && raw.depositOutcome !== "NotRequired") ||
    (policy !== null && raw.depositOutcome === "NotRequired") ||
    (payment === null && ["Satisfied", "Failed"].includes(raw.depositOutcome as string)) ||
    (raw.status === "Seated") !== (dining !== null) ||
    ["Cancelled", "NoShow", "Expired"].includes(raw.status as string) !== (reason !== null) ||
    (["Pending", "Confirmed", "CheckedIn", "Seated"].includes(raw.status as string) &&
      reason !== null)
  )
    return fail("RESERVATION_INPUT_INVALID");
  return Object.freeze({
    reservationReference: parseReservationReference(raw.reservationReference),
    tenantReference: parseReservationReference(raw.tenantReference),
    brandReference: parseReservationReference(raw.brandReference),
    storeReference: parseReservationReference(raw.storeReference),
    capacityPoolReference: parseReservationReference(raw.capacityPoolReference),
    capacityHoldReference: parseReservationReference(raw.capacityHoldReference),
    capacityHoldExpiresAt: holdExpires,
    startAt,
    expectedEndAt,
    partySize: positive(raw.partySize, 1000),
    contact: parseContact(raw.contact),
    channel: raw.channel,
    accessibilityRequestCodes: Object.freeze(attributes),
    specialRequestCode:
      raw.specialRequestCode === null ? null : parseReservationCode(raw.specialRequestCode),
    depositPolicyReference: policy,
    depositPolicyVersion: policyVersion,
    paymentIntentReference: payment,
    depositOutcome: raw.depositOutcome as DepositOutcome,
    status: raw.status as ReservationStatus,
    revisionNumber: positive(raw.revisionNumber),
    aggregateVersion: positive(raw.aggregateVersion),
    diningSessionReference: dining,
    terminalReasonCode: reason,
    createdAt,
    observedAt,
  });
}

export function transitionReservation(
  currentInput: Reservation,
  action: "Confirm" | "CheckIn" | "Cancel" | "MarkNoShow" | "Expire" | "RecordSeated",
  input: {
    readonly observedAt: ReservationInstant;
    readonly reasonCode: ReservationCode | null;
    readonly diningSessionReference: ReservationReference | null;
    readonly noShowEligibleAt: ReservationInstant | null;
  },
) {
  const current = createReservation(currentInput);
  const next: Record<string, unknown> = { ...current, observedAt: input.observedAt };
  if (
    action === "Confirm" &&
    current.status === "Pending" &&
    Date.parse(current.capacityHoldExpiresAt) > Date.parse(input.observedAt) &&
    ["NotRequired", "Satisfied"].includes(current.depositOutcome)
  )
    next.status = "Confirmed";
  else if (action === "CheckIn" && current.status === "Confirmed") next.status = "CheckedIn";
  else if (
    action === "Cancel" &&
    ["Pending", "Confirmed", "CheckedIn"].includes(current.status) &&
    input.reasonCode !== null
  ) {
    next.status = "Cancelled";
    next.terminalReasonCode = input.reasonCode;
  } else if (
    action === "MarkNoShow" &&
    current.status === "Confirmed" &&
    input.reasonCode !== null &&
    input.noShowEligibleAt !== null &&
    Date.parse(input.observedAt) >= Date.parse(input.noShowEligibleAt)
  ) {
    next.status = "NoShow";
    next.terminalReasonCode = input.reasonCode;
  } else if (
    action === "Expire" &&
    current.status === "Pending" &&
    input.reasonCode !== null &&
    Date.parse(input.observedAt) >= Date.parse(current.capacityHoldExpiresAt)
  ) {
    next.status = "Expired";
    next.terminalReasonCode = input.reasonCode;
  } else if (
    action === "RecordSeated" &&
    current.status === "CheckedIn" &&
    input.diningSessionReference !== null
  ) {
    next.status = "Seated";
    next.diningSessionReference = input.diningSessionReference;
  } else
    return fail(
      action === "Confirm" ? "RESERVATION_DEPOSIT_CONFLICT" : "RESERVATION_TRANSITION_INVALID",
    );
  next.aggregateVersion = current.aggregateVersion + 1;
  return createReservation(next);
}

export function reviseReservation(
  currentInput: Reservation,
  candidateInput: Reservation,
  evidence: {
    readonly revisionReference: ReservationReference;
    readonly reasonCode: ReservationCode;
    readonly actorReference: ReservationReference;
    readonly observedAt: ReservationInstant;
    readonly critical: boolean;
  },
): { readonly reservation: Reservation; readonly revision: ReservationRevision } {
  const current = createReservation(currentInput);
  const candidate = createReservation(candidateInput);
  if (["Seated", "Cancelled", "NoShow", "Expired"].includes(current.status))
    return fail("RESERVATION_TRANSITION_INVALID");
  if (
    candidate.reservationReference !== current.reservationReference ||
    candidate.tenantReference !== current.tenantReference ||
    candidate.brandReference !== current.brandReference ||
    candidate.storeReference !== current.storeReference ||
    candidate.createdAt !== current.createdAt ||
    candidate.aggregateVersion !== current.aggregateVersion + 1 ||
    candidate.revisionNumber !== current.revisionNumber + 1 ||
    candidate.observedAt !== evidence.observedAt ||
    candidate.status !== current.status ||
    candidate.diningSessionReference !== null ||
    candidate.terminalReasonCode !== null ||
    candidate.depositPolicyReference !== current.depositPolicyReference ||
    candidate.depositPolicyVersion !== current.depositPolicyVersion ||
    candidate.paymentIntentReference !== current.paymentIntentReference ||
    candidate.depositOutcome !== current.depositOutcome
  )
    return fail("RESERVATION_INPUT_INVALID");
  const criticalChanged =
    candidate.capacityPoolReference !== current.capacityPoolReference ||
    candidate.startAt !== current.startAt ||
    candidate.expectedEndAt !== current.expectedEndAt ||
    candidate.partySize !== current.partySize;
  if (evidence.critical !== criticalChanged) return fail("RESERVATION_INPUT_INVALID");
  if (
    evidence.critical &&
    (candidate.capacityHoldReference === current.capacityHoldReference ||
      Date.parse(candidate.capacityHoldExpiresAt) <= Date.parse(evidence.observedAt))
  )
    return fail("RESERVATION_CAPACITY_CONFLICT");
  if (!evidence.critical && candidate.capacityHoldReference !== current.capacityHoldReference)
    return fail("RESERVATION_CAPACITY_CONFLICT");
  return Object.freeze({
    reservation: candidate,
    revision: Object.freeze({
      revisionReference: evidence.revisionReference,
      reservationReference: current.reservationReference,
      revisionNumber: candidate.revisionNumber,
      reasonCode: evidence.reasonCode,
      critical: evidence.critical,
      previousCapacityHoldReference: current.capacityHoldReference,
      replacementCapacityHoldReference: candidate.capacityHoldReference,
      previousSnapshot: current,
      revisedSnapshot: candidate,
      revisedByActorReference: evidence.actorReference,
      revisedAt: evidence.observedAt,
    }),
  });
}
