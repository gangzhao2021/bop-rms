import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  DiscrepancyCommand,
  DiscrepancyIngestionCommand,
  DiscrepancyProjection,
  DiscrepancyQuery,
  DiscrepancyRecord,
} from "../../contracts/discrepancy.js";
import type { SupplierDiscrepancy } from "../../domain/aggregates/discrepancy.js";
import type { OfferingReference } from "../../domain/aggregates/offering.js";
export interface DiscrepancyPorts {
  readonly authorization: {
    authorize(input: DiscrepancyCommand | DiscrepancyIngestionCommand | DiscrepancyQuery): Promise<{
      readonly authorized: true;
      readonly mayViewSupplierContact?: boolean;
      readonly mayViewEvidence?: boolean;
      readonly mayViewCost?: boolean;
      readonly mayViewHistory?: boolean;
      readonly mayWaiveRemainder?: boolean;
    } | null>;
  };
  readonly projection: { query(input: DiscrepancyQuery): Promise<DiscrepancyProjection> };
  readonly source: {
    /** Public PO/Receipt projection only. */ inspect(
      command: DiscrepancyCommand | DiscrepancyIngestionCommand,
    ): Promise<unknown>;
  };
  readonly approvals: {
    validate(reference: OfferingReference, command: DiscrepancyCommand): Promise<unknown>;
  };
  readonly collaboration: {
    request(input: {
      readonly command: DiscrepancyCommand;
      readonly discrepancy: SupplierDiscrepancy;
    }): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(reference: OfferingReference): Promise<DiscrepancyRecord | null>;
    resolveSource(input: {
      readonly sourceEventReference: OfferingReference;
      readonly receiptLineReference: OfferingReference;
      readonly type: string;
    }): Promise<DiscrepancyRecord | null>;
    load(input: {
      readonly tenantReference: OfferingReference;
      readonly brandReference: OfferingReference;
      readonly stockSiteReference: OfferingReference;
      readonly discrepancyReference: OfferingReference;
    }): Promise<SupplierDiscrepancy | null>;
    commit(record: DiscrepancyRecord): Promise<DiscrepancyRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: DiscrepancyCommand | DiscrepancyIngestionCommand;
      readonly before: SupplierDiscrepancy | null;
      readonly after: SupplierDiscrepancy;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
