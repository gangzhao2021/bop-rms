import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  InventoryInstant,
  InventoryItemAggregate,
  InventoryReference,
} from "../domain/inventory-item.js";

export type InventoryItemAction =
  "Create" | "Update" | "Activate" | "Deactivate" | "Archive" | "Restore" | "SetReorderPolicy";

export interface InventoryItemCommand {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly actorReference: InventoryReference;
  readonly purpose: "InventoryItemManagement";
  readonly permission: "inventory.manage";
  readonly operationReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly action: InventoryItemAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface InventoryItemCommandRecord {
  readonly operationReference: InventoryReference;
  readonly intentHash: string;
  readonly action: InventoryItemAction;
  readonly item: InventoryItemAggregate;
  readonly outcome: "Applied" | "AlreadyApplied";
  readonly audit: AppendAuditRecordInput;
}
