import { validateAuditRecord } from "@bop/audit";

import {
  createWaitlistEntry,
  recordWaitlistNotificationOutcome,
  reviseWaitEstimate,
  reviseWaitlistEntry,
  reviseWaitPriority,
  transitionWaitlistEntry,
} from "../domain/waitlist.js";
import {
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  type ReservationCode,
  type ReservationInstant,
  type ReservationReference,
} from "../domain/reservation.js";
import type {
  WaitlistAction,
  WaitlistAuthorizationEvidence,
  WaitlistFutureEvent,
  WaitlistOperationRecord,
  WaitlistPorts,
} from "./ports/waitlist-ports.js";

export type WaitlistWorkflowErrorCode =
  | "WAITLIST_INPUT_INVALID"
  | "WAITLIST_PERMISSION_DENIED"
  | "WAITLIST_VERSION_CONFLICT"
  | "WAITLIST_IDEMPOTENCY_CONFLICT"
  | "WAITLIST_LIFECYCLE_CONFLICT"
  | "WAITLIST_DEPENDENCY_UNAVAILABLE";

export class WaitlistWorkflowError extends Error {
  constructor(readonly code: WaitlistWorkflowErrorCode) {
    super("Waitlist operation is unavailable");
    this.name = "WaitlistWorkflowError";
  }
}

const dependency = (): never => {
  throw new WaitlistWorkflowError("WAITLIST_DEPENDENCY_UNAVAILABLE");
};
const actionValues = [
  "Join",
  "CheckIn",
  "Call",
  "MarkReady",
  "MarkMissed",
  "RestoreWaiting",
  "RestoreCheckedIn",
  "Revise",
  "UpdateEstimate",
  "OverridePriority",
  "RecordNotificationOutcome",
  "Cancel",
  "Expire",
  "ExtendReady",
  "RecordSeated",
] as const;
const actions = new Set<WaitlistAction>(actionValues);
const eventType: Partial<Record<WaitlistAction, WaitlistFutureEvent["eventType"]>> = {
  Join: "WaitlistEntryJoined",
  CheckIn: "WaitlistEntryCheckedIn",
  Call: "WaitlistEntryCalled",
  MarkReady: "WaitlistEntryReady",
  MarkMissed: "WaitlistEntryMissed",
  RestoreWaiting: "WaitlistEntryRestored",
  RestoreCheckedIn: "WaitlistEntryRestored",
  UpdateEstimate: "EstimatedWaitChanged",
  Cancel: "WaitlistEntryCancelled",
  Expire: "WaitlistEntryExpired",
  RecordSeated: "WaitlistEntrySeated",
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
    throw new WaitlistWorkflowError("WAITLIST_INPUT_INVALID");
  }
}

function input<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new WaitlistWorkflowError("WAITLIST_INPUT_INVALID");
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
  evidence: WaitlistAuthorizationEvidence | null,
  expected: {
    readonly action: WaitlistAction;
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
      evidence.purpose !== "waitlist-management" ||
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
      audit.actionCode !== `WAITLIST_${expected.action.toUpperCase()}` ||
      audit.targetType !== "WaitlistEntry" ||
      audit.targetId !== expected.targetReference ||
      audit.occurredAt !== expected.observedAt
    )
      throw new Error("denied");
    return Object.freeze({ audit, actorReference: evidence.actorReference });
  } catch {
    throw new WaitlistWorkflowError("WAITLIST_PERMISSION_DENIED");
  }
}

function parseEvidence(value: unknown) {
  if (value === null) return null;
  const raw = closed(value, [
    "reasonCode",
    "evidenceReference",
    "deadline",
    "eligibleAt",
    "notificationRequestReference",
    "diningSessionReference",
  ]);
  const optionalCode = (candidate: unknown) =>
    candidate === null ? null : input(() => parseReservationCode(candidate));
  const optionalReference = (candidate: unknown) =>
    candidate === null ? null : input(() => parseReservationReference(candidate));
  const optionalInstant = (candidate: unknown) =>
    candidate === null ? null : input(() => parseReservationInstant(candidate));
  return Object.freeze({
    reasonCode: optionalCode(raw.reasonCode),
    evidenceReference: optionalReference(raw.evidenceReference),
    deadline: optionalInstant(raw.deadline),
    eligibleAt: optionalInstant(raw.eligibleAt),
    notificationRequestReference: optionalReference(raw.notificationRequestReference),
    diningSessionReference: optionalReference(raw.diningSessionReference),
  });
}

function evidenceValid(action: WaitlistAction, evidence: ReturnType<typeof parseEvidence>) {
  const populated = (key: keyof NonNullable<typeof evidence>) => evidence?.[key] !== null;
  if (action === "CheckIn") return evidence === null;
  if (evidence === null) return false;
  const expected: Partial<Record<WaitlistAction, readonly (keyof typeof evidence)[]>> = {
    Join: ["evidenceReference"],
    Call: ["deadline", "notificationRequestReference"],
    MarkReady: ["deadline"],
    MarkMissed: ["reasonCode"],
    RestoreWaiting: ["reasonCode"],
    RestoreCheckedIn: ["reasonCode"],
    Revise: ["reasonCode", "evidenceReference"],
    UpdateEstimate: ["reasonCode", "evidenceReference"],
    OverridePriority: ["reasonCode", "evidenceReference"],
    RecordNotificationOutcome: ["evidenceReference"],
    Cancel: ["reasonCode"],
    Expire: ["reasonCode", "eligibleAt"],
    ExtendReady: ["reasonCode", "deadline"],
    RecordSeated: ["evidenceReference", "diningSessionReference"],
  };
  const required = expected[action] ?? [];
  return (
    required.every(populated) &&
    (
      [
        "reasonCode",
        "evidenceReference",
        "deadline",
        "eligibleAt",
        "notificationRequestReference",
        "diningSessionReference",
      ] as const
    ).every((key) => required.includes(key) || !populated(key))
  );
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("evidence");
  return value;
}

export function createWaitlistService(ports: WaitlistPorts) {
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
      if (typeof raw.action !== "string" || !actions.has(raw.action as WaitlistAction))
        throw new WaitlistWorkflowError("WAITLIST_INPUT_INVALID");
      const action = raw.action as WaitlistAction;
      const operationReference = input(() => parseReservationReference(raw.operationReference));
      const candidate = input(() => createWaitlistEntry(raw.candidate));
      const observedAt = input(() => parseReservationInstant(raw.observedAt));
      const commandEvidence = parseEvidence(raw.evidence);
      if (
        candidate.observedAt !== observedAt ||
        !evidenceValid(action, commandEvidence) ||
        (action === "Join" && raw.expectedAggregateVersion !== null) ||
        (action !== "Join" &&
          (!Number.isSafeInteger(raw.expectedAggregateVersion) ||
            (raw.expectedAggregateVersion as number) < 1))
      )
        throw new WaitlistWorkflowError("WAITLIST_INPUT_INVALID");
      let intentDigest: string;
      try {
        intentDigest = ports.references.hashIntent(JSON.stringify(raw));
      } catch {
        return dependency();
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(intentDigest)) return dependency();
      const authorization = await ports.authorization
        .authorize({ action, targetReference: candidate.waitlistEntryReference, observedAt })
        .catch(dependency);
      const authorized = authorize(authorization, {
        action,
        targetReference: candidate.waitlistEntryReference,
        tenantReference: candidate.tenantReference,
        brandReference: candidate.brandReference,
        storeReference: candidate.storeReference,
        observedAt,
      });
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.intentDigest, intentDigest))
          throw new WaitlistWorkflowError("WAITLIST_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, entry: prior.entry });
      }
      const loaded = await ports.repository
        .load(candidate.waitlistEntryReference)
        .catch(dependency);
      const current = loaded === null ? null : state(() => createWaitlistEntry(loaded));
      let revision: WaitlistOperationRecord["revision"] = null;
      if (action === "Join") {
        if (
          current !== null ||
          !["Waiting", "CheckedIn"].includes(candidate.status) ||
          (candidate.joinMode === "Remote" && candidate.status !== "Waiting") ||
          (candidate.joinMode === "WalkIn" && candidate.status !== "CheckedIn") ||
          candidate.aggregateVersion !== 1 ||
          candidate.revisionNumber !== 1 ||
          candidate.priorityKind !== "Default" ||
          candidate.joinedAt !== observedAt ||
          candidate.createdAt !== observedAt ||
          candidate.calledAt !== null ||
          candidate.responseDeadline !== null ||
          candidate.readyAt !== null ||
          candidate.readyExpiresAt !== null ||
          candidate.readyExtensionUsed ||
          candidate.notificationStatus !== "NotRequested" ||
          candidate.notificationRequestReference !== null ||
          candidate.diningSessionReference !== null ||
          candidate.terminalReasonCode !== null ||
          (candidate.status === "Waiting" && candidate.checkedInAt !== null) ||
          (candidate.status === "CheckedIn" && candidate.checkedInAt !== observedAt)
        )
          throw new WaitlistWorkflowError("WAITLIST_LIFECYCLE_CONFLICT");
        const valid = await ports.collaborators
          .validateJoin({
            candidate,
            evidenceReference: required(commandEvidence?.evidenceReference),
          })
          .catch(dependency);
        if (!valid) throw new WaitlistWorkflowError("WAITLIST_LIFECYCLE_CONFLICT");
      } else {
        if (current === null || raw.expectedAggregateVersion !== current.aggregateVersion)
          throw new WaitlistWorkflowError("WAITLIST_VERSION_CONFLICT");
        try {
          if (action === "Revise") {
            const result = reviseWaitlistEntry(current, candidate, {
              revisionReference: required(commandEvidence?.evidenceReference),
              reasonCode: required(commandEvidence?.reasonCode),
              actorReference: authorized.actorReference,
              observedAt,
            });
            revision = result.revision;
          } else if (action === "UpdateEstimate") {
            const valid = await ports.collaborators
              .validateEstimate({
                current,
                candidate,
                evidenceReference: required(commandEvidence?.evidenceReference),
              })
              .catch(dependency);
            if (!valid) throw new Error("estimate");
            const result = reviseWaitEstimate(current, candidate, {
              estimateRevisionReference: required(commandEvidence?.evidenceReference),
              reasonCode: required(commandEvidence?.reasonCode),
              actorReference: authorized.actorReference,
              observedAt,
            });
            revision = result.revision;
          } else if (action === "OverridePriority") {
            const valid = await ports.collaborators
              .validatePriority({
                current,
                candidate,
                evidenceReference: required(commandEvidence?.evidenceReference),
              })
              .catch(dependency);
            if (!valid) throw new Error("priority");
            const result = reviseWaitPriority(current, candidate, {
              priorityRevisionReference: required(commandEvidence?.evidenceReference),
              reasonCode: required(commandEvidence?.reasonCode),
              actorReference: authorized.actorReference,
              observedAt,
            });
            revision = result.revision;
          } else if (action === "RecordNotificationOutcome") {
            const valid = await ports.collaborators
              .validateNotificationOutcome({
                current,
                candidate,
                evidenceReference: required(commandEvidence?.evidenceReference),
              })
              .catch(dependency);
            if (!valid) throw new Error("notification");
            recordWaitlistNotificationOutcome(current, candidate, observedAt);
          } else {
            if (action === "RecordSeated") {
              const valid = await ports.collaborators
                .validateDiningResult({
                  current,
                  candidate,
                  evidenceReference: required(commandEvidence?.evidenceReference),
                })
                .catch(dependency);
              if (!valid) throw new Error("dining");
            }
            const expected = transitionWaitlistEntry(current, action, {
              observedAt,
              reasonCode: commandEvidence?.reasonCode as ReservationCode | null,
              deadline: commandEvidence?.deadline as ReservationInstant | null,
              eligibleAt: commandEvidence?.eligibleAt as ReservationInstant | null,
              notificationRequestReference:
                commandEvidence?.notificationRequestReference as ReservationReference | null,
              diningSessionReference:
                commandEvidence?.diningSessionReference as ReservationReference | null,
            });
            if (action === "Expire" && commandEvidence?.eligibleAt !== current.maxWaitExpiresAt)
              throw new Error("expiry");
            if (!same(candidate, expected)) throw new Error("candidate");
          }
        } catch (error) {
          if (error instanceof WaitlistWorkflowError) throw error;
          throw new WaitlistWorkflowError("WAITLIST_LIFECYCLE_CONFLICT");
        }
      }
      const mappedEvent = eventType[action];
      const record: WaitlistOperationRecord = Object.freeze({
        operationReference,
        intentDigest,
        entry: candidate,
        revision,
        reasonCode: commandEvidence?.reasonCode ?? null,
        collaborationEvidenceReference: commandEvidence?.evidenceReference ?? null,
        audit: authorized.audit,
        event:
          mappedEvent === undefined
            ? null
            : Object.freeze({
                eventType: mappedEvent,
                waitlistEntryReference: candidate.waitlistEntryReference,
                aggregateVersion: candidate.aggregateVersion.toString(),
                status: candidate.status,
                occurredAt: observedAt,
              }),
      });
      await ports.repository.commit(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, entry: candidate });
    },
  });
}
