import {
  assertGuestSessionUsable,
  createGuestSessionRecord,
  GuestSessionError,
  parseGuestOperationReference,
  parseGuestSelectorHash,
  parseGuestDiningAdmissionReference,
  parseGuestDiningAdmissionEvidence,
  type GuestDiningAdmissionEvidence,
  type GuestSelectorHash,
  type GuestSessionRecord,
} from "./guest-session.js";
import {
  parseCanonicalInstant,
  readClosedRecord,
  type CanonicalInstant,
} from "./identity-actor.js";

/** Candidate records must never be installed in the live Session store before activation. */
export interface GuestDiningBindingPreparation {
  readonly purpose: "DiningSessionBinding";
  readonly operationReference: string;
  readonly admissionReference: string;
  readonly predecessor: GuestSessionRecord;
  readonly candidate: GuestSessionRecord;
  readonly recoverySelectorHash: GuestSelectorHash;
  readonly revision: number;
  readonly status: "Prepared" | "Acknowledged" | "Activated";
  readonly preparedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly acknowledgedAt: CanonicalInstant | null;
  readonly activatedAt: CanonicalInstant | null;
}

export interface GuestDiningBindingProof {
  readonly sessionSelectorHash: GuestSelectorHash;
  readonly csrfSelectorHash: GuestSelectorHash;
  readonly recoverySelectorHash: GuestSelectorHash;
}

export type GuestDiningBindingHashEquals = (
  left: GuestSelectorHash,
  right: GuestSelectorHash,
) => boolean;

/** Supplied by the current Dining admission owner port, never accepted from a browser. */
export type GuestDiningBindingOwnerEvidence = GuestDiningAdmissionEvidence;

function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}

function safe<T>(read: () => T): T {
  try {
    return read();
  } catch {
    return unavailable();
  }
}

const fields = [
  "purpose",
  "operationReference",
  "admissionReference",
  "predecessor",
  "candidate",
  "recoverySelectorHash",
  "revision",
  "status",
  "preparedAt",
  "expiresAt",
  "acknowledgedAt",
  "activatedAt",
] as const;

const immutableContext = (record: GuestSessionRecord) => {
  const session = record.session;
  return JSON.stringify([
    session.brandReference,
    session.storeReference,
    session.publicStoreReference,
    session.publicTableReference,
    session.channel,
    session.locale,
    session.qrReference,
    session.qrRevocationVersion,
  ]);
};

export function parseGuestDiningBindingPreparation(value: unknown): GuestDiningBindingPreparation {
  return safe(() => {
    const raw = readClosedRecord(value, fields);
    const predecessor = createGuestSessionRecord(raw.predecessor);
    const candidate = createGuestSessionRecord(raw.candidate);
    const operationReference = parseGuestOperationReference(raw.operationReference);
    const admissionReference = parseGuestDiningAdmissionReference(raw.admissionReference);
    const recoverySelectorHash = parseGuestSelectorHash(raw.recoverySelectorHash);
    const preparedAt = parseCanonicalInstant(raw.preparedAt);
    const expiresAt = parseCanonicalInstant(raw.expiresAt);
    const acknowledgedAt =
      raw.acknowledgedAt === null ? null : parseCanonicalInstant(raw.acknowledgedAt);
    const activatedAt = raw.activatedAt === null ? null : parseCanonicalInstant(raw.activatedAt);
    const prior = assertGuestSessionUsable(predecessor.session, preparedAt);
    const next = assertGuestSessionUsable(candidate.session, preparedAt);
    if (
      raw.purpose !== "DiningSessionBinding" ||
      prior.channel !== "DineIn" ||
      prior.diningState !== "ContextOnly" ||
      next.diningState !== "DiningBound" ||
      immutableContext(predecessor) !== immutableContext(candidate) ||
      next.sessionReference === prior.sessionReference ||
      next.version !== 1 ||
      next.rotatedFromGuestSessionReference !== prior.sessionReference ||
      next.createdAt !== preparedAt ||
      next.lastSeenAt !== preparedAt ||
      next.orderClosedAt !== null ||
      next.closureExpiresAt !== null ||
      Date.parse(next.idleExpiresAt) !== Date.parse(preparedAt) + 4 * 60 * 60 * 1000 ||
      Date.parse(next.absoluteExpiresAt) !== Date.parse(preparedAt) + 24 * 60 * 60 * 1000 ||
      candidate.operationReference !== operationReference ||
      new Set([
        predecessor.sessionSelectorHash,
        predecessor.csrfSelectorHash,
        candidate.sessionSelectorHash,
        candidate.csrfSelectorHash,
        recoverySelectorHash,
      ]).size !== 5 ||
      Date.parse(expiresAt) <= Date.parse(preparedAt) ||
      Date.parse(expiresAt) >
        Math.min(
          Date.parse(preparedAt) + 15 * 60 * 1000,
          Date.parse(prior.idleExpiresAt),
          Date.parse(prior.absoluteExpiresAt),
          prior.closureExpiresAt === null ? Infinity : Date.parse(prior.closureExpiresAt),
        ) ||
      (raw.status !== "Prepared" && raw.status !== "Acknowledged" && raw.status !== "Activated") ||
      raw.revision !== (raw.status === "Prepared" ? 1 : raw.status === "Acknowledged" ? 2 : 3) ||
      (raw.status === "Prepared") !== (acknowledgedAt === null) ||
      (raw.status === "Activated") !== (activatedAt !== null) ||
      (acknowledgedAt !== null && (acknowledgedAt < preparedAt || acknowledgedAt >= expiresAt)) ||
      (activatedAt !== null &&
        (acknowledgedAt === null || activatedAt < acknowledgedAt || activatedAt >= expiresAt))
    )
      return unavailable();
    return Object.freeze({
      purpose: "DiningSessionBinding",
      operationReference,
      admissionReference,
      predecessor,
      candidate,
      recoverySelectorHash,
      revision: raw.revision as number,
      status: raw.status as GuestDiningBindingPreparation["status"],
      preparedAt,
      expiresAt,
      acknowledgedAt,
      activatedAt,
    });
  });
}

export function prepareGuestDiningBinding(input: {
  readonly operationReference: string;
  readonly admissionReference: string;
  readonly predecessor: GuestSessionRecord;
  readonly candidate: GuestSessionRecord;
  readonly recoverySelectorHash: GuestSelectorHash;
  readonly preparedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
}): GuestDiningBindingPreparation {
  return safe(() =>
    parseGuestDiningBindingPreparation({
      ...readClosedRecord(input, [
        "operationReference",
        "admissionReference",
        "predecessor",
        "candidate",
        "recoverySelectorHash",
        "preparedAt",
        "expiresAt",
      ]),
      purpose: "DiningSessionBinding",
      revision: 1,
      status: "Prepared",
      acknowledgedAt: null,
      activatedAt: null,
    }),
  );
}

function currentAuthority(
  preparation: GuestDiningBindingPreparation,
  current: GuestSessionRecord,
  observedAt: CanonicalInstant,
) {
  const record = createGuestSessionRecord(current);
  assertGuestSessionUsable(record.session, observedAt);
  if (
    observedAt < preparation.preparedAt ||
    observedAt >= preparation.expiresAt ||
    JSON.stringify(record) !== JSON.stringify(preparation.predecessor)
  )
    unavailable();
}

function possession(
  preparation: GuestDiningBindingPreparation,
  input: GuestDiningBindingProof,
  equals: GuestDiningBindingHashEquals,
) {
  const proof = readClosedRecord(input, [
    "sessionSelectorHash",
    "csrfSelectorHash",
    "recoverySelectorHash",
  ]);
  const checks = [
    equals(
      parseGuestSelectorHash(proof.sessionSelectorHash),
      preparation.candidate.sessionSelectorHash,
    ),
    equals(parseGuestSelectorHash(proof.csrfSelectorHash), preparation.candidate.csrfSelectorHash),
    equals(parseGuestSelectorHash(proof.recoverySelectorHash), preparation.recoverySelectorHash),
  ];
  if (checks.some((matched) => matched !== true)) unavailable();
}

export function acknowledgeGuestDiningBinding(
  input: {
    readonly preparation: GuestDiningBindingPreparation;
    readonly current: GuestSessionRecord;
    readonly proof: GuestDiningBindingProof;
    readonly observedAt: CanonicalInstant;
  },
  equals: GuestDiningBindingHashEquals,
): GuestDiningBindingPreparation {
  return safe(() => {
    const command = readClosedRecord(input, [
      "preparation",
      "current",
      "proof",
      "observedAt",
    ]) as unknown as typeof input;
    const preparation = parseGuestDiningBindingPreparation(command.preparation);
    const at = parseCanonicalInstant(command.observedAt);
    currentAuthority(preparation, command.current, at);
    possession(preparation, command.proof, equals);
    if (preparation.status === "Activated") return unavailable();
    if (preparation.status === "Acknowledged") {
      if (preparation.acknowledgedAt === null || at < preparation.acknowledgedAt)
        return unavailable();
      return preparation;
    }
    return parseGuestDiningBindingPreparation({
      ...preparation,
      revision: 2,
      status: "Acknowledged",
      acknowledgedAt: at,
    });
  });
}

/** The owner repository must commit this entire plan with Audit and exact CAS, or roll it all back. */
export function activateGuestDiningBinding(
  input: {
    readonly preparation: GuestDiningBindingPreparation;
    readonly current: GuestSessionRecord;
    readonly proof: GuestDiningBindingProof;
    readonly ownerEvidence: GuestDiningBindingOwnerEvidence;
    readonly observedAt: CanonicalInstant;
  },
  equals: GuestDiningBindingHashEquals,
) {
  return safe(() => {
    const command = readClosedRecord(input, [
      "preparation",
      "current",
      "proof",
      "ownerEvidence",
      "observedAt",
    ]) as unknown as typeof input;
    const preparation = parseGuestDiningBindingPreparation(command.preparation);
    const at = parseCanonicalInstant(command.observedAt);
    currentAuthority(preparation, command.current, at);
    possession(preparation, command.proof, equals);
    if (
      preparation.status !== "Acknowledged" ||
      preparation.acknowledgedAt === null ||
      at < preparation.acknowledgedAt
    )
      return unavailable();
    const evidence = parseGuestDiningAdmissionEvidence(command.ownerEvidence);
    const candidate = preparation.candidate;
    if (
      evidence.guestSessionReference !== preparation.predecessor.session.sessionReference ||
      evidence.operationReference !== preparation.operationReference ||
      evidence.admissionReference !== preparation.admissionReference ||
      evidence.storeReference !== candidate.session.storeReference ||
      evidence.publicTableReference !== candidate.session.publicTableReference ||
      evidence.diningSessionReference !== candidate.session.diningSessionReference ||
      evidence.diningParticipantReference !== candidate.session.diningParticipantReference ||
      evidence.evaluatedAt < preparation.acknowledgedAt ||
      evidence.evaluatedAt > at ||
      evidence.validUntil <= at
    )
      return unavailable();
    const activated = parseGuestDiningBindingPreparation({
      ...preparation,
      revision: 3,
      status: "Activated",
      activatedAt: at,
    });
    const revoked = createGuestSessionRecord({
      ...preparation.predecessor,
      session: {
        ...preparation.predecessor.session,
        status: "Revoked",
        version: preparation.predecessor.session.version + 1,
        revocationReason: "BindingChanged",
        revokedAt: at,
      },
    });
    return Object.freeze({
      preparation: activated,
      revoked,
      candidate,
      expectedPreparationRevision: preparation.revision,
      expectedPredecessorVersion: preparation.predecessor.session.version,
    });
  });
}

/** Authenticates candidate continuity only; later Dining commands still require current Dining authority. */
export function completeGuestDiningBinding(
  input: {
    readonly preparation: GuestDiningBindingPreparation;
    readonly current: GuestSessionRecord;
    readonly sessionSelectorHash: GuestSelectorHash;
    readonly csrfSelectorHash: GuestSelectorHash;
    readonly observedAt: CanonicalInstant;
  },
  equals: GuestDiningBindingHashEquals,
) {
  return safe(() => {
    const command = readClosedRecord(input, [
      "preparation",
      "current",
      "sessionSelectorHash",
      "csrfSelectorHash",
      "observedAt",
    ]) as unknown as typeof input;
    const preparation = parseGuestDiningBindingPreparation(command.preparation);
    const at = parseCanonicalInstant(command.observedAt);
    const current = createGuestSessionRecord(command.current);
    assertGuestSessionUsable(current.session, at);
    const candidate = preparation.candidate;
    const checks = [
      equals(parseGuestSelectorHash(command.sessionSelectorHash), current.sessionSelectorHash),
      equals(parseGuestSelectorHash(command.csrfSelectorHash), current.csrfSelectorHash),
    ];
    if (
      preparation.status !== "Activated" ||
      preparation.activatedAt === null ||
      at < preparation.activatedAt ||
      current.session.sessionReference !== candidate.session.sessionReference ||
      immutableContext(current) !== immutableContext(candidate) ||
      current.session.diningState !== "DiningBound" ||
      current.session.diningSessionReference === null ||
      current.session.diningParticipantReference === null ||
      current.session.diningSessionReference !== candidate.session.diningSessionReference ||
      current.session.diningParticipantReference !== candidate.session.diningParticipantReference ||
      current.sessionSelectorHash !== candidate.sessionSelectorHash ||
      current.csrfSelectorHash !== candidate.csrfSelectorHash ||
      checks.some((matched) => matched !== true)
    )
      return unavailable();
    return Object.freeze({
      operationReference: preparation.operationReference,
      admissionReference: preparation.admissionReference,
      sessionReference: current.session.sessionReference,
      brandReference: current.session.brandReference,
      storeReference: current.session.storeReference,
      diningSessionReference: current.session.diningSessionReference,
      diningParticipantReference: current.session.diningParticipantReference,
      activatedAt: preparation.activatedAt,
    });
  });
}
