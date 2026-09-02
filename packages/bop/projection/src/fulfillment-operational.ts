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
export const fulfillmentOperationalProjectionName = "fulfillment_operations_v1" as const;
type Scope = Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
export interface FulfillmentOperationalSource extends Scope {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly fulfillmentType: "Pickup";
  readonly phase: "Pending" | "Ready" | "InProgress" | "Completed";
  readonly orderedQuantity: number;
  readonly readyQuantity: number;
  readonly handedOverQuantity: number;
  readonly packageCount: number;
  readonly proofReadiness: "Unavailable" | "Ready" | "Validated";
  readonly stagingLocationLabel: string | null;
  readonly exceptionReference: string | null;
  readonly readyAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly sourceVersion: bigint;
  readonly sourceDigest: string;
}
export interface FulfillmentOperationalProjection extends Scope {
  readonly projectionName: typeof fulfillmentOperationalProjectionName;
  readonly projectionVersion: 1;
  readonly businessDate: string;
  readonly generationReference: string;
  readonly sourceCheckpoint: string;
  readonly asOfUtc: string;
  readonly projectedAt: string;
  readonly lastRebuiltAt: string | null;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly initializedEmpty: boolean;
  readonly rows: readonly FulfillmentOperationalSource[];
}
const SAFE_LABEL = /^[^\p{Cc}\p{Cf}]{1,64}$/u;
function quantity(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > 9999)
    return projectionFail("INPUT_INVALID");
  return Number(value);
}
export function parseFulfillmentOperationalSource(value: unknown): FulfillmentOperationalSource {
  const raw = projectionExact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "fulfillmentReference",
    "orderReference",
    "fulfillmentType",
    "phase",
    "orderedQuantity",
    "readyQuantity",
    "handedOverQuantity",
    "packageCount",
    "proofReadiness",
    "stagingLocationLabel",
    "exceptionReference",
    "readyAt",
    "completedAt",
    "updatedAt",
    "sourceVersion",
    "sourceDigest",
  ]);
  if (
    raw.fulfillmentType !== "Pickup" ||
    !["Pending", "Ready", "InProgress", "Completed"].includes(String(raw.phase)) ||
    !["Unavailable", "Ready", "Validated"].includes(String(raw.proofReadiness)) ||
    (raw.stagingLocationLabel !== null &&
      (typeof raw.stagingLocationLabel !== "string" || !SAFE_LABEL.test(raw.stagingLocationLabel)))
  )
    return projectionFail("INPUT_INVALID");
  const orderedQuantity = quantity(raw.orderedQuantity);
  const readyQuantity = quantity(raw.readyQuantity, true);
  const handedOverQuantity = quantity(raw.handedOverQuantity, true);
  const packageCount = quantity(raw.packageCount);
  if (
    handedOverQuantity > readyQuantity ||
    readyQuantity > orderedQuantity ||
    (raw.phase === "Pending") !== (readyQuantity === 0 && raw.readyAt === null) ||
    (["Ready", "InProgress", "Completed"].includes(String(raw.phase)) &&
      (readyQuantity !== orderedQuantity || raw.readyAt === null)) ||
    (raw.phase === "Completed") !==
      (handedOverQuantity === orderedQuantity && raw.completedAt !== null) ||
    (raw.proofReadiness === "Validated" &&
      !["Ready", "InProgress", "Completed"].includes(String(raw.phase))) ||
    (raw.phase === "Completed" && raw.exceptionReference !== null)
  )
    return projectionFail("SOURCE_CONFLICT");
  return Object.freeze({
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    fulfillmentReference: projectionReference(raw.fulfillmentReference),
    orderReference: projectionReference(raw.orderReference),
    fulfillmentType: "Pickup",
    phase: raw.phase,
    orderedQuantity,
    readyQuantity,
    handedOverQuantity,
    packageCount,
    proofReadiness: raw.proofReadiness,
    stagingLocationLabel: raw.stagingLocationLabel,
    exceptionReference: projectionOptionalReference(raw.exceptionReference),
    readyAt: raw.readyAt === null ? null : projectionInstant(raw.readyAt),
    completedAt: raw.completedAt === null ? null : projectionInstant(raw.completedAt),
    updatedAt: projectionInstant(raw.updatedAt),
    sourceVersion: projectionVersion(raw.sourceVersion),
    sourceDigest: projectionDigest(raw.sourceDigest),
  }) as FulfillmentOperationalSource;
}
export function buildFulfillmentOperationalProjection(
  input: Scope & {
    readonly businessDate: string;
    readonly generationReference: string;
    readonly sourceCheckpoint: string;
    readonly asOfUtc: string;
    readonly projectedAt: string;
    readonly lastRebuiltAt: string | null;
    readonly sources: readonly unknown[];
  },
): FulfillmentOperationalProjection {
  const scope = {
    tenantReference: projectionReference(input.tenantReference),
    brandReference: projectionReference(input.brandReference),
    storeReference: projectionReference(input.storeReference),
  };
  if (!Array.isArray(input.sources) || input.sources.length > 500)
    return projectionFail("INPUT_INVALID");
  const sources = input.sources.map(parseFulfillmentOperationalSource);
  for (const source of sources) assertProjectionScope(source, scope);
  if (
    new Set(sources.map((source) => source.fulfillmentReference)).size !== sources.length ||
    new Set(sources.map((source) => source.orderReference)).size !== sources.length
  )
    return projectionFail("DUPLICATE_SOURCE");
  const asOfUtc = projectionInstant(input.asOfUtc);
  const projectedAt = projectionInstant(input.projectedAt);
  return Object.freeze({
    projectionName: fulfillmentOperationalProjectionName,
    projectionVersion: 1,
    ...scope,
    businessDate: validateBusinessDate(input.businessDate),
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
