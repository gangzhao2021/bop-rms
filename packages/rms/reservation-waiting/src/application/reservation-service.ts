import { validateAuditRecord } from "@bop/audit";

import {
  createReservation,
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  reviseReservation,
  transitionReservation,
  type ReservationCode,
  type ReservationReference,
} from "../domain/reservation.js";
import type {
  ReservationAction,
  ReservationAuthorizationEvidence,
  ReservationFutureEvent,
  ReservationOperationRecord,
  ReservationPorts,
} from "./ports/reservation-ports.js";

export type ReservationWorkflowErrorCode =
  | "RESERVATION_INPUT_INVALID"
  | "RESERVATION_PERMISSION_DENIED"
  | "RESERVATION_VERSION_CONFLICT"
  | "RESERVATION_IDEMPOTENCY_CONFLICT"
  | "RESERVATION_LIFECYCLE_CONFLICT"
  | "RESERVATION_DEPENDENCY_UNAVAILABLE";

export class ReservationWorkflowError extends Error {
  constructor(readonly code: ReservationWorkflowErrorCode) {
    super("Reservation operation is unavailable");
    this.name = "ReservationWorkflowError";
  }
}

const dependency = (): never => {
  throw new ReservationWorkflowError("RESERVATION_DEPENDENCY_UNAVAILABLE");
};
const actions = new Set<ReservationAction>([
  "Create",
  "Revise",
  "Confirm",
  "CheckIn",
  "Cancel",
  "MarkNoShow",
  "Expire",
  "RecordSeated",
]);
const eventType: Record<ReservationAction, ReservationFutureEvent["eventType"]> = {
  Create: "ReservationCreated",
  Revise: "ReservationRevised",
  Confirm: "ReservationConfirmed",
  CheckIn: "ReservationCheckedIn",
  Cancel: "ReservationCancelled",
  MarkNoShow: "ReservationNoShowRecorded",
  Expire: "ReservationExpired",
  RecordSeated: "ReservationSeated",
};

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
      throw new Error("invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new Error("invalid");
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new ReservationWorkflowError("RESERVATION_INPUT_INVALID");
  }
}

function input<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new ReservationWorkflowError("RESERVATION_INPUT_INVALID");
  }
}
function state<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    return dependency();
  }
}

function authorize(
  evidence: ReservationAuthorizationEvidence | null,
  expected: {
    readonly action: ReservationAction;
    readonly targetReference: ReservationReference;
    readonly tenantReference: ReservationReference;
    readonly brandReference: ReservationReference;
    readonly storeReference: ReservationReference;
    readonly observedAt: string;
  },
) {
  try {
    if (evidence === null) throw new Error("denied");
    const audit = validateAuditRecord(evidence.audit, Date.parse(expected.observedAt));
    if (
      evidence.purpose !== "reservation-management" ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== "dining.operate" ||
      evidence.permission.scopeKind !== "Store" ||
      evidence.tenantReference !== expected.tenantReference ||
      evidence.brandReference !== expected.brandReference ||
      evidence.storeReference !== expected.storeReference ||
      audit.brandId !== expected.brandReference ||
      audit.storeId !== expected.storeReference ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== evidence.actorReference ||
      audit.actionCode !== `RESERVATION_${expected.action.toUpperCase()}` ||
      audit.targetType !== "Reservation" ||
      audit.targetId !== expected.targetReference ||
      audit.occurredAt !== expected.observedAt
    )
      throw new Error("denied");
    return Object.freeze({ audit, actorReference: evidence.actorReference });
  } catch {
    throw new ReservationWorkflowError("RESERVATION_PERMISSION_DENIED");
  }
}

function parseEvidence(value: unknown) {
  if (value === null) return null;
  const raw = closed(value, ["revisionReference", "reasonCode", "critical", "noShowEligibleAt"]);
  if (typeof raw.critical !== "boolean")
    throw new ReservationWorkflowError("RESERVATION_INPUT_INVALID");
  return Object.freeze({
    revisionReference:
      raw.revisionReference === null
        ? null
        : input(() => parseReservationReference(raw.revisionReference)),
    reasonCode: raw.reasonCode === null ? null : input(() => parseReservationCode(raw.reasonCode)),
    critical: raw.critical,
    noShowEligibleAt:
      raw.noShowEligibleAt === null
        ? null
        : input(() => parseReservationInstant(raw.noShowEligibleAt)),
  });
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createReservationService(ports: ReservationPorts) {
  return Object.freeze({
    async execute(value: unknown) {
      const raw = closed(value, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "evidence",
        "observedAt",
      ]);
      if (typeof raw.action !== "string" || !actions.has(raw.action as ReservationAction))
        throw new ReservationWorkflowError("RESERVATION_INPUT_INVALID");
      const action = raw.action as ReservationAction;
      const operationReference = input(() => parseReservationReference(raw.operationReference));
      const candidate = input(() => createReservation(raw.candidate));
      const observedAt = input(() => parseReservationInstant(raw.observedAt));
      const commandEvidence = parseEvidence(raw.evidence);
      const revisionEvidenceValid =
        action === "Revise" &&
        commandEvidence !== null &&
        commandEvidence.revisionReference !== null &&
        commandEvidence.reasonCode !== null &&
        commandEvidence.noShowEligibleAt === null;
      const noShowEvidenceValid =
        action === "MarkNoShow" &&
        commandEvidence !== null &&
        commandEvidence.revisionReference === null &&
        commandEvidence.reasonCode === null &&
        commandEvidence.critical === false &&
        commandEvidence.noShowEligibleAt !== null;
      const noEvidenceValid =
        !["Revise", "MarkNoShow"].includes(action) && commandEvidence === null;
      if (
        candidate.observedAt !== observedAt ||
        (!revisionEvidenceValid && !noShowEvidenceValid && !noEvidenceValid) ||
        (action === "Create" && raw.expectedAggregateVersion !== null) ||
        (action !== "Create" &&
          (!Number.isSafeInteger(raw.expectedAggregateVersion) ||
            (raw.expectedAggregateVersion as number) < 1))
      )
        throw new ReservationWorkflowError("RESERVATION_INPUT_INVALID");
      let intentDigest: string;
      try {
        intentDigest = ports.references.hashIntent(JSON.stringify(raw));
      } catch {
        return dependency();
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(intentDigest)) return dependency();
      const authorization = await ports.authorization
        .authorize({ action, targetReference: candidate.reservationReference, observedAt })
        .catch(dependency);
      const authorized = authorize(authorization, {
        action,
        targetReference: candidate.reservationReference,
        tenantReference: candidate.tenantReference,
        brandReference: candidate.brandReference,
        storeReference: candidate.storeReference,
        observedAt,
      });
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.intentDigest, intentDigest))
          throw new ReservationWorkflowError("RESERVATION_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, reservation: prior.reservation });
      }
      const loaded = await ports.repository.load(candidate.reservationReference).catch(dependency);
      const current = loaded === null ? null : state(() => createReservation(loaded));
      let revision = null;
      if (action === "Create") {
        if (
          current !== null ||
          candidate.status !== "Pending" ||
          candidate.aggregateVersion !== 1 ||
          candidate.revisionNumber !== 1 ||
          commandEvidence !== null
        )
          throw new ReservationWorkflowError("RESERVATION_LIFECYCLE_CONFLICT");
      } else {
        if (current === null || raw.expectedAggregateVersion !== current.aggregateVersion)
          throw new ReservationWorkflowError("RESERVATION_VERSION_CONFLICT");
        try {
          if (action === "Revise") {
            if (
              commandEvidence?.revisionReference === null ||
              commandEvidence?.revisionReference === undefined ||
              commandEvidence.reasonCode === null
            )
              throw new Error("evidence");
            const result = reviseReservation(current, candidate, {
              revisionReference: commandEvidence.revisionReference,
              reasonCode: commandEvidence.reasonCode,
              actorReference: authorized.actorReference,
              observedAt,
              critical: commandEvidence.critical,
            });
            revision = result.revision;
          } else {
            const expected = transitionReservation(current, action, {
              observedAt,
              reasonCode: candidate.terminalReasonCode as ReservationCode | null,
              diningSessionReference: candidate.diningSessionReference,
              noShowEligibleAt: commandEvidence?.noShowEligibleAt ?? null,
            });
            if (!same(candidate, expected)) throw new Error("candidate");
          }
        } catch {
          throw new ReservationWorkflowError("RESERVATION_LIFECYCLE_CONFLICT");
        }
      }
      const record: ReservationOperationRecord = Object.freeze({
        operationReference,
        intentDigest,
        reservation: candidate,
        revision,
        audit: authorized.audit,
        event: Object.freeze({
          eventType: eventType[action],
          reservationReference: candidate.reservationReference,
          aggregateVersion: candidate.aggregateVersion.toString(),
          status: candidate.status,
          occurredAt: observedAt,
        }),
      });
      await ports.repository.commit(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, reservation: candidate });
    },
  });
}
