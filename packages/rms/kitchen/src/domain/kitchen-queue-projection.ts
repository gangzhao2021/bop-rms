import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
} from "./kitchen-ticket.js";

export const kitchenQueueProjectionName = "kitchen_work_queue_v1" as const;
export const kitchenQueueProjectionVersion = 1 as const;
export const kitchenQueueConsumerName = "kitchen.queue-projection:v1" as const;
export const kitchenQueueConsumerVersion = 1 as const;
export const kitchenQueuePermission = "kitchen.operate" as const;
export const kitchenQueueSnapshotBindingVersion = 2 as const;

export const kitchenQueueProjectionErrorCodes = [
  "KITCHEN_QUEUE_INPUT_INVALID",
  "KITCHEN_QUEUE_PERMISSION_DENIED",
  "KITCHEN_QUEUE_NOT_FOUND",
  "KITCHEN_QUEUE_VERSION_CONFLICT",
  "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
] as const;
export type KitchenQueueProjectionErrorCode = (typeof kitchenQueueProjectionErrorCodes)[number];

export class KitchenQueueProjectionError extends Error {
  constructor(readonly code: KitchenQueueProjectionErrorCode) {
    super("kitchen queue is unavailable");
    this.name = "KitchenQueueProjectionError";
  }
}

export type KitchenQueueGenerationStatus = "Building" | "Active" | "Retired";
export type KitchenQueueFreshnessStatus = "Fresh" | "Stale";
export type KitchenQueueWorkItemStatus =
  "Queued" | "Held" | "In Progress" | "Completed" | "Cancelled";

export type KitchenQueueLocalizedNames = Readonly<Record<string, string>>;

export interface KitchenQueueSelectedOption {
  readonly optionReference: KitchenReference;
  readonly quantity: number;
  readonly localizedNames: KitchenQueueLocalizedNames;
}

export interface KitchenQueueSourceEventPayload {
  readonly kitchenTicketReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly workItemCount: number;
  readonly aggregateVersion: 1;
  readonly createdAt: KitchenInstant;
}

export interface KitchenQueueSourceEvent {
  readonly eventId: KitchenReference;
  readonly eventType: "KitchenWorkCreated";
  readonly schemaVersion: 1;
  readonly occurredAt: KitchenInstant;
  readonly producerModule: "@rms/kitchen";
  readonly tenantId: KitchenReference;
  readonly storeId: KitchenReference;
  readonly aggregateType: "KitchenTicket";
  readonly aggregateId: KitchenReference;
  readonly aggregateVersion: 1n;
  readonly correlationId: KitchenReference;
  readonly causationId: KitchenReference;
  readonly actor: Readonly<{ readonly type: "System" }>;
  readonly payload: KitchenQueueSourceEventPayload;
  readonly redactionClassification: "indirect_identifier";
  readonly replayMetadata: Readonly<{ readonly replaySafe: true }>;
}

export interface KitchenQueueSourceItem {
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly sourceItemOrdinal: number;
  readonly ticketAggregateVersion: bigint;
  readonly workItemVersion: bigint;
  readonly status: KitchenQueueWorkItemStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly localizedDisplayNames: KitchenQueueLocalizedNames;
  readonly selectedOptions: readonly KitchenQueueSelectedOption[];
  readonly stationReference: KitchenReference;
  readonly workItemCreatedAt: KitchenInstant;
  readonly acceptedAt: KitchenInstant | null;
  readonly orderItemReadyAt: KitchenInstant | null;
  readonly catalogSnapshotControlled: true;
}

export interface KitchenQueueSourceTicket {
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly ticketAggregateVersion: bigint;
  readonly ticketStatus: "Open";
  readonly sourceEvent: KitchenQueueSourceEvent;
  readonly items: readonly KitchenQueueSourceItem[];
}

export interface KitchenQueueSourceFeed {
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly sourceCheckpointReference: KitchenReference;
  readonly asOfUtc: KitchenInstant;
  readonly coverageStatus: "CompleteThroughCheckpoint";
  readonly tickets: readonly KitchenQueueSourceTicket[];
}

export type KitchenQueueLifecycleEventType =
  | "KitchenWorkAccepted"
  | "KitchenWorkStarted"
  | "KitchenItemProgressRecorded"
  | "KitchenItemCompleted";

export interface KitchenQueueLifecycleEventProof {
  readonly kind: "Event";
  readonly eventType: KitchenQueueLifecycleEventType;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly operationReference: KitchenReference;
  readonly actionCode:
    | "KITCHEN_WORK_ITEM_ACCEPTED"
    | "KITCHEN_WORK_ITEM_STARTED"
    | "KITCHEN_WORK_ITEM_COMPLETION_RECORDED";
  readonly purpose: "KitchenWorkExecution";
  readonly reasonCode: "WORK_ITEM_ACCEPTED" | "WORK_ITEM_STARTED" | "COMPLETION_QUANTITY_RECORDED";
  readonly sourceChannel: "KDS_COMMAND";
  readonly actor: Readonly<{ readonly type: "User"; readonly actorReference: KitchenReference }>;
  readonly expectedTicketVersion: bigint;
  readonly committedTicketVersion: bigint;
  readonly expectedWorkItemVersion: bigint;
  readonly committedWorkItemVersion: bigint;
  readonly beforeStatus: "Queued" | "In Progress";
  readonly afterStatus: "Queued" | "In Progress" | "Completed";
  readonly quantityDelta: number | null;
  readonly completedQuantity: number | null;
  readonly requiredQuantity: number | null;
  readonly occurredAt: KitchenInstant;
  readonly auditReference: KitchenReference;
  readonly auditSemanticDigest: KitchenDigest;
  readonly effectDigest: KitchenDigest;
  readonly eventReference: KitchenReference;
  readonly eventSemanticDigest: KitchenDigest;
  readonly projectionProofDigest: KitchenDigest;
}

export interface KitchenQueueManualReadyProof {
  readonly kind: "ManualReady";
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly operationReference: KitchenReference;
  readonly actionCode: "KITCHEN_ORDER_ITEM_READY";
  readonly purpose: "KitchenExpoCoordination";
  readonly reasonCode: "EXPO_MARKED_READY";
  readonly sourceChannel: "KDS_COMMAND";
  readonly actor: Readonly<{ readonly type: "User"; readonly actorReference: KitchenReference }>;
  readonly expectedTicketVersion: bigint;
  readonly committedTicketVersion: bigint;
  readonly workItemVersion: bigint;
  readonly workItemStatus: "Completed";
  readonly workItems: readonly Readonly<{
    readonly workItemReference: KitchenReference;
    readonly workItemVersion: bigint;
  }>[];
  readonly workItemsDigest: KitchenDigest;
  readonly readyResultReference: KitchenReference;
  readonly readyQuantity: number;
  readonly requiredQuantity: number;
  readonly readyAt: KitchenInstant;
  readonly auditReference: KitchenReference;
  readonly auditSemanticDigest: KitchenDigest;
  readonly effectDigest: KitchenDigest;
  readonly eventReference: null;
  readonly eventSemanticDigest: null;
  readonly projectionProofDigest: KitchenDigest;
}

export interface KitchenQueueAutomaticReadyProof {
  readonly kind: "AutomaticReady";
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly operationReference: KitchenReference;
  readonly parentOperationReference: KitchenReference;
  readonly committedTicketVersion: bigint;
  readonly workItemVersion: bigint;
  readonly workItemStatus: "Completed";
  readonly actionCode: "KITCHEN_ORDER_ITEM_READY";
  readonly purpose: "KitchenExpoCoordination";
  readonly reasonCode: "ALL_WORK_ITEMS_COMPLETED";
  readonly sourceChannel: "KITCHEN_AUTOMATION";
  readonly actor: Readonly<{ readonly type: "System"; readonly actorReference: null }>;
  readonly workItems: readonly Readonly<{
    readonly workItemReference: KitchenReference;
    readonly workItemVersion: bigint;
  }>[];
  readonly workItemsDigest: KitchenDigest;
  readonly readyResultReference: KitchenReference;
  readonly readyQuantity: number;
  readonly requiredQuantity: number;
  readonly readyAt: KitchenInstant;
  readonly auditReference: KitchenReference;
  readonly auditSemanticDigest: KitchenDigest;
  readonly effectDigest: KitchenDigest;
  readonly eventReference: null;
  readonly eventSemanticDigest: null;
  readonly readyCausalBundleDigest: KitchenDigest;
  readonly projectionProofDigest: KitchenDigest;
}

export type KitchenQueueLifecycleProjectionProof =
  KitchenQueueLifecycleEventProof | KitchenQueueManualReadyProof | KitchenQueueAutomaticReadyProof;

export interface KitchenQueueLifecycleProofBundle {
  readonly ticketReference: KitchenReference;
  readonly operationCount: number;
  readonly readyResultCount: number;
  readonly lifecycleProofSetDigest: KitchenDigest;
  readonly proofs: readonly KitchenQueueLifecycleProjectionProof[];
}

export interface KitchenQueueLifecycleSourceTicket extends KitchenQueueSourceTicket {
  readonly updatedAt: KitchenInstant;
}

export interface KitchenQueueLifecycleQueueFeed extends Omit<KitchenQueueSourceFeed, "tickets"> {
  readonly tickets: readonly KitchenQueueLifecycleSourceTicket[];
}

export interface KitchenQueueLifecycleSourceFeed {
  readonly queueFeed: KitchenQueueLifecycleQueueFeed;
  readonly proofBundles: readonly KitchenQueueLifecycleProofBundle[];
}

export interface KitchenQueueRow {
  readonly projectionGenerationReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly sourceItemOrdinal: number;
  readonly ticketAggregateVersion: bigint;
  readonly workItemVersion: bigint;
  readonly status: KitchenQueueWorkItemStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly localizedDisplayNames: KitchenQueueLocalizedNames;
  readonly selectedOptions: readonly KitchenQueueSelectedOption[];
  readonly stationReference: KitchenReference;
  readonly originalSourceEventReference: KitchenReference;
  readonly sourceEventSemanticDigest: KitchenDigest;
  readonly sourceEventOccurredAt: KitchenInstant;
  readonly workItemCreatedAt: KitchenInstant;
  readonly acceptedAt: KitchenInstant | null;
  readonly orderItemReadyAt: KitchenInstant | null;
}

export interface KitchenQueueGeneration {
  readonly projectionGenerationReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly projectionName: typeof kitchenQueueProjectionName;
  readonly projectionVersion: typeof kitchenQueueProjectionVersion;
  readonly generationStatus: KitchenQueueGenerationStatus;
  readonly sourceCheckpointReference: KitchenReference;
  readonly sourceEventBindingDigest: KitchenDigest;
  readonly queueSnapshotDigest: KitchenDigest;
  readonly ticketCount: number;
  readonly workItemCount: number;
  readonly initializedEmpty: boolean;
  readonly asOfUtc: KitchenInstant;
  readonly projectedAt: KitchenInstant;
  readonly activationLagMs: number;
  readonly lastRebuiltAt: KitchenInstant | null;
  readonly freshnessStatus: KitchenQueueFreshnessStatus;
  readonly rebuildReference: KitchenReference | null;
  readonly rebuildRequestDigest: KitchenDigest | null;
  readonly rebuildRequestedAt: KitchenInstant | null;
  readonly expectedPriorGenerationReference: KitchenReference | null;
}

export interface KitchenQueueStoredGeneration extends KitchenQueueGeneration {
  readonly snapshotBindingVersion: 1 | 2;
}

export interface KitchenQueueProjectionBundle {
  readonly generation: KitchenQueueGeneration;
  readonly rows: readonly KitchenQueueRow[];
}

export interface KitchenQueueStoredProjectionBundle {
  readonly generation: KitchenQueueStoredGeneration;
  readonly rows: readonly KitchenQueueRow[];
}

export interface KitchenQueueRebuildRequest {
  readonly action: "RebuildKitchenQueueProjection";
  readonly purpose: "ProjectionRecovery";
  readonly projectionName: typeof kitchenQueueProjectionName;
  readonly projectionVersion: typeof kitchenQueueProjectionVersion;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly rebuildReference: KitchenReference;
  readonly expectedActiveGenerationReference: KitchenReference | null;
  readonly requestedAt: KitchenInstant;
}

export interface KitchenQueueFilters {
  readonly orderReference: KitchenReference | null;
  readonly ticketReference: KitchenReference | null;
  readonly workItemReference: KitchenReference | null;
  readonly stationReference: KitchenReference | null;
  readonly status: KitchenQueueWorkItemStatus | null;
}

export interface KitchenQueueCursor {
  readonly projectionGenerationReference: KitchenReference;
  readonly afterCreatedAt: KitchenInstant;
  readonly afterWorkItemReference: KitchenReference;
  readonly filterSortDigest: KitchenDigest;
}

export interface KitchenQueueListQuery {
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly observedAt: KitchenInstant;
  readonly filters: KitchenQueueFilters;
  readonly cursor: KitchenQueueCursor | null;
  readonly limit: number;
}

export interface KitchenQueueGetQuery {
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly observedAt: KitchenInstant;
  readonly workItemReference: KitchenReference;
}

export interface KitchenQueueItemView {
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly sourceItemOrdinal: number;
  readonly ticketAggregateVersion: bigint;
  readonly workItemVersion: bigint;
  readonly status: KitchenQueueWorkItemStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly localizedDisplayNames: KitchenQueueLocalizedNames;
  readonly selectedOptions: readonly KitchenQueueSelectedOption[];
  readonly stationReference: KitchenReference;
  readonly workItemCreatedAt: KitchenInstant;
  readonly acceptedAt: KitchenInstant | null;
  readonly orderItemReadyAt: KitchenInstant | null;
}

export interface KitchenQueueFutureCapabilities {
  readonly course: "NotAvailable";
  readonly priority: "NotAvailable";
  readonly slaOverdue: "NotAvailable";
  readonly holdReason: "NotAvailable";
  readonly exception: "NotAvailable";
  readonly claim: "NotAvailable";
  readonly eta: "NotAvailable";
  readonly structuredAllergenAssistance: "NotAvailable";
}

export interface KitchenQueueResultMetadata {
  readonly projectionName: typeof kitchenQueueProjectionName;
  readonly projectionVersion: typeof kitchenQueueProjectionVersion;
  readonly projectionGenerationReference: KitchenReference;
  readonly sourceCheckpointReference: KitchenReference;
  readonly asOfUtc: KitchenInstant;
  readonly projectedAt: KitchenInstant;
  readonly activationLagMs: number;
  readonly freshnessStatus: KitchenQueueFreshnessStatus;
  readonly partial: false;
  readonly stale: boolean;
  readonly lastRebuiltAt: KitchenInstant | null;
  readonly initializedEmpty: boolean;
  readonly projectionRegistryStatus: "runtime-inactive";
  readonly projectionHealth: "NotAvailable";
  readonly bulkExport: "NotAvailable";
  readonly futureCapabilities: KitchenQueueFutureCapabilities;
}

export interface KitchenQueueListResult extends KitchenQueueResultMetadata {
  readonly items: readonly KitchenQueueItemView[];
  readonly nextCursor: KitchenQueueCursor | null;
}

export interface KitchenQueueGetResult extends KitchenQueueResultMetadata {
  readonly item: KitchenQueueItemView;
}

export type KitchenQueueDigestPort = (canonicalValue: string) => string;

const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/u;

function invalid(): never {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
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
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenQueueProjectionError) throw error;
    return invalid();
  }
}

function descriptorSnapshot(value: unknown): Readonly<Record<string, unknown>> {
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
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
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
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return invalid();
      result[key] = descriptors[key]?.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenQueueProjectionError) throw error;
    return invalid();
  }
}

function exactArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = (descriptors as unknown as Record<PropertyKey, PropertyDescriptor>)[
      "length"
    ];
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < minimum ||
      lengthDescriptor.value > maximum
    )
      return invalid();
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== length + 1 ||
      !keys.includes("length") ||
      keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string") return true;
        const index = Number(key);
        return (
          !Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key
        );
      })
    )
      return invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenQueueProjectionError) throw error;
    return invalid();
  }
}

function reference(value: unknown): KitchenReference {
  try {
    return parseKitchenTicketReference(value);
  } catch {
    return invalid();
  }
}

function instant(value: unknown): KitchenInstant {
  try {
    return parseKitchenTicketInstant(value);
  } catch {
    return invalid();
  }
}

function digest(value: unknown): KitchenDigest {
  try {
    return parseKitchenTicketDigest(value);
  } catch {
    return invalid();
  }
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return invalid();
  return value as number;
}

function positiveBigint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n) return invalid();
  return value;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function controlledText(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) return invalid();
  const normalized = value.normalize("NFC").trim();
  if (
    normalized !== value ||
    normalized.length === 0 ||
    [...normalized].length > 200 ||
    [...normalized].some((character) => {
      const point = character.codePointAt(0);
      return (
        point === undefined ||
        point <= 0x1f ||
        (point >= 0x7f && point <= 0x9f) ||
        point === 0x061c ||
        point === 0x200e ||
        point === 0x200f ||
        point === 0x2028 ||
        point === 0x2029 ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069)
      );
    })
  )
    return invalid();
  return value;
}

function localizedNames(value: unknown): KitchenQueueLocalizedNames {
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
      keys.length < 1 ||
      keys.length > 20 ||
      keys.some((key) => typeof key !== "string" || !localePattern.test(key))
    )
      return invalid();
    const result: Record<string, string> = {};
    const localeKeys = keys as string[];
    for (const key of [...localeKeys].sort(compareAscii)) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[key] = controlledText(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenQueueProjectionError) throw error;
    return invalid();
  }
}

function selectedOption(value: unknown): KitchenQueueSelectedOption {
  const raw = exact(value, ["optionReference", "quantity", "localizedNames"]);
  return Object.freeze({
    optionReference: reference(raw.optionReference),
    quantity: integer(raw.quantity, 1, 999),
    localizedNames: localizedNames(raw.localizedNames),
  });
}

function selectedOptions(value: unknown): readonly KitchenQueueSelectedOption[] {
  const parsed = exactArray(value, 0, 100)
    .map(selectedOption)
    .sort((left, right) => compareAscii(left.optionReference, right.optionReference));
  if (new Set(parsed.map((option) => option.optionReference)).size !== parsed.length)
    return invalid();
  return Object.freeze(parsed);
}

function optionalReference(value: unknown): KitchenReference | null {
  return value === null ? null : reference(value);
}

function optionalInstant(value: unknown): KitchenInstant | null {
  return value === null ? null : instant(value);
}

function optionalDigest(value: unknown): KitchenDigest | null {
  return value === null ? null : digest(value);
}

function workItemStatus(value: unknown): KitchenQueueWorkItemStatus {
  if (
    typeof value !== "string" ||
    !["Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(value)
  )
    return invalid();
  return value as KitchenQueueWorkItemStatus;
}

function validQuantityStatus(
  status: KitchenQueueWorkItemStatus,
  completedQuantity: number,
  requiredQuantity: number,
): boolean {
  if (status === "Queued") return completedQuantity === 0;
  if (status === "In Progress") return completedQuantity < requiredQuantity;
  if (status === "Completed") return completedQuantity === requiredQuantity;
  return completedQuantity <= requiredQuantity;
}

export function parseKitchenQueueSourceEvent(value: unknown): KitchenQueueSourceEvent {
  const raw = exact(value, [
    "eventId",
    "eventType",
    "schemaVersion",
    "occurredAt",
    "producerModule",
    "tenantId",
    "storeId",
    "aggregateType",
    "aggregateId",
    "aggregateVersion",
    "correlationId",
    "causationId",
    "actor",
    "payload",
    "redactionClassification",
    "replayMetadata",
  ]);
  const actor = exact(raw.actor, ["type"]);
  const replay = exact(raw.replayMetadata, ["replaySafe"]);
  const payload = exact(raw.payload, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "workItemCount",
    "aggregateVersion",
    "createdAt",
  ]);
  const parsedPayload = Object.freeze({
    kitchenTicketReference: reference(payload.kitchenTicketReference),
    orderReference: reference(payload.orderReference),
    orderBatchReference: reference(payload.orderBatchReference),
    confirmationReference: reference(payload.confirmationReference),
    workItemCount: integer(payload.workItemCount, 1, 100),
    aggregateVersion: payload.aggregateVersion,
    createdAt: instant(payload.createdAt),
  });
  const occurredAt = instant(raw.occurredAt);
  const aggregateId = reference(raw.aggregateId);
  if (
    raw.eventType !== "KitchenWorkCreated" ||
    raw.schemaVersion !== 1 ||
    raw.producerModule !== "@rms/kitchen" ||
    raw.aggregateType !== "KitchenTicket" ||
    raw.aggregateVersion !== 1n ||
    actor.type !== "System" ||
    parsedPayload.aggregateVersion !== 1 ||
    aggregateId !== parsedPayload.kitchenTicketReference ||
    occurredAt !== parsedPayload.createdAt ||
    raw.redactionClassification !== "indirect_identifier" ||
    replay.replaySafe !== true
  )
    return invalid();
  return Object.freeze({
    eventId: reference(raw.eventId),
    eventType: "KitchenWorkCreated" as const,
    schemaVersion: 1 as const,
    occurredAt,
    producerModule: "@rms/kitchen" as const,
    tenantId: reference(raw.tenantId),
    storeId: reference(raw.storeId),
    aggregateType: "KitchenTicket" as const,
    aggregateId,
    aggregateVersion: 1n as const,
    correlationId: reference(raw.correlationId),
    causationId: reference(raw.causationId),
    actor: Object.freeze({ type: "System" as const }),
    payload: Object.freeze({
      kitchenTicketReference: parsedPayload.kitchenTicketReference,
      orderReference: parsedPayload.orderReference,
      orderBatchReference: parsedPayload.orderBatchReference,
      confirmationReference: parsedPayload.confirmationReference,
      workItemCount: parsedPayload.workItemCount,
      aggregateVersion: 1 as const,
      createdAt: parsedPayload.createdAt,
    }),
    redactionClassification: "indirect_identifier" as const,
    replayMetadata: Object.freeze({ replaySafe: true as const }),
  });
}

function parseSourceItem(value: unknown): KitchenQueueSourceItem {
  const raw = exact(value, [
    "ticketReference",
    "workItemReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "sourceItemOrdinal",
    "ticketAggregateVersion",
    "workItemVersion",
    "status",
    "requiredQuantity",
    "completedQuantity",
    "localizedDisplayNames",
    "selectedOptions",
    "stationReference",
    "workItemCreatedAt",
    "acceptedAt",
    "orderItemReadyAt",
    "catalogSnapshotControlled",
  ]);
  if (raw.catalogSnapshotControlled !== true) return invalid();
  const requiredQuantity = integer(raw.requiredQuantity, 1, 999);
  const completedQuantity = integer(raw.completedQuantity, 0, requiredQuantity);
  const status = workItemStatus(raw.status);
  const workItemCreatedAt = instant(raw.workItemCreatedAt);
  const acceptedAt = optionalInstant(raw.acceptedAt);
  const orderItemReadyAt = optionalInstant(raw.orderItemReadyAt);
  if (
    !validQuantityStatus(status, completedQuantity, requiredQuantity) ||
    (acceptedAt !== null && Date.parse(acceptedAt) < Date.parse(workItemCreatedAt)) ||
    (orderItemReadyAt !== null &&
      (status !== "Completed" ||
        acceptedAt === null ||
        Date.parse(orderItemReadyAt) < Date.parse(acceptedAt)))
  )
    return invalid();
  return Object.freeze({
    ticketReference: reference(raw.ticketReference),
    workItemReference: reference(raw.workItemReference),
    orderReference: reference(raw.orderReference),
    orderBatchReference: reference(raw.orderBatchReference),
    orderItemReference: reference(raw.orderItemReference),
    sourceItemOrdinal: integer(raw.sourceItemOrdinal, 1, 100),
    ticketAggregateVersion: positiveBigint(raw.ticketAggregateVersion),
    workItemVersion: positiveBigint(raw.workItemVersion),
    status,
    requiredQuantity,
    completedQuantity,
    localizedDisplayNames: localizedNames(raw.localizedDisplayNames),
    selectedOptions: selectedOptions(raw.selectedOptions),
    stationReference: reference(raw.stationReference),
    workItemCreatedAt,
    acceptedAt,
    orderItemReadyAt,
    catalogSnapshotControlled: true as const,
  });
}

export function parseKitchenQueueSourceTicket(value: unknown): KitchenQueueSourceTicket {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "ticketReference",
    "orderReference",
    "orderBatchReference",
    "ticketAggregateVersion",
    "ticketStatus",
    "sourceEvent",
    "items",
  ]);
  if (raw.ticketStatus !== "Open") return invalid();
  const brandReference = reference(raw.brandReference);
  const storeReference = reference(raw.storeReference);
  const ticketReference = reference(raw.ticketReference);
  const orderReference = reference(raw.orderReference);
  const orderBatchReference = reference(raw.orderBatchReference);
  const sourceEvent = parseKitchenQueueSourceEvent(raw.sourceEvent);
  const items = exactArray(raw.items, 1, 100)
    .map(parseSourceItem)
    .sort((left, right) => left.sourceItemOrdinal - right.sourceItemOrdinal);
  if (
    sourceEvent.tenantId !== brandReference ||
    sourceEvent.storeId !== storeReference ||
    sourceEvent.aggregateId !== ticketReference ||
    sourceEvent.payload.kitchenTicketReference !== ticketReference ||
    sourceEvent.payload.orderReference !== orderReference ||
    sourceEvent.payload.orderBatchReference !== orderBatchReference ||
    sourceEvent.payload.workItemCount !== items.length ||
    new Set(items.map((item) => item.workItemReference)).size !== items.length ||
    new Set(items.map((item) => item.orderItemReference)).size !== items.length ||
    items.some(
      (item, index) =>
        item.sourceItemOrdinal !== index + 1 ||
        item.ticketReference !== ticketReference ||
        item.orderReference !== orderReference ||
        item.orderBatchReference !== orderBatchReference ||
        item.workItemCreatedAt !== sourceEvent.payload.createdAt ||
        item.ticketAggregateVersion !== positiveBigint(raw.ticketAggregateVersion),
    )
  )
    return invalid();
  return Object.freeze({
    brandReference,
    storeReference,
    ticketReference,
    orderReference,
    orderBatchReference,
    ticketAggregateVersion: positiveBigint(raw.ticketAggregateVersion),
    ticketStatus: "Open" as const,
    sourceEvent,
    items: Object.freeze(items),
  });
}

export function parseKitchenQueueSourceFeed(value: unknown): KitchenQueueSourceFeed {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "sourceCheckpointReference",
    "asOfUtc",
    "coverageStatus",
    "tickets",
  ]);
  if (raw.coverageStatus !== "CompleteThroughCheckpoint") return invalid();
  const brandReference = reference(raw.brandReference);
  const storeReference = reference(raw.storeReference);
  const asOfUtc = instant(raw.asOfUtc);
  const tickets = exactArray(raw.tickets, 0, Number.MAX_SAFE_INTEGER)
    .map(parseKitchenQueueSourceTicket)
    .sort((left, right) => compareAscii(left.ticketReference, right.ticketReference));
  const workItems = tickets.flatMap((ticket) => ticket.items);
  if (
    tickets.some(
      (ticket) =>
        ticket.brandReference !== brandReference ||
        ticket.storeReference !== storeReference ||
        Date.parse(ticket.sourceEvent.occurredAt) > Date.parse(asOfUtc) ||
        ticket.items.some(
          (item) =>
            Date.parse(item.workItemCreatedAt) > Date.parse(asOfUtc) ||
            (item.acceptedAt !== null && Date.parse(item.acceptedAt) > Date.parse(asOfUtc)) ||
            (item.orderItemReadyAt !== null &&
              Date.parse(item.orderItemReadyAt) > Date.parse(asOfUtc)),
        ),
    ) ||
    new Set(tickets.map((ticket) => ticket.ticketReference)).size !== tickets.length ||
    new Set(tickets.map((ticket) => ticket.sourceEvent.eventId)).size !== tickets.length ||
    new Set(workItems.map((item) => item.workItemReference)).size !== workItems.length
  )
    return invalid();
  return Object.freeze({
    brandReference,
    storeReference,
    sourceCheckpointReference: reference(raw.sourceCheckpointReference),
    asOfUtc,
    coverageStatus: "CompleteThroughCheckpoint" as const,
    tickets: Object.freeze(tickets),
  });
}

function proofWorkItems(value: unknown): KitchenQueueManualReadyProof["workItems"] {
  const values = exactArray(value, 1, 1).map((item) => {
    const raw = exact(item, ["workItemReference", "workItemVersion"]);
    return Object.freeze({
      workItemReference: reference(raw.workItemReference),
      workItemVersion: positiveBigint(raw.workItemVersion),
    });
  });
  return Object.freeze(values);
}

function proofActor(value: unknown, expectedType: "User" | "System") {
  const raw = exact(value, ["type", "actorReference"]);
  if (raw.type !== expectedType) return invalid();
  return expectedType === "User"
    ? Object.freeze({ type: "User" as const, actorReference: reference(raw.actorReference) })
    : raw.actorReference === null
      ? Object.freeze({ type: "System" as const, actorReference: null })
      : invalid();
}

function normalizedProofValue(
  proof: KitchenQueueLifecycleProjectionProof,
): Readonly<Record<string, unknown>> {
  const entries = Object.entries(proof)
    .filter(([key]) => key !== "projectionProofDigest" && key !== "readyCausalBundleDigest")
    .map(([key, value]) => {
      if (typeof value === "bigint") return [key, value.toString(10)] as const;
      if (key === "workItems") {
        return [
          key,
          (value as KitchenQueueManualReadyProof["workItems"]).map((item) =>
            Object.freeze({
              workItemReference: item.workItemReference,
              workItemVersion: item.workItemVersion.toString(10),
            }),
          ),
        ] as const;
      }
      return [key, value] as const;
    });
  return Object.freeze(Object.fromEntries(entries));
}

function parseLifecycleEventProof(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueLifecycleEventProof {
  const raw = exact(value, [
    "kind",
    "eventType",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "operationReference",
    "actionCode",
    "purpose",
    "reasonCode",
    "sourceChannel",
    "actor",
    "expectedTicketVersion",
    "committedTicketVersion",
    "expectedWorkItemVersion",
    "committedWorkItemVersion",
    "beforeStatus",
    "afterStatus",
    "quantityDelta",
    "completedQuantity",
    "requiredQuantity",
    "occurredAt",
    "auditReference",
    "auditSemanticDigest",
    "effectDigest",
    "eventReference",
    "eventSemanticDigest",
    "projectionProofDigest",
  ]);
  if (
    raw.kind !== "Event" ||
    typeof raw.eventType !== "string" ||
    ![
      "KitchenWorkAccepted",
      "KitchenWorkStarted",
      "KitchenItemProgressRecorded",
      "KitchenItemCompleted",
    ].includes(raw.eventType) ||
    raw.purpose !== "KitchenWorkExecution" ||
    raw.sourceChannel !== "KDS_COMMAND"
  )
    return invalid();
  const expectedTicketVersion = positiveBigint(raw.expectedTicketVersion);
  const committedTicketVersion = positiveBigint(raw.committedTicketVersion);
  const expectedWorkItemVersion = positiveBigint(raw.expectedWorkItemVersion);
  const committedWorkItemVersion = positiveBigint(raw.committedWorkItemVersion);
  if (
    committedTicketVersion !== expectedTicketVersion + 1n ||
    committedWorkItemVersion !== expectedWorkItemVersion + 1n
  )
    return invalid();
  const eventType = raw.eventType as KitchenQueueLifecycleEventType;
  const quantityDelta = raw.quantityDelta === null ? null : integer(raw.quantityDelta, 1, 999);
  const completedQuantity =
    raw.completedQuantity === null ? null : integer(raw.completedQuantity, 0, 999);
  const requiredQuantity =
    raw.requiredQuantity === null ? null : integer(raw.requiredQuantity, 1, 999);
  const literalValid =
    eventType === "KitchenWorkAccepted"
      ? raw.actionCode === "KITCHEN_WORK_ITEM_ACCEPTED" &&
        raw.reasonCode === "WORK_ITEM_ACCEPTED" &&
        raw.beforeStatus === "Queued" &&
        raw.afterStatus === "Queued" &&
        quantityDelta === null &&
        completedQuantity === null &&
        requiredQuantity === null
      : eventType === "KitchenWorkStarted"
        ? raw.actionCode === "KITCHEN_WORK_ITEM_STARTED" &&
          raw.reasonCode === "WORK_ITEM_STARTED" &&
          raw.beforeStatus === "Queued" &&
          raw.afterStatus === "In Progress" &&
          quantityDelta === null &&
          completedQuantity === null &&
          requiredQuantity === null
        : eventType === "KitchenItemProgressRecorded"
          ? raw.actionCode === "KITCHEN_WORK_ITEM_COMPLETION_RECORDED" &&
            raw.reasonCode === "COMPLETION_QUANTITY_RECORDED" &&
            raw.beforeStatus === "In Progress" &&
            raw.afterStatus === "In Progress" &&
            quantityDelta !== null &&
            completedQuantity !== null &&
            requiredQuantity !== null &&
            completedQuantity < requiredQuantity &&
            quantityDelta <= completedQuantity
          : raw.actionCode === "KITCHEN_WORK_ITEM_COMPLETION_RECORDED" &&
            raw.reasonCode === "COMPLETION_QUANTITY_RECORDED" &&
            raw.beforeStatus === "In Progress" &&
            raw.afterStatus === "Completed" &&
            quantityDelta !== null &&
            completedQuantity !== null &&
            requiredQuantity !== null &&
            completedQuantity === requiredQuantity &&
            quantityDelta <= completedQuantity;
  if (!literalValid) return invalid();
  const proof = Object.freeze({
    kind: "Event" as const,
    eventType,
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    ticketReference: reference(raw.ticketReference),
    workItemReference: reference(raw.workItemReference),
    orderItemReference: reference(raw.orderItemReference),
    operationReference: reference(raw.operationReference),
    actionCode: raw.actionCode as KitchenQueueLifecycleEventProof["actionCode"],
    purpose: "KitchenWorkExecution" as const,
    reasonCode: raw.reasonCode as KitchenQueueLifecycleEventProof["reasonCode"],
    sourceChannel: "KDS_COMMAND" as const,
    actor: proofActor(raw.actor, "User") as KitchenQueueLifecycleEventProof["actor"],
    expectedTicketVersion,
    committedTicketVersion,
    expectedWorkItemVersion,
    committedWorkItemVersion,
    beforeStatus: raw.beforeStatus as KitchenQueueLifecycleEventProof["beforeStatus"],
    afterStatus: raw.afterStatus as KitchenQueueLifecycleEventProof["afterStatus"],
    quantityDelta,
    completedQuantity,
    requiredQuantity,
    occurredAt: instant(raw.occurredAt),
    auditReference: reference(raw.auditReference),
    auditSemanticDigest: digest(raw.auditSemanticDigest),
    effectDigest: digest(raw.effectDigest),
    eventReference: reference(raw.eventReference),
    eventSemanticDigest: digest(raw.eventSemanticDigest),
    projectionProofDigest: digest(raw.projectionProofDigest),
  });
  if (
    new Set([proof.operationReference, proof.auditReference, proof.eventReference]).size !== 3 ||
    proof.projectionProofDigest !== canonicalDigest(sha256, normalizedProofValue(proof))
  )
    return invalid();
  return proof;
}

function parseManualReadyProof(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueManualReadyProof {
  const raw = exact(value, [
    "kind",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "operationReference",
    "actionCode",
    "purpose",
    "reasonCode",
    "sourceChannel",
    "actor",
    "expectedTicketVersion",
    "committedTicketVersion",
    "workItemVersion",
    "workItemStatus",
    "workItems",
    "workItemsDigest",
    "readyResultReference",
    "readyQuantity",
    "requiredQuantity",
    "readyAt",
    "auditReference",
    "auditSemanticDigest",
    "effectDigest",
    "eventReference",
    "eventSemanticDigest",
    "projectionProofDigest",
  ]);
  if (
    raw.kind !== "ManualReady" ||
    raw.actionCode !== "KITCHEN_ORDER_ITEM_READY" ||
    raw.purpose !== "KitchenExpoCoordination" ||
    raw.reasonCode !== "EXPO_MARKED_READY" ||
    raw.sourceChannel !== "KDS_COMMAND" ||
    raw.workItemStatus !== "Completed" ||
    raw.eventReference !== null ||
    raw.eventSemanticDigest !== null
  )
    return invalid();
  const workItemReference = reference(raw.workItemReference);
  const workItemVersion = positiveBigint(raw.workItemVersion);
  const workItems = proofWorkItems(raw.workItems);
  const expectedTicketVersion = positiveBigint(raw.expectedTicketVersion);
  const committedTicketVersion = positiveBigint(raw.committedTicketVersion);
  const readyQuantity = integer(raw.readyQuantity, 1, 999);
  const requiredQuantity = integer(raw.requiredQuantity, 1, 999);
  if (
    committedTicketVersion !== expectedTicketVersion + 1n ||
    workItems[0]?.workItemReference !== workItemReference ||
    workItems[0]?.workItemVersion !== workItemVersion ||
    readyQuantity !== requiredQuantity
  )
    return invalid();
  const workItemsDigest = digest(raw.workItemsDigest);
  if (
    workItemsDigest !==
    canonicalDigest(
      sha256,
      Object.freeze(
        workItems.map((item) =>
          Object.freeze({
            workItemReference: item.workItemReference,
            workItemVersion: item.workItemVersion.toString(10),
          }),
        ),
      ),
    )
  )
    return invalid();
  const proof = Object.freeze({
    kind: "ManualReady" as const,
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    ticketReference: reference(raw.ticketReference),
    workItemReference,
    orderItemReference: reference(raw.orderItemReference),
    operationReference: reference(raw.operationReference),
    actionCode: "KITCHEN_ORDER_ITEM_READY" as const,
    purpose: "KitchenExpoCoordination" as const,
    reasonCode: "EXPO_MARKED_READY" as const,
    sourceChannel: "KDS_COMMAND" as const,
    actor: proofActor(raw.actor, "User") as KitchenQueueManualReadyProof["actor"],
    expectedTicketVersion,
    committedTicketVersion,
    workItemVersion,
    workItemStatus: "Completed" as const,
    workItems,
    workItemsDigest,
    readyResultReference: reference(raw.readyResultReference),
    readyQuantity,
    requiredQuantity,
    readyAt: instant(raw.readyAt),
    auditReference: reference(raw.auditReference),
    auditSemanticDigest: digest(raw.auditSemanticDigest),
    effectDigest: digest(raw.effectDigest),
    eventReference: null,
    eventSemanticDigest: null,
    projectionProofDigest: digest(raw.projectionProofDigest),
  });
  if (
    new Set([proof.operationReference, proof.readyResultReference, proof.auditReference]).size !==
      3 ||
    proof.projectionProofDigest !== canonicalDigest(sha256, normalizedProofValue(proof))
  )
    return invalid();
  return proof;
}

function parseAutomaticReadyProof(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueAutomaticReadyProof {
  const raw = exact(value, [
    "kind",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "operationReference",
    "parentOperationReference",
    "committedTicketVersion",
    "workItemVersion",
    "workItemStatus",
    "actionCode",
    "purpose",
    "reasonCode",
    "sourceChannel",
    "actor",
    "workItems",
    "workItemsDigest",
    "readyResultReference",
    "readyQuantity",
    "requiredQuantity",
    "readyAt",
    "auditReference",
    "auditSemanticDigest",
    "effectDigest",
    "eventReference",
    "eventSemanticDigest",
    "readyCausalBundleDigest",
    "projectionProofDigest",
  ]);
  if (
    raw.kind !== "AutomaticReady" ||
    raw.actionCode !== "KITCHEN_ORDER_ITEM_READY" ||
    raw.purpose !== "KitchenExpoCoordination" ||
    raw.reasonCode !== "ALL_WORK_ITEMS_COMPLETED" ||
    raw.sourceChannel !== "KITCHEN_AUTOMATION" ||
    raw.workItemStatus !== "Completed" ||
    raw.eventReference !== null ||
    raw.eventSemanticDigest !== null
  )
    return invalid();
  const workItemReference = reference(raw.workItemReference);
  const workItemVersion = positiveBigint(raw.workItemVersion);
  const workItems = proofWorkItems(raw.workItems);
  const readyQuantity = integer(raw.readyQuantity, 1, 999);
  const requiredQuantity = integer(raw.requiredQuantity, 1, 999);
  if (
    workItems[0]?.workItemReference !== workItemReference ||
    workItems[0]?.workItemVersion !== workItemVersion ||
    readyQuantity !== requiredQuantity
  )
    return invalid();
  const workItemsDigest = digest(raw.workItemsDigest);
  if (
    workItemsDigest !==
    canonicalDigest(
      sha256,
      Object.freeze(
        workItems.map((item) =>
          Object.freeze({
            workItemReference: item.workItemReference,
            workItemVersion: item.workItemVersion.toString(10),
          }),
        ),
      ),
    )
  )
    return invalid();
  const proof = Object.freeze({
    kind: "AutomaticReady" as const,
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    ticketReference: reference(raw.ticketReference),
    workItemReference,
    orderItemReference: reference(raw.orderItemReference),
    operationReference: reference(raw.operationReference),
    parentOperationReference: reference(raw.parentOperationReference),
    committedTicketVersion: positiveBigint(raw.committedTicketVersion),
    workItemVersion,
    workItemStatus: "Completed" as const,
    actionCode: "KITCHEN_ORDER_ITEM_READY" as const,
    purpose: "KitchenExpoCoordination" as const,
    reasonCode: "ALL_WORK_ITEMS_COMPLETED" as const,
    sourceChannel: "KITCHEN_AUTOMATION" as const,
    actor: proofActor(raw.actor, "System") as KitchenQueueAutomaticReadyProof["actor"],
    workItems,
    workItemsDigest,
    readyResultReference: reference(raw.readyResultReference),
    readyQuantity,
    requiredQuantity,
    readyAt: instant(raw.readyAt),
    auditReference: reference(raw.auditReference),
    auditSemanticDigest: digest(raw.auditSemanticDigest),
    effectDigest: digest(raw.effectDigest),
    eventReference: null,
    eventSemanticDigest: null,
    readyCausalBundleDigest: digest(raw.readyCausalBundleDigest),
    projectionProofDigest: digest(raw.projectionProofDigest),
  });
  if (
    new Set([
      proof.operationReference,
      proof.parentOperationReference,
      proof.readyResultReference,
      proof.auditReference,
    ]).size !== 4 ||
    proof.projectionProofDigest !== canonicalDigest(sha256, normalizedProofValue(proof))
  )
    return invalid();
  return proof;
}

function parseLifecycleProof(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueLifecycleProjectionProof {
  const snapshot = descriptorSnapshot(value);
  return snapshot.kind === "Event"
    ? parseLifecycleEventProof(value, sha256)
    : snapshot.kind === "ManualReady"
      ? parseManualReadyProof(value, sha256)
      : snapshot.kind === "AutomaticReady"
        ? parseAutomaticReadyProof(value, sha256)
        : invalid();
}

function lifecycleProofOccurredAt(proof: KitchenQueueLifecycleProjectionProof): KitchenInstant {
  return proof.kind === "Event" ? proof.occurredAt : proof.readyAt;
}

function parseLifecycleProofBundle(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueLifecycleProofBundle {
  const raw = exact(value, [
    "ticketReference",
    "operationCount",
    "readyResultCount",
    "lifecycleProofSetDigest",
    "proofs",
  ]);
  const ticketReference = reference(raw.ticketReference);
  const proofs = exactArray(raw.proofs, 0, Number.MAX_SAFE_INTEGER)
    .map((proof) => parseLifecycleProof(proof, sha256))
    .sort((left, right) => {
      const leftVersion = left.committedTicketVersion;
      const rightVersion = right.committedTicketVersion;
      return leftVersion < rightVersion
        ? -1
        : leftVersion > rightVersion
          ? 1
          : compareAscii(left.operationReference, right.operationReference);
    });
  const operationCount = integer(raw.operationCount, 0, Number.MAX_SAFE_INTEGER);
  const readyResultCount = integer(raw.readyResultCount, 0, Number.MAX_SAFE_INTEGER);
  if (
    operationCount !== proofs.length ||
    readyResultCount !== proofs.filter((proof) => proof.kind !== "Event").length ||
    proofs.some((proof) => proof.ticketReference !== ticketReference) ||
    new Set(proofs.map((proof) => proof.operationReference)).size !== proofs.length ||
    new Set(
      proofs.map((proof) => `${proof.committedTicketVersion.toString(10)}:${proof.actionCode}`),
    ).size !== proofs.length
  )
    return invalid();
  const ownedReferences = proofs.flatMap((proof) => [
    proof.operationReference,
    proof.auditReference,
    ...(proof.eventReference === null ? [] : [proof.eventReference]),
    ...(proof.kind === "Event" ? [] : [proof.readyResultReference]),
  ]);
  if (new Set(ownedReferences).size !== ownedReferences.length) return invalid();
  const primary = proofs.filter((proof) => proof.kind !== "AutomaticReady");
  if (
    primary.some((proof, index) => {
      const previous = primary[index - 1];
      return (
        proof.committedTicketVersion !== BigInt(index + 2) ||
        ("expectedTicketVersion" in proof && proof.expectedTicketVersion !== BigInt(index + 1)) ||
        (previous !== undefined &&
          Date.parse(lifecycleProofOccurredAt(proof)) <
            Date.parse(lifecycleProofOccurredAt(previous)))
      );
    })
  )
    return invalid();
  for (const proof of proofs) {
    if (proof.kind !== "AutomaticReady") continue;
    const parent = proofs.find(
      (candidate): candidate is KitchenQueueLifecycleEventProof =>
        candidate.kind === "Event" &&
        candidate.eventType === "KitchenItemCompleted" &&
        candidate.operationReference === proof.parentOperationReference,
    );
    if (
      parent === undefined ||
      parent.committedTicketVersion !== proof.committedTicketVersion ||
      parent.workItemReference !== proof.workItemReference ||
      parent.orderItemReference !== proof.orderItemReference ||
      parent.committedWorkItemVersion !== proof.workItemVersion ||
      parent.occurredAt !== proof.readyAt ||
      proof.readyCausalBundleDigest !==
        canonicalDigest(
          sha256,
          Object.freeze({
            parentProjectionProofDigest: parent.projectionProofDigest,
            childProjectionProofDigest: proof.projectionProofDigest,
            readyResultReference: proof.readyResultReference,
            workItems: proof.workItems.map((item) =>
              Object.freeze({
                workItemReference: item.workItemReference,
                workItemVersion: item.workItemVersion.toString(10),
              }),
            ),
            workItemsDigest: proof.workItemsDigest,
            readyQuantity: proof.readyQuantity,
            requiredQuantity: proof.requiredQuantity,
            readyAt: proof.readyAt,
          }),
        )
    )
      return invalid();
  }
  const lifecycleProofSetDigest = digest(raw.lifecycleProofSetDigest);
  if (
    lifecycleProofSetDigest !==
    canonicalDigest(
      sha256,
      Object.freeze({
        normalizedProjectionProofs: proofs.map((proof) =>
          Object.freeze({
            committedTicketVersion: proof.committedTicketVersion.toString(10),
            operationReference: proof.operationReference,
            projectionProofDigest: proof.projectionProofDigest,
          }),
        ),
      }),
    )
  )
    return invalid();
  return Object.freeze({
    ticketReference,
    operationCount,
    readyResultCount,
    lifecycleProofSetDigest,
    proofs: Object.freeze(proofs),
  });
}

function parseLifecycleSourceItem(value: unknown, includeReady: boolean): KitchenQueueSourceItem {
  const fields = [
    "ticketReference",
    "workItemReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "sourceItemOrdinal",
    "ticketAggregateVersion",
    "workItemVersion",
    "status",
    "requiredQuantity",
    "completedQuantity",
    "localizedDisplayNames",
    "selectedOptions",
    "stationReference",
    "workItemCreatedAt",
    "acceptedAt",
    ...(includeReady ? ["orderItemReadyAt"] : []),
    "catalogSnapshotControlled",
  ];
  const raw = exact(value, fields);
  return parseSourceItem({
    ...raw,
    orderItemReadyAt: includeReady ? raw.orderItemReadyAt : null,
  });
}

function reconcileLifecycleTicket(
  ticket: KitchenQueueLifecycleSourceTicket,
  bundle: KitchenQueueLifecycleProofBundle,
  includeReady: boolean,
): void {
  if (bundle.ticketReference !== ticket.ticketReference) return invalid();
  const primary = bundle.proofs.filter((proof) => proof.kind !== "AutomaticReady");
  const expectedTicketVersion = BigInt(primary.length + 1);
  const latestPrimary = primary.at(-1);
  const observedReferences = new Set([
    ticket.brandReference,
    ticket.storeReference,
    ticket.ticketReference,
    ticket.orderReference,
    ticket.orderBatchReference,
    ticket.sourceEvent.eventId,
    ticket.sourceEvent.correlationId,
    ticket.sourceEvent.causationId,
    ticket.sourceEvent.payload.confirmationReference,
    ...ticket.items.flatMap((item) => [
      item.workItemReference,
      item.orderItemReference,
      item.stationReference,
    ]),
    ...bundle.proofs.flatMap((proof) =>
      proof.actor.actorReference === null ? [] : [proof.actor.actorReference],
    ),
  ]);
  if (
    ticket.ticketAggregateVersion !== expectedTicketVersion ||
    ticket.updatedAt !==
      (latestPrimary === undefined
        ? ticket.sourceEvent.occurredAt
        : lifecycleProofOccurredAt(latestPrimary)) ||
    bundle.proofs.some(
      (proof) =>
        proof.brandReference !== ticket.brandReference ||
        proof.storeReference !== ticket.storeReference ||
        !ticket.items.some(
          (item) =>
            item.workItemReference === proof.workItemReference &&
            item.orderItemReference === proof.orderItemReference,
        ) ||
        observedReferences.has(proof.operationReference) ||
        observedReferences.has(proof.auditReference) ||
        (proof.eventReference !== null && observedReferences.has(proof.eventReference)) ||
        (proof.kind !== "Event" && observedReferences.has(proof.readyResultReference)),
    )
  )
    return invalid();
  for (const item of ticket.items) {
    const eventProofs = bundle.proofs.filter(
      (proof): proof is KitchenQueueLifecycleEventProof =>
        proof.kind === "Event" && proof.workItemReference === item.workItemReference,
    );
    const readyProofs = bundle.proofs.filter(
      (proof): proof is KitchenQueueManualReadyProof | KitchenQueueAutomaticReadyProof =>
        proof.kind !== "Event" && proof.orderItemReference === item.orderItemReference,
    );
    const accept = eventProofs.filter((proof) => proof.eventType === "KitchenWorkAccepted");
    let expectedStatus: KitchenQueueWorkItemStatus = "Queued";
    let expectedCompletedQuantity = 0;
    let expectedAcceptedAt: KitchenInstant | null = null;
    let acceptingActorReference: KitchenReference | null = null;
    let priorFactAt: KitchenInstant = item.workItemCreatedAt;
    for (const proof of eventProofs) {
      if (
        proof.beforeStatus !== expectedStatus ||
        Date.parse(proof.occurredAt) < Date.parse(priorFactAt) ||
        Date.parse(proof.occurredAt) > Date.parse(ticket.updatedAt)
      )
        return invalid();
      if (proof.eventType === "KitchenWorkAccepted") {
        if (expectedAcceptedAt !== null) return invalid();
        expectedAcceptedAt = proof.occurredAt;
        acceptingActorReference = proof.actor.actorReference;
      } else if (proof.eventType === "KitchenWorkStarted") {
        if (
          expectedAcceptedAt === null ||
          expectedStatus !== "Queued" ||
          proof.actor.actorReference !== acceptingActorReference
        )
          return invalid();
        expectedStatus = "In Progress";
      } else {
        if (
          expectedStatus !== "In Progress" ||
          proof.actor.actorReference !== acceptingActorReference ||
          proof.quantityDelta === null ||
          proof.completedQuantity === null ||
          proof.requiredQuantity !== item.requiredQuantity ||
          proof.completedQuantity !== expectedCompletedQuantity + proof.quantityDelta
        )
          return invalid();
        expectedCompletedQuantity = proof.completedQuantity;
        if (proof.eventType === "KitchenItemCompleted") expectedStatus = "Completed";
      }
      priorFactAt = proof.occurredAt;
    }
    if (
      accept.length > 1 ||
      readyProofs.length > 1 ||
      item.workItemVersion !== BigInt(eventProofs.length + 1) ||
      item.acceptedAt !== expectedAcceptedAt ||
      (includeReady && item.orderItemReadyAt !== (readyProofs[0]?.readyAt ?? null)) ||
      item.status !== expectedStatus ||
      item.completedQuantity !== expectedCompletedQuantity ||
      eventProofs.some(
        (proof, index) =>
          proof.expectedWorkItemVersion !== BigInt(index + 1) ||
          proof.committedWorkItemVersion !== BigInt(index + 2) ||
          proof.brandReference !== ticket.brandReference ||
          proof.storeReference !== ticket.storeReference ||
          proof.orderItemReference !== item.orderItemReference,
      )
    )
      return invalid();
    if (
      readyProofs.some(
        (proof) =>
          proof.brandReference !== ticket.brandReference ||
          proof.storeReference !== ticket.storeReference ||
          proof.workItemReference !== item.workItemReference ||
          proof.workItemVersion !== item.workItemVersion ||
          proof.readyQuantity !== item.requiredQuantity ||
          Date.parse(proof.readyAt) < Date.parse(item.workItemCreatedAt) ||
          Date.parse(proof.readyAt) > Date.parse(ticket.updatedAt),
      )
    )
      return invalid();
  }
}

function parseKitchenQueueLifecycleSourceFeed(
  value: unknown,
  includeReady: boolean,
  sha256: KitchenQueueDigestPort,
): KitchenQueueLifecycleSourceFeed {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "sourceCheckpointReference",
    "asOfUtc",
    "coverageStatus",
    "tickets",
  ]);
  if (raw.coverageStatus !== "CompleteThroughCheckpoint") return invalid();
  const rawTickets = exactArray(
    raw.tickets,
    includeReady ? 0 : 1,
    includeReady ? Number.MAX_SAFE_INTEGER : 1,
  );
  const proofBundles: KitchenQueueLifecycleProofBundle[] = [];
  const baseTickets: KitchenQueueSourceTicket[] = [];
  const tickets = rawTickets.map((value) => {
    const ticketRaw = exact(value, [
      "brandReference",
      "storeReference",
      "ticketReference",
      "orderReference",
      "orderBatchReference",
      "ticketAggregateVersion",
      "ticketStatus",
      "updatedAt",
      "sourceEvent",
      "items",
      "proofBundle",
    ]);
    const bundle = parseLifecycleProofBundle(ticketRaw.proofBundle, sha256);
    const items = exactArray(ticketRaw.items, 1, Number.MAX_SAFE_INTEGER).map((item) =>
      parseLifecycleSourceItem(item, includeReady),
    );
    const baseTicket = parseKitchenQueueSourceTicket({
      brandReference: ticketRaw.brandReference,
      storeReference: ticketRaw.storeReference,
      ticketReference: ticketRaw.ticketReference,
      orderReference: ticketRaw.orderReference,
      orderBatchReference: ticketRaw.orderBatchReference,
      ticketAggregateVersion: ticketRaw.ticketAggregateVersion,
      ticketStatus: ticketRaw.ticketStatus,
      sourceEvent: ticketRaw.sourceEvent,
      items,
    });
    const updatedAt = instant(ticketRaw.updatedAt);
    if (
      Date.parse(updatedAt) < Date.parse(baseTicket.sourceEvent.occurredAt) ||
      baseTicket.items.some(
        (item) =>
          Date.parse(item.workItemCreatedAt) > Date.parse(updatedAt) ||
          (item.acceptedAt !== null && Date.parse(item.acceptedAt) > Date.parse(updatedAt)) ||
          (item.orderItemReadyAt !== null &&
            Date.parse(item.orderItemReadyAt) > Date.parse(updatedAt)),
      )
    )
      return invalid();
    const ticket: KitchenQueueLifecycleSourceTicket = Object.freeze({
      ...baseTicket,
      updatedAt,
    });
    reconcileLifecycleTicket(ticket, bundle, includeReady);
    proofBundles.push(bundle);
    baseTickets.push(baseTicket);
    return ticket;
  });
  const baseQueueFeed = parseKitchenQueueSourceFeed({
    brandReference: raw.brandReference,
    storeReference: raw.storeReference,
    sourceCheckpointReference: raw.sourceCheckpointReference,
    asOfUtc: raw.asOfUtc,
    coverageStatus: raw.coverageStatus,
    tickets: baseTickets,
  });
  if (
    tickets.some((ticket) => Date.parse(ticket.updatedAt) > Date.parse(baseQueueFeed.asOfUtc)) ||
    proofBundles.some((bundle) =>
      bundle.proofs.some(
        (proof) =>
          Date.parse(proof.kind === "Event" ? proof.occurredAt : proof.readyAt) >
          Date.parse(baseQueueFeed.asOfUtc),
      ),
    )
  )
    return invalid();
  const orderedTickets = tickets
    .map((ticket, index) => {
      const proofBundle = proofBundles[index];
      if (proofBundle === undefined || proofBundle.ticketReference !== ticket.ticketReference)
        return invalid();
      return Object.freeze({ ticket, proofBundle });
    })
    .sort((left, right) => compareAscii(left.ticket.ticketReference, right.ticket.ticketReference));
  const allProofs = orderedTickets.flatMap(({ proofBundle }) => proofBundle.proofs);
  const ownedReferences = allProofs.flatMap((proof) => [
    proof.operationReference,
    proof.auditReference,
    ...(proof.eventReference === null ? [] : [proof.eventReference]),
    ...(proof.kind === "Event" ? [] : [proof.readyResultReference]),
  ]);
  const observedReferences = new Set(
    orderedTickets.flatMap(({ ticket, proofBundle }) => [
      ticket.brandReference,
      ticket.storeReference,
      ticket.ticketReference,
      ticket.orderReference,
      ticket.orderBatchReference,
      ticket.sourceEvent.eventId,
      ticket.sourceEvent.correlationId,
      ticket.sourceEvent.causationId,
      ticket.sourceEvent.payload.confirmationReference,
      ...ticket.items.flatMap((item) => [
        item.workItemReference,
        item.orderItemReference,
        item.stationReference,
      ]),
      ...proofBundle.proofs.flatMap((proof) =>
        proof.actor.actorReference === null ? [] : [proof.actor.actorReference],
      ),
    ]),
  );
  if (
    new Set(ownedReferences).size !== ownedReferences.length ||
    ownedReferences.some((reference) => observedReferences.has(reference))
  )
    return invalid();
  const queueFeed: KitchenQueueLifecycleQueueFeed = Object.freeze({
    ...baseQueueFeed,
    tickets: Object.freeze(orderedTickets.map(({ ticket }) => ticket)),
  });
  return Object.freeze({
    queueFeed,
    proofBundles: Object.freeze(orderedTickets.map(({ proofBundle }) => proofBundle)),
  });
}

export function parseKitchenQueueLifecycleIncrementalSourceFeed(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueLifecycleSourceFeed {
  const source = parseKitchenQueueLifecycleSourceFeed(value, false, sha256);
  if (
    source.queueFeed.tickets.length !== 1 ||
    source.proofBundles.length !== 1 ||
    source.proofBundles[0]?.proofs.length === 0
  )
    return invalid();
  return source;
}

export function parseKitchenQueueLifecycleRebuildSourceFeed(
  value: unknown,
  sha256: KitchenQueueDigestPort,
): KitchenQueueLifecycleSourceFeed {
  return parseKitchenQueueLifecycleSourceFeed(value, true, sha256);
}

export function parseKitchenQueueRow(value: unknown): KitchenQueueRow {
  const raw = exact(value, [
    "projectionGenerationReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "sourceItemOrdinal",
    "ticketAggregateVersion",
    "workItemVersion",
    "status",
    "requiredQuantity",
    "completedQuantity",
    "localizedDisplayNames",
    "selectedOptions",
    "stationReference",
    "originalSourceEventReference",
    "sourceEventSemanticDigest",
    "sourceEventOccurredAt",
    "workItemCreatedAt",
    "acceptedAt",
    "orderItemReadyAt",
  ]);
  const requiredQuantity = integer(raw.requiredQuantity, 1, 999);
  const completedQuantity = integer(raw.completedQuantity, 0, requiredQuantity);
  const status = workItemStatus(raw.status);
  const sourceEventOccurredAt = instant(raw.sourceEventOccurredAt);
  const workItemCreatedAt = instant(raw.workItemCreatedAt);
  const acceptedAt = optionalInstant(raw.acceptedAt);
  const orderItemReadyAt = optionalInstant(raw.orderItemReadyAt);
  if (
    !validQuantityStatus(status, completedQuantity, requiredQuantity) ||
    sourceEventOccurredAt !== workItemCreatedAt ||
    (acceptedAt !== null && Date.parse(acceptedAt) < Date.parse(workItemCreatedAt)) ||
    (orderItemReadyAt !== null &&
      (status !== "Completed" ||
        acceptedAt === null ||
        Date.parse(orderItemReadyAt) < Date.parse(acceptedAt)))
  )
    return invalid();
  return Object.freeze({
    projectionGenerationReference: reference(raw.projectionGenerationReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    ticketReference: reference(raw.ticketReference),
    workItemReference: reference(raw.workItemReference),
    orderReference: reference(raw.orderReference),
    orderBatchReference: reference(raw.orderBatchReference),
    orderItemReference: reference(raw.orderItemReference),
    sourceItemOrdinal: integer(raw.sourceItemOrdinal, 1, 100),
    ticketAggregateVersion: positiveBigint(raw.ticketAggregateVersion),
    workItemVersion: positiveBigint(raw.workItemVersion),
    status,
    requiredQuantity,
    completedQuantity,
    localizedDisplayNames: localizedNames(raw.localizedDisplayNames),
    selectedOptions: selectedOptions(raw.selectedOptions),
    stationReference: reference(raw.stationReference),
    originalSourceEventReference: reference(raw.originalSourceEventReference),
    sourceEventSemanticDigest: digest(raw.sourceEventSemanticDigest),
    sourceEventOccurredAt,
    workItemCreatedAt,
    acceptedAt,
    orderItemReadyAt,
  });
}

export function parseKitchenQueueRows(value: unknown): readonly KitchenQueueRow[] {
  const rows = exactArray(value, 0, Number.MAX_SAFE_INTEGER).map(parseKitchenQueueRow);
  return Object.freeze(rows);
}

export function parseKitchenQueueStoredGeneration(value: unknown): KitchenQueueStoredGeneration {
  const raw = exact(value, [
    "projectionGenerationReference",
    "brandReference",
    "storeReference",
    "projectionName",
    "projectionVersion",
    "snapshotBindingVersion",
    "generationStatus",
    "sourceCheckpointReference",
    "sourceEventBindingDigest",
    "queueSnapshotDigest",
    "ticketCount",
    "workItemCount",
    "initializedEmpty",
    "asOfUtc",
    "projectedAt",
    "activationLagMs",
    "lastRebuiltAt",
    "freshnessStatus",
    "rebuildReference",
    "rebuildRequestDigest",
    "rebuildRequestedAt",
    "expectedPriorGenerationReference",
  ]);
  if (
    raw.projectionName !== kitchenQueueProjectionName ||
    raw.projectionVersion !== kitchenQueueProjectionVersion ||
    typeof raw.generationStatus !== "string" ||
    !["Building", "Active", "Retired"].includes(raw.generationStatus) ||
    typeof raw.initializedEmpty !== "boolean" ||
    typeof raw.freshnessStatus !== "string" ||
    !["Fresh", "Stale"].includes(raw.freshnessStatus)
  )
    return invalid();
  const ticketCount = integer(raw.ticketCount, 0, Number.MAX_SAFE_INTEGER);
  const workItemCount = integer(raw.workItemCount, 0, Number.MAX_SAFE_INTEGER);
  const snapshotBindingVersion = integer(raw.snapshotBindingVersion, 1, 2) as 1 | 2;
  const asOfUtc = instant(raw.asOfUtc);
  const projectedAt = instant(raw.projectedAt);
  const activationLagMs = integer(raw.activationLagMs, 0, Number.MAX_SAFE_INTEGER);
  const calculatedLag = Date.parse(projectedAt) - Date.parse(asOfUtc);
  const freshnessStatus = raw.freshnessStatus as KitchenQueueFreshnessStatus;
  const rebuildReference = optionalReference(raw.rebuildReference);
  const rebuildRequestDigest = optionalDigest(raw.rebuildRequestDigest);
  const rebuildRequestedAt = optionalInstant(raw.rebuildRequestedAt);
  const expectedPriorGenerationReference = optionalReference(raw.expectedPriorGenerationReference);
  const lastRebuiltAt = optionalInstant(raw.lastRebuiltAt);
  const isRebuild = rebuildReference !== null;
  if (
    calculatedLag !== activationLagMs ||
    (activationLagMs <= 2000 ? freshnessStatus !== "Fresh" : freshnessStatus !== "Stale") ||
    raw.initializedEmpty !== (ticketCount === 0 && workItemCount === 0) ||
    (ticketCount === 0) !== (workItemCount === 0) ||
    workItemCount < ticketCount ||
    (lastRebuiltAt !== null && Date.parse(lastRebuiltAt) > Date.parse(projectedAt)) ||
    (rebuildRequestedAt !== null && Date.parse(rebuildRequestedAt) > Date.parse(projectedAt)) ||
    (isRebuild && lastRebuiltAt !== projectedAt) ||
    (raw.initializedEmpty && !isRebuild) ||
    isRebuild !== (rebuildRequestDigest !== null) ||
    isRebuild !== (rebuildRequestedAt !== null) ||
    (!isRebuild && expectedPriorGenerationReference !== null)
  )
    return invalid();
  return Object.freeze({
    projectionGenerationReference: reference(raw.projectionGenerationReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    projectionName: kitchenQueueProjectionName,
    projectionVersion: kitchenQueueProjectionVersion,
    snapshotBindingVersion,
    generationStatus: raw.generationStatus as KitchenQueueGenerationStatus,
    sourceCheckpointReference: reference(raw.sourceCheckpointReference),
    sourceEventBindingDigest: digest(raw.sourceEventBindingDigest),
    queueSnapshotDigest: digest(raw.queueSnapshotDigest),
    ticketCount,
    workItemCount,
    initializedEmpty: raw.initializedEmpty,
    asOfUtc,
    projectedAt,
    activationLagMs,
    lastRebuiltAt,
    freshnessStatus,
    rebuildReference,
    rebuildRequestDigest,
    rebuildRequestedAt,
    expectedPriorGenerationReference,
  });
}

function publicGeneration(generation: KitchenQueueStoredGeneration): KitchenQueueGeneration {
  return Object.freeze({
    projectionGenerationReference: generation.projectionGenerationReference,
    brandReference: generation.brandReference,
    storeReference: generation.storeReference,
    projectionName: generation.projectionName,
    projectionVersion: generation.projectionVersion,
    generationStatus: generation.generationStatus,
    sourceCheckpointReference: generation.sourceCheckpointReference,
    sourceEventBindingDigest: generation.sourceEventBindingDigest,
    queueSnapshotDigest: generation.queueSnapshotDigest,
    ticketCount: generation.ticketCount,
    workItemCount: generation.workItemCount,
    initializedEmpty: generation.initializedEmpty,
    asOfUtc: generation.asOfUtc,
    projectedAt: generation.projectedAt,
    activationLagMs: generation.activationLagMs,
    lastRebuiltAt: generation.lastRebuiltAt,
    freshnessStatus: generation.freshnessStatus,
    rebuildReference: generation.rebuildReference,
    rebuildRequestDigest: generation.rebuildRequestDigest,
    rebuildRequestedAt: generation.rebuildRequestedAt,
    expectedPriorGenerationReference: generation.expectedPriorGenerationReference,
  });
}

export function parseKitchenQueueGeneration(value: unknown): KitchenQueueGeneration {
  const raw = exact(value, [
    "projectionGenerationReference",
    "brandReference",
    "storeReference",
    "projectionName",
    "projectionVersion",
    "generationStatus",
    "sourceCheckpointReference",
    "sourceEventBindingDigest",
    "queueSnapshotDigest",
    "ticketCount",
    "workItemCount",
    "initializedEmpty",
    "asOfUtc",
    "projectedAt",
    "activationLagMs",
    "lastRebuiltAt",
    "freshnessStatus",
    "rebuildReference",
    "rebuildRequestDigest",
    "rebuildRequestedAt",
    "expectedPriorGenerationReference",
  ]);
  return publicGeneration(parseKitchenQueueStoredGeneration({ ...raw, snapshotBindingVersion: 2 }));
}

export function stripKitchenQueueStoredGeneration(value: unknown): KitchenQueueGeneration {
  return publicGeneration(parseKitchenQueueStoredGeneration(value));
}

export function parseKitchenQueueRebuildRequest(value: unknown): KitchenQueueRebuildRequest {
  const raw = exact(value, [
    "action",
    "purpose",
    "projectionName",
    "projectionVersion",
    "brandReference",
    "storeReference",
    "rebuildReference",
    "expectedActiveGenerationReference",
    "requestedAt",
  ]);
  if (
    raw.action !== "RebuildKitchenQueueProjection" ||
    raw.purpose !== "ProjectionRecovery" ||
    raw.projectionName !== kitchenQueueProjectionName ||
    raw.projectionVersion !== kitchenQueueProjectionVersion
  )
    return invalid();
  return Object.freeze({
    action: "RebuildKitchenQueueProjection" as const,
    purpose: "ProjectionRecovery" as const,
    projectionName: kitchenQueueProjectionName,
    projectionVersion: kitchenQueueProjectionVersion,
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    rebuildReference: reference(raw.rebuildReference),
    expectedActiveGenerationReference: optionalReference(raw.expectedActiveGenerationReference),
    requestedAt: instant(raw.requestedAt),
  });
}

export function parseKitchenQueueFilters(value: unknown): KitchenQueueFilters {
  const raw = exact(value, [
    "orderReference",
    "ticketReference",
    "workItemReference",
    "stationReference",
    "status",
  ]);
  return Object.freeze({
    orderReference: optionalReference(raw.orderReference),
    ticketReference: optionalReference(raw.ticketReference),
    workItemReference: optionalReference(raw.workItemReference),
    stationReference: optionalReference(raw.stationReference),
    status: raw.status === null ? null : workItemStatus(raw.status),
  });
}

export function parseKitchenQueueCursor(value: unknown): KitchenQueueCursor {
  const raw = exact(value, [
    "projectionGenerationReference",
    "afterCreatedAt",
    "afterWorkItemReference",
    "filterSortDigest",
  ]);
  return Object.freeze({
    projectionGenerationReference: reference(raw.projectionGenerationReference),
    afterCreatedAt: instant(raw.afterCreatedAt),
    afterWorkItemReference: reference(raw.afterWorkItemReference),
    filterSortDigest: digest(raw.filterSortDigest),
  });
}

export function parseKitchenQueueListQuery(value: unknown): KitchenQueueListQuery {
  const raw = exact(value, [
    "actorReference",
    "brandReference",
    "storeReference",
    "observedAt",
    "filters",
    "cursor",
    "limit",
  ]);
  return Object.freeze({
    actorReference: reference(raw.actorReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    observedAt: instant(raw.observedAt),
    filters: parseKitchenQueueFilters(raw.filters),
    cursor: raw.cursor === null ? null : parseKitchenQueueCursor(raw.cursor),
    limit: integer(raw.limit, 1, 50),
  });
}

export function parseKitchenQueueGetQuery(value: unknown): KitchenQueueGetQuery {
  const raw = exact(value, [
    "actorReference",
    "brandReference",
    "storeReference",
    "observedAt",
    "workItemReference",
  ]);
  return Object.freeze({
    actorReference: reference(raw.actorReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    observedAt: instant(raw.observedAt),
    workItemReference: reference(raw.workItemReference),
  });
}

function canonicalDigest(port: KitchenQueueDigestPort, value: unknown): KitchenDigest {
  try {
    return digest(port(JSON.stringify(value)));
  } catch {
    throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
  }
}

export function computeKitchenQueueSourceEventSemanticDigest(
  value: unknown,
  port: KitchenQueueDigestPort,
): KitchenDigest {
  const event = parseKitchenQueueSourceEvent(value);
  return canonicalDigest(
    port,
    Object.freeze({
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      producerModule: event.producerModule,
      tenantId: event.tenantId,
      storeId: event.storeId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion.toString(10),
      correlationId: event.correlationId,
      causationId: event.causationId,
      actor: Object.freeze({ type: event.actor.type }),
      payload: Object.freeze({
        kitchenTicketReference: event.payload.kitchenTicketReference,
        orderReference: event.payload.orderReference,
        orderBatchReference: event.payload.orderBatchReference,
        confirmationReference: event.payload.confirmationReference,
        workItemCount: event.payload.workItemCount,
        aggregateVersion: event.payload.aggregateVersion,
        createdAt: event.payload.createdAt,
      }),
      redactionClassification: event.redactionClassification,
      replayMetadata: Object.freeze({ replaySafe: event.replayMetadata.replaySafe }),
    }),
  );
}

export function computeKitchenQueueSourceEventBindingDigest(
  values: readonly unknown[],
  port: KitchenQueueDigestPort,
): KitchenDigest {
  const rows = exactArray(values, 0, Number.MAX_SAFE_INTEGER).map(parseKitchenQueueRow);
  const perTicket = new Map<string, KitchenQueueRow>();
  const ticketByEventReference = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.ticketReference}:${row.ticketAggregateVersion.toString(10)}`;
    const existing = perTicket.get(key);
    const eventTicket = ticketByEventReference.get(row.originalSourceEventReference);
    if (
      (existing !== undefined &&
        (existing.originalSourceEventReference !== row.originalSourceEventReference ||
          existing.sourceEventSemanticDigest !== row.sourceEventSemanticDigest)) ||
      (eventTicket !== undefined && eventTicket !== key)
    )
      return invalid();
    perTicket.set(key, existing ?? row);
    ticketByEventReference.set(row.originalSourceEventReference, key);
  }
  const normalizedSourceBindings = [...perTicket.values()]
    .sort((left, right) =>
      compareAscii(left.originalSourceEventReference, right.originalSourceEventReference),
    )
    .map((row) =>
      Object.freeze({
        originalEventReference: row.originalSourceEventReference,
        sourceEventSemanticDigest: row.sourceEventSemanticDigest,
      }),
    );
  return canonicalDigest(port, Object.freeze({ normalizedSourceBindings }));
}

export function computeKitchenQueueSnapshotDigest(
  input: {
    readonly brandReference: unknown;
    readonly storeReference: unknown;
    readonly rows: readonly unknown[];
    readonly snapshotBindingVersion?: unknown;
  },
  port: KitchenQueueDigestPort,
): KitchenDigest {
  const brandReference = reference(input.brandReference);
  const storeReference = reference(input.storeReference);
  const snapshotBindingVersion =
    input.snapshotBindingVersion === undefined
      ? kitchenQueueSnapshotBindingVersion
      : (integer(input.snapshotBindingVersion, 1, 2) as 1 | 2);
  const rows = exactArray(input.rows, 0, Number.MAX_SAFE_INTEGER)
    .map(parseKitchenQueueRow)
    .sort((left, right) => compareAscii(left.workItemReference, right.workItemReference));
  if (
    rows.some(
      (row) => row.brandReference !== brandReference || row.storeReference !== storeReference,
    ) ||
    new Set(rows.map((row) => row.workItemReference)).size !== rows.length
  )
    return invalid();
  const ticketCount = new Set(rows.map((row) => row.ticketReference)).size;
  const normalizedSafeRows = rows.map((row) => {
    const common = {
      ticketReference: row.ticketReference,
      workItemReference: row.workItemReference,
      orderReference: row.orderReference,
      orderBatchReference: row.orderBatchReference,
      orderItemReference: row.orderItemReference,
      sourceItemOrdinal: row.sourceItemOrdinal,
      ticketAggregateVersion: row.ticketAggregateVersion.toString(10),
      workItemVersion: row.workItemVersion.toString(10),
      status: row.status,
      requiredQuantity: row.requiredQuantity,
      completedQuantity: row.completedQuantity,
      localizedDisplayNames: row.localizedDisplayNames,
      selectedOptions: row.selectedOptions,
      stationReference: row.stationReference,
      workItemCreatedAt: row.workItemCreatedAt,
    };
    return snapshotBindingVersion === 1
      ? Object.freeze(common)
      : Object.freeze({
          ...common,
          acceptedAt: row.acceptedAt,
          orderItemReadyAt: row.orderItemReadyAt,
        });
  });
  return canonicalDigest(
    port,
    Object.freeze({
      projectionName: kitchenQueueProjectionName,
      projectionVersion: kitchenQueueProjectionVersion,
      ...(snapshotBindingVersion === 2 ? { snapshotBindingVersion } : {}),
      brandReference,
      storeReference,
      ticketCount,
      workItemCount: rows.length,
      normalizedSafeRows,
    }),
  );
}

export function reconcileKitchenQueueStoredProjectionBundle(
  input: {
    readonly generation: unknown;
    readonly rows: unknown;
  },
  port: KitchenQueueDigestPort,
): KitchenQueueStoredProjectionBundle {
  const generation = parseKitchenQueueStoredGeneration(input.generation);
  const rows = parseKitchenQueueRows(input.rows);
  const tickets = new Map<string, KitchenQueueRow[]>();
  for (const row of rows) {
    if (
      row.projectionGenerationReference !== generation.projectionGenerationReference ||
      row.brandReference !== generation.brandReference ||
      row.storeReference !== generation.storeReference ||
      Date.parse(row.sourceEventOccurredAt) > Date.parse(generation.asOfUtc) ||
      Date.parse(row.workItemCreatedAt) > Date.parse(generation.asOfUtc) ||
      (row.acceptedAt !== null && Date.parse(row.acceptedAt) > Date.parse(generation.asOfUtc)) ||
      (row.orderItemReadyAt !== null &&
        Date.parse(row.orderItemReadyAt) > Date.parse(generation.asOfUtc)) ||
      (generation.snapshotBindingVersion === 1 &&
        (row.acceptedAt !== null || row.orderItemReadyAt !== null))
    )
      return invalid();
    const group = tickets.get(row.ticketReference) ?? [];
    group.push(row);
    tickets.set(row.ticketReference, group);
  }
  if (
    new Set(rows.map((row) => row.workItemReference)).size !== rows.length ||
    generation.ticketCount !== tickets.size ||
    generation.workItemCount !== rows.length ||
    generation.sourceEventBindingDigest !==
      computeKitchenQueueSourceEventBindingDigest(rows, port) ||
    generation.queueSnapshotDigest !==
      computeKitchenQueueSnapshotDigest(
        {
          brandReference: generation.brandReference,
          storeReference: generation.storeReference,
          rows,
          snapshotBindingVersion: generation.snapshotBindingVersion,
        },
        port,
      )
  )
    return invalid();
  for (const group of tickets.values()) {
    group.sort((left, right) => left.sourceItemOrdinal - right.sourceItemOrdinal);
    const first = group[0];
    if (
      first === undefined ||
      new Set(group.map((row) => row.orderItemReference)).size !== group.length ||
      group.some(
        (row, index) =>
          row.sourceItemOrdinal !== index + 1 ||
          row.orderReference !== first.orderReference ||
          row.orderBatchReference !== first.orderBatchReference ||
          row.originalSourceEventReference !== first.originalSourceEventReference ||
          row.sourceEventSemanticDigest !== first.sourceEventSemanticDigest ||
          row.sourceEventOccurredAt !== first.sourceEventOccurredAt ||
          row.workItemCreatedAt !== first.workItemCreatedAt,
      )
    )
      return invalid();
  }
  return Object.freeze({ generation, rows: Object.freeze(rows) });
}

export function reconcileKitchenQueueProjectionBundle(
  input: {
    readonly generation: unknown;
    readonly rows: unknown;
  },
  port: KitchenQueueDigestPort,
): KitchenQueueProjectionBundle {
  const generation = parseKitchenQueueGeneration(input.generation);
  let lastInputError: KitchenQueueProjectionError | null = null;
  for (const snapshotBindingVersion of [2, 1] as const) {
    try {
      const stored = reconcileKitchenQueueStoredProjectionBundle(
        {
          generation: { ...generation, snapshotBindingVersion },
          rows: input.rows,
        },
        port,
      );
      return Object.freeze({
        generation: publicGeneration(stored.generation),
        rows: stored.rows,
      });
    } catch (error) {
      if (
        error instanceof KitchenQueueProjectionError &&
        error.code === "KITCHEN_QUEUE_INPUT_INVALID"
      ) {
        lastInputError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastInputError ?? new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
}

export function computeKitchenQueueRebuildRequestDigest(
  value: unknown,
  port: KitchenQueueDigestPort,
): KitchenDigest {
  const request = parseKitchenQueueRebuildRequest(value);
  return canonicalDigest(
    port,
    Object.freeze({
      action: request.action,
      purpose: request.purpose,
      projectionName: request.projectionName,
      projectionVersion: request.projectionVersion,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
      expectedActiveGenerationReference: request.expectedActiveGenerationReference,
      requestedAt: request.requestedAt,
    }),
  );
}

export function computeKitchenQueueFilterSortDigest(
  input: {
    readonly brandReference: unknown;
    readonly storeReference: unknown;
    readonly filters: unknown;
  },
  port: KitchenQueueDigestPort,
): KitchenDigest {
  const filters = parseKitchenQueueFilters(input.filters);
  return canonicalDigest(
    port,
    Object.freeze({
      projectionName: kitchenQueueProjectionName,
      projectionVersion: kitchenQueueProjectionVersion,
      brandReference: reference(input.brandReference),
      storeReference: reference(input.storeReference),
      filters: Object.freeze({
        orderReference: filters.orderReference,
        ticketReference: filters.ticketReference,
        workItemReference: filters.workItemReference,
        stationReference: filters.stationReference,
        status: filters.status,
      }),
      sort: Object.freeze({
        workItemCreatedAt: "Ascending",
        workItemReference: "AsciiAscending",
      }),
    }),
  );
}

export function buildKitchenQueueRows(input: {
  readonly generationReference: unknown;
  readonly feed: unknown;
  readonly sha256: KitchenQueueDigestPort;
}): readonly KitchenQueueRow[] {
  const generationReference = reference(input.generationReference);
  const feed = parseKitchenQueueSourceFeed(input.feed);
  const rows = feed.tickets.flatMap((ticket) => {
    const semanticDigest = computeKitchenQueueSourceEventSemanticDigest(
      ticket.sourceEvent,
      input.sha256,
    );
    return ticket.items.map((item) =>
      parseKitchenQueueRow({
        projectionGenerationReference: generationReference,
        brandReference: feed.brandReference,
        storeReference: feed.storeReference,
        ticketReference: item.ticketReference,
        workItemReference: item.workItemReference,
        orderReference: item.orderReference,
        orderBatchReference: item.orderBatchReference,
        orderItemReference: item.orderItemReference,
        sourceItemOrdinal: item.sourceItemOrdinal,
        ticketAggregateVersion: item.ticketAggregateVersion,
        workItemVersion: item.workItemVersion,
        status: item.status,
        requiredQuantity: item.requiredQuantity,
        completedQuantity: item.completedQuantity,
        localizedDisplayNames: item.localizedDisplayNames,
        selectedOptions: item.selectedOptions,
        stationReference: item.stationReference,
        originalSourceEventReference: ticket.sourceEvent.eventId,
        sourceEventSemanticDigest: semanticDigest,
        sourceEventOccurredAt: ticket.sourceEvent.occurredAt,
        workItemCreatedAt: item.workItemCreatedAt,
        acceptedAt: item.acceptedAt,
        orderItemReadyAt: item.orderItemReadyAt,
      }),
    );
  });
  if (new Set(rows.map((row) => row.workItemReference)).size !== rows.length) return invalid();
  return Object.freeze(
    rows.sort((left, right) => compareAscii(left.workItemReference, right.workItemReference)),
  );
}

function sameLocalizedNames(
  left: KitchenQueueLocalizedNames,
  right: KitchenQueueLocalizedNames,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function sameSelectedOptions(
  left: readonly KitchenQueueSelectedOption[],
  right: readonly KitchenQueueSelectedOption[],
): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => {
      const expected = right[index];
      return (
        expected !== undefined &&
        option.optionReference === expected.optionReference &&
        option.quantity === expected.quantity &&
        sameLocalizedNames(option.localizedNames, expected.localizedNames)
      );
    })
  );
}

function sameKitchenQueueRow(left: KitchenQueueRow, right: KitchenQueueRow): boolean {
  return (
    left.projectionGenerationReference === right.projectionGenerationReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.ticketReference === right.ticketReference &&
    left.workItemReference === right.workItemReference &&
    left.orderReference === right.orderReference &&
    left.orderBatchReference === right.orderBatchReference &&
    left.orderItemReference === right.orderItemReference &&
    left.sourceItemOrdinal === right.sourceItemOrdinal &&
    left.ticketAggregateVersion === right.ticketAggregateVersion &&
    left.workItemVersion === right.workItemVersion &&
    left.status === right.status &&
    left.requiredQuantity === right.requiredQuantity &&
    left.completedQuantity === right.completedQuantity &&
    sameLocalizedNames(left.localizedDisplayNames, right.localizedDisplayNames) &&
    sameSelectedOptions(left.selectedOptions, right.selectedOptions) &&
    left.stationReference === right.stationReference &&
    left.originalSourceEventReference === right.originalSourceEventReference &&
    left.sourceEventSemanticDigest === right.sourceEventSemanticDigest &&
    left.sourceEventOccurredAt === right.sourceEventOccurredAt &&
    left.workItemCreatedAt === right.workItemCreatedAt &&
    left.acceptedAt === right.acceptedAt &&
    left.orderItemReadyAt === right.orderItemReadyAt
  );
}

export function buildKitchenQueueStoredGeneration(input: {
  readonly generationReference: unknown;
  readonly generationStatus: "Building" | "Active";
  readonly feed: unknown;
  readonly rows: readonly unknown[];
  readonly projectedAt: unknown;
  readonly lastRebuiltAt: unknown;
  readonly rebuildRequest: unknown | null;
  readonly sha256: KitchenQueueDigestPort;
}): KitchenQueueStoredGeneration {
  const feed = parseKitchenQueueSourceFeed(input.feed);
  const rows = exactArray(input.rows, 0, Number.MAX_SAFE_INTEGER).map(parseKitchenQueueRow);
  const generationReference = reference(input.generationReference);
  const expectedRows = buildKitchenQueueRows({
    generationReference,
    feed,
    sha256: input.sha256,
  });
  if (
    rows.length !== expectedRows.length ||
    rows.some((row, index) => {
      const expected = expectedRows[index];
      return expected === undefined || !sameKitchenQueueRow(row, expected);
    })
  )
    return invalid();
  const projectedAt = instant(input.projectedAt);
  const activationLagMs = Date.parse(projectedAt) - Date.parse(feed.asOfUtc);
  if (!Number.isSafeInteger(activationLagMs) || activationLagMs < 0) return invalid();
  const rebuildRequest =
    input.rebuildRequest === null ? null : parseKitchenQueueRebuildRequest(input.rebuildRequest);
  if (
    rebuildRequest !== null &&
    (rebuildRequest.brandReference !== feed.brandReference ||
      rebuildRequest.storeReference !== feed.storeReference)
  )
    return invalid();
  if (rows.length === 0 && rebuildRequest === null) return invalid();
  return parseKitchenQueueStoredGeneration({
    projectionGenerationReference: generationReference,
    brandReference: feed.brandReference,
    storeReference: feed.storeReference,
    projectionName: kitchenQueueProjectionName,
    projectionVersion: kitchenQueueProjectionVersion,
    snapshotBindingVersion: kitchenQueueSnapshotBindingVersion,
    generationStatus: input.generationStatus,
    sourceCheckpointReference: feed.sourceCheckpointReference,
    sourceEventBindingDigest: computeKitchenQueueSourceEventBindingDigest(rows, input.sha256),
    queueSnapshotDigest: computeKitchenQueueSnapshotDigest(
      {
        brandReference: feed.brandReference,
        storeReference: feed.storeReference,
        rows,
        snapshotBindingVersion: kitchenQueueSnapshotBindingVersion,
      },
      input.sha256,
    ),
    ticketCount: feed.tickets.length,
    workItemCount: rows.length,
    initializedEmpty: rows.length === 0,
    asOfUtc: feed.asOfUtc,
    projectedAt,
    activationLagMs,
    lastRebuiltAt: rebuildRequest === null ? optionalInstant(input.lastRebuiltAt) : projectedAt,
    freshnessStatus: activationLagMs <= 2000 ? "Fresh" : "Stale",
    rebuildReference: rebuildRequest?.rebuildReference ?? null,
    rebuildRequestDigest:
      rebuildRequest === null
        ? null
        : computeKitchenQueueRebuildRequestDigest(rebuildRequest, input.sha256),
    rebuildRequestedAt: rebuildRequest?.requestedAt ?? null,
    expectedPriorGenerationReference: rebuildRequest?.expectedActiveGenerationReference ?? null,
  });
}

export function buildKitchenQueueGeneration(input: {
  readonly generationReference: unknown;
  readonly generationStatus: "Building" | "Active";
  readonly feed: unknown;
  readonly rows: readonly unknown[];
  readonly projectedAt: unknown;
  readonly lastRebuiltAt: unknown;
  readonly rebuildRequest: unknown | null;
  readonly sha256: KitchenQueueDigestPort;
}): KitchenQueueGeneration {
  return publicGeneration(buildKitchenQueueStoredGeneration(input));
}

export function createKitchenQueueItemView(value: unknown): KitchenQueueItemView {
  const row = parseKitchenQueueRow(value);
  return Object.freeze({
    ticketReference: row.ticketReference,
    workItemReference: row.workItemReference,
    orderReference: row.orderReference,
    orderBatchReference: row.orderBatchReference,
    orderItemReference: row.orderItemReference,
    sourceItemOrdinal: row.sourceItemOrdinal,
    ticketAggregateVersion: row.ticketAggregateVersion,
    workItemVersion: row.workItemVersion,
    status: row.status,
    requiredQuantity: row.requiredQuantity,
    completedQuantity: row.completedQuantity,
    localizedDisplayNames: row.localizedDisplayNames,
    selectedOptions: row.selectedOptions,
    stationReference: row.stationReference,
    workItemCreatedAt: row.workItemCreatedAt,
    acceptedAt: row.acceptedAt,
    orderItemReadyAt: row.orderItemReadyAt,
  });
}

function resultMetadata(generationValue: unknown): KitchenQueueResultMetadata {
  const generation = parseKitchenQueueGeneration(generationValue);
  if (generation.generationStatus !== "Active") return invalid();
  return Object.freeze({
    projectionName: generation.projectionName,
    projectionVersion: generation.projectionVersion,
    projectionGenerationReference: generation.projectionGenerationReference,
    sourceCheckpointReference: generation.sourceCheckpointReference,
    asOfUtc: generation.asOfUtc,
    projectedAt: generation.projectedAt,
    activationLagMs: generation.activationLagMs,
    freshnessStatus: generation.freshnessStatus,
    partial: false as const,
    stale: generation.freshnessStatus === "Stale",
    lastRebuiltAt: generation.lastRebuiltAt,
    initializedEmpty: generation.initializedEmpty,
    projectionRegistryStatus: "runtime-inactive" as const,
    projectionHealth: "NotAvailable" as const,
    bulkExport: "NotAvailable" as const,
    futureCapabilities: Object.freeze({
      course: "NotAvailable" as const,
      priority: "NotAvailable" as const,
      slaOverdue: "NotAvailable" as const,
      holdReason: "NotAvailable" as const,
      exception: "NotAvailable" as const,
      claim: "NotAvailable" as const,
      eta: "NotAvailable" as const,
      structuredAllergenAssistance: "NotAvailable" as const,
    }),
  });
}

export function buildKitchenQueueListResult(input: {
  readonly generation: unknown;
  readonly rows: readonly unknown[];
  readonly nextCursor: unknown | null;
}): KitchenQueueListResult {
  const metadata = resultMetadata(input.generation);
  const items = exactArray(input.rows, 0, Number.MAX_SAFE_INTEGER).map(createKitchenQueueItemView);
  return Object.freeze({
    projectionName: metadata.projectionName,
    projectionVersion: metadata.projectionVersion,
    projectionGenerationReference: metadata.projectionGenerationReference,
    sourceCheckpointReference: metadata.sourceCheckpointReference,
    asOfUtc: metadata.asOfUtc,
    projectedAt: metadata.projectedAt,
    activationLagMs: metadata.activationLagMs,
    freshnessStatus: metadata.freshnessStatus,
    partial: false as const,
    stale: metadata.stale,
    lastRebuiltAt: metadata.lastRebuiltAt,
    initializedEmpty: metadata.initializedEmpty,
    projectionRegistryStatus: metadata.projectionRegistryStatus,
    projectionHealth: metadata.projectionHealth,
    bulkExport: metadata.bulkExport,
    futureCapabilities: metadata.futureCapabilities,
    items: Object.freeze(items),
    nextCursor: input.nextCursor === null ? null : parseKitchenQueueCursor(input.nextCursor),
  });
}

export function buildKitchenQueueGetResult(input: {
  readonly generation: unknown;
  readonly row: unknown;
}): KitchenQueueGetResult {
  const metadata = resultMetadata(input.generation);
  return Object.freeze({
    projectionName: metadata.projectionName,
    projectionVersion: metadata.projectionVersion,
    projectionGenerationReference: metadata.projectionGenerationReference,
    sourceCheckpointReference: metadata.sourceCheckpointReference,
    asOfUtc: metadata.asOfUtc,
    projectedAt: metadata.projectedAt,
    activationLagMs: metadata.activationLagMs,
    freshnessStatus: metadata.freshnessStatus,
    partial: false as const,
    stale: metadata.stale,
    lastRebuiltAt: metadata.lastRebuiltAt,
    initializedEmpty: metadata.initializedEmpty,
    projectionRegistryStatus: metadata.projectionRegistryStatus,
    projectionHealth: metadata.projectionHealth,
    bulkExport: metadata.bulkExport,
    futureCapabilities: metadata.futureCapabilities,
    item: createKitchenQueueItemView(input.row),
  });
}
