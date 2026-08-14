import type { AppendAuditRecordInput } from "@bop/audit";
import type { DiningSession } from "../../contracts/dining-session.js";
import type { DiningTable } from "../../domain/dining-table.js";
import type { DiningReference } from "../../contracts/dining-session.js";

export type DiningTableAction =
  "CreateDraft" | "ReplaceDraft" | "Publish" | "IssueQr" | "RevokeQr" | "SetBlock" | "ClearBlock";

export interface DiningTableEvent {
  readonly eventType:
    | "DiningTableDrafted"
    | "DiningTableConfigurationPublished"
    | "DiningTableQrLifecycleChanged"
    | "DiningTableOperationalStateChanged";
  readonly tableReference: DiningReference;
  readonly aggregateVersion: string;
  readonly lifecycle: DiningTable["lifecycle"];
  readonly qrStatus: DiningTable["qrStatus"];
  readonly operationalState: DiningTable["operationalState"];
  readonly occurredAt: string;
}

export interface DiningSessionMovedEvent {
  readonly eventType: "DiningSessionTableMoved";
  readonly diningSessionReference: DiningReference;
  readonly sourceTableReference: DiningReference;
  readonly targetTableReference: DiningReference;
  readonly aggregateVersion: string;
  readonly occurredAt: string;
}

export interface DiningTableOperationRecord {
  readonly operationReference: DiningReference;
  readonly intentDigest: string;
  readonly table: DiningTable;
  readonly audit: AppendAuditRecordInput;
  readonly event: DiningTableEvent;
}

export interface DiningSessionMoveRecord {
  readonly operationReference: DiningReference;
  readonly intentDigest: string;
  readonly session: DiningSession;
  readonly sourceTable: DiningTable;
  readonly targetTable: DiningTable;
  readonly audit: AppendAuditRecordInput;
  readonly event: DiningSessionMovedEvent;
}

export interface DiningTableAuthorizationEvidence {
  readonly tenantReference: DiningReference;
  readonly brandReference: DiningReference;
  readonly storeReference: DiningReference;
  readonly actorReference: DiningReference;
  readonly purpose: "dining-table";
  readonly permission: {
    readonly effect: "Allow" | "Deny";
    readonly action: "dining.operate";
    readonly scopeKind: "Store";
  };
  readonly audit: AppendAuditRecordInput;
}

export interface DiningTablePorts {
  readonly authorization: {
    authorize(input: {
      readonly action: DiningTableAction | "MoveSession";
      readonly targetReference: DiningReference;
      readonly observedAt: string;
    }): Promise<DiningTableAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveTableOperation(reference: DiningReference): Promise<DiningTableOperationRecord | null>;
    loadTable(reference: DiningReference): Promise<DiningTable | null>;
    commitTable(record: DiningTableOperationRecord): Promise<void>;
    resolveMoveOperation(reference: DiningReference): Promise<DiningSessionMoveRecord | null>;
    loadSession(reference: DiningReference): Promise<DiningSession | null>;
    commitMove(record: DiningSessionMoveRecord): Promise<void>;
  };
}
