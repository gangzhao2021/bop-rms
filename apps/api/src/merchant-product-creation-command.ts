import { readClosedRecord } from "@bop/identity";
import { sha256Hex } from "@bop/audit";
import {
  CatalogError,
  createCatalogProductService,
  createPostgresProductCreationStore,
  parseCatalogInstant,
  parseCatalogHash,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogDecimal,
  parseCatalogLocale,
  parseLocalizedNames,
  parseVariantSelections,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const fail = (code: ConstructorParameters<typeof CatalogError>[0]): never => {
  throw new CatalogError(code);
};
function decode(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "internalCode",
      "productType",
      "defaultLocale",
      "localizedNames",
      "taxClassificationReference",
      "skus",
      "operationReference",
    ]);
    if (
      (raw.productType !== "PreparedFood" && raw.productType !== "NonAlcoholicBeverage") ||
      !Array.isArray(raw.skus)
    )
      return fail("CATALOG_INPUT_INVALID");
    const defaultLocale = parseCatalogLocale(raw.defaultLocale);
    const skus = raw.skus.map((value) => {
      const sku = readClosedRecord(value, [
        "skuCode",
        "localizedNames",
        "variantSelections",
        "unitOfSale",
        "unitQuantity",
      ]);
      const unitQuantity = parseCatalogDecimal(sku.unitQuantity);
      // Exact PostgreSQL numeric(20,6); never permit implicit numeric rounding.
      if (!/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/.test(unitQuantity))
        return fail("CATALOG_INPUT_INVALID");
      return {
        skuCode: parseCatalogCode(sku.skuCode),
        localizedNames: parseLocalizedNames(sku.localizedNames, defaultLocale),
        variantSelections: [...parseVariantSelections(sku.variantSelections)].sort((a, b) =>
          a.dimensionReference.localeCompare(b.dimensionReference),
        ),
        unitOfSale: parseCatalogCode(sku.unitOfSale),
        unitQuantity,
      };
    });
    return {
      internalCode: parseCatalogCode(raw.internalCode),
      productType: raw.productType,
      defaultLocale,
      localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
      taxClassificationReference:
        raw.taxClassificationReference === null
          ? null
          : parseCatalogReference(raw.taxClassificationReference),
      skus,
      operationReference: parseCatalogReference(raw.operationReference),
    };
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}
function identity(operation: string, brand: string, purpose: string, index: number) {
  const hash = sha256Hex("CatalogHttp:" + brand + ":" + purpose + ":" + index + ":" + operation);
  return parseCatalogReference(
    operation.slice(0, 14) +
      "7" +
      hash.slice(0, 3) +
      "-8" +
      hash.slice(3, 6) +
      "-" +
      hash.slice(6, 18),
  );
}

/** Server-bound Product graph creation; operation replay uses its original clock. */
export function createMerchantProductCreationCommand(options: {
  merchant: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  auditReference(operationReference: string): string;
}) {
  const resolveScope = createMerchantBrandScope(options.merchant);
  return async (request: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    const command = decode(request.command);
    return options.merchant.transactions.run(async (identityTransaction) => {
      const transaction: ProductLifecycleTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await identityTransaction.query(sql, values);
          if (!result || typeof result !== "object") return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
          )
            return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };
      const scope = await resolveScope(
        transaction,
        request.sessionCookie,
        session.sessionReference,
      );
      const permission = async () => {
        const decision = await scope.authorizeAction("catalog.product.manage");
        return decision?.effect === "Allow" &&
          decision.scopeKind === "Brand" &&
          decision.action === "catalog.product.manage"
          ? decision
          : null;
      };
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      const brand = parseCatalogReference(scope.context.brand.brandReference);
      const product = identity(command.operationReference, brand, "Product", 0);
      const store = createPostgresProductCreationStore({
        brandReference: brand,
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) =>
          (input.productReference === null || input.productReference === product) &&
          (!input.record || input.record.action === "Create") &&
          (await permission()) !== null,
      });
      const unavailable = (): never => fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const prior = await store.resolveOperation(command.operationReference);
      const requestedAt = parseCatalogInstant(prior?.aggregate.createdAt ?? options.merchant.now());
      const indexes: Record<string, number> = {};
      const service = createCatalogProductService({
        // Only Create is exposed here; editing requires a separate complete Draft writer.
        repository: { ...store, commit: unavailable },
        optionSets: { resolveVersion: unavailable },
        references: {
          generate: (purpose) => {
            const index = indexes[purpose] ?? 0;
            indexes[purpose] = index + 1;
            return identity(command.operationReference, brand, purpose, index);
          },
          hashIntent: (value) => parseCatalogHash(sha256Hex(value)),
          equals: (a, b) => a === b,
        },
        authorization: {
          authorize: async (input) => {
            const decision = await permission();
            if (
              !decision ||
              input.action !== "Create" ||
              input.productReference !== product ||
              input.operationReference !== command.operationReference
            )
              return null;
            return {
              tenantContext: scope.context,
              permission: decision,
              audit: {
                auditId: parseCatalogReference(options.auditReference(input.operationReference)),
                brandId: brand,
                actor: { type: "User", reference: scope.actorReference },
                actionCode: "CATALOG_PRODUCT_CREATE",
                targetType: "CatalogProduct",
                targetId: product,
                correlationId: input.operationReference,
                occurredAt: input.observedAt,
                reasonCode: "AUTHORIZED_OPERATION",
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              },
            };
          },
        },
      });
      const result = await service.create({ ...command, requestedAt });
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      return {
        status: result.status,
        productReference: result.aggregate.productReference,
        versionReference: result.aggregate.draft.versionReference,
        aggregateVersion: result.aggregate.aggregateVersion,
        lifecycle: result.aggregate.lifecycle,
        skus: result.aggregate.draft.skus.map((sku) => ({
          skuReference: sku.skuReference,
          skuCode: sku.skuCode,
          lifecycle: sku.lifecycle,
        })),
      };
    });
  };
}
