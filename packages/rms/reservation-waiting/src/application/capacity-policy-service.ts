import { validateAuditRecord } from "@bop/audit";

import {
  createCapacityPolicy,
  reviseCapacityPolicy,
  simulateCapacityPolicy,
  transitionCapacityPolicy,
  type CapacityPolicyVersion,
} from "../domain/capacity-policy.js";
import {
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  type ReservationReference,
} from "../domain/reservation.js";
import type {
  CapacityPolicyAction,
  CapacityPolicyAuthorizationEvidence,
  CapacityPolicyOperationRecord,
  CapacityPolicyPorts,
  CapacityPolicyPublicationEvidence,
} from "./ports/capacity-policy-ports.js";

export type CapacityPolicyWorkflowErrorCode =
  | "CAPACITY_POLICY_INPUT_INVALID"
  | "CAPACITY_POLICY_PERMISSION_DENIED"
  | "CAPACITY_POLICY_NOT_FOUND"
  | "CAPACITY_POLICY_VERSION_CONFLICT"
  | "CAPACITY_POLICY_IDEMPOTENCY_CONFLICT"
  | "CAPACITY_POLICY_LIFECYCLE_CONFLICT"
  | "CAPACITY_POLICY_DEPENDENCY_UNAVAILABLE";

export class CapacityPolicyWorkflowError extends Error {
  constructor(readonly code: CapacityPolicyWorkflowErrorCode) {
    super("Capacity policy operation is unavailable");
    this.name = "CapacityPolicyWorkflowError";
  }
}

const dependency = (): never => {
  throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_DEPENDENCY_UNAVAILABLE");
};
const actions = new Set<CapacityPolicyAction>(["SaveDraft", "Revise", "Publish", "Schedule"]);

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
    throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_INPUT_INVALID");
  }
}

function input<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_INPUT_INVALID");
  }
}

function state<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_LIFECYCLE_CONFLICT");
  }
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function authorize(
  evidence: CapacityPolicyAuthorizationEvidence | null,
  expected: {
    readonly action: CapacityPolicyAction;
    readonly targetReference: ReservationReference;
    readonly policy: Pick<
      CapacityPolicyVersion,
      "tenantReference" | "brandReference" | "storeReference"
    >;
    readonly observedAt: string;
  },
) {
  try {
    if (evidence === null) throw new Error("denied");
    const audit = validateAuditRecord(evidence.audit, Date.parse(expected.observedAt));
    if (
      evidence.purpose !== "reservation-capacity-management" ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== "dining.operate" ||
      evidence.permission.scopeKind !== "Store" ||
      evidence.tenantReference !== expected.policy.tenantReference ||
      evidence.brandReference !== expected.policy.brandReference ||
      evidence.storeReference !== expected.policy.storeReference ||
      audit.brandId !== expected.policy.brandReference ||
      audit.storeId !== expected.policy.storeReference ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== evidence.actorReference ||
      audit.actionCode !== `CAPACITY_POLICY_${expected.action.toUpperCase()}` ||
      audit.targetType !== "CapacityPolicy" ||
      audit.targetId !== expected.targetReference ||
      audit.occurredAt !== expected.observedAt
    )
      throw new Error("denied");
    return Object.freeze({ audit, actorReference: evidence.actorReference });
  } catch {
    throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_PERMISSION_DENIED");
  }
}

function publicationEvidence(
  evidence: CapacityPolicyPublicationEvidence,
  policy: CapacityPolicyVersion,
  observedAt: string,
) {
  try {
    if (
      evidence.policyReference !== policy.policyReference ||
      evidence.versionReference !== policy.versionReference ||
      evidence.observedAt !== observedAt ||
      evidence.blockingCodes.length !== 0
    )
      throw new Error("invalid");
    return parseReservationReference(evidence.evidenceReference);
  } catch {
    return dependency();
  }
}

export function createCapacityPolicyService(ports: CapacityPolicyPorts) {
  return Object.freeze({
    async execute(value: unknown) {
      const raw = closed(value, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "revisionEvidence",
        "observedAt",
      ]);
      if (typeof raw.action !== "string" || !actions.has(raw.action as CapacityPolicyAction))
        throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_INPUT_INVALID");
      const action = raw.action as Exclude<CapacityPolicyAction, "Simulate">;
      const operationReference = input(() => parseReservationReference(raw.operationReference));
      const candidate = input(() => createCapacityPolicy(raw.candidate));
      const observedAt = input(() => parseReservationInstant(raw.observedAt));
      let revisionEvidence: {
        readonly revisionReference: ReservationReference;
        readonly reasonCode: ReturnType<typeof parseReservationCode>;
      } | null = null;
      if (raw.revisionEvidence !== null) {
        const evidence = closed(raw.revisionEvidence, ["revisionReference", "reasonCode"]);
        revisionEvidence = Object.freeze({
          revisionReference: input(() => parseReservationReference(evidence.revisionReference)),
          reasonCode: input(() => parseReservationCode(evidence.reasonCode)),
        });
      }
      if (
        (["SaveDraft", "Revise"].includes(action) && candidate.observedAt !== observedAt) ||
        (action === "SaveDraft" &&
          (raw.expectedAggregateVersion !== null ||
            candidate.lifecycle !== "Draft" ||
            candidate.aggregateVersion !== 1 ||
            candidate.policyVersion !== 1 ||
            revisionEvidence !== null)) ||
        (action !== "SaveDraft" &&
          (!Number.isSafeInteger(raw.expectedAggregateVersion) ||
            (raw.expectedAggregateVersion as number) < 1)) ||
        (action === "Revise") !== (revisionEvidence !== null) ||
        (["Publish", "Schedule"].includes(action) && revisionEvidence !== null)
      )
        throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_INPUT_INVALID");
      let intentDigest: string;
      try {
        intentDigest = ports.references.hashIntent(JSON.stringify(raw));
      } catch {
        return dependency();
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(intentDigest)) return dependency();
      const authorization = await ports.authorization
        .authorize({ action, targetReference: candidate.policyReference, observedAt })
        .catch(dependency);
      const authorized = authorize(authorization, {
        action,
        targetReference: candidate.policyReference,
        policy: candidate,
        observedAt,
      });
      const replay = await ports.repository.findOperation(operationReference).catch(dependency);
      if (replay !== null) {
        if (replay.intentDigest !== intentDigest)
          throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_IDEMPOTENCY_CONFLICT");
        return replay;
      }
      const current = await ports.repository
        .getCurrent(candidate.policyReference)
        .catch(dependency);
      if (action === "SaveDraft" && current !== null)
        throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_VERSION_CONFLICT");
      if (action !== "SaveDraft") {
        if (current === null) throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_NOT_FOUND");
        if (current.aggregateVersion !== raw.expectedAggregateVersion)
          throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_VERSION_CONFLICT");
      }
      let next = candidate;
      let revision = null;
      let publicationEvidenceReference: ReservationReference | null = null;
      if (action === "Revise") {
        if (current === null || revisionEvidence === null)
          throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_LIFECYCLE_CONFLICT");
        const result = state(() =>
          reviseCapacityPolicy(current, candidate, {
            ...revisionEvidence,
            actorReference: authorized.actorReference as ReservationReference,
            observedAt,
          }),
        );
        next = result.policy;
        revision = result.revision;
      } else if (action === "Publish" || action === "Schedule") {
        if (current === null || !same(current, candidate))
          throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_VERSION_CONFLICT");
        const evidence = await ports.evidence
          .validatePublication(current, observedAt)
          .catch(dependency);
        publicationEvidenceReference = publicationEvidence(evidence, current, observedAt);
        next = state(() => transitionCapacityPolicy(current, action, observedAt));
      }
      const operation = Object.freeze({
        operationReference,
        policyReference: next.policyReference,
        versionReference: next.versionReference,
        action,
        expectedAggregateVersion:
          action === "SaveDraft" ? null : (raw.expectedAggregateVersion as number),
        resultAggregateVersion: next.aggregateVersion,
        intentDigest,
        reasonCode: revisionEvidence?.reasonCode ?? null,
        publicationEvidenceReference,
        committedAt: observedAt,
      } satisfies CapacityPolicyOperationRecord);
      await ports.repository
        .commit({ previous: current, policy: next, revision, operation, audit: authorized.audit })
        .catch(dependency);
      return operation;
    },

    async simulate(value: unknown) {
      const raw = closed(value, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "policyReference",
        "versionReference",
        "scenarioRequest",
        "observedAt",
      ]);
      const tenantReference = input(() => parseReservationReference(raw.tenantReference));
      const brandReference = input(() => parseReservationReference(raw.brandReference));
      const storeReference = input(() => parseReservationReference(raw.storeReference));
      const policyReference = input(() => parseReservationReference(raw.policyReference));
      const versionReference = input(() => parseReservationReference(raw.versionReference));
      const observedAt = input(() => parseReservationInstant(raw.observedAt));
      const authorization = await ports.authorization
        .authorize({ action: "Simulate", targetReference: policyReference, observedAt })
        .catch(dependency);
      authorize(authorization, {
        action: "Simulate",
        targetReference: policyReference,
        policy: { tenantReference, brandReference, storeReference },
        observedAt,
      });
      const policy = await ports.repository.getVersion(versionReference).catch(dependency);
      if (
        policy === null ||
        policy.policyReference !== policyReference ||
        policy.tenantReference !== tenantReference ||
        policy.brandReference !== brandReference ||
        policy.storeReference !== storeReference
      )
        throw new CapacityPolicyWorkflowError("CAPACITY_POLICY_NOT_FOUND");
      const scenario = await ports.evidence
        .resolveSimulationScenario(policy, raw.scenarioRequest, observedAt)
        .catch(dependency);
      return state(() => simulateCapacityPolicy(policy, scenario));
    },
  });
}
