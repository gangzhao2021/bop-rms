import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  StockAdjustmentAction,
  StockAdjustmentCommand,
  StockAdjustmentCommandRecord,
  StockAdjustmentPermission,
  StockAdjustmentQuery,
} from "../../contracts/stock-adjustment.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { StockAdjustmentAggregate } from "../../domain/stock-adjustment.js";
import type { MovementStockScope } from "../../domain/stock-movement.js";

export interface StockAdjustmentPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "StockAdjustmentManagement" | "StockAdjustmentRead";
      readonly permission: StockAdjustmentPermission;
      readonly action: StockAdjustmentAction | "Detail";
      readonly stockScope: MovementStockScope;
    }): Promise<{
      readonly authorized: true;
      readonly negativeOverrideAuthorized?: boolean;
      readonly mayViewEvidence?: boolean;
    } | null>;
  };
  readonly projection: {
    query(input: StockAdjustmentQuery): Promise<{
      readonly projectionName: "inventory_adjustment_wizard_v1";
      readonly projectionVersion: 1;
      readonly stockScope: StockAdjustmentAggregate["stockScope"];
      readonly asOfUtc: StockAdjustmentAggregate["updatedAt"];
      readonly freshness: "Current" | "Stale" | "Rebuilding";
      readonly partial: boolean;
      readonly adjustment: StockAdjustmentAggregate;
    }>;
  };
  readonly snapshot: {
    inspect(command: StockAdjustmentCommand): Promise<unknown>;
  };
  readonly evidence: {
    /** Resolves only evidence references authorized for the command Tenant, Brand and purpose. */
    resolve(command: StockAdjustmentCommand): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: InventoryReference,
    ): Promise<StockAdjustmentCommandRecord | null>;
    load(adjustmentReference: InventoryReference): Promise<StockAdjustmentAggregate | null>;
    commit(record: StockAdjustmentCommandRecord): Promise<StockAdjustmentCommandRecord>;
  };
  readonly posting: {
    /** Atomically commits one Posted Adjustment, its unique operation and immutable Movement. */
    commit(input: {
      readonly command: StockAdjustmentCommand;
      readonly before: StockAdjustmentAggregate;
      readonly intentHash: string;
      readonly audit: AppendAuditRecordInput;
    }): Promise<StockAdjustmentCommandRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: StockAdjustmentCommand;
      readonly before: StockAdjustmentAggregate | null;
      readonly after: StockAdjustmentAggregate | null;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "StockAdjustment"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
