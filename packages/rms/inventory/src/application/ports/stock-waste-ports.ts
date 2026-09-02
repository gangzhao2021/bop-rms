import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  StockWasteAction,
  StockWasteCommand,
  StockWasteCommandRecord,
  StockWastePermission,
  StockWasteQuery,
} from "../../contracts/stock-waste.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { StockWasteAggregate } from "../../domain/stock-waste.js";
import type { MovementStockScope } from "../../domain/stock-movement.js";

export interface StockWastePorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "StockWasteManagement" | "StockWasteRead";
      readonly permission: StockWastePermission;
      readonly action: StockWasteAction | "Detail";
      readonly stockScope: MovementStockScope;
    }): Promise<{
      readonly authorized: true;
      readonly negativeOverrideAuthorized?: boolean;
      readonly mayViewEvidence?: boolean;
      readonly mayViewCost?: boolean;
    } | null>;
  };
  readonly projection: {
    query(input: StockWasteQuery): Promise<{
      readonly projectionName: "inventory_waste_wizard_v1";
      readonly projectionVersion: 1;
      readonly stockScope: StockWasteAggregate["stockScope"];
      readonly asOfUtc: StockWasteAggregate["updatedAt"];
      readonly freshness: "Current" | "Stale" | "Rebuilding";
      readonly partial: boolean;
      readonly waste: StockWasteAggregate;
    }>;
  };
  readonly snapshot: {
    inspect(command: StockWasteCommand): Promise<unknown>;
  };
  readonly evidence: {
    /** Resolves only evidence references authorized for the command Tenant, Brand and purpose. */
    resolve(command: StockWasteCommand): Promise<unknown>;
  };
  readonly source: {
    /** Resolves a stable authorized Kitchen or Compliance public reference; never a private table row. */
    resolve(command: StockWasteCommand): Promise<unknown>;
  };
  readonly policy: {
    /** Returns the server-owned approval threshold decision for this exact Waste intent. */
    decide(command: StockWasteCommand): Promise<unknown>;
  };
  readonly valuation: {
    /** Returns an optional exact minor-unit cost snapshot; the browser cannot author valuation. */
    inspect(command: StockWasteCommand): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: InventoryReference,
    ): Promise<StockWasteCommandRecord | null>;
    load(wasteReference: InventoryReference): Promise<StockWasteAggregate | null>;
    commit(record: StockWasteCommandRecord): Promise<StockWasteCommandRecord>;
  };
  readonly posting: {
    /** Atomically commits one Posted Waste, its unique operation and immutable Movement. */
    commit(input: {
      readonly command: StockWasteCommand;
      readonly before: StockWasteAggregate;
      readonly intentHash: string;
      readonly audit: AppendAuditRecordInput;
    }): Promise<StockWasteCommandRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: StockWasteCommand;
      readonly before: StockWasteAggregate | null;
      readonly after: StockWasteAggregate | null;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "StockWaste"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
