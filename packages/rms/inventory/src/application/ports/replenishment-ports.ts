import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  ReplenishmentAction,
  ReplenishmentCommand,
  ReplenishmentCommandRecord,
  ReplenishmentProjection,
  ReplenishmentQuery,
} from "../../contracts/replenishment.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { ReplenishmentNeedAggregate } from "../../domain/replenishment-need.js";
import type { MovementStockScope } from "../../domain/stock-movement.js";

export interface ReplenishmentPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "ReplenishmentRead" | "ReplenishmentManagement";
      readonly permission: "inventory.manage" | "procurement.requisition.create";
      readonly action: ReplenishmentAction | "List";
      readonly stockScope: MovementStockScope;
    }): Promise<{
      readonly authorized: true;
      readonly mayViewSupplierSummary?: boolean;
      readonly mayAcknowledge?: boolean;
      readonly mayDismiss?: boolean;
      readonly mayCreateRequisitionDraft?: boolean;
    } | null>;
  };
  readonly projection: { query(input: ReplenishmentQuery): Promise<ReplenishmentProjection> };
  readonly snapshot: {
    /** Rebinds exact owner facts; no Procurement private-table access. */
    inspect(command: ReplenishmentCommand): Promise<unknown>;
  };
  readonly procurement: {
    /** Public command port. It may return only a Draft Requisition for the same Need and scope. */
    createRequisitionDraft(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly stockScope: MovementStockScope;
      readonly sourceNeedReference: InventoryReference;
      readonly itemReference: InventoryReference;
      readonly requestedQuantity: string;
      readonly baseUnitCode: string;
      readonly requiredBy: string;
      readonly urgency: string;
      readonly idempotencyReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly occurredAt: string;
    }): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(reference: InventoryReference): Promise<ReplenishmentCommandRecord | null>;
    load(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly stockScope: MovementStockScope;
      readonly needReference: InventoryReference;
    }): Promise<ReplenishmentNeedAggregate | null>;
    commit(record: ReplenishmentCommandRecord): Promise<ReplenishmentCommandRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: ReplenishmentCommand;
      readonly before: ReplenishmentNeedAggregate;
      readonly after: ReplenishmentNeedAggregate;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
