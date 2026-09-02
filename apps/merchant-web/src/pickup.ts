export interface PickupQueueItem {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly publicOrderNumber: string;
  readonly phase: "Ready" | "InProgress" | "Completed";
  readonly readyAt: string;
  readonly proofReadiness: "Ready" | "Unavailable";
  readonly stagingLocation: string | null;
  readonly claimStatus: "Unclaimed" | "Claimed" | "Unavailable";
  readonly exceptionStatus: "None" | "Reported";
  readonly packageCount: number;
  readonly allergenCue: "None" | "Present";
}
export interface PickupQueueView {
  readonly screenId: "FUL-PICKUP-QUEUE";
  readonly projectionName: "fulfillment_pickup_queue_v1";
  readonly projectionVersion: 1;
  readonly storeLabel: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed";
  readonly items: readonly PickupQueueItem[];
}
export interface PickupClient {
  loadQueue(): Promise<unknown>;
}
export class PickupClientError extends Error {
  constructor(
    readonly code:
      "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable",
  ) {
    super("Pickup is unavailable");
    this.name = "PickupClientError";
  }
}
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("PICKUP_VIEW_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("PICKUP_VIEW_INVALID");
    result[key] = descriptor.value;
  }
  return result;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("PICKUP_VIEW_INVALID");
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value)
    throw new Error("PICKUP_VIEW_INVALID");
  return value;
}
function item(value: unknown): PickupQueueItem {
  const input = closed(value, [
    "fulfillmentReference",
    "orderReference",
    "publicOrderNumber",
    "phase",
    "readyAt",
    "proofReadiness",
    "stagingLocation",
    "claimStatus",
    "exceptionStatus",
    "packageCount",
    "allergenCue",
  ]);
  if (
    typeof input.publicOrderNumber !== "string" ||
    !/^[A-Z0-9-]{1,40}$/u.test(input.publicOrderNumber) ||
    !["Ready", "InProgress", "Completed"].includes(String(input.phase)) ||
    !["Ready", "Unavailable"].includes(String(input.proofReadiness)) ||
    (input.stagingLocation !== null &&
      (typeof input.stagingLocation !== "string" || !SAFE.test(input.stagingLocation))) ||
    !["Unclaimed", "Claimed", "Unavailable"].includes(String(input.claimStatus)) ||
    !["None", "Reported"].includes(String(input.exceptionStatus)) ||
    !Number.isSafeInteger(input.packageCount) ||
    Number(input.packageCount) < 1 ||
    !["None", "Present"].includes(String(input.allergenCue))
  )
    throw new Error("PICKUP_VIEW_INVALID");
  return Object.freeze({
    fulfillmentReference: reference(input.fulfillmentReference),
    orderReference: reference(input.orderReference),
    publicOrderNumber: input.publicOrderNumber,
    phase: input.phase as PickupQueueItem["phase"],
    readyAt: instant(input.readyAt),
    proofReadiness: input.proofReadiness as PickupQueueItem["proofReadiness"],
    stagingLocation: input.stagingLocation,
    claimStatus: input.claimStatus as PickupQueueItem["claimStatus"],
    exceptionStatus: input.exceptionStatus as PickupQueueItem["exceptionStatus"],
    packageCount: Number(input.packageCount),
    allergenCue: input.allergenCue as PickupQueueItem["allergenCue"],
  });
}
export function parsePickupQueueView(value: unknown): PickupQueueView {
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "storeLabel",
    "projectedAt",
    "freshnessStatus",
    "items",
  ]);
  if (
    input.screenId !== "FUL-PICKUP-QUEUE" ||
    input.projectionName !== "fulfillment_pickup_queue_v1" ||
    input.projectionVersion !== 1 ||
    typeof input.storeLabel !== "string" ||
    !SAFE.test(input.storeLabel) ||
    !["Fresh", "Stale", "Rebuilding", "Failed"].includes(String(input.freshnessStatus)) ||
    !Array.isArray(input.items) ||
    input.items.length > 200
  )
    throw new Error("PICKUP_VIEW_INVALID");
  const items = Object.freeze(input.items.map(item));
  if (new Set(items.map((entry) => entry.fulfillmentReference)).size !== items.length)
    throw new Error("PICKUP_VIEW_INVALID");
  return Object.freeze({
    screenId: "FUL-PICKUP-QUEUE",
    projectionName: "fulfillment_pickup_queue_v1",
    projectionVersion: 1,
    storeLabel: input.storeLabel,
    projectedAt: instant(input.projectedAt),
    freshnessStatus: input.freshnessStatus as PickupQueueView["freshnessStatus"],
    items,
  });
}
export const unavailablePickupClient: PickupClient = Object.freeze({
  loadQueue: () => Promise.reject(new PickupClientError("Unavailable")),
});
