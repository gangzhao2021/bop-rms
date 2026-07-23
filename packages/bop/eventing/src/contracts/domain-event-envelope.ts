export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type RedactionClassification =
  | "none"
  | "indirect_identifier"
  | "personal"
  | "sensitive_personal"
  | "payment"
  | "health"
  | "credential";

export type EventActor =
  { readonly type: "Actor"; readonly actorId: string } | { readonly type: "System" };

export interface DomainEventEnvelope<Payload extends JsonObject = JsonObject> {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly producerModule: `@bop/${string}` | `@rms/${string}`;
  readonly tenantId: string;
  readonly storeId?: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: bigint;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly actor: EventActor;
  readonly payload: Payload;
  readonly redactionClassification: RedactionClassification;
  readonly replayMetadata: JsonObject;
}
