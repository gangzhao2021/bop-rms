import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";

import type {
  CatalogHash,
  CatalogInstant,
  CatalogReference,
  ProductAggregate,
} from "../../contracts/product.js";

export interface CatalogAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}
export interface CatalogOperationRecord {
  readonly action: "Create" | "ReplaceDraft" | "ChangeLifecycle";
  readonly operationReference: CatalogReference;
  readonly operationIntentHash: CatalogHash;
  readonly aggregate: ProductAggregate;
}
export interface CatalogAuthorizationPort {
  authorize(input: {
    readonly action: CatalogOperationRecord["action"];
    readonly operationReference: CatalogReference;
    readonly productReference: CatalogReference | null;
    readonly observedAt: CatalogInstant;
  }): Promise<CatalogAuthorizationEvidence | null>;
}
export interface CatalogReferencePort {
  generate(purpose: "Product" | "ProductVersion" | "Sku"): string;
  hashIntent(value: string): CatalogHash;
  equals(left: CatalogHash, right: CatalogHash): boolean;
}
export interface CatalogProductRepositoryPort {
  resolveOperation(operationReference: CatalogReference): Promise<CatalogOperationRecord | null>;
  load(productReference: CatalogReference): Promise<ProductAggregate | null>;
  codeAvailable(input: {
    readonly brandReference: CatalogReference;
    readonly productCode: string;
    readonly skuCodes: readonly string[];
    readonly excludingProductReference: CatalogReference | null;
  }): Promise<boolean>;
  create(input: {
    readonly record: CatalogOperationRecord;
    readonly audit: AppendAuditRecordInput;
  }): Promise<CatalogOperationRecord>;
  commit(input: {
    readonly record: CatalogOperationRecord;
    readonly expectedAggregateVersion: number;
    readonly audit: AppendAuditRecordInput;
  }): Promise<CatalogOperationRecord>;
}
export interface CatalogProductPorts {
  readonly authorization: CatalogAuthorizationPort;
  readonly references: CatalogReferencePort;
  readonly repository: CatalogProductRepositoryPort;
}
