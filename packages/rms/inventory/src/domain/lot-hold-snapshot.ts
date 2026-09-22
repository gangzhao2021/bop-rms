import {
  createLotHold,
  releaseLot,
  quarantineLot,
  LotHoldError,
  type LotHoldAggregate,
} from "./lot-hold.js";
import { parseStockScope } from "./stock-movement.js";

function invalid(): never {
  throw new LotHoldError("LOT_HOLD_INVALID");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function same(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== "object") return left === right;
  if (right === null || typeof right !== "object") return false;
  const keys = Reflect.ownKeys(left);
  if (keys.length !== Reflect.ownKeys(right).length || Array.isArray(left) !== Array.isArray(right))
    return false;
  return keys.every((key) => {
    const a = Object.getOwnPropertyDescriptor(left, key),
      b = Object.getOwnPropertyDescriptor(right, key);
    return (
      a !== undefined && b !== undefined && "value" in a && "value" in b && same(a.value, b.value)
    );
  });
}

/** Rebuild persisted hold state from its immutable owner decisions, never trust only a status flag. */
export function parseLotHoldSnapshot(value: unknown): LotHoldAggregate {
  try {
    const raw = closed(value, [
      "holdReference",
      "tenantReference",
      "brandReference",
      "stockScope",
      "locationReference",
      "itemReference",
      "lotReference",
      "expiryDate",
      "onHand",
      "reserved",
      "balanceVersion",
      "status",
      "decisions",
      "aggregateVersion",
      "createdAt",
      "createdBy",
      "updatedAt",
      "updatedBy",
    ]);
    const stockScope = parseStockScope(raw.stockScope);
    if (
      !Array.isArray(raw.decisions) ||
      raw.decisions.length === 0 ||
      Reflect.ownKeys(raw.decisions).length !== raw.decisions.length + 1
    )
      return invalid();
    let current: LotHoldAggregate | null = null;
    const decisions: Record<string, unknown>[] = [];
    for (let index = 0; index < raw.decisions.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(raw.decisions, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      const decision = closed(descriptor.value, [
        "decision",
        "reasonCode",
        "complianceDecisionReference",
        "onHand",
        "reserved",
        "balanceVersion",
        "actorReference",
        "occurredAt",
      ]);
      decisions.push(decision);
      if (current === null) {
        if (decision.decision !== "Quarantined") return invalid();
        current = createLotHold({
          holdReference: raw.holdReference,
          tenantReference: raw.tenantReference,
          brandReference: raw.brandReference,
          stockScope,
          locationReference: raw.locationReference,
          itemReference: raw.itemReference,
          lotReference: raw.lotReference,
          expiryDate: raw.expiryDate,
          reasonCode: decision.reasonCode,
          complianceDecisionReference: decision.complianceDecisionReference,
          onHand: decision.onHand,
          reserved: decision.reserved,
          balanceVersion: decision.balanceVersion,
          actorReference: decision.actorReference,
          occurredAt: decision.occurredAt,
        });
      } else {
        if (
          typeof decision.occurredAt !== "string" ||
          decision.occurredAt < current.updatedAt ||
          typeof decision.balanceVersion !== "number" ||
          decision.balanceVersion < current.balanceVersion
        )
          return invalid();
        const input = {
          expectedVersion: current.aggregateVersion,
          reasonCode: decision.reasonCode,
          complianceDecisionReference: decision.complianceDecisionReference,
          onHand: decision.onHand,
          reserved: decision.reserved,
          balanceVersion: decision.balanceVersion,
          actorReference: decision.actorReference,
          occurredAt: decision.occurredAt,
        };
        if (decision.decision === "Released") current = releaseLot(current, input);
        else if (decision.decision === "Quarantined") current = quarantineLot(current, input);
        else return invalid();
      }
    }
    if (current === null || !same(current, { ...raw, stockScope, decisions })) return invalid();
    return current;
  } catch {
    return invalid();
  }
}
