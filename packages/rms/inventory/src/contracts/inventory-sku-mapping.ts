import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { InventoryItemError } from "../domain/inventory-item.js";
import {
  parseInventorySkuMappingCommand,
  parseInventorySkuMappingVersion,
  planInventorySkuMappingVersion,
  type InventorySkuMappingCommand,
  type InventorySkuMappingVersion,
  type InventorySkuMappingCurrentItem,
  type InventorySkuMappingHeldSku,
} from "../domain/inventory-sku-mapping.js";
export const inventorySkuMappingWriteFields = Object.freeze([
  "mappingReference",
  "itemReference",
  "expectedMappingVersion",
  "expectedItemVersion",
  "configurationOperationReference",
  "action",
  "target.productReference",
  "target.productVersionReference",
  "target.skuReference",
  "target.catalogConfigurationDigest",
  "reasonCode",
] as const);
export function inventorySkuMappingIntentDigest(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalizeRfc8785(parseInventorySkuMappingCommand(value)));
}
/** Reconstitute the original mutation intent, including expected versions, original
 * Actor and timestamp. A typed record alone is not proof of an unaltered intent. */
export function verifyInventorySkuMappingVersion(value: unknown): InventorySkuMappingVersion {
  const v = parseInventorySkuMappingVersion(value);
  const command = {
    purpose: "InventorySkuMappingManagement" as const,
    permission: "inventory.item.update" as const,
    tenantReference: v.tenantReference,
    brandReference: v.brandReference,
    actorReference: v.actorReference,
    operationReference: v.operationReference,
    occurredAt: v.occurredAt,
    mappingReference: v.mappingReference,
    itemReference: v.itemReference,
    expectedMappingVersion: v.mappingVersion - 1,
    expectedItemVersion: v.sourceItemVersion,
    configurationOperationReference: v.sourceConfigurationOperationReference,
    action: v.action,
    target: v.target,
    reasonCode: v.reasonCode,
  };
  if (inventorySkuMappingIntentDigest(command) !== v.mappingIntentDigest)
    throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
  return v;
}
export function planInventorySkuMapping(
  input: InventorySkuMappingCommand,
  before: InventorySkuMappingVersion | null,
  item: InventorySkuMappingCurrentItem,
  sku: InventorySkuMappingHeldSku | null,
  now: string,
): InventorySkuMappingVersion {
  const command = parseInventorySkuMappingCommand(input);
  return planInventorySkuMappingVersion(
    command,
    before === null ? null : verifyInventorySkuMappingVersion(before),
    item,
    sku,
    inventorySkuMappingIntentDigest(command),
    now,
  );
}
export function recoverInventorySkuMapping(
  input: InventorySkuMappingCommand,
  stored: unknown,
): InventorySkuMappingVersion {
  const command = parseInventorySkuMappingCommand(input),
    record = verifyInventorySkuMappingVersion(stored);
  if (
    record.tenantReference !== command.tenantReference ||
    record.brandReference !== command.brandReference ||
    record.operationReference !== command.operationReference ||
    record.mappingIntentDigest !== inventorySkuMappingIntentDigest(command)
  )
    throw new InventoryItemError("INVENTORY_ITEM_IDEMPOTENCY_CONFLICT");
  return record;
}
