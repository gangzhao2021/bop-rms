import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  StockCountAction,
  StockCountCommand,
  StockCountCommandRecord,
  StockCountPermission,
  StockCountQuery,
} from "../../contracts/stock-count.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { StockCountAggregate } from "../../domain/stock-count.js";

export interface StockCountPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "StockCountManagement" | "StockCountRead";
      readonly permission: StockCountPermission;
      readonly action: StockCountAction | "List" | "Detail";
    }): Promise<{ readonly authorized: true; readonly mayViewExpected?: boolean } | null>;
  };
  readonly projection: {
    query(input: StockCountQuery): Promise<{
      readonly projectionName: "inventory_count_workbench_v1";
      readonly projectionVersion: 1;
      readonly stockScope: StockCountAggregate["stockScope"];
      readonly asOfUtc: StockCountAggregate["updatedAt"];
      readonly freshness: "Current" | "Stale" | "Rebuilding";
      readonly partial: boolean;
      readonly counts: readonly StockCountAggregate[];
    }>;
  };
  readonly snapshot: {
    capture(command: StockCountCommand): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: InventoryReference,
    ): Promise<StockCountCommandRecord | null>;
    load(countReference: InventoryReference): Promise<StockCountAggregate | null>;
    commit(record: StockCountCommandRecord): Promise<StockCountCommandRecord>;
  };
  readonly posting: {
    /** Atomically commits the Posted Count, unique operation and one Movement per non-zero line. */
    commit(input: {
      readonly command: StockCountCommand;
      readonly before: StockCountAggregate;
      readonly intentHash: string;
      readonly audit: AppendAuditRecordInput;
    }): Promise<StockCountCommandRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: StockCountCommand;
      readonly before: StockCountAggregate | null;
      readonly after: StockCountAggregate | null;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "StockCount"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
