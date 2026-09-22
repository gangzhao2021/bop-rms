export interface PickupQueueItem {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly publicOrderNumber: string | null;
  readonly phase: "Ready" | "InProgress" | "Completed";
  readonly readyAt: string;
  readonly proofReadiness: "Ready" | "Unavailable";
  readonly stagingLocation: string | null;
  readonly claimStatus: "Unclaimed" | "Claimed" | "Unavailable";
  readonly exceptionStatus: "None" | "Reported" | "Unavailable";
  readonly packageCount: number | null;
  readonly allergenCue: "None" | "Present" | "Unavailable";
  readonly execution?: PickupExecution;
}
export interface PickupExecution {
  readonly aggregateVersion: string;
  readonly publicOrderReference: string | null;
  readonly proof: {
    readonly kind: "HumanCode" | "Opaque";
    readonly generation: number;
    readonly expiresAt: string;
  } | null;
  readonly items: readonly {
    readonly fulfillmentItemReference: string;
    readonly orderedQuantity: number;
    readonly readyQuantity: number;
    readonly handedOverQuantity: number;
  }[];
}
export interface PickupWorkstation {
  readonly deviceReference: string;
  readonly pickupLocationReference: string;
}
export interface PickupQueueView {
  readonly workstation?: PickupWorkstation | null;

  readonly screenId: "FUL-PICKUP-QUEUE";
  readonly projectionName: "fulfillment_pickup_queue_v1";
  readonly projectionVersion: 1;
  readonly storeLabel: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed";
  readonly items: readonly PickupQueueItem[];
  readonly nextAfterFulfillmentReference?: string | null;
}
export interface PickupClient {
  loadQueue(input?: {
    afterFulfillmentReference: string | null;
    includeCompleted: boolean;
  }): Promise<unknown>;
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
export function parsePickupReference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("PICKUP_VIEW_INVALID");
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value)
    throw new Error("PICKUP_VIEW_INVALID");
  return value;
}
function item(value: unknown): PickupQueueItem {
  const hasExecution = !!value && typeof value === "object" && Object.hasOwn(value, "execution");
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
    ...(hasExecution ? ["execution"] : []),
  ]);
  if (
    (input.publicOrderNumber !== null &&
      (typeof input.publicOrderNumber !== "string" ||
        !/^[A-Z0-9-]{1,40}$/u.test(input.publicOrderNumber))) ||
    !["Ready", "InProgress", "Completed"].includes(String(input.phase)) ||
    !["Ready", "Unavailable"].includes(String(input.proofReadiness)) ||
    (input.stagingLocation !== null &&
      (typeof input.stagingLocation !== "string" || !SAFE.test(input.stagingLocation))) ||
    !["Unclaimed", "Claimed", "Unavailable"].includes(String(input.claimStatus)) ||
    !["None", "Reported", "Unavailable"].includes(String(input.exceptionStatus)) ||
    (input.packageCount !== null &&
      (!Number.isSafeInteger(input.packageCount) || Number(input.packageCount) < 1)) ||
    !["None", "Present", "Unavailable"].includes(String(input.allergenCue))
  )
    throw new Error("PICKUP_VIEW_INVALID");
  return Object.freeze({
    fulfillmentReference: parsePickupReference(input.fulfillmentReference),
    orderReference: parsePickupReference(input.orderReference),
    publicOrderNumber: input.publicOrderNumber,
    phase: input.phase as PickupQueueItem["phase"],
    readyAt: instant(input.readyAt),
    proofReadiness: input.proofReadiness as PickupQueueItem["proofReadiness"],
    stagingLocation: input.stagingLocation,
    claimStatus: input.claimStatus as PickupQueueItem["claimStatus"],
    exceptionStatus: input.exceptionStatus as PickupQueueItem["exceptionStatus"],
    packageCount: input.packageCount === null ? null : Number(input.packageCount),
    allergenCue: input.allergenCue as PickupQueueItem["allergenCue"],
    ...(hasExecution ? { execution: parsePickupExecution(input.execution) } : {}),
  });
}
export function parsePickupWorkstation(value: unknown): PickupWorkstation | null {
  if (value === null) return null;
  const raw = closed(value, ["deviceReference", "pickupLocationReference"]);
  return Object.freeze({
    deviceReference: parsePickupReference(raw.deviceReference),
    pickupLocationReference: parsePickupReference(raw.pickupLocationReference),
  });
}
export function parsePickupQueueView(value: unknown): PickupQueueView {
  const hasWorkstation =
    !!value && typeof value === "object" && Object.hasOwn(value, "workstation");
  const hasCursor =
    !!value && typeof value === "object" && Object.hasOwn(value, "nextAfterFulfillmentReference");
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "storeLabel",
    "projectedAt",
    "freshnessStatus",
    "items",
    ...(hasCursor ? ["nextAfterFulfillmentReference"] : []),
    ...(hasWorkstation ? ["workstation"] : []),
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
    ...(hasWorkstation ? { workstation: parsePickupWorkstation(input.workstation) } : {}),
    ...(hasCursor
      ? {
          nextAfterFulfillmentReference:
            input.nextAfterFulfillmentReference === null
              ? null
              : parsePickupReference(input.nextAfterFulfillmentReference),
        }
      : {}),
  });
}
export const unavailablePickupClient: PickupClient = Object.freeze({
  loadQueue: () => Promise.reject(new PickupClientError("Unavailable")),
});

export function parsePickupExecution(value: unknown): PickupExecution {
  const raw = closed(value, ["aggregateVersion", "publicOrderReference", "proof", "items"]);
  if (
    typeof raw.aggregateVersion !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(raw.aggregateVersion) ||
    BigInt(raw.aggregateVersion) > 9223372036854775807n ||
    (raw.publicOrderReference !== null &&
      (typeof raw.publicOrderReference !== "string" ||
        !/^[A-Za-z0-9_-]{22}$/.test(raw.publicOrderReference))) ||
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > 100
  )
    throw new Error("PICKUP_VIEW_INVALID");
  let proof: PickupExecution["proof"] = null;
  if (raw.proof !== null) {
    const p = closed(raw.proof, ["kind", "generation", "expiresAt"]);
    if (
      (p.kind !== "HumanCode" && p.kind !== "Opaque") ||
      !Number.isSafeInteger(p.generation) ||
      Number(p.generation) < 1
    )
      throw new Error("PICKUP_VIEW_INVALID");
    proof = Object.freeze({
      kind: p.kind,
      generation: Number(p.generation),
      expiresAt: instant(p.expiresAt),
    });
  }
  const items = raw.items.map((value) => {
    const item = closed(value, [
      "fulfillmentItemReference",
      "orderedQuantity",
      "readyQuantity",
      "handedOverQuantity",
    ]);
    if (
      ![item.orderedQuantity, item.readyQuantity, item.handedOverQuantity].every(
        (v) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 999,
      ) ||
      Number(item.orderedQuantity) < 1 ||
      Number(item.readyQuantity) > Number(item.orderedQuantity) ||
      Number(item.handedOverQuantity) > Number(item.readyQuantity)
    )
      throw new Error("PICKUP_VIEW_INVALID");
    return Object.freeze({
      fulfillmentItemReference: parsePickupReference(item.fulfillmentItemReference),
      orderedQuantity: Number(item.orderedQuantity),
      readyQuantity: Number(item.readyQuantity),
      handedOverQuantity: Number(item.handedOverQuantity),
    });
  });
  if (new Set(items.map((item) => item.fulfillmentItemReference)).size !== items.length)
    throw new Error("PICKUP_VIEW_INVALID");
  return Object.freeze({
    aggregateVersion: raw.aggregateVersion,
    publicOrderReference: raw.publicOrderReference,
    proof,
    items: Object.freeze(items),
  });
}
