import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  Reservation,
  ReservationReference,
  ReservationRevision,
} from "../../domain/reservation.js";

export type ReservationAction =
  "Create" | "Revise" | "Confirm" | "CheckIn" | "Cancel" | "MarkNoShow" | "Expire" | "RecordSeated";

export interface ReservationFutureEvent {
  readonly eventType:
    | "ReservationCreated"
    | "ReservationRevised"
    | "ReservationConfirmed"
    | "ReservationCheckedIn"
    | "ReservationCancelled"
    | "ReservationNoShowRecorded"
    | "ReservationExpired"
    | "ReservationSeated";
  readonly reservationReference: ReservationReference;
  readonly aggregateVersion: string;
  readonly status: Reservation["status"];
  readonly occurredAt: string;
}

export interface ReservationOperationRecord {
  readonly operationReference: ReservationReference;
  readonly intentDigest: string;
  readonly reservation: Reservation;
  readonly revision: ReservationRevision | null;
  readonly audit: AppendAuditRecordInput;
  readonly event: ReservationFutureEvent;
}

export interface ReservationAuthorizationEvidence {
  readonly tenantReference: ReservationReference;
  readonly brandReference: ReservationReference;
  readonly storeReference: ReservationReference;
  readonly actorReference: ReservationReference;
  readonly purpose: "reservation-management";
  readonly permission: {
    readonly effect: "Allow" | "Deny";
    readonly action: "dining.operate";
    readonly scopeKind: "Store";
  };
  readonly audit: AppendAuditRecordInput;
}

export interface ReservationPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: ReservationAction;
      readonly targetReference: ReservationReference;
      readonly observedAt: string;
    }): Promise<ReservationAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveOperation(reference: ReservationReference): Promise<ReservationOperationRecord | null>;
    load(reference: ReservationReference): Promise<Reservation | null>;
    commit(record: ReservationOperationRecord): Promise<void>;
  };
}
