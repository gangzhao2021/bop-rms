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
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { createMerchantProductLifecycleRuntimeAuthority } from "./merchant-product-lifecycle-runtime-authority.js";
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
  currentRuntime?: true;
  categoryPolicy?: MerchantProductCategoryPolicy;
  writeAuthority?: MerchantProductLifecycleAuthority;
  lifecycleReview?: MerchantProductLifecycleReview;
}) {
  const merchant = { ...options.merchant },
    authenticate = options.authentication.authorize.bind(options.authentication),
    clock = options.merchant.now.bind(options.merchant),
    auditReference = options.auditReference.bind(options),
    categoryPolicy = options.categoryPolicy,
    writeAuthority = options.writeAuthority,
    lifecycleReview = options.lifecycleReview,
    currentRuntime = options.currentRuntime === true;
  if (
    (options.currentRuntime !== undefined && options.currentRuntime !== true) ||
    (currentRuntime && (categoryPolicy !== undefined || writeAuthority !== undefined))
  )
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  const resolveScope = createMerchantBrandScope(merchant);
  const host = createMerchantCategoryTransactions({
    run: merchant.transactions.run.bind(merchant.transactions),
  });
  return async (request: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
    expectedScope: unknown;
  }) => {
    const expectedScope = parseMerchantProductCommandScope(request.expectedScope),
      authenticationInput = { sessionCookie: request.sessionCookie, csrf: request.csrf },
      command = decode(request.command);
    const session = await authenticate(authenticationInput);
    let latest = "",
      clockFailed = false,
      originalValidUntil: string | undefined;
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (
          currentRuntime &&
          (clockFailed ||
            (latest && at < latest) ||
            (originalValidUntil && at >= originalValidUntil))
        )
          return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
        latest = at;
        return at;
      } catch (error) {
        clockFailed = true;
        if (currentRuntime) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
        throw error;
      }
    };
    if (currentRuntime) originalValidUntil = new Date(Date.parse(now()) + 5000).toISOString();
    let callbackCompleted = false,
      calls = 0;
    const transactionResult = host.transactions.run(async (identityTransaction) => {
      if (++calls !== 1) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const transaction: ProductLifecycleTransaction = identityTransaction;
      const scope = await resolveScope(
        transaction,
        authenticationInput.sessionCookie,
        session.sessionReference,
      );
      now();
      const prefix = command.skuReference === null ? "product" : "sku",
        suffix =
          command.targetLifecycle === "Archived"
            ? "archive"
            : command.targetLifecycle === "Draft"
              ? "restore"
              : "detail",
        capabilityKey = `catalog.cat_${prefix}_${suffix}` as NonNullable<
          Parameters<typeof createMerchantProductCurrentAuthorization>[0]["capabilityKey"]
        >;
      const bridge = currentRuntime
        ? createMerchantProductCurrentAuthorization({
            merchant,
            transaction: identityTransaction,
            scope,
            sessionCookie: authenticationInput.sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalValidUntil ?? fail("CATALOG_DEPENDENCY_UNAVAILABLE"),
            capabilityKey,
          })
        : undefined;
      const runtime = bridge
        ? createMerchantProductLifecycleRuntimeAuthority({
            transaction: identityTransaction,
            tenantReference: scope.tenantReference,
            brandReference: scope.context.brand.brandReference,
            actorReference: scope.actorReference,
            command,
            clock: { now },
            originalValidUntil: originalValidUntil ?? fail("CATALOG_DEPENDENCY_UNAVAILABLE"),
            currentAuthorization: bridge,
            capability: createMerchantProductStoreCapabilityGuard({
              transaction: identityTransaction,
              tenantReference: scope.tenantReference,
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.selectedStoreReference,
              actorReference: scope.actorReference,
              clock: { now },
              originalValidUntil: originalValidUntil ?? fail("CATALOG_DEPENDENCY_UNAVAILABLE"),
              currentAuthorization: bridge,
              registerBeforeCommit: host.registerBeforeCommit,
              capabilityKey,
            }),
            registerBeforeCommit: host.registerBeforeCommit,
          })
        : undefined;
      let lifecycleIntent: ReturnType<typeof resolveMerchantProductLifecycleIntent> | null = null;
      const permission = async () => {
        if (currentRuntime) {
          now();
          bridge?.assertCurrent();
        }
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
          if (currentRuntime) {
            now();
            bridge?.assertCurrent();
          }
          if (action === "catalog.product.manage") owningDecision = decision;
        }
        return owningDecision;
      };
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      const brand = parseCatalogReference(scope.context.brand.brandReference);
      const guard =
        runtime ??
        createMerchantProductLifecycleGuard({
          transaction,
          scope,
          sessionReference: session.sessionReference,
          productReference: command.productReference,
          skuReference: command.skuReference,
          operationReference: command.operationReference,
          expectedAggregateVersion: command.expectedAggregateVersion,
          targetLifecycle: command.targetLifecycle,
          ...(command.reasonCode === undefined ? {} : { reasonCode: command.reasonCode }),
          authority: writeAuthority,
          now,
          registerBeforeCommit: host.registerBeforeCommit,
        });
      await guard.holdAndRegister();
      const categoryAssignments =
        runtime?.categoryAssignments ??
        createMerchantProductCategoryAssignments({
          transaction,
          tenantReference: scope.tenantReference,
          brandReference: brand,
          actorReference: scope.actorReference,
          now,
          policy: categoryPolicy,
          registerBeforeCommit: host.registerBeforeCommit,
        });
      const store = createPostgresProductLifecycleStore({
        brandReference: brand,
        ...(runtime ? { editorContentAuthority: runtime.editorContentAuthority } : {}),
        ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) =>
          (input.productReference === null ||
            input.productReference === command.productReference) &&
          (!input.record ||
            input.record.action === "ChangeLifecycle" ||
            (input.recordOrigin === "StoredOperation" &&
              (input.record.action === "Create" || input.record.action === "ReplaceDraft") &&
              input.productReference === command.productReference &&
              input.record.aggregate.productReference === command.productReference &&
              input.record.aggregate.brandReference === brand &&
              input.record.aggregate.aggregateVersion === command.expectedAggregateVersion)) &&
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
            review: lifecycleReview,
            now,
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
                auditId: parseCatalogReference(auditReference(input.operationReference)),
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
        requestedAt: now(),
      });
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      await guard.hold();
      runtime?.assertCurrent();
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
