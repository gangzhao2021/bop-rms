import type {
  BrandOperatingEntityAssignment,
  BusinessFunction,
  OperatingEntity,
  OperatingEntityReference,
  StoreOperatingEntityAssignment,
} from "../../domain/operating-entity.js";
import type {
  BrandReference,
  CanonicalInstant,
  OrganizationVersion,
  StoreReference,
} from "@bop/tenant";

export interface OperatingEntityPort {
  getOperatingEntity(reference: OperatingEntityReference): Promise<OperatingEntity | null>;
  saveOperatingEntity(
    entity: OperatingEntity,
    expectedVersion: OrganizationVersion,
  ): Promise<OperatingEntity>;
  saveBrandAssignment(
    assignment: BrandOperatingEntityAssignment,
    expectedVersion: OrganizationVersion,
  ): Promise<BrandOperatingEntityAssignment>;
  saveStoreAssignment(
    assignment: StoreOperatingEntityAssignment,
    expectedVersion: OrganizationVersion,
  ): Promise<StoreOperatingEntityAssignment>;
  findStoreAssignments(
    brandReference: BrandReference,
    storeReference: StoreReference,
    businessFunction: BusinessFunction,
    effectiveAt: CanonicalInstant,
  ): Promise<readonly StoreOperatingEntityAssignment[]>;
}
