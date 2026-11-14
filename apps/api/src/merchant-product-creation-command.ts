import {
  createMerchantProductEditorRuntimeBrandSources,
  parseMerchantProductAuthoringSources,
  type MerchantProductAuthoringSources,
} from "./merchant-product-editor-runtime-brand-sources.js";
import { createMerchantProductEditorSellingUnitAuthority } from "./merchant-product-editor-selling-unit-authority.js";
import { createMerchantProductCategoryPolicyAuthority } from "./merchant-product-category-policy-authority.js";
import {
  createMerchantProductWriteGuard,
  MerchantProductWriteFeatureDisabled,
  type MerchantProductWriteAuthority,
} from "./merchant-product-write-authority.js";
import {
  parseMerchantProductCommandScope,
  bindMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
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
  parseProductCategoryClassification,
  parseLocalizedNames,
  parseVariantSelections,
  parseCatalogProductInitialEditorContent,
  copyCategoryPersistenceValue,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import {
  createMerchantProductEditorContentAuthority,
  type MerchantProductEditorContentAuthority,
} from "./merchant-product-editor-content-authority.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  createMerchantProductCreationContentFactory,
  type RegisteredProductCreationContent,
} from "./merchant-product-creation-content.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { createMerchantProductAuthoringRuntimeAuthority } from "./merchant-product-authoring-runtime-authority.js";

const fail = (code: ConstructorParameters<typeof CatalogError>[0]): never => {
  throw new CatalogError(code);
};
function decode(value: unknown, completeContentConfigured: boolean) {
  try {
    const classified =
      value !== null && typeof value === "object" && Object.hasOwn(value, "categoryClassification");
    const complete =
      value !== null && typeof value === "object" && Object.hasOwn(value, "editorContent");
    const raw = readClosedRecord(value, [
      "internalCode",
      "productType",
      "defaultLocale",
      "localizedNames",
      "taxClassificationReference",
      "skus",
      "operationReference",
      ...(classified ? ["categoryClassification"] : []),
      ...(complete ? ["editorContent"] : []),
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
    if (
      complete &&
      (!completeContentConfigured ||
        skus.length > 1 ||
        skus.some((sku) => sku.variantSelections.length !== 0))
    )
      return fail("CATALOG_INPUT_INVALID");
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
      ...(complete
        ? {
            editorContent: (() => {
              const content = parseCatalogProductInitialEditorContent(
                raw.editorContent,
                defaultLocale,
              );
              if (
                skus.length !== 0 &&
                (content.variantDimensions.length !== 0 || content.variantCombinations.length !== 0)
              )
                return fail("CATALOG_INPUT_INVALID");
              return content;
            })(),
          }
        : {}),
      ...(classified
        ? { categoryClassification: parseProductCategoryClassification(raw.categoryClassification) }
        : {}),
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
interface MerchantProductCreationLegacyOptions {
  merchant: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  auditReference(operationReference: string): string;
  categoryPolicy?: MerchantProductCategoryPolicy;
  writeAuthority?: MerchantProductWriteAuthority;
  editorContentAuthority?: MerchantProductEditorContentAuthority;
  registeredEditorContent?: RegisteredProductCreationContent;
}
export type MerchantProductCreationCommandOptions = Omit<
  MerchantProductCreationLegacyOptions,
  "categoryPolicy" | "writeAuthority" | "editorContentAuthority" | "registeredEditorContent"
> &
  (
    | {
        readonly currentRuntime: true;
        readonly authoringSources: MerchantProductAuthoringSources;
        readonly categoryPolicy?: never;
        readonly writeAuthority?: never;
        readonly editorContentAuthority?: never;
        readonly registeredEditorContent?: never;
      }
    | (Pick<
        MerchantProductCreationLegacyOptions,
        "categoryPolicy" | "writeAuthority" | "editorContentAuthority" | "registeredEditorContent"
      > & { readonly currentRuntime?: never; readonly authoringSources?: never })
  );
export function createMerchantProductCreationCommand(
  options: MerchantProductCreationCommandOptions,
) {
  const resolveScope = createMerchantBrandScope(options.merchant);
  const host = createMerchantCategoryTransactions(options.merchant.transactions);
  const currentRuntime = options.currentRuntime === true;
  if (
    (options.currentRuntime !== undefined && !currentRuntime) ||
    (currentRuntime &&
      (options.writeAuthority !== undefined ||
        options.editorContentAuthority !== undefined ||
        options.registeredEditorContent !== undefined ||
        options.categoryPolicy !== undefined ||
        options.authoringSources === undefined)) ||
    (!currentRuntime && options.authoringSources !== undefined)
  )
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  if (
    options.editorContentAuthority !== undefined &&
    typeof options.editorContentAuthority !== "function"
  )
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  if (options.registeredEditorContent !== undefined && options.editorContentAuthority !== undefined)
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  const contentAuthority = options.editorContentAuthority?.bind(options);
  const runtimeBrandSelection = currentRuntime
    ? parseMerchantProductAuthoringSources(options.authoringSources)
    : undefined;
  const registeredContent =
    runtimeBrandSelection !== undefined
      ? createMerchantProductCreationContentFactory({ authoringSources: runtimeBrandSelection })
      : options.registeredEditorContent === undefined
        ? undefined
        : createMerchantProductCreationContentFactory(options.registeredEditorContent);
  return async (request: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
    expectedScope: unknown;
  }) => {
    const authenticationInput = { sessionCookie: request.sessionCookie, csrf: request.csrf };
    const expectedScope = parseMerchantProductCommandScope(
      copyCategoryPersistenceValue(request.expectedScope),
    );
    const command = decode(
      copyCategoryPersistenceValue(request.command),
      contentAuthority !== undefined || registeredContent !== undefined,
    );
    if (currentRuntime && command.editorContent === undefined) return fail("CATALOG_INPUT_INVALID");
    const clock = options.merchant.now.bind(options.merchant);
    let latest = parseCatalogInstant(clock()),
      clockFailed = false;
    const originalValidUntil = new Date(Date.parse(latest) + 5000).toISOString();
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (currentRuntime && (clockFailed || at < latest || at >= originalValidUntil))
          return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
        latest = at;
        return at;
      } catch (error) {
        clockFailed = true;
        throw error;
      }
    };
    const session = await options.authentication.authorize({
      ...authenticationInput,
    });
    now();
    let callbackCompleted = false;
    let calls = 0;
    const transactionResult = host.transactions.run(async (identityTransaction) => {
      if (++calls !== 1) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const transaction: ProductLifecycleTransaction = identityTransaction;
      const scope = await resolveScope(
        transaction,
        authenticationInput.sessionCookie,
        session.sessionReference,
      );
      const actualScope = bindMerchantProductCommandScope(
        {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.selectedStoreReference,
        },
        expectedScope,
      );
      now();
      const bridge = currentRuntime
        ? createMerchantProductCurrentAuthorization({
            merchant: options.merchant,
            transaction: identityTransaction,
            scope,
            sessionCookie: authenticationInput.sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil,
            capabilityKey: "catalog.cat_product_create",
          })
        : undefined;
      const permission = async () => {
        if (bridge) {
          now();
          await bridge.authorizeActions([
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.create",
            ...(command.skus.length ? ["catalog.sku.create"] : []),
          ]);
          bridge.assertCurrent();
        }
        const decision = await scope.authorizeAction("catalog.product.manage");
        if (bridge) {
          now();
          bridge.assertCurrent();
        }
        return decision?.effect === "Allow" &&
          decision.scopeKind === "Brand" &&
          decision.action === "catalog.product.manage"
          ? decision
          : null;
      };
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      const brand = parseCatalogReference(scope.context.brand.brandReference);
      await host.registerBeforeCommit(
        transaction,
        async () => {
          if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
        },
        () => {
          if (bridge) {
            now();
            bridge.assertCurrent();
          }
        },
      );
      const product = identity(command.operationReference, brand, "Product", 0);
      const intent = {
        action: "Create" as const,
        expectedAggregateVersion: null,
        createsSkus: command.skus.length > 0,
      };
      const runtime = bridge
        ? createMerchantProductAuthoringRuntimeAuthority({
            transaction: identityTransaction,
            tenantReference: scope.tenantReference,
            brandReference: brand,
            storeReference: scope.selectedStoreReference,
            actorReference: scope.actorReference,
            sessionReference: session.sessionReference,
            productReference: product,
            operationReference: command.operationReference,
            intent,
            clock: { now },
            originalValidUntil,
            currentAuthorization: bridge,
            capability: createMerchantProductStoreCapabilityGuard({
              transaction: identityTransaction,
              tenantReference: scope.tenantReference,
              brandReference: brand,
              storeReference: scope.selectedStoreReference,
              actorReference: scope.actorReference,
              clock: { now },
              originalValidUntil,
              currentAuthorization: bridge,
              registerBeforeCommit: host.registerBeforeCommit,
              capabilityKey: "catalog.cat_product_create",
            }),
            registerBeforeCommit: host.registerBeforeCommit,
          })
        : undefined;
      const writeGuard = createMerchantProductWriteGuard({
        transaction,
        scope,
        sessionReference: session.sessionReference,
        productReference: product,
        operationReference: command.operationReference,
        intent,
        authority: runtime?.writeAuthority ?? options.writeAuthority,
        now,
        registerBeforeCommit: host.registerBeforeCommit,
      });
      await writeGuard.holdAndRegister();
      const runtimeBrandSources =
        bridge === undefined
          ? undefined
          : createMerchantProductEditorRuntimeBrandSources(
              {
                transaction,
                tenantReference: scope.tenantReference,
                brandReference: brand,
                storeReference: scope.selectedStoreReference,
                actorReference: scope.actorReference,
                sessionReference: session.sessionReference,
                productReference: product,
                operationReference: command.operationReference,
                action: "Create",
                expectedAggregateVersion: null,
                originalValidUntil,
                currentAuthorization: bridge,
                clock: { now },
                registerBeforeCommit: host.registerBeforeCommit,
              },
              runtimeBrandSelection ?? fail("CATALOG_DEPENDENCY_UNAVAILABLE"),
            );
      const categoryAssignments = createMerchantProductCategoryAssignments({
        transaction,
        tenantReference: scope.tenantReference,
        brandReference: brand,
        actorReference: scope.actorReference,
        now,
        policy:
          runtimeBrandSources?.categoryPolicy ??
          (options.categoryPolicy === undefined
            ? undefined
            : createMerchantProductCategoryPolicyAuthority({
                merchant: options.merchant,
                transaction,
                sessionCookie: authenticationInput.sessionCookie,
                sessionReference: session.sessionReference,
                scope: {
                  tenantReference: scope.tenantReference,
                  brandReference: brand,
                  storeReference: scope.selectedStoreReference,
                  actorReference: scope.actorReference,
                  productReference: product,
                },
                holdPolicyUntilTransactionCompletes: options.categoryPolicy,
              })),
        registerBeforeCommit: host.registerBeforeCommit,
      });

      const composedContent =
        registeredContent === undefined
          ? contentAuthority
          : registeredContent({
              transaction,
              tenantReference: scope.tenantReference,
              brandReference: brand,
              storeReference: scope.selectedStoreReference,
              actorReference: scope.actorReference,
              sessionReference: session.sessionReference,
              productReference: product,
              operationReference: command.operationReference,
              clock: { now },
              registerBeforeCommit: host.registerBeforeCommit,
              ...(bridge === undefined ? {} : { currentAuthorization: bridge, originalValidUntil }),
              ...(runtimeBrandSources === undefined ? {} : { runtimeBrandSources }),
            });
      const completeContent =
        bridge && composedContent
          ? createMerchantProductEditorSellingUnitAuthority({
              transaction,
              tenantReference: scope.tenantReference,
              brandReference: brand,
              storeReference: scope.selectedStoreReference,
              actorReference: scope.actorReference,
              sessionReference: session.sessionReference,
              productReference: product,
              operationReference: command.operationReference,
              purposeCode: "CATALOG_PRODUCT_CREATE",
              clock: { now },
              originalValidUntil,
              currentAuthorization: bridge,
              registerBeforeCommit: host.registerBeforeCommit,
              remainingAuthority: composedContent,
            })
          : composedContent;
      const editorContentAuthority =
        completeContent === undefined
          ? undefined
          : createMerchantProductEditorContentAuthority({
              transaction,
              scope,
              sessionReference: session.sessionReference,
              productReference: product,
              operationReference: command.operationReference,
              authority: completeContent,
              purposeCode: "CATALOG_PRODUCT_CREATE",
              now,
              registerBeforeCommit: host.registerBeforeCommit,
            });
      const store = createPostgresProductCreationStore({
        brandReference: brand,
        ...(editorContentAuthority === undefined ? {} : { editorContentAuthority }),
        ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) =>
          (input.productReference === null || input.productReference === product) &&
          (!input.record || input.record.action === "Create") &&
          (await permission()) !== null,
      });
      const unavailable = (): never => fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const prior = await store.resolveOperation(command.operationReference);
      const requestedAt = parseCatalogInstant(prior?.aggregate.createdAt ?? now());
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
      callbackCompleted = true;
      return {
        status: result.status,
        scope: actualScope,
        operationReference: command.operationReference,
        productReference: result.aggregate.productReference,
        versionReference: result.aggregate.draft.versionReference,
        aggregateVersion: result.aggregate.aggregateVersion,
        lifecycle: result.aggregate.lifecycle,
        ...(result.aggregate.draft.categoryClassification === undefined
          ? {}
          : { categoryClassification: result.aggregate.draft.categoryClassification }),
        skus: result.aggregate.draft.skus.map((sku) => ({
          skuReference: sku.skuReference,
          skuCode: sku.skuCode,
          lifecycle: sku.lifecycle,
        })),
      };
    });
    return transactionResult.catch((error: unknown) => {
      // Once the authorized callback returned, a lost COMMIT acknowledgement is
      // an unavailable transaction outcome, never evidence of permission denial.
      if (
        callbackCompleted &&
        !(error instanceof CatalogError) &&
        !(error instanceof MerchantProductWriteFeatureDisabled)
      )
        return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      throw error;
    });
  };
}
