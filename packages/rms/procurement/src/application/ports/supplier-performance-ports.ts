import type {
  SupplierPerformanceCommand,
  SupplierPerformanceQuery,
  SupplierPerformanceRecord,
} from "../../contracts/supplier-performance.js";
import type { OfferingReference } from "../../domain/aggregates/offering.js";
export interface SupplierPerformancePorts {
  readonly authorization: {
    authorize(input: SupplierPerformanceQuery | SupplierPerformanceCommand): Promise<{
      readonly authorized: true;
      readonly mayDrillFacts?: boolean;
      readonly mayViewPriceVariance?: boolean;
      readonly mayViewManualAssessments?: boolean;
      readonly mayExport?: boolean;
      readonly mayOpenReviewTask?: boolean;
    } | null>;
  };
  readonly source: {
    /** Public PO, Revision, Acknowledgement and Goods Receipt event contracts only. */
    read(query: SupplierPerformanceQuery): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(reference: OfferingReference): Promise<SupplierPerformanceRecord | null>;
    commit(record: SupplierPerformanceRecord): Promise<SupplierPerformanceRecord>;
  };
  readonly collaboration: {
    openReviewTask(command: SupplierPerformanceCommand): Promise<unknown>;
  };
  readonly audit: {
    create(command: SupplierPerformanceCommand): Promise<SupplierPerformanceRecord["audit"]>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
