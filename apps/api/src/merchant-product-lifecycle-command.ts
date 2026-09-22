import { readClosedRecord } from "@bop/identity";
import { sha256Hex } from "@bop/audit";
import {
  CatalogError,
  createCatalogProductService,
  createPostgresProductLifecycleStore,
  parseCatalogInstant,
  parseCatalogHash,
  parseCatalogReference,
  parseProductLifecycle,
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
      "productReference",
      "skuReference",
      "targetLifecycle",
      "expectedAggregateVersion",
      "operationReference",
    ]);
    if (
      !Number.isSafeInteger(raw.expectedAggregateVersion) ||
      (raw.expectedAggregateVersion as number) < 1
    )
      return fail("CATALOG_INPUT_INVALID");
    return {
      productReference: parseCatalogReference(raw.productReference),
      skuReference: raw.skuReference === null ? null : parseCatalogReference(raw.skuReference),
      targetLifecycle: parseProductLifecycle(raw.targetLifecycle),
      expectedAggregateVersion: raw.expectedAggregateVersion as number,
      operationReference: parseCatalogReference(raw.operationReference),
    };
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}

/** Only the lifecycle command is exposed. The current Brand permission and
 * immutable result come from server owners, including on idempotent replay. */
export function createMerchantProductLifecycleCommand(options: {
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
      const store = createPostgresProductLifecycleStore({
        brandReference: brand,
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) =>
          (input.productReference === null ||
            input.productReference === command.productReference) &&
          (!input.record || input.record.action === "ChangeLifecycle") &&
          (await permission()) !== null,
      });
      const unavailable = (): never => fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const service = createCatalogProductService({
        // Create/ReplaceDraft are not routed here and require their own complete owner adapter.
        repository: { ...store, create: unavailable, codeAvailable: unavailable },
        optionSets: { resolveVersion: unavailable },
        references: {
          generate: unavailable,
          hashIntent: (value) => parseCatalogHash(sha256Hex(value)),
          equals: (a, b) => a === b,
        },
        authorization: {
          authorize: async (input) => {
            const decision = await permission();
            if (
              !decision ||
              input.action !== "ChangeLifecycle" ||
              input.productReference !== command.productReference ||
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
                actionCode: "CATALOG_PRODUCT_CHANGELIFECYCLE",
                targetType: "CatalogProduct",
                targetId: command.productReference,
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
      const result = await service.changeLifecycle({
        ...command,
        requestedAt: parseCatalogInstant(options.merchant.now()),
      });
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      return {
        status: result.status,
        productReference: result.aggregate.productReference,
        skuReference: command.skuReference,
        aggregateVersion: result.aggregate.aggregateVersion,
        productLifecycle: result.aggregate.lifecycle,
        skuLifecycle:
          command.skuReference === null
            ? null
            : (result.aggregate.draft.skus.find((sku) => sku.skuReference === command.skuReference)
                ?.lifecycle ?? fail("CATALOG_DEPENDENCY_UNAVAILABLE")),
      };
    });
  };
}
