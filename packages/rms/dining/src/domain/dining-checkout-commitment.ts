import {
  parseDiningHash,
  parseDiningInstant,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  type DiningHash,
  type DiningInstant,
  type DiningReference,
} from "./dining-session.js";

export class DiningCheckoutCommitmentError extends Error {
  constructor(
    readonly code:
      | "DINING_CHECKOUT_INPUT_INVALID"
      | "DINING_CHECKOUT_CONTEXT_CHANGED"
      | "DINING_CHECKOUT_EXPIRED"
      | "DINING_CHECKOUT_LINK_MISMATCH"
      | "DINING_CHECKOUT_CLOCK_CONFLICT",
  ) {
    super("dining checkout commitment is unavailable");
    this.name = "DiningCheckoutCommitmentError";
  }
}

export interface DiningCheckoutCommitment {
  readonly commitmentReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly sessionVersion: number;
  readonly tableReference: DiningReference;
  readonly tableAssignmentVersion: number;
  readonly participantReference: DiningReference;
  readonly participantVersion: number;
  readonly guestSessionReference: DiningReference;
  readonly cartReference: DiningReference;
  readonly cartVersion: number;
  readonly quoteReference: DiningReference;
  readonly submissionReference: DiningReference;
  readonly orderReference: DiningReference;
  readonly orderBatchReference: DiningReference;
  readonly paymentOperationReference: DiningReference;
  readonly intentHash: DiningHash;
  readonly preparedAt: DiningInstant;
  readonly preparationValidUntil: DiningInstant;
  readonly state: "Prepared" | "PaymentPending" | "Expired";
  readonly orderingLinkedAt: DiningInstant | null;
  readonly paymentRequestedAt: DiningInstant | null;
  readonly capacityExpiresAt: DiningInstant | null;
}

const referenceFields = [
  "commitmentReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "tableReference",
  "participantReference",
  "guestSessionReference",
  "cartReference",
  "quoteReference",
  "submissionReference",
  "orderReference",
  "orderBatchReference",
  "paymentOperationReference",
] as const;
const versionFields = [
  "sessionVersion",
  "tableAssignmentVersion",
  "participantVersion",
  "cartVersion",
] as const;
const fields = [
  ...referenceFields,
  ...versionFields,
  "intentHash",
  "preparedAt",
  "preparationValidUntil",
  "state",
  "orderingLinkedAt",
  "paymentRequestedAt",
  "capacityExpiresAt",
] as const;

function fail(code: DiningCheckoutCommitmentError["code"]): never {
  throw new DiningCheckoutCommitmentError(code);
}
function invalid(): never {
  return fail("DINING_CHECKOUT_INPUT_INVALID");
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((k) => typeof k !== "string" || !keys.includes(k))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
function protect<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DiningCheckoutCommitmentError) throw error;
    return invalid();
  }
}
const time = (v: DiningInstant) => Date.parse(v);
function version(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 1) return invalid();
  return v as number;
}

/** Strict historical fact parser; this does not establish current authority or durability. */
export function parseDiningCheckoutCommitment(value: unknown): DiningCheckoutCommitment {
  return protect(() => {
    const raw = closed(value, fields);
    const refs = Object.fromEntries(
      referenceFields.map((k) => [k, parseDiningReference(raw[k])]),
    ) as Pick<DiningCheckoutCommitment, (typeof referenceFields)[number]>;
    const versions = Object.fromEntries(versionFields.map((k) => [k, version(raw[k])])) as Pick<
      DiningCheckoutCommitment,
      (typeof versionFields)[number]
    >;
    const preparedAt = parseDiningInstant(raw.preparedAt);
    const preparationValidUntil = parseDiningInstant(raw.preparationValidUntil);
    if (time(preparationValidUntil) <= time(preparedAt)) return invalid();
    const orderingLinkedAt =
      raw.orderingLinkedAt === null ? null : parseDiningInstant(raw.orderingLinkedAt);
    const paymentRequestedAt =
      raw.paymentRequestedAt === null ? null : parseDiningInstant(raw.paymentRequestedAt);
    const capacityExpiresAt =
      raw.capacityExpiresAt === null ? null : parseDiningInstant(raw.capacityExpiresAt);
    if (raw.state !== "Prepared" && raw.state !== "PaymentPending" && raw.state !== "Expired")
      return invalid();
    const sealed =
      paymentRequestedAt !== null && orderingLinkedAt !== null && capacityExpiresAt !== null;
    const empty =
      paymentRequestedAt === null && orderingLinkedAt === null && capacityExpiresAt === null;
    if (
      (!sealed && !empty) ||
      (raw.state === "Prepared" && !empty) ||
      (raw.state === "PaymentPending" && !sealed)
    )
      return invalid();
    if (
      sealed &&
      (time(orderingLinkedAt) < time(preparedAt) ||
        time(paymentRequestedAt) < time(orderingLinkedAt) ||
        time(paymentRequestedAt) >= time(preparationValidUntil) ||
        time(capacityExpiresAt) !== time(paymentRequestedAt) + 30 * 60 * 1000)
    )
      return invalid();
    return Object.freeze({
      ...refs,
      ...versions,
      intentHash: parseDiningHash(raw.intentHash),
      preparedAt,
      preparationValidUntil,
      state: raw.state,
      orderingLinkedAt,
      paymentRequestedAt,
      capacityExpiresAt,
    });
  });
}

function current(
  value: unknown,
  commitment: DiningCheckoutCommitment,
  observedAt: DiningInstant,
): void {
  const raw = closed(value, ["session", "participant"]);
  const session = parseDiningSession(raw.session),
    participant = parseDiningParticipant(raw.participant);
  if (
    session.phase !== "Active" ||
    session.brandReference !== commitment.brandReference ||
    session.storeReference !== commitment.storeReference ||
    session.diningSessionReference !== commitment.diningSessionReference ||
    session.version !== commitment.sessionVersion ||
    session.tableReference !== commitment.tableReference ||
    session.tableAssignmentVersion !== commitment.tableAssignmentVersion ||
    participant.diningSessionReference !== session.diningSessionReference ||
    participant.participantReference !== commitment.participantReference ||
    participant.version !== commitment.participantVersion ||
    participant.status !== "Active" ||
    time(session.startedAt) > time(observedAt) ||
    time(participant.joinedAt) > time(observedAt)
  )
    return fail("DINING_CHECKOUT_CONTEXT_CHANGED");
}

/** Owner transaction must supply current locked context plus separately authorized Guest intent. */
export function prepareDiningCheckoutCommitment(
  value: unknown,
  context: unknown,
): DiningCheckoutCommitment {
  return protect(() => {
    const raw = closed(value, [
      ...referenceFields,
      ...versionFields,
      "intentHash",
      "preparedAt",
      "preparationValidUntil",
    ]);
    const result = parseDiningCheckoutCommitment({
      ...raw,
      state: "Prepared",
      orderingLinkedAt: null,
      paymentRequestedAt: null,
      capacityExpiresAt: null,
    });
    current(context, result, result.preparedAt);
    return result;
  });
}

/** Link evidence comes from acknowledged/recovered Ordering history, never a request-start clock. */
export function sealDiningCheckoutCommitment(
  value: unknown,
  context: unknown,
  linkValue: unknown,
  requestedAtValue: unknown,
  observedAtValue: unknown,
): DiningCheckoutCommitment {
  return protect(() => {
    const commitment = parseDiningCheckoutCommitment(value);
    const requestedAt = parseDiningInstant(requestedAtValue),
      observedAt = parseDiningInstant(observedAtValue);
    const linkFields = [
      "commitmentReference",
      "brandReference",
      "storeReference",
      "submissionReference",
      "orderReference",
      "orderBatchReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "paymentOperationReference",
      "guestSessionReference",
      "intentHash",
    ] as const;
    const link = closed(linkValue, [...linkFields, "acknowledgedAt"]);
    for (const key of linkFields)
      if (link[key] !== commitment[key]) return fail("DINING_CHECKOUT_LINK_MISMATCH");
    const linkedAt = parseDiningInstant(link.acknowledgedAt);
    if (
      time(observedAt) < time(requestedAt) ||
      time(requestedAt) < time(linkedAt) ||
      time(linkedAt) < time(commitment.preparedAt)
    )
      return fail("DINING_CHECKOUT_CLOCK_CONFLICT");
    current(context, commitment, observedAt);
    if (commitment.paymentRequestedAt !== null) {
      if (commitment.paymentRequestedAt !== requestedAt || commitment.orderingLinkedAt !== linkedAt)
        return fail("DINING_CHECKOUT_CLOCK_CONFLICT");
      // Recover the original seal even after its deadline. This is history, not permission to pay.
      return commitment;
    }
    if (
      commitment.state !== "Prepared" ||
      time(observedAt) >= time(commitment.preparationValidUntil)
    )
      return fail("DINING_CHECKOUT_EXPIRED");
    const expiresAt = parseDiningInstant(
      new Date(time(requestedAt) + 30 * 60 * 1000).toISOString(),
    );
    return parseDiningCheckoutCommitment({
      ...commitment,
      state: "PaymentPending",
      orderingLinkedAt: linkedAt,
      paymentRequestedAt: requestedAt,
      capacityExpiresAt: expiresAt,
    });
  });
}

/** Expiry only changes this checkout fact. It cannot release a table or mutate a Session/Batch. */
export function expireDiningCheckoutCommitment(
  value: unknown,
  observedAtValue: unknown,
): DiningCheckoutCommitment {
  return protect(() => {
    const commitment = parseDiningCheckoutCommitment(value);
    const observedAt = parseDiningInstant(observedAtValue);
    const deadline = commitment.capacityExpiresAt ?? commitment.preparationValidUntil;
    if (time(observedAt) < time(deadline)) return fail("DINING_CHECKOUT_CLOCK_CONFLICT");
    return parseDiningCheckoutCommitment({ ...commitment, state: "Expired" });
  });
}

/** Current payment eligibility is distinct from immutable seal recovery. */
export function assertDiningCheckoutCommitmentUsable(
  value: unknown,
  context: unknown,
  observedAtValue: unknown,
): DiningCheckoutCommitment {
  return protect(() => {
    const commitment = parseDiningCheckoutCommitment(value),
      observedAt = parseDiningInstant(observedAtValue);
    current(context, commitment, observedAt);
    if (
      commitment.state !== "PaymentPending" ||
      commitment.capacityExpiresAt === null ||
      commitment.paymentRequestedAt === null ||
      time(observedAt) >= time(commitment.capacityExpiresAt)
    )
      return fail("DINING_CHECKOUT_EXPIRED");
    if (time(observedAt) < time(commitment.paymentRequestedAt))
      return fail("DINING_CHECKOUT_CLOCK_CONFLICT");
    return commitment;
  });
}

/** Current pre-Ordering eligibility, distinct from history recovery and sealed Payment authority. */
export function assertDiningCheckoutPreparedForOrdering(
  value: unknown,
  context: unknown,
  observedAtValue: unknown,
): DiningCheckoutCommitment {
  return protect(() => {
    const commitment = parseDiningCheckoutCommitment(value);
    const observedAt = parseDiningInstant(observedAtValue);
    current(context, commitment, observedAt);
    if (
      commitment.state !== "Prepared" ||
      time(observedAt) >= time(commitment.preparationValidUntil)
    )
      return fail("DINING_CHECKOUT_EXPIRED");
    if (time(observedAt) < time(commitment.preparedAt))
      return fail("DINING_CHECKOUT_CLOCK_CONFLICT");
    return commitment;
  });
}
