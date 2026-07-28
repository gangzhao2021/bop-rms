import type {
  Brand,
  BrandReference,
  OrganizationVersion,
  Store,
  StoreReference,
} from "../../domain/brand-store.js";

export interface TenantOrganizationPort {
  getBrand(reference: BrandReference): Promise<Brand | null>;
  getStore(reference: StoreReference): Promise<Store | null>;
  saveBrand(brand: Brand, expectedVersion: OrganizationVersion): Promise<Brand>;
  saveStore(store: Store, expectedVersion: OrganizationVersion): Promise<Store>;
  listStoreReferences(brandReference: BrandReference): Promise<readonly StoreReference[]>;
}
