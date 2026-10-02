import {
  createMerchantProductLifecycleReviewLease,
  type MerchantProductLifecycleReview,
} from "./merchant-product-lifecycle-review.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import {
  createMerchantProductLifecycleGuard,
  type MerchantProductLifecycleAuthority,
} from "./merchant-product-lifecycle-authority.js";
import { resolveMerchantProductLifecycleIntent } from "./merchant-product-lifecycle-intent.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import { readClosedRecord } from "@bop/identity";
import { sha256Hex } from "@bop/audit";
import {
  CatalogError,
  createProductLifecycleReviewRequest,
  requiresProductLifecycleReview,
  createCatalogProductService,
  createPostgresProductLifecycleStore,
  parseCatalogInstant,
  parseCatalogHash,
  parseCatalogLifecycleReasonCode,
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
      ...(typeof value === "object" && value !== null && Object.hasOwn(value, "reasonCode")
        ? ["reasonCode"]
        : []),
    ]);
    if (
      !Number.isSafeInteger(raw.expectedAggregateVersion) ||
      (raw.expectedAggregateVersion as number) < 1 ||
      (raw.expectedAggregateVersion as number) >= 2147483647
    )
      return fail("CATALOG_INPUT_INVALID");
    const targetLifecycle = parseProductLifecycle(raw.targetLifecycle);
    const hasReason = Object.hasOwn(raw, "reasonCode");
    if (!hasReason && ["Suspended", "Discontinued", "Archived", "Draft"].includes(targetLifecycle))
      return fail("CATALOG_INPUT_INVALID");
    return {
      ...(hasReason ? { reasonCode: parseCatalogLifecycleReasonCode(raw.reasonCode) } : {}),
      productReference: parseCatalogReference(raw.productReference),
      skuReference: raw.skuReference === null ? null : parseCatalogReference(raw.skuReference),
      targetLifecycle,
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
  categoryPolicy?: MerchantProductCategoryPolicy;
  writeAuthority?: MerchantProductLifecycleAuthority;
  lifecycleReview?: MerchantProductLifecycleReview;
}) {
  const resolveScope = createMerchantBrandScope(options.merchant);
  const host = createMerchantCategoryTransactions(options.merchant.transactions);
  return async (request: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
    expectedScope: unknown;
  }) => {
    const expectedScope = parseMerchantProductCommandScope(request.expectedScope);
    const session = await options.authentication.authorize({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    const command = decode(request.command);
    let callbackCompleted = false;
    const transactionResult = host.transactions.run(async (identityTransaction) => {
      const transaction: ProductLifecycleTransaction = identityTransaction;
      const scope = await resolveScope(
        transaction,
        request.sessionCookie,
        session.sessionReference,
      );
      let lifecycleIntent: ReturnType<typeof resolveMerchantProductLifecycleIntent> | null = null;
      const permission = async () => {
        bindMerchantProductCommandScope(
          {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.selectedStoreReference,
          },
          expectedScope,
        );
        let owningDecision = null;
        for (const action of [
          "catalog.manage",
          "catalog.product.manage",
          ...(lifecycleIntent ? [lifecycleIntent.actionPermission] : []),
        ]) {
          const decision = await scope.authorizeAction(action);
          if (
            decision?.effect !== "Allow" ||
            decision.scopeKind !== "Brand" ||
            decision.action !== action
          )
            return null;
          if (action === "catalog.product.manage") owningDecision = decision;
        }
        return owningDecision;
      };
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      const brand = parseCatalogReference(scope.context.brand.brandReference);
      const guard = createMerchantProductLifecycleGuard({
        transaction,
        scope,
        sessionReference: session.sessionReference,
        productReference: command.productReference,
        skuReference: command.skuReference,
        operationReference: command.operationReference,
        expectedAggregateVersion: command.expectedAggregateVersion,
        targetLifecycle: command.targetLifecycle,
        ...(command.reasonCode === undefined ? {} : { reasonCode: command.reasonCode }),
        authority: options.writeAuthority,
        now: options.merchant.now,
        registerBeforeCommit: host.registerBeforeCommit,
      });
      await guard.holdAndRegister();
      const categoryAssignments = createMerchantProductCategoryAssignments({
        transaction,
        tenantReference: scope.tenantReference,
        brandReference: brand,
        actorReference: scope.actorReference,
        now: options.merchant.now,
        policy: options.categoryPolicy,
        registerBeforeCommit: host.registerBeforeCommit,
      });
      const store = createPostgresProductLifecycleStore({
        brandReference: brand,
        ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) =>
          (input.productReference === null ||
            input.productReference === command.productReference) &&
          (!input.record || input.record.action === "ChangeLifecycle") &&
          (await permission()) !== null,
      });
      const prior = await store.resolveOperation(command.operationReference);
      if (
        prior &&
        (prior.action !== "ChangeLifecycle" ||
          prior.aggregate.aggregateVersion !== command.expectedAggregateVersion + 1)
      )
        return fail("CATALOG_IDEMPOTENCY_CONFLICT");
      if (!prior) {
        const current = await store.load(command.productReference);
        if (!current) return fail("CATALOG_UNAVAILABLE");
        if (current.aggregateVersion !== command.expectedAggregateVersion)
          return fail("CATALOG_VERSION_CONFLICT");
      }
      const original = await store.loadAggregateVersion(
        command.productReference,
        command.expectedAggregateVersion,
      );
      if (!original) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const before =
        command.skuReference === null
          ? original.lifecycle
          : original.draft.skus.find((sku) => sku.skuReference === command.skuReference)?.lifecycle;
      if (before === undefined) return fail("CATALOG_UNAVAILABLE");
      lifecycleIntent = resolveMerchantProductLifecycleIntent(
        command.skuReference === null ? "Product" : "Sku",
        before,
        command.targetLifecycle,
      );
      await guard.bindIntent(lifecycleIntent);
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      const reviewLease = requiresProductLifecycleReview(command.targetLifecycle)
        ? createMerchantProductLifecycleReviewLease({
            transaction,
            scope,
            sessionReference: session.sessionReference,
            request: createProductLifecycleReviewRequest({
              aggregate: original,
              actorReference: scope.actorReference,
              skuReference: command.skuReference,
              operationReference: command.operationReference,
              targetLifecycle: command.targetLifecycle,
              reasonCode: command.reasonCode ?? "",
            }),
            mode: prior ? "Replay" : "Apply",
            actionPermission: lifecycleIntent.actionPermission,
            review: options.lifecycleReview,
            now: options.merchant.now,
            registerBeforeCommit: host.registerBeforeCommit,
          })
        : null;
      if (reviewLease) await reviewLease.holdAndRegister();
      const unavailable = (): never => fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const service = createCatalogProductService({
        ...(reviewLease ? { lifecycleReview: reviewLease } : {}),
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
                reasonCode: command.reasonCode ?? "AUTHORIZED_OPERATION",
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
      await guard.hold();
      callbackCompleted = true;
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
    return transactionResult.catch((error: unknown) => {
      // Once the authorized callback returned, a lost COMMIT acknowledgement is
      // an unavailable transaction outcome, never evidence of permission denial.
      if (callbackCompleted && !(error instanceof CatalogError))
        return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      throw error;
    });
  };
}
