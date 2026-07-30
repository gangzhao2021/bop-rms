import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TaskRecord } from "@bop/task";
import type { TenantContext } from "@bop/tenant";

import type {
  DiningClosingOperationRecord,
  DiningClosureEvidence,
} from "../../contracts/dining-closing.js";
import type {
  DiningHash,
  DiningInstant,
  DiningReference,
  DiningSession,
} from "../../contracts/dining-session.js";

export interface DiningClosingStaffEvidence {
  readonly kind: "Staff";
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export interface DiningClosingHostEvidence {
  readonly kind: "Host";
  readonly guestSessionReference: DiningReference;
  readonly participantReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly status: "CurrentHost";
  readonly observedAt: DiningInstant;
  readonly audit: AppendAuditRecordInput;
}

export type DiningClosingAuthorityEvidence = DiningClosingStaffEvidence | DiningClosingHostEvidence;

export interface DiningClosingAuthorizationPort {
  authorize(input: {
    readonly operation: "Begin" | "Cancel" | "Finalize";
    readonly session: DiningSession;
    readonly operationReference: DiningReference;
    readonly observedAt: DiningInstant;
  }): Promise<DiningClosingAuthorityEvidence | null>;
}

export interface DiningClosureEvidencePort {
  resolve(input: {
    readonly diningSessionReference: DiningReference;
    readonly storeReference: DiningReference;
    readonly observedAt: DiningInstant;
  }): Promise<DiningClosureEvidence | null>;
}

export interface DiningClosingReversibilityPort {
  evaluate(input: {
    readonly diningSessionReference: DiningReference;
    readonly storeReference: DiningReference;
    readonly observedAt: DiningInstant;
  }): Promise<"Reversible" | "Irreversible" | "Indeterminate" | "Unavailable">;
}

export interface EnsureDiningExceptionTaskInput {
  readonly purpose: "DINING_UNPAID_BATCH_EXCEPTION";
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly diningSessionReference: DiningReference;
  readonly orderReference: DiningReference;
  readonly evidenceVersion: number;
  readonly evidenceDigest: DiningHash;
  readonly intentHash: DiningHash;
  readonly requestedAt: DiningInstant;
}

export interface DiningExceptionTaskPort {
  ensure(input: EnsureDiningExceptionTaskInput): Promise<{
    readonly orderReference: DiningReference;
    readonly evidenceVersion: number;
    readonly intentHash: DiningHash;
    readonly task: TaskRecord;
  }>;
}

export interface DiningClosingStorePort {
  load(diningSessionReference: DiningReference): Promise<DiningSession | null>;
  resolveOperation(
    operationReference: DiningReference,
  ): Promise<DiningClosingOperationRecord | null>;
  commit(input: {
    readonly record: DiningClosingOperationRecord;
    readonly expectedSessionVersion: number;
    readonly audit: AppendAuditRecordInput;
  }): Promise<DiningClosingOperationRecord>;
}

export interface DiningClosingHashPort {
  hashIntent(value: string): DiningHash;
  equals(left: DiningHash, right: DiningHash): boolean;
}

export interface DiningClosingPorts {
  readonly authorization: DiningClosingAuthorizationPort;
  readonly closureEvidence: DiningClosureEvidencePort;
  readonly reversibility: DiningClosingReversibilityPort;
  readonly tasks: DiningExceptionTaskPort;
  readonly store: DiningClosingStorePort;
  readonly hashes: DiningClosingHashPort;
}
