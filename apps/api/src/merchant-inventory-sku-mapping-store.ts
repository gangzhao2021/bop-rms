import {
  CatalogError,
  createPostgresCatalogInventorySkuReferenceSourceStore,
  type CatalogInventorySkuReferenceOptions,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  InventoryItemError,
  createPostgresInventorySkuMappingStore,
  inventorySkuMappingIntentDigest,
  parseInventorySkuMappingCommand,
  type InventorySkuMappingStoreOptions,
  type InventorySkuMappingHeldSku,
  type InventorySkuMappingCommand,
} from "@rms/inventory";
export interface MerchantInventorySkuMappingOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly inventoryAuthority: InventorySkuMappingStoreOptions["authority"];
  readonly catalogAuthority: CatalogInventorySkuReferenceOptions["authority"];
  readonly audit: InventorySkuMappingStoreOptions["audit"];
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
function ownError(error: unknown): InventoryItemError | undefined {
  return error instanceof InventoryItemError &&
    [
      "INVENTORY_ITEM_PERMISSION_DENIED",
      "INVENTORY_ITEM_CONFLICT",
      "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT",
    ].includes(error.code)
    ? error
    : undefined;
}
/** Internal command adapter, not a normal HTTP route or default IAM provider.
 * Own one RC transaction through Catalog current-SKU lease, Inventory parent KEY
 * SHARE/global fence and Audit. Every source runner binds the exact same tx. */
export function createMerchantInventorySkuMappingStore(
  options: MerchantInventorySkuMappingOptions,
) {
  return Object.freeze({
    async execute(input: InventorySkuMappingCommand) {
      const command = parseInventorySkuMappingCommand(input);
      let calls = 0,
        completed:
          | {
              readonly value: Awaited<
                ReturnType<ReturnType<typeof createPostgresInventorySkuMappingStore>["execute"]>
              >;
            }
          | undefined;
      try {
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const source = createPostgresCatalogInventorySkuReferenceSourceStore({
            ...options,
            transactions: { run: (work) => work(tx) },
            authority: options.catalogAuthority,
          });
          const inventory = createPostgresInventorySkuMappingStore({
            ...options,
            transactions: { run: (work) => work(tx) },
            authority: options.inventoryAuthority,
            catalog: {
              async withHeldCurrentSku(actual, input, work) {
                if (actual !== tx) return fail();
                const c = parseInventorySkuMappingCommand(input.command);
                if (
                  c.action !== "Set" ||
                  c.target === null ||
                  input.mappingIntentDigest !== inventorySkuMappingIntentDigest(c)
                )
                  return fail();
                let callbackError: InventoryItemError | undefined;
                try {
                  return await source.withCurrentSnapshot(
                    {
                      purposeCode: "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ",
                      tenantReference: c.tenantReference,
                      brandReference: c.brandReference,
                      actorReference: c.actorReference,
                      operationReference: c.operationReference,
                      consumerIntentDigest: input.mappingIntentDigest,
                      productReference: c.target.productReference,
                      productVersionReference: c.target.productVersionReference,
                      skuReference: c.target.skuReference,
                      expectedConfigurationDigest: c.target.catalogConfigurationDigest,
                    },
                    async (snapshot) => {
                      const held: InventorySkuMappingHeldSku = Object.freeze({
                        tenantReference: snapshot.request.tenantReference,
                        brandReference: snapshot.request.brandReference,
                        actorReference: snapshot.request.actorReference,
                        operationReference: snapshot.request.operationReference,
                        mappingIntentDigest: snapshot.request.consumerIntentDigest,
                        productReference: snapshot.request.productReference,
                        productVersionReference: snapshot.configuration.versionReference,
                        skuReference: snapshot.request.skuReference,
                        catalogConfigurationDigest: snapshot.configurationDigest,
                        coverage: "HeldCurrentSku",
                        observedAt: snapshot.observedAt,
                      });
                      try {
                        return await work(held);
                      } catch (error) {
                        callbackError = ownError(error);
                        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
                      }
                    },
                  );
                } catch (error) {
                  // Callback failures must cross the public Catalog boundary as bounded Catalog
                  // failures; restore the original owning code after the holder unwinds.
                  if (callbackError) throw callbackError;
                  if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
                    throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
                  return fail();
                }
              },
            },
          });
          completed = Object.freeze({ value: await inventory.execute(command) });
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        const preserved = ownError(error);
        if (preserved) throw preserved;
        return fail();
      }
    },
  });
}
