import { canonicalizeRfc8785 } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../domain/inventory-item.js";
import { parseInventoryItemSnapshot } from "../domain/inventory-item-snapshot.js";
import type { InventoryItemPorts } from "./ports/inventory-item-ports.js";

function fail(): never {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
}
/** Resolve durable configuration evidence. The caller owns access authorization and final stock fencing. */
export function createInventoryRecipeItemSource(
  repository: Pick<InventoryItemPorts["repository"], "load" | "resolveOperation">,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string }>,
) {
  const tenant = parseInventoryReference(scopeInput.tenantReference);
  const brand = parseInventoryReference(scopeInput.brandReference);
  return Object.freeze({
    async resolve(
      input: Readonly<{
        itemReference: string;
        configurationOperationReference: string;
        observedAt: string;
      }>,
    ) {
      try {
        const itemReference = parseInventoryReference(input.itemReference);
        const operation = parseInventoryReference(input.configurationOperationReference);
        const observedAt = parseInventoryInstant(input.observedAt);
        const record = await repository.resolveOperation(operation);
        if (record === null || record.operationReference !== operation) return fail();
        const pinned = parseInventoryItemSnapshot(record.item);
        const currentValue = await repository.load(itemReference);
        if (currentValue === null) return fail();
        const current = parseInventoryItemSnapshot(currentValue);
        for (const snapshot of [pinned, current]) {
          if (
            snapshot.tenantReference !== tenant ||
            snapshot.brandReference !== brand ||
            snapshot.itemReference !== itemReference ||
            snapshot.lifecycle !== "Active" ||
            snapshot.updatedAt > observedAt
          )
            return fail();
        }
        if (
          current.aggregateVersion < pinned.aggregateVersion ||
          canonicalizeRfc8785(current.baseUnit) !== canonicalizeRfc8785(pinned.baseUnit)
        )
          return fail();
        return Object.freeze({
          tenantReference: tenant,
          brandReference: brand,
          itemReference,
          sourceVersionKind: "InventoryItemConfigurationOperation" as const,
          sourceVersionReference: operation,
          sourceItemVersion: pinned.aggregateVersion,
          sourceAuditReference: record.audit.auditId,
          baseUnit: pinned.baseUnit,
          unitConversions: pinned.unitConversions,
          currentItemVersion: current.aggregateVersion,
          trackingPolicy: current.trackingPolicy,
          observedAt,
        });
      } catch {
        return fail();
      }
    },
  });
}
