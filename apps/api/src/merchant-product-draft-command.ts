import { createMerchantProductFrozenOptionAuthority } from "./merchant-product-frozen-option-authority.js";
import { createMerchantProductEditorPinnedOptionAuthority } from "./merchant-product-editor-pinned-option-authority.js";
import { createMerchantProductEditorPolicyContentAuthority } from "./merchant-product-editor-policy-content-authority.js";
import { createMerchantProductVariantHistoryAuthority } from "./merchant-product-variant-history-authority.js";
import {
  createMerchantProductEditorVariantContentAuthority,
  type MerchantProductEditorVariantRemainingAuthority,
} from "./merchant-product-editor-variant-content-authority.js";
import { createMerchantProductContentRegistryAuthority } from "./merchant-product-content-registry-authority.js";
import {
  createMerchantProductEditorRegisteredContentAuthority,
  type MerchantProductEditorRemainingContentAuthority,
} from "./merchant-product-editor-registered-content-authority.js";
import { createMerchantProductCategoryPolicyAuthority } from "./merchant-product-category-policy-authority.js";
import {
  createMerchantProductWriteGuard,
  deriveProductDraftSkuMutationIntent,
  MerchantProductWriteFeatureDisabled,
  type MerchantProductWriteAuthority,
} from "./merchant-product-write-authority.js";
import {
  parseMerchantProductCommandScope,
  bindMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantProductEditorContentAuthority,
  type MerchantProductEditorContentAuthority,
} from "./merchant-product-editor-content-authority.js";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import { readClosedRecord } from "@bop/identity";
import { sha256Hex } from "@bop/audit";
import {
  CatalogError,
  contentRegistryFields,
  createCatalogProductService,
  createPostgresProductVariantIdentityHistorySource,
  createPostgresProductDraftStore,
  createPostgresProductCreationStore,
  createPostgresProductOptionSetSource,
  createPostgresFrozenFullOptionSetContentStore,
  parseProductVersion,
  parseCatalogInstant,
  parseCatalogHash,
  parseCatalogReference,
  type ProductLifecycleTransaction,
  type CatalogContentRegistryAuthority,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type PolicyContentOptions = Omit<
  Parameters<typeof createMerchantProductEditorPolicyContentAuthority>[0],
  "tenantReference" | "brandReference" | "actorReference" | "clock" | "remainingAuthority"
> &
  (
    | {
        readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
        readonly pinnedOptions?: never;
      }
    | {
        readonly remainingAuthority?: never;
        readonly pinnedOptions: {
          readonly optionAuthority: Parameters<
            typeof createMerchantProductEditorPinnedOptionAuthority
          >[0]["optionAuthority"];
          readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
        };
      }
  );

const fail = (code: ConstructorParameters<typeof CatalogError>[0]): never => {
  throw new CatalogError(code);
};
function decode(value: unknown, completeContentConfigured: boolean) {
  try {
    const raw = readClosedRecord(value, [
      "productReference",
      "draft",
      "expectedAggregateVersion",
      "operationReference",
    ]);
    if (
      !Number.isSafeInteger(raw.expectedAggregateVersion) ||
      (raw.expectedAggregateVersion as number) < 1 ||
      (raw.expectedAggregateVersion as number) >= 2147483647
    )
      return fail("CATALOG_INPUT_INVALID");
    const draft = parseProductVersion(raw.draft);
    if (draft.editorContent !== undefined && !completeContentConfigured)
      return fail("CATALOG_INPUT_INVALID");
    return {
      productReference: parseCatalogReference(raw.productReference),
      draft,
      expectedAggregateVersion: raw.expectedAggregateVersion as number,
      operationReference: parseCatalogReference(raw.operationReference),
    };
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}

/** Complete Product Draft save with current Brand permission and server-owned clock. */
export function createMerchantProductDraftCommand(options: {
  merchant: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  auditReference(operationReference: string): string;
  categoryPolicy?: MerchantProductCategoryPolicy;
  writeAuthority?: MerchantProductWriteAuthority;
  editorContentAuthority?: MerchantProductEditorContentAuthority;
  /** Actual owning registry composition; remaining fields/references stay mandatory. */
  registeredEditorContent?: {
    readonly registryAuthority: CatalogContentRegistryAuthority;
  } & (
    | {
        readonly remainingAuthority: MerchantProductEditorRemainingContentAuthority;
        readonly variantHistory?: never;
      }
    | {
        readonly remainingAuthority?: never;
        readonly variantHistory: {
          readonly authority: Parameters<
            typeof createPostgresProductVariantIdentityHistorySource
          >[0]["authority"];
        } & (
          | {
              readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
              readonly contentPolicy?: never;
            }
          | {
              readonly remainingAuthority?: never;
              readonly contentPolicy: PolicyContentOptions;
            }
        );
      }
  );
}) {
  const resolveScope = createMerchantBrandScope(options.merchant);
  const host = createMerchantCategoryTransactions({
    run: options.merchant.transactions.run.bind(options.merchant.transactions),
  });
  if (
    options.editorContentAuthority !== undefined &&
    typeof options.editorContentAuthority !== "function"
  )
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  const registeredOptions = options.registeredEditorContent;
  if (
    registeredOptions !== undefined &&
    (options.editorContentAuthority !== undefined ||
      typeof registeredOptions.registryAuthority?.holdUntilTransactionCompletes !== "function" ||
      (registeredOptions.variantHistory === undefined
        ? typeof registeredOptions.remainingAuthority !== "function"
        : registeredOptions.remainingAuthority !== undefined ||
          typeof registeredOptions.variantHistory?.authority?.holdUntilTransactionCompletes !==
            "function" ||
          (registeredOptions.variantHistory?.contentPolicy === undefined
            ? typeof registeredOptions.variantHistory?.remainingAuthority !== "function"
            : registeredOptions.variantHistory.remainingAuthority !== undefined ||
              typeof registeredOptions.variantHistory.contentPolicy?.brandAuthority
                ?.withCurrentContentRead !== "function" ||
              typeof registeredOptions.variantHistory.contentPolicy?.brandAuthority?.isCurrent !==
                "function" ||
              typeof registeredOptions.variantHistory.contentPolicy?.policyAuthority
                ?.holdUntilTransactionCompletes !== "function" ||
              (registeredOptions.variantHistory.contentPolicy?.pinnedOptions === undefined
                ? typeof registeredOptions.variantHistory.contentPolicy?.remainingAuthority !==
                  "function"
                : registeredOptions.variantHistory.contentPolicy.remainingAuthority !== undefined ||
                  typeof registeredOptions.variantHistory.contentPolicy.pinnedOptions
                    ?.optionAuthority?.holdUntilTransactionCompletes !== "function" ||
                  typeof registeredOptions.variantHistory.contentPolicy.pinnedOptions
                    ?.remainingAuthority !== "function"))))
  )
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  const policyOptions = registeredOptions?.variantHistory?.contentPolicy;
  let contentPolicy: typeof policyOptions;
  if (policyOptions !== undefined) {
    try {
      if (
        !Number.isSafeInteger(policyOptions.expectedBrandVersion) ||
        policyOptions.expectedBrandVersion < 1 ||
        policyOptions.expectedBrandVersion > 2147483647 ||
        !Number.isSafeInteger(policyOptions.policyVersion) ||
        policyOptions.policyVersion < 1 ||
        policyOptions.policyVersion > 2147483647
      )
        return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      contentPolicy = Object.freeze({
        configurationVersionReference: parseCatalogReference(
          policyOptions.configurationVersionReference,
        ),
        expectedBrandVersion: policyOptions.expectedBrandVersion,
        policyReference: parseCatalogReference(policyOptions.policyReference),
        policyVersion: policyOptions.policyVersion,
        brandAuthority: Object.freeze({
          withCurrentContentRead: policyOptions.brandAuthority.withCurrentContentRead.bind(
            policyOptions.brandAuthority,
          ),
          isCurrent: policyOptions.brandAuthority.isCurrent.bind(policyOptions.brandAuthority),
        }),
        policyAuthority: Object.freeze({
          holdUntilTransactionCompletes:
            policyOptions.policyAuthority.holdUntilTransactionCompletes.bind(
              policyOptions.policyAuthority,
            ),
        }),
        ...(policyOptions.pinnedOptions === undefined
          ? { remainingAuthority: policyOptions.remainingAuthority }
          : {
              pinnedOptions: Object.freeze({
                optionAuthority: Object.freeze({
                  holdUntilTransactionCompletes:
                    policyOptions.pinnedOptions.optionAuthority.holdUntilTransactionCompletes.bind(
                      policyOptions.pinnedOptions.optionAuthority,
                    ),
                }),
                remainingAuthority: policyOptions.pinnedOptions.remainingAuthority,
              }),
            }),
      });
    } catch {
      return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
    }
  }
  const registered =
    registeredOptions === undefined
      ? undefined
      : Object.freeze({
          registryAuthority: Object.freeze({
            holdUntilTransactionCompletes:
              registeredOptions.registryAuthority.holdUntilTransactionCompletes.bind(
                registeredOptions.registryAuthority,
              ),
          }),
          remainingAuthority: registeredOptions.remainingAuthority,
          variantHistory:
            registeredOptions.variantHistory === undefined
              ? undefined
              : Object.freeze({
                  authority: Object.freeze({
                    holdUntilTransactionCompletes:
                      registeredOptions.variantHistory.authority.holdUntilTransactionCompletes.bind(
                        registeredOptions.variantHistory.authority,
                      ),
                  }),
                  remainingAuthority: registeredOptions.variantHistory.remainingAuthority,
                  contentPolicy,
                }),
        });
  const contentAuthority = options.editorContentAuthority?.bind(options),
    now = options.merchant.now.bind(options.merchant),
    authorizeSession = options.authentication.authorize.bind(options.authentication),
    writeAuthority = options.writeAuthority?.bind(options),
    auditReference = options.auditReference.bind(options),
    categoryPolicy = options.categoryPolicy;
  return async (request: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
    expectedScope: unknown;
  }) => {
    const expectedScope = parseMerchantProductCommandScope(request.expectedScope);
    const session = await authorizeSession({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    const command = decode(
      request.command,
      typeof contentAuthority === "function" || registered !== undefined,
    );
    let callbackCompleted = false;
    let assertCompleteContentCurrent: (() => void) | undefined;
    const transactionResult = host.transactions.run(async (identityTransaction) => {
      const transaction: ProductLifecycleTransaction = identityTransaction;
      const scope = await resolveScope(
        transaction,
        request.sessionCookie,
        session.sessionReference,
      );
      const actualScope = bindMerchantProductCommandScope(
        {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.selectedStoreReference,
        },
        expectedScope,
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
      await host.registerBeforeCommit(transaction, async () => {
        if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      });
      const writeGuard = createMerchantProductWriteGuard({
        transaction,
        scope,
        sessionReference: session.sessionReference,
        productReference: command.productReference,
        operationReference: command.operationReference,
        intent: {
          action: "ReplaceDraft",
          expectedAggregateVersion: command.expectedAggregateVersion,
        },
        authority: writeAuthority,
        now,
        registerBeforeCommit: host.registerBeforeCommit,
      });
      await writeGuard.holdAndRegister();
      const categoryAssignments = createMerchantProductCategoryAssignments({
        transaction,
        tenantReference: scope.tenantReference,
        brandReference: brand,
        actorReference: scope.actorReference,
        now,
        policy:
          categoryPolicy === undefined
            ? undefined
            : createMerchantProductCategoryPolicyAuthority({
                merchant: options.merchant,
                transaction,
                sessionCookie: request.sessionCookie,
                sessionReference: session.sessionReference,
                scope: {
                  tenantReference: scope.tenantReference,
                  brandReference: brand,
                  storeReference: scope.selectedStoreReference,
                  actorReference: scope.actorReference,
                  productReference: command.productReference,
                },
                holdPolicyUntilTransactionCompletes: categoryPolicy,
              }),
        registerBeforeCommit: host.registerBeforeCommit,
      });

      let currentContentAuthority = contentAuthority;
      let frozenOptionSets: ReturnType<typeof createPostgresProductOptionSetSource> | undefined;
      if (registered !== undefined) {
        const nativeRegistry = createMerchantProductContentRegistryAuthority({
          merchant: options.merchant,
          transaction,
          sessionCookie: request.sessionCookie,
          sessionReference: session.sessionReference,
          scope: {
            tenantReference: scope.tenantReference,
            brandReference: brand,
            storeReference: scope.selectedStoreReference,
            actorReference: scope.actorReference,
          },
          authority: registered.registryAuthority,
        });
        const nativeHistory =
          registered.variantHistory === undefined
            ? undefined
            : createMerchantProductVariantHistoryAuthority({
                merchant: options.merchant,
                transaction,
                sessionCookie: request.sessionCookie,
                sessionReference: session.sessionReference,
                scope: {
                  tenantReference: scope.tenantReference,
                  brandReference: brand,
                  storeReference: scope.selectedStoreReference,
                  actorReference: scope.actorReference,
                  productReference: command.productReference,
                },
                authority: registered.variantHistory.authority,
              });
        const policy = registered.variantHistory?.contentPolicy;
        const nativeOption =
          policy?.pinnedOptions === undefined
            ? undefined
            : createMerchantProductFrozenOptionAuthority({
                merchant: options.merchant,
                transaction,
                sessionCookie: request.sessionCookie,
                sessionReference: session.sessionReference,
                scope: {
                  tenantReference: scope.tenantReference,
                  brandReference: brand,
                  storeReference: scope.selectedStoreReference,
                  actorReference: scope.actorReference,
                },
                authority: policy.pinnedOptions.optionAuthority,
              });
        if (nativeOption !== undefined) {
          const frozen = createPostgresFrozenFullOptionSetContentStore({
            tenantReference: scope.tenantReference,
            brandReference: brand,
            actorReference: scope.actorReference,
            clock: { now },
            authority: nativeOption.authority,
            transactions: { run: (work) => work(transaction) },
          });
          let pendingRead: Promise<void> = Promise.resolve(),
            readFailed = false;
          frozenOptionSets = {
            resolveVersion(input) {
              const result = pendingRead
                .then(async () => {
                  if (readFailed) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
                  if (input.brandReference !== brand) return fail("CATALOG_PERMISSION_DENIED");
                  const bindings = command.draft.optionBindings.filter(
                    (binding) =>
                      binding.optionSetReference === input.optionSetReference &&
                      binding.optionSetVersionReference === input.optionSetVersionReference,
                  );
                  if (
                    bindings.length === 0 ||
                    bindings.some(
                      (binding) =>
                        command.draft.editorContent?.optionRules.find(
                          (rule) => rule.bindingReference === binding.bindingReference,
                        )?.versionResolution !== "Pinned",
                    )
                  )
                    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
                  const observation = await frozen.readPinned({
                    optionSetReference: input.optionSetReference,
                    versionReference: input.optionSetVersionReference,
                    expectedRecordDigest: null,
                  });
                  // The owning immutable original aggregate is an actual source result.
                  // It is neither today's editable root nor current Published qualification.
                  return observation.content.editorContent.sourceAggregate;
                })
                .catch((error: unknown) => {
                  readFailed = true;
                  throw error;
                });
              pendingRead = result.then(
                () => undefined,
                () => undefined,
              );
              return result;
            },
          };
        }
        let variantRemaining = registered.variantHistory?.remainingAuthority;
        if (policy !== undefined) {
          const remaining =
            nativeOption === undefined || policy.pinnedOptions === undefined
              ? policy.remainingAuthority
              : createMerchantProductEditorPinnedOptionAuthority({
                  tenantReference: scope.tenantReference,
                  brandReference: brand,
                  actorReference: scope.actorReference,
                  clock: { now },
                  optionAuthority: nativeOption.authority,
                  remainingAuthority: policy.pinnedOptions.remainingAuthority,
                });
          if (remaining === undefined) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          variantRemaining = createMerchantProductEditorPolicyContentAuthority({
            ...policy,
            tenantReference: scope.tenantReference,
            brandReference: brand,
            actorReference: scope.actorReference,
            clock: { now },
            remainingAuthority: remaining,
          });
        }
        let remainingAuthority = registered.remainingAuthority;
        if (nativeHistory !== undefined) {
          if (variantRemaining === undefined) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          remainingAuthority = createMerchantProductEditorVariantContentAuthority({
            variantAuthority: nativeHistory.authority,
            remainingAuthority: variantRemaining,
            clock: { now },
          });
        }
        if (remainingAuthority === undefined) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
        const registeredContent = createMerchantProductEditorRegisteredContentAuthority({
          registryAuthority: nativeRegistry,
          remainingAuthority,
          clock: { now },
        });
        currentContentAuthority = async (tx, input) => {
          // Original receipt recovery checks current admission without replacing
          // its original registry/content with today's definitions.
          await nativeRegistry.holdUntilTransactionCompletes(tx, {
            tenantReference: scope.tenantReference,
            brandReference: brand,
            actorReference: scope.actorReference,
            actorKind: "User",
            purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
            permission: "catalog.manage",
            action: "catalog.content-registry.read",
            registry: null,
            requiredFields: contentRegistryFields,
            observedAt: parseCatalogInstant(now()),
          });
          await nativeHistory?.assertCurrent(tx);
          await nativeOption?.assertCurrent(tx);
          await registeredContent(tx, input);
          await nativeOption?.assertCurrent(tx);
          await nativeHistory?.assertCurrent(tx);
        };
      }
      const editorContentAuthority =
        currentContentAuthority === undefined
          ? undefined
          : createMerchantProductEditorContentAuthority({
              transaction,
              scope,
              sessionReference: session.sessionReference,
              productReference: command.productReference,
              operationReference: command.operationReference,
              authority: currentContentAuthority,
              now,
              registerBeforeCommit: host.registerBeforeCommit,
            });

      const store = createPostgresProductDraftStore({
        brandReference: brand,
        ...(editorContentAuthority === undefined ? {} : { editorContentAuthority }),
        ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) =>
          (input.productReference === null ||
            input.productReference === command.productReference) &&
          (!input.record || input.record.action === "ReplaceDraft") &&
          (await permission()) !== null,
      });
      const unavailable = (): never => fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      const prior = await store.resolveOperation(command.operationReference);
      const baseline = prior?.aggregate ?? (await store.load(command.productReference));
      if (!baseline) return fail("CATALOG_UNAVAILABLE");
      if (
        prior &&
        (prior.action !== "ReplaceDraft" ||
          prior.aggregate.aggregateVersion !== command.expectedAggregateVersion + 1)
      )
        return fail("CATALOG_IDEMPOTENCY_CONFLICT");
      if (!prior && baseline.aggregateVersion !== command.expectedAggregateVersion)
        return fail("CATALOG_VERSION_CONFLICT");
      const original = await store.loadAggregateVersion(
        command.productReference,
        command.expectedAggregateVersion,
      );
      if (!original) return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
      await writeGuard.bindSkuDraftIntent(
        deriveProductDraftSkuMutationIntent(original, command.draft),
      );
      const requestedAt = parseCatalogInstant(prior?.aggregate.updatedAt ?? now());
      const codes = createPostgresProductCreationStore({
        brandReference: brand,
        ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        transactions: { run: (work) => work(transaction) },
        authorize: async () => (await permission()) !== null,
      });
      const service = createCatalogProductService({
        repository: { ...store, create: unavailable, codeAvailable: codes.codeAvailable },
        optionSets:
          frozenOptionSets ??
          createPostgresProductOptionSetSource({
            brandReference: brand,
            transaction,
            authorize: async () => (await permission()) !== null,
          }),
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
              input.action !== "ReplaceDraft" ||
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
                actionCode: "CATALOG_PRODUCT_REPLACEDRAFT",
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
      const result = await service.replaceDraft({
        ...command,
        draft: {
          ...command.draft,
          updatedAt: requestedAt,
          skus: command.draft.skus.map((sku) => {
            const stored = baseline.draft.skus.find(
              (candidate) => candidate.skuReference === sku.skuReference,
            );
            return {
              ...sku,
              createdAt: stored?.createdAt ?? requestedAt,
              createdByActorReference: stored?.createdByActorReference ?? scope.actorReference,
            };
          }),
        },
        requestedAt,
      });
      if (!(await permission())) return fail("CATALOG_PERMISSION_DENIED");
      callbackCompleted = true;
      if (result.aggregate.draft.editorContent !== undefined)
        assertCompleteContentCurrent = editorContentAuthority?.assertCurrent;
      return {
        status: result.status,
        scope: actualScope,
        operationReference: command.operationReference,
        productReference: result.aggregate.productReference,
        aggregateVersion: result.aggregate.aggregateVersion,
        draft: result.aggregate.draft,
      };
    });
    return transactionResult
      .then((result) => {
        // COMMIT may already have succeeded. Suppress expired private content,
        // leaving original operation recovery available; never claim rollback.
        assertCompleteContentCurrent?.();
        return result;
      })
      .catch((error: unknown) => {
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
