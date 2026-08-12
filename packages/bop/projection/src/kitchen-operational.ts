import {
  assertProjectionScope,
  projectionDigest,
  projectionExact,
  projectionFail,
  projectionInstant,
  projectionOptionalReference,
  projectionReference,
  projectionVersion,
  validateBusinessDate,
} from "./projection-contract.js";
export const kitchenOperationalProjectionName = "kitchen_operations_v1" as const;
type Scope = Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
export interface KitchenOperationalSource extends Scope {
  readonly ticketReference: string;
  readonly workItemReference: string;
  readonly orderReference: string;
  readonly orderItemReference: string;
  readonly stationReference: string;
  readonly status: "Queued" | "Held" | "InProgress" | "Completed" | "Cancelled";
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly safetyCue: "None" | "ReviewRequired" | "Acknowledged";
  readonly exceptionReference: string | null;
  readonly acceptedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly orderItemReadyAt: string | null;
  readonly updatedAt: string;
  readonly sourceVersion: bigint;
  readonly sourceDigest: string;
}
export interface KitchenOperationalProjection extends Scope {
  readonly projectionName: typeof kitchenOperationalProjectionName;
  readonly projectionVersion: 1;
  readonly businessDate: string;
  readonly stationReference: string | null;
  readonly generationReference: string;
  readonly sourceCheckpoint: string;
  readonly asOfUtc: string;
  readonly projectedAt: string;
  readonly lastRebuiltAt: string | null;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly initializedEmpty: boolean;
  readonly rows: readonly KitchenOperationalSource[];
}
function quantity(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > 999)
    return projectionFail("INPUT_INVALID");
  return Number(value);
}
export function parseKitchenOperationalSource(value: unknown): KitchenOperationalSource {
  const raw = projectionExact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderReference",
    "orderItemReference",
    "stationReference",
    "status",
    "requiredQuantity",
    "completedQuantity",
    "safetyCue",
    "exceptionReference",
    "acceptedAt",
    "startedAt",
    "completedAt",
    "orderItemReadyAt",
    "updatedAt",
    "sourceVersion",
    "sourceDigest",
  ]);
  if (
    !["Queued", "Held", "InProgress", "Completed", "Cancelled"].includes(String(raw.status)) ||
    !["None", "ReviewRequired", "Acknowledged"].includes(String(raw.safetyCue))
  )
    return projectionFail("INPUT_INVALID");
  const requiredQuantity = quantity(raw.requiredQuantity);
  const completedQuantity = quantity(raw.completedQuantity, true);
  if (
    completedQuantity > requiredQuantity ||
    (raw.status === "Completed") !==
      (completedQuantity === requiredQuantity && raw.completedAt !== null) ||
    (raw.status === "InProgress" && raw.startedAt === null) ||
    (raw.orderItemReadyAt !== null && raw.status !== "Completed") ||
    (raw.exceptionReference !== null && raw.status === "Completed")
  )
    return projectionFail("SOURCE_CONFLICT");
  return Object.freeze({
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    ticketReference: projectionReference(raw.ticketReference),
    workItemReference: projectionReference(raw.workItemReference),
    orderReference: projectionReference(raw.orderReference),
    orderItemReference: projectionReference(raw.orderItemReference),
    stationReference: projectionReference(raw.stationReference),
    status: raw.status,
    requiredQuantity,
    completedQuantity,
    safetyCue: raw.safetyCue,
    exceptionReference: projectionOptionalReference(raw.exceptionReference),
    acceptedAt: raw.acceptedAt === null ? null : projectionInstant(raw.acceptedAt),
    startedAt: raw.startedAt === null ? null : projectionInstant(raw.startedAt),
    completedAt: raw.completedAt === null ? null : projectionInstant(raw.completedAt),
    orderItemReadyAt:
      raw.orderItemReadyAt === null ? null : projectionInstant(raw.orderItemReadyAt),
    updatedAt: projectionInstant(raw.updatedAt),
    sourceVersion: projectionVersion(raw.sourceVersion),
    sourceDigest: projectionDigest(raw.sourceDigest),
  }) as KitchenOperationalSource;
}
export function buildKitchenOperationalProjection(
  input: Scope & {
    readonly businessDate: string;
    readonly stationReference: string | null;
    readonly generationReference: string;
    readonly sourceCheckpoint: string;
    readonly asOfUtc: string;
    readonly projectedAt: string;
    readonly lastRebuiltAt: string | null;
    readonly sources: readonly unknown[];
  },
): KitchenOperationalProjection {
  const scope = {
    tenantReference: projectionReference(input.tenantReference),
    brandReference: projectionReference(input.brandReference),
    storeReference: projectionReference(input.storeReference),
  };
  if (!Array.isArray(input.sources) || input.sources.length > 1000)
    return projectionFail("INPUT_INVALID");
  const sources = input.sources.map(parseKitchenOperationalSource);
  for (const source of sources) assertProjectionScope(source, scope);
  if (new Set(sources.map((source) => source.workItemReference)).size !== sources.length)
    return projectionFail("DUPLICATE_SOURCE");
  const stationReference = projectionOptionalReference(input.stationReference);
  if (
    stationReference !== null &&
    sources.some((source) => source.stationReference !== stationReference)
  )
    return projectionFail("SCOPE_MISMATCH");
  const asOfUtc = projectionInstant(input.asOfUtc);
  const projectedAt = projectionInstant(input.projectedAt);
  return Object.freeze({
    projectionName: kitchenOperationalProjectionName,
    projectionVersion: 1,
    ...scope,
    businessDate: validateBusinessDate(input.businessDate),
    stationReference,
    generationReference: projectionReference(input.generationReference),
    sourceCheckpoint: projectionReference(input.sourceCheckpoint),
    asOfUtc,
    projectedAt,
    lastRebuiltAt: input.lastRebuiltAt === null ? null : projectionInstant(input.lastRebuiltAt),
    freshnessStatus: Date.parse(projectedAt) - Date.parse(asOfUtc) <= 2000 ? "Fresh" : "Stale",
    initializedEmpty: sources.length === 0,
    rows: Object.freeze(sources),
  });
}
