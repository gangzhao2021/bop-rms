import type {
  DiningHash,
  DiningIdentityAdmission,
  DiningInstant,
  DiningParticipant,
  DiningReference,
  DiningSession,
  DiningTableStartEvidence,
} from "../../domain/dining-session.js";
import type {
  DiningCredentialPort,
  DiningGuestContextPort,
  DiningJoinRecord,
} from "./dining-session-ports.js";

export interface DiningAdmissionSnapshot {
  readonly session: DiningSession;
  readonly participant: DiningParticipant;
  readonly admission: DiningIdentityAdmission;
  readonly table: DiningTableStartEvidence;
  readonly join: DiningJoinRecord;
  readonly joinedGuestSessionReference: DiningReference;
}
export interface DiningAdmissionConsumptionRecord {
  readonly operationReference: DiningReference;
  readonly operationIntentHash: DiningHash;
  readonly guestSessionReference: DiningReference;
  readonly admission: DiningIdentityAdmission;
}
export interface DiningAdmissionConsumeWrite {
  readonly snapshot: DiningAdmissionSnapshot;
  readonly record: DiningAdmissionConsumptionRecord;
}
export interface DiningAdmissionConsumptionReceipt {
  readonly status: "Applied" | "AlreadyApplied";
  readonly record: DiningAdmissionConsumptionRecord;
}
export interface DiningAdmissionConsumptionPorts {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly guests: DiningGuestContextPort;
  readonly credentials: Pick<DiningCredentialPort, "hashOperationIntent" | "equals">;
  readonly store: {
    /** Coherent current owner facts plus immutable original Join. Tenant is bound by the adapter. */
    readCurrent(input: {
      readonly admissionReference: DiningReference;
      readonly observedAt: DiningInstant;
    }): Promise<DiningAdmissionSnapshot | null>;
    resolveOperation(
      operationReference: DiningReference,
    ): Promise<DiningAdmissionConsumptionRecord | null>;
    /** Revalidate complete facts under owner locks; consume, original history and SystemRestricted Audit are atomic. */
    consume(command: DiningAdmissionConsumeWrite): Promise<DiningAdmissionConsumptionReceipt>;
  };
}
export interface DiningAdmissionConsumptionResult {
  readonly status: "Consumed" | "AlreadyApplied";
  readonly record: DiningAdmissionConsumptionRecord;
}
