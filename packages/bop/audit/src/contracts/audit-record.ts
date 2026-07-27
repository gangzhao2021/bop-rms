export type AuditActor =
  { readonly type: "System" } | { readonly type: "User" | "Service"; readonly reference: string };

export type AuditClassification = "Public" | "Internal" | "Confidential" | "Restricted";
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface AppendAuditRecordInput {
  readonly auditId: string;
  readonly brandId: string;
  readonly storeId?: string;
  readonly actor: AuditActor;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeSummary?: JsonObject;
  readonly afterSummary?: JsonObject;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly sourceChannel: string;
  readonly deviceNetworkReference?: string;
  readonly dataClassification: AuditClassification;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  readonly correctsAuditId?: string;
}

export interface AuditTransaction {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}
