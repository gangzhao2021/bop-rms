export type KitchenStatus = "Queued" | "Held" | "In Progress" | "Completed" | "Cancelled";

export interface KitchenBoardItem {
  readonly workItemReference: string;
  readonly ticketReference: string;
  readonly orderReference: string;
  readonly stationLabel: string;
  readonly displayName: string;
  readonly status: KitchenStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly createdAt: string;
  readonly allergenCue: "None" | "ReviewRequired" | "Acknowledged";
  readonly exceptionStatus: "None" | "Reported";
}

export interface KitchenBoardView {
  readonly screenId: "KIT-KITCHEN-QUEUE";
  readonly projectionName: "kitchen_work_queue_v1";
  readonly projectionVersion: 1;
  readonly storeLabel: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly operatorStatus: "Named" | "Locked" | "HandoverRequired";
  readonly items: readonly KitchenBoardItem[];
}

export interface KitchenBoardClient {
  loadQueue(): Promise<unknown>;
  loadWorkItem(reference: string): Promise<unknown>;
}

export class KitchenBoardClientError extends Error {
  constructor(
    readonly code:
      "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable",
  ) {
    super("Kitchen Board is unavailable");
    this.name = "KitchenBoardClientError";
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,100}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("KITCHEN_BOARD_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export function parseKitchenRouteReference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("KITCHEN_BOARD_INVALID");
  return value;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !INSTANT.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return value;
}

function item(value: unknown): KitchenBoardItem {
  const input = closed(value, [
    "workItemReference",
    "ticketReference",
    "orderReference",
    "stationLabel",
    "displayName",
    "status",
    "requiredQuantity",
    "completedQuantity",
    "createdAt",
    "allergenCue",
    "exceptionStatus",
  ]);
  if (
    typeof input.stationLabel !== "string" ||
    !SAFE_TEXT.test(input.stationLabel) ||
    typeof input.displayName !== "string" ||
    !SAFE_TEXT.test(input.displayName) ||
    !["Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(String(input.status)) ||
    !["None", "ReviewRequired", "Acknowledged"].includes(String(input.allergenCue)) ||
    !["None", "Reported"].includes(String(input.exceptionStatus)) ||
    !Number.isSafeInteger(input.requiredQuantity) ||
    Number(input.requiredQuantity) < 1 ||
    !Number.isSafeInteger(input.completedQuantity) ||
    Number(input.completedQuantity) < 0 ||
    Number(input.completedQuantity) > Number(input.requiredQuantity)
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    workItemReference: parseKitchenRouteReference(input.workItemReference),
    ticketReference: parseKitchenRouteReference(input.ticketReference),
    orderReference: parseKitchenRouteReference(input.orderReference),
    stationLabel: input.stationLabel,
    displayName: input.displayName,
    status: input.status as KitchenStatus,
    requiredQuantity: Number(input.requiredQuantity),
    completedQuantity: Number(input.completedQuantity),
    createdAt: instant(input.createdAt),
    allergenCue: input.allergenCue as KitchenBoardItem["allergenCue"],
    exceptionStatus: input.exceptionStatus as KitchenBoardItem["exceptionStatus"],
  });
}

export function parseKitchenBoardView(value: unknown): KitchenBoardView {
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "storeLabel",
    "projectedAt",
    "freshnessStatus",
    "operatorStatus",
    "items",
  ]);
  if (
    input.screenId !== "KIT-KITCHEN-QUEUE" ||
    input.projectionName !== "kitchen_work_queue_v1" ||
    input.projectionVersion !== 1 ||
    typeof input.storeLabel !== "string" ||
    !SAFE_TEXT.test(input.storeLabel) ||
    !["Fresh", "Stale"].includes(String(input.freshnessStatus)) ||
    !["Named", "Locked", "HandoverRequired"].includes(String(input.operatorStatus)) ||
    !Array.isArray(input.items) ||
    input.items.length > 200
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const items = Object.freeze(input.items.map(item));
  if (new Set(items.map((entry) => entry.workItemReference)).size !== items.length)
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    screenId: "KIT-KITCHEN-QUEUE",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    storeLabel: input.storeLabel,
    projectedAt: instant(input.projectedAt),
    freshnessStatus: input.freshnessStatus as KitchenBoardView["freshnessStatus"],
    operatorStatus: input.operatorStatus as KitchenBoardView["operatorStatus"],
    items,
  });
}

export function parseKitchenWorkItemView(value: unknown): KitchenBoardItem {
  return item(value);
}

export const unavailableKitchenBoardClient: KitchenBoardClient = Object.freeze({
  loadQueue: () => Promise.reject(new KitchenBoardClientError("Unavailable")),
  loadWorkItem: () => Promise.reject(new KitchenBoardClientError("Unavailable")),
});
