import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  InventoryItemAction,
  InventoryItemCommand,
  InventoryItemCommandRecord,
} from "../../contracts/inventory-item-command.js";
import type { InventoryItemAggregate, InventoryReference } from "../../domain/inventory-item.js";

export interface InventoryItemPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "InventoryItemManagement";
      readonly permission: "inventory.manage";
      readonly action: InventoryItemAction;
    }): Promise<{ readonly authorized: true } | null>;
  };
  readonly audit: {
    create(input: {
      readonly command: InventoryItemCommand;
      readonly before: InventoryItemAggregate | null;
      readonly after: InventoryItemAggregate;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "InventoryItem" | "ReorderPolicy"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveOperation(
      operationReference: InventoryReference,
    ): Promise<InventoryItemCommandRecord | null>;
    load(itemReference: InventoryReference): Promise<InventoryItemAggregate | null>;
    internalCodeExists(input: {
      readonly brandReference: InventoryReference;
      readonly normalizedCode: string;
      readonly excludingItemReference: InventoryReference | null;
    }): Promise<boolean>;
    commit(record: InventoryItemCommandRecord): Promise<InventoryItemCommandRecord>;
  };
}
