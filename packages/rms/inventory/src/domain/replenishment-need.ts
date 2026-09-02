import {
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryDecimal,
  type InventoryInstant,
  type InventoryReference,
} from "./inventory-item.js";
import type { MovementStockScope } from "./stock-movement.js";

export type ReplenishmentNeedStatus =
  "Open" | "Acknowledged" | "RequisitionDraftCreated" | "Dismissed";

export type ReplenishmentNeedDecision = Readonly<{
  kind: "Acknowledged" | "Dismissed" | "RequisitionDraftLinked";
  reasonCode: string | null;
  requisitionReference: InventoryReference | null;
  actorReference: InventoryReference;
  occurredAt: InventoryInstant;
}>;

export interface ReplenishmentNeedAggregate {
  readonly needReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: MovementStockScope;
  readonly itemReference: InventoryReference;
  readonly available: InventoryDecimal;
  readonly reorderPoint: InventoryDecimal;
  readonly safetyStock: InventoryDecimal;
  readonly forecastQuantity: InventoryDecimal;
  readonly suggestedQuantity: InventoryDecimal;
  readonly baseUnitCode: string;
  readonly requiredBy: string;
  readonly reasonCode: string;
  readonly urgency: "Low" | "Normal" | "High" | "Critical";
  readonly policyReference: InventoryReference;
  readonly balanceVersion: number;
  readonly forecastReference: InventoryReference;
  readonly forecastAsOfUtc: InventoryInstant;
  readonly status: ReplenishmentNeedStatus;
  readonly decisions: readonly ReplenishmentNeedDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly updatedAt: InventoryInstant;
}

export type ReplenishmentNeedErrorCode =
  | "REPLENISHMENT_INVALID"
  | "REPLENISHMENT_CONFLICT"
  | "REPLENISHMENT_STATE_CONFLICT"
  | "REPLENISHMENT_NOT_FOUND"
  | "REPLENISHMENT_PERMISSION_DENIED"
  | "REPLENISHMENT_IDEMPOTENCY_CONFLICT"
  | "REPLENISHMENT_DEPENDENCY_UNAVAILABLE";

export class ReplenishmentNeedError extends Error {
  constructor(readonly code: ReplenishmentNeedErrorCode) {
    super("Replenishment Need operation unavailable");
    this.name = "ReplenishmentNeedError";
  }
}

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const version = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ReplenishmentNeedError("REPLENISHMENT_INVALID");
  return value as number;
};
const code = (value: unknown, pattern = codePattern) => {
  if (typeof value !== "string" || !pattern.test(value))
    throw new ReplenishmentNeedError("REPLENISHMENT_INVALID");
  return value;
};
const date = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw new ReplenishmentNeedError("REPLENISHMENT_INVALID");
  return value;
};

export function detectReplenishmentNeed(
  input: Omit<
    ReplenishmentNeedAggregate,
    "status" | "decisions" | "aggregateVersion" | "updatedAt"
  >,
): ReplenishmentNeedAggregate {
  const available = parseInventoryDecimal(input.available);
  const reorderPoint = parseInventoryDecimal(input.reorderPoint);
  const safetyStock = parseInventoryDecimal(input.safetyStock);
  const forecastQuantity = parseInventoryDecimal(input.forecastQuantity);
  const suggestedQuantity = parseInventoryDecimal(input.suggestedQuantity);
  if (suggestedQuantity === "0") throw new ReplenishmentNeedError("REPLENISHMENT_INVALID");
  if (!["Low", "Normal", "High", "Critical"].includes(input.urgency))
    throw new ReplenishmentNeedError("REPLENISHMENT_INVALID");
  return Object.freeze({
    ...input,
    needReference: parseInventoryReference(input.needReference),
    tenantReference: parseInventoryReference(input.tenantReference),
    brandReference: parseInventoryReference(input.brandReference),
    stockScope: Object.freeze({
      scopeType: input.stockScope.scopeType,
      scopeReference: parseInventoryReference(input.stockScope.scopeReference),
    }),
    itemReference: parseInventoryReference(input.itemReference),
    available,
    reorderPoint,
    safetyStock,
    forecastQuantity,
    suggestedQuantity,
    baseUnitCode: code(input.baseUnitCode, unitPattern),
    requiredBy: date(input.requiredBy),
    reasonCode: code(input.reasonCode),
    urgency: input.urgency,
    policyReference: parseInventoryReference(input.policyReference),
    balanceVersion: version(input.balanceVersion),
    forecastReference: parseInventoryReference(input.forecastReference),
    forecastAsOfUtc: parseInventoryInstant(input.forecastAsOfUtc),
    createdAt: parseInventoryInstant(input.createdAt),
    updatedAt: parseInventoryInstant(input.createdAt),
    status: "Open",
    decisions: Object.freeze([]),
    aggregateVersion: 1,
  });
}

function decide(
  need: ReplenishmentNeedAggregate,
  input: {
    expectedVersion: number;
    kind: ReplenishmentNeedDecision["kind"];
    reasonCode: string | null;
    requisitionReference: InventoryReference | null;
    actorReference: InventoryReference;
    occurredAt: InventoryInstant;
  },
): ReplenishmentNeedAggregate {
  if (need.aggregateVersion !== version(input.expectedVersion))
    throw new ReplenishmentNeedError("REPLENISHMENT_CONFLICT");
  if (need.status === "Dismissed" || need.status === "RequisitionDraftCreated")
    throw new ReplenishmentNeedError("REPLENISHMENT_STATE_CONFLICT");
  if (input.kind === "Acknowledged" && need.status !== "Open")
    throw new ReplenishmentNeedError("REPLENISHMENT_STATE_CONFLICT");
  const decision = Object.freeze({
    ...input,
    reasonCode: input.reasonCode === null ? null : code(input.reasonCode),
    requisitionReference:
      input.requisitionReference === null
        ? null
        : parseInventoryReference(input.requisitionReference),
    actorReference: parseInventoryReference(input.actorReference),
    occurredAt: parseInventoryInstant(input.occurredAt),
  });
  const status: ReplenishmentNeedStatus =
    input.kind === "Acknowledged"
      ? "Acknowledged"
      : input.kind === "Dismissed"
        ? "Dismissed"
        : "RequisitionDraftCreated";
  return Object.freeze({
    ...need,
    status,
    decisions: Object.freeze([...need.decisions, decision]),
    aggregateVersion: need.aggregateVersion + 1,
    updatedAt: decision.occurredAt,
  });
}

export const acknowledgeReplenishmentNeed = (
  need: ReplenishmentNeedAggregate,
  input: {
    expectedVersion: number;
    actorReference: InventoryReference;
    occurredAt: InventoryInstant;
  },
) => decide(need, { ...input, kind: "Acknowledged", reasonCode: null, requisitionReference: null });

export const dismissReplenishmentNeed = (
  need: ReplenishmentNeedAggregate,
  input: {
    expectedVersion: number;
    reasonCode: string;
    actorReference: InventoryReference;
    occurredAt: InventoryInstant;
  },
) => decide(need, { ...input, kind: "Dismissed", requisitionReference: null });

export const linkRequisitionDraft = (
  need: ReplenishmentNeedAggregate,
  input: {
    expectedVersion: number;
    requisitionReference: InventoryReference;
    actorReference: InventoryReference;
    occurredAt: InventoryInstant;
  },
) => decide(need, { ...input, kind: "RequisitionDraftLinked", reasonCode: null });
