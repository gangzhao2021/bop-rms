import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";

import type { CategoryAggregate, MenuAggregate } from "../../domain/category-menu.js";
import type { CatalogHash, CatalogInstant, CatalogReference } from "../../contracts/product.js";

export interface CategoryMenuAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export type CategoryOperationAction = "Create" | "Move" | "ChangeLifecycle";
export type MenuOperationAction = "Create" | "ReplaceDraft";

export interface CategoryOperationRecord {
  readonly action: CategoryOperationAction;
  readonly operationReference: CatalogReference;
  readonly operationIntentHash: CatalogHash;
  readonly aggregate: CategoryAggregate;
}

export interface MenuOperationRecord {
  readonly action: MenuOperationAction;
  readonly operationReference: CatalogReference;
  readonly operationIntentHash: CatalogHash;
  readonly aggregate: MenuAggregate;
}

export interface CategoryMenuAuthorizationPort {
  authorize(input: {
    readonly resource: "Category" | "Menu";
    readonly action: CategoryOperationAction | MenuOperationAction;
    readonly operationReference: CatalogReference;
    readonly aggregateReference: CatalogReference;
    readonly observedAt: CatalogInstant;
  }): Promise<CategoryMenuAuthorizationEvidence | null>;
}

export interface CategoryMenuReferencePort {
  generate(purpose: "Category" | "Menu" | "MenuVersion" | "MenuSection" | "Placement"): string;
  hashIntent(value: string): CatalogHash;
  equals(left: CatalogHash, right: CatalogHash): boolean;
}

export interface CatalogStructureFactPort {
  validateStores(input: {
    readonly brandReference: CatalogReference;
    readonly storeReferences: readonly CatalogReference[];
  }): Promise<boolean>;
  validateCategories(input: {
    readonly brandReference: CatalogReference;
    readonly categoryReferences: readonly CatalogReference[];
  }): Promise<boolean>;
  validateSellables(input: {
    readonly brandReference: CatalogReference;
    readonly sellableReferences: readonly CatalogReference[];
    readonly sellableType: "Sku";
  }): Promise<boolean>;
}

export interface CategoryRepositoryPort {
  resolveOperation(operationReference: CatalogReference): Promise<CategoryOperationRecord | null>;
  load(categoryReference: CatalogReference): Promise<CategoryAggregate | null>;
  codeAvailable(input: {
    readonly brandReference: CatalogReference;
    readonly internalCode: string;
    readonly excludingCategoryReference: CatalogReference | null;
  }): Promise<boolean>;
  inspectMove(input: {
    readonly categoryReference: CatalogReference;
    readonly brandReference: CatalogReference;
    readonly parentCategoryReference: CatalogReference | null;
    readonly sortOrder: number;
  }): Promise<{
    readonly parent: CategoryAggregate | null;
    readonly ancestorReferences: readonly CatalogReference[];
    readonly subtreeDepth: number;
    readonly siblingSortAvailable: boolean;
    readonly hasActiveChildren: boolean;
  }>;
  create(input: {
    readonly record: CategoryOperationRecord;
    readonly audit: AppendAuditRecordInput;
  }): Promise<CategoryOperationRecord>;
  commit(input: {
    readonly record: CategoryOperationRecord;
    readonly expectedAggregateVersion: number;
    readonly audit: AppendAuditRecordInput;
  }): Promise<CategoryOperationRecord>;
}

export interface MenuRepositoryPort {
  resolveOperation(operationReference: CatalogReference): Promise<MenuOperationRecord | null>;
  load(menuReference: CatalogReference): Promise<MenuAggregate | null>;
  codeAvailable(input: {
    readonly brandReference: CatalogReference;
    readonly internalCode: string;
    readonly excludingMenuReference: CatalogReference | null;
  }): Promise<boolean>;
  inspectBase(input: {
    readonly menuReference: CatalogReference;
    readonly brandReference: CatalogReference;
    readonly baseMenuReference: CatalogReference | null;
  }): Promise<{ readonly base: MenuAggregate | null; readonly menuIsBase: boolean }>;
  create(input: {
    readonly record: MenuOperationRecord;
    readonly audit: AppendAuditRecordInput;
  }): Promise<MenuOperationRecord>;
  commit(input: {
    readonly record: MenuOperationRecord;
    readonly expectedAggregateVersion: number;
    readonly audit: AppendAuditRecordInput;
  }): Promise<MenuOperationRecord>;
}

export interface CategoryMenuPorts {
  readonly authorization: CategoryMenuAuthorizationPort;
  readonly references: CategoryMenuReferencePort;
  readonly facts: CatalogStructureFactPort;
  readonly categories: CategoryRepositoryPort;
  readonly menus: MenuRepositoryPort;
}
