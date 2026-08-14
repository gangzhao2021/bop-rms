import type { AppendAuditRecordInput } from "@bop/audit";

import type {
  WaitEstimateRevision,
  WaitlistEntry,
  WaitlistEntryRevision,
  WaitPriorityRevision,
} from "../../domain/waitlist.js";
import type { ReservationReference } from "../../domain/reservation.js";
import type { ReservationCode } from "../../domain/reservation.js";

export type WaitlistAction =
  | "Join"
  | "CheckIn"
  | "Call"
  | "MarkReady"
  | "MarkMissed"
  | "RestoreWaiting"
  | "RestoreCheckedIn"
  | "Revise"
  | "UpdateEstimate"
  | "OverridePriority"
  | "RecordNotificationOutcome"
  | "Cancel"
  | "Expire"
  | "ExtendReady"
  | "RecordSeated";

export interface WaitlistFutureEvent {
  readonly eventType:
    | "WaitlistEntryJoined"
    | "WaitlistEntryCheckedIn"
    | "WaitlistEntryCalled"
    | "WaitlistEntryReady"
    | "WaitlistEntryMissed"
    | "WaitlistEntryRestored"
    | "WaitlistEntryCancelled"
    | "WaitlistEntryExpired"
    | "WaitlistEntrySeated"
    | "EstimatedWaitChanged";
  readonly waitlistEntryReference: ReservationReference;
  readonly aggregateVersion: string;
  readonly status: WaitlistEntry["status"];
  readonly occurredAt: string;
}

export interface WaitlistOperationRecord {
  readonly operationReference: ReservationReference;
  readonly intentDigest: string;
  readonly entry: WaitlistEntry;
  readonly revision: WaitlistEntryRevision | WaitEstimateRevision | WaitPriorityRevision | null;
  readonly reasonCode: ReservationCode | null;
  readonly collaborationEvidenceReference: ReservationReference | null;
  readonly audit: AppendAuditRecordInput;
  readonly event: WaitlistFutureEvent | null;
}

export interface WaitlistAuthorizationEvidence {
  readonly tenantReference: ReservationReference;
  readonly brandReference: ReservationReference;
  readonly storeReference: ReservationReference;
  readonly actorReference: ReservationReference;
  readonly purpose: "waitlist-management";
  readonly permission: {
    readonly effect: "Allow" | "Deny";
    readonly action: "dining.operate";
    readonly scopeKind: "Store";
  };
  readonly audit: AppendAuditRecordInput;
}

export interface WaitlistPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: WaitlistAction;
      readonly targetReference: ReservationReference;
      readonly observedAt: string;
    }): Promise<WaitlistAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly collaborators: {
    validateJoin(input: {
      readonly candidate: WaitlistEntry;
      readonly evidenceReference: ReservationReference;
    }): Promise<boolean>;
    validateEstimate(input: {
      readonly current: WaitlistEntry;
      readonly candidate: WaitlistEntry;
      readonly evidenceReference: ReservationReference;
    }): Promise<boolean>;
    validatePriority(input: {
      readonly current: WaitlistEntry;
      readonly candidate: WaitlistEntry;
      readonly evidenceReference: ReservationReference;
    }): Promise<boolean>;
    validateNotificationOutcome(input: {
      readonly current: WaitlistEntry;
      readonly candidate: WaitlistEntry;
      readonly evidenceReference: ReservationReference;
    }): Promise<boolean>;
    validateDiningResult(input: {
      readonly current: WaitlistEntry;
      readonly candidate: WaitlistEntry;
      readonly evidenceReference: ReservationReference;
    }): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(reference: ReservationReference): Promise<WaitlistOperationRecord | null>;
    load(reference: ReservationReference): Promise<WaitlistEntry | null>;
    commit(record: WaitlistOperationRecord): Promise<void>;
  };
}
