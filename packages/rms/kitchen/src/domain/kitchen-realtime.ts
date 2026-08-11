import { parseKitchenQueueGeneration } from "./kitchen-queue-projection.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
  type KitchenInstant,
  type KitchenReference,
} from "./kitchen-ticket.js";

export const kitchenRealtimeMessageType = "kitchen.work-queue.updated" as const;
export const kitchenRealtimeMessageVersion = 1 as const;
export const kitchenRealtimeResourceType = "kitchenQueueGeneration" as const;
export const kitchenRealtimeReferencePurpose = "KitchenRealtimeMessage" as const;

export interface KitchenRealtimeHint {
  readonly messageId: KitchenReference;
  readonly type: typeof kitchenRealtimeMessageType;
  readonly version: typeof kitchenRealtimeMessageVersion;
  readonly occurredAt: KitchenInstant;
  readonly scope: Readonly<{
    readonly brandId: KitchenReference;
    readonly storeId: KitchenReference;
  }>;
  readonly resource: Readonly<{
    readonly type: typeof kitchenRealtimeResourceType;
    readonly id: KitchenReference;
  }>;
  readonly projectionVersion: 1;
}

export type KitchenRealtimePublishOutcome =
  "Delivered" | "NoSubscribers" | "Unavailable" | "Rejected";

export interface KitchenRealtimePublishResult {
  readonly outcome: KitchenRealtimePublishOutcome;
  readonly message: KitchenRealtimeHint | null;
}

export interface KitchenRealtimeMetric {
  readonly operation: "publish";
  readonly result: "delivered" | "no_subscribers" | "unavailable" | "rejected";
}

function invalid(): never {
  throw new Error("KITCHEN_REALTIME_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      })
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch {
    return invalid();
  }
}

export function createKitchenRealtimeHint(input: {
  readonly generation: unknown;
  readonly messageReference: unknown;
}): KitchenRealtimeHint {
  try {
    const raw = exact(input, ["generation", "messageReference"]);
    const generation = parseKitchenQueueGeneration(raw.generation);
    if (generation.generationStatus !== "Active") return invalid();
    const messageId = parseKitchenTicketReference(raw.messageReference);
    const reservedReferences = [
      generation.projectionGenerationReference,
      generation.brandReference,
      generation.storeReference,
      generation.sourceCheckpointReference,
      generation.rebuildReference,
      generation.expectedPriorGenerationReference,
    ].filter((reference) => reference !== null);
    if (new Set(reservedReferences).size !== reservedReferences.length) return invalid();
    if (reservedReferences.some((reference) => reference === messageId)) return invalid();
    return Object.freeze({
      messageId,
      type: kitchenRealtimeMessageType,
      version: kitchenRealtimeMessageVersion,
      occurredAt: parseKitchenTicketInstant(generation.projectedAt),
      scope: Object.freeze({
        brandId: generation.brandReference,
        storeId: generation.storeReference,
      }),
      resource: Object.freeze({
        type: kitchenRealtimeResourceType,
        id: generation.projectionGenerationReference,
      }),
      projectionVersion: generation.projectionVersion,
    });
  } catch {
    return invalid();
  }
}

export function parseKitchenRealtimeHint(value: unknown): KitchenRealtimeHint {
  try {
    const raw = exact(value, [
      "messageId",
      "type",
      "version",
      "occurredAt",
      "scope",
      "resource",
      "projectionVersion",
    ]);
    const scope = exact(raw.scope, ["brandId", "storeId"]);
    const resource = exact(raw.resource, ["type", "id"]);
    if (
      raw.type !== kitchenRealtimeMessageType ||
      raw.version !== kitchenRealtimeMessageVersion ||
      raw.projectionVersion !== 1 ||
      resource.type !== kitchenRealtimeResourceType
    )
      return invalid();
    const messageId = parseKitchenTicketReference(raw.messageId);
    const brandId = parseKitchenTicketReference(scope.brandId);
    const storeId = parseKitchenTicketReference(scope.storeId);
    const resourceId = parseKitchenTicketReference(resource.id);
    if (new Set([messageId, brandId, storeId, resourceId]).size !== 4) return invalid();
    return Object.freeze({
      messageId,
      type: kitchenRealtimeMessageType,
      version: kitchenRealtimeMessageVersion,
      occurredAt: parseKitchenTicketInstant(raw.occurredAt),
      scope: Object.freeze({ brandId, storeId }),
      resource: Object.freeze({ type: kitchenRealtimeResourceType, id: resourceId }),
      projectionVersion: 1,
    });
  } catch {
    return invalid();
  }
}

export function createKitchenRealtimePublishResult(
  outcome: KitchenRealtimePublishOutcome,
  message: KitchenRealtimeHint | null,
): KitchenRealtimePublishResult {
  if (
    !["Delivered", "NoSubscribers", "Unavailable", "Rejected"].includes(outcome) ||
    (outcome === "Delivered" || outcome === "NoSubscribers") !== (message !== null)
  )
    return invalid();
  return Object.freeze({
    outcome,
    message: message === null ? null : parseKitchenRealtimeHint(message),
  });
}
