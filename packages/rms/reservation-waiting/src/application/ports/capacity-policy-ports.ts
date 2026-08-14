import type { AppendAuditRecordInput } from "@bop/audit";

import type {
  CapacityPolicyRevision,
  CapacityPolicyVersion,
  CapacitySimulationScenario,
} from "../../domain/capacity-policy.js";
import type {
  ReservationCode,
  ReservationInstant,
  ReservationReference,
} from "../../domain/reservation.js";

export type CapacityPolicyAction = "SaveDraft" | "Revise" | "Publish" | "Schedule" | "Simulate";

export interface CapacityPolicyAuthorizationEvidence {
  readonly tenantReference: ReservationReference;
  readonly brandReference: ReservationReference;
  readonly storeReference: ReservationReference;
  readonly actorReference: ReservationReference;
  readonly purpose: "reservation-capacity-management";
  readonly permission: {
    readonly effect: "Allow";
    readonly action: "dining.operate";
    readonly scopeKind: "Store";
  };
  readonly audit: unknown;
}

export interface CapacityPolicyOperationRecord {
  readonly operationReference: ReservationReference;
  readonly policyReference: ReservationReference;
  readonly versionReference: ReservationReference;
  readonly action: Exclude<CapacityPolicyAction, "Simulate">;
  readonly expectedAggregateVersion: number | null;
  readonly resultAggregateVersion: number;
  readonly intentDigest: string;
  readonly reasonCode: ReservationCode | null;
  readonly publicationEvidenceReference: ReservationReference | null;
  readonly committedAt: ReservationInstant;
}

export interface CapacityPolicyPublicationEvidence {
  readonly policyReference: ReservationReference;
  readonly versionReference: ReservationReference;
  readonly evidenceReference: ReservationReference;
  readonly blockingCodes: readonly never[];
  readonly observedAt: ReservationInstant;
}

export interface CapacityPolicyPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: CapacityPolicyAction;
      readonly targetReference: ReservationReference;
      readonly observedAt: ReservationInstant;
    }): Promise<CapacityPolicyAuthorizationEvidence | null>;
  };
  readonly evidence: {
    validatePublication(
      policy: CapacityPolicyVersion,
      observedAt: ReservationInstant,
    ): Promise<CapacityPolicyPublicationEvidence>;
    resolveSimulationScenario(
      policy: CapacityPolicyVersion,
      request: unknown,
      observedAt: ReservationInstant,
    ): Promise<CapacitySimulationScenario>;
  };
  readonly references: {
    hashIntent(canonicalIntent: string): string;
  };
  readonly repository: {
    findOperation(
      operationReference: ReservationReference,
    ): Promise<CapacityPolicyOperationRecord | null>;
    getCurrent(policyReference: ReservationReference): Promise<CapacityPolicyVersion | null>;
    getVersion(versionReference: ReservationReference): Promise<CapacityPolicyVersion | null>;
    commit(input: {
      readonly previous: CapacityPolicyVersion | null;
      readonly policy: CapacityPolicyVersion;
      readonly revision: CapacityPolicyRevision | null;
      readonly operation: CapacityPolicyOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<void>;
  };
}
