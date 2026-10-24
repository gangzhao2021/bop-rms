import { createPostgresTransactionCurrentPermissionPolicySource } from "@bop/permission";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogApprovalValiditySeconds,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductPublicationReplacementIntent,
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  createPostgresProductPublicationStoreV2,
  catalogProductPublicationAuditAction,
  productPublicationWriteFieldsV2,
  type ProductPublicationStoreOptionsV2,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  parseMerchantProductCommandScope,
  bindMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import {
  createMerchantProductPublicationContentAuthorityV2,
  type MerchantProductPublicationContentAuthorityV2,
} from "./merchant-product-publication-content-authority-v2.js";
import {
  captureMerchantProductUniqueScopeConfigurationV2,
  createMerchantProductUniqueScopeFactsV2,
  type MerchantProductUniqueScopeConfigurationV2,
} from "./merchant-product-unique-scope-facts-v2.js";

import {
  createMerchantProductStoreCapabilityGuard,
  type MerchantProductStoreCapabilityGuard,
} from "./merchant-product-store-capability.js";
import { createMerchantProductPublicationRuntimeAuthority } from "./merchant-product-publication-runtime-authority.js";

const fields = [
  "profile",
  "operationReference",
  "productReference",
  "versionReference",
  "expectedProductAggregateVersion",
  "expectedPublicationVersion",
  "action",
  "contentDigest",
  "configurationDigest",
  "scopeSet",
  "effectivePeriod",
  "scheduleReference",
  "replacementVersionReference",
  "successorDraftVersionReference",
  "occurredAt",
  "reasonCode",
  "replacementIntent",
  "replacementIntentDigest",
] as const;
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
type AuthorityInput = Parameters<
  ProductPublicationStoreOptionsV2["authority"]["holdUntilTransactionCompletes"]
>[1];
export interface MerchantProductPublicationSourceFactoryV2Input {
  readonly transaction: Parameters<
    ProductPublicationStoreOptionsV2["authority"]["holdUntilTransactionCompletes"]
  >[0];
  readonly command: AuthorityInput["command"];
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly storeReference: string;
  readonly sessionReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  /** Actual current Brand-scoped User permission in this same outer transaction. */
  readonly authorizeMediaAccess: () => Promise<void>;
  readonly currentAuthorization?: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  /** Concrete same-request Screen authority; absent only for legacy composition. */
  readonly capability?: MerchantProductStoreCapabilityGuard;
  readonly registerBeforeCommit: NonNullable<
    ProductPublicationStoreOptionsV2["registerBeforeCommit"]
  >;
}
export type MerchantProductPublicationSourceFactoryV2 = (
  input: MerchantProductPublicationSourceFactoryV2Input,
) => {
  readonly sources: ProductPublicationStoreOptionsV2["sources"];
  readonly editorContentAuthority: MerchantProductPublicationContentAuthorityV2;
};
export interface MerchantProductPublicationOptionsV2 {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
  readonly maximumApprovalValiditySeconds: number;
  readonly authority?: ProductPublicationStoreOptionsV2["authority"];
  /** Select the concrete fixed field policy and same-transaction capability resolver. */
  readonly currentRuntime?: true;
  /** Full actual current facts are mandatory for every new action. The owning
   * V2 writer creates independent approvals and reads its original receipts. */
  readonly sources?: ProductPublicationStoreOptionsV2["sources"];
  /** Exclusive alternative to supplied sources and their legacy overlays. The
   * synchronous factory captures ports only; owning reads stay inside callbacks. */
  readonly sourceFactory?: MerchantProductPublicationSourceFactoryV2;
  readonly editorContentAuthority?: MerchantProductPublicationContentAuthorityV2;
  /** Validate-only negative necessary-condition composition; never a replacement
   * for full source facts, including on review/publication/timing actions. */
  readonly currentUniqueScope?: MerchantProductUniqueScopeConfigurationV2;
}

/** Explicit V2 ordinary entry. Original complete intent/time survives retry;
 * Tenant/Brand/Actor are resolved from the current authenticated server scope. */
export function createMerchantProductPublicationCommandV2(
  options: MerchantProductPublicationOptionsV2,
) {
  if (
    typeof options.merchant?.now !== "function" ||
    typeof options.merchant.transactions?.run !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.auditReference !== "function" ||
    (options.currentRuntime !== undefined && options.currentRuntime !== true) ||
    (options.currentRuntime === true
      ? options.authority !== undefined || typeof options.sourceFactory !== "function"
      : typeof options.authority?.holdUntilTransactionCompletes !== "function") ||
    (options.sourceFactory === undefined
      ? typeof options.sources?.withHeldCurrentFacts !== "function" ||
        typeof options.sources?.withCurrentPolicy !== "function"
      : typeof options.sourceFactory !== "function" ||
        options.sources !== undefined ||
        options.currentUniqueScope !== undefined ||
        options.editorContentAuthority !== undefined) ||
    (options.editorContentAuthority !== undefined &&
      typeof options.editorContentAuthority !== "function")
  )
    return fail();
  const now = options.merchant.now.bind(options.merchant),
    authenticate = options.authentication.authorize.bind(options.authentication),
    auditReference = options.auditReference.bind(options),
    suppliedHold = options.authority?.holdUntilTransactionCompletes.bind(options.authority),
    currentRuntime = options.currentRuntime === true,
    maximumApprovalValiditySeconds = parseCatalogApprovalValiditySeconds(
      options.maximumApprovalValiditySeconds,
    ),
    resolveScope = createMerchantBrandScope(options.merchant),
    host = createMerchantCategoryTransactions(
      Object.freeze({ run: options.merchant.transactions.run.bind(options.merchant.transactions) }),
    ),
    suppliedSources =
      options.sources === undefined
        ? undefined
        : Object.freeze({
            withHeldCurrentFacts: options.sources.withHeldCurrentFacts.bind(options.sources),
            withCurrentPolicy: options.sources.withCurrentPolicy.bind(options.sources),
          }),
    sourceFactory = options.sourceFactory?.bind(options),
    suppliedContentHold = options.editorContentAuthority?.bind(options),
    unique =
      options.currentUniqueScope === undefined
        ? undefined
        : captureMerchantProductUniqueScopeConfigurationV2(options.currentUniqueScope);
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }) => {
    const expected = parseMerchantProductCommandScope(request.expectedScope);
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(copyCategoryPersistenceValue(request.command), fields);
      if (raw.profile !== "CatalogProductPublicationCommandV2")
        return fail("CATALOG_INPUT_INVALID");
      const intent = parseCatalogProductPublicationReplacementIntent(raw.replacementIntent);
      if (raw.replacementIntentDigest !== intent.digest) return fail("CATALOG_INPUT_INVALID");
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    if (raw.action === "ActivateScheduled") return fail("CATALOG_PERMISSION_DENIED");
    const session = await authenticate({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    let failed = false;
    const readClock = () => {
      try {
        return parseCatalogInstant(now());
      } catch {
        failed = true;
        return fail();
      }
    };
    let latest = readClock();
    let validUntil = new Date(Date.parse(latest) + 5000).toISOString();
    const checkClock = () => {
      const at = readClock();
      if (failed || at < latest || at >= validUntil) {
        failed = true;
        return fail();
      }
      latest = at;
      return at;
    };
    let transactionCalls = 0;
    let completed: { readonly value: unknown } | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++transactionCalls !== 1) {
        failed = true;
        return fail();
      }
      checkClock();
      const permissionPolicy = currentRuntime
        ? createPostgresTransactionCurrentPermissionPolicySource(tx)
        : undefined;
      if (
        currentRuntime &&
        (!permissionPolicy ||
          typeof permissionPolicy.authorize !== "function" ||
          typeof permissionPolicy.authorizeWithRoles !== "function" ||
          typeof permissionPolicy.authorizeActionsWithRoles !== "function")
      )
        return fail();
      const scope = await (
        permissionPolicy === undefined
          ? resolveScope
          : createMerchantBrandScope(options.merchant, permissionPolicy)
      )(tx, request.sessionCookie, session.sessionReference);
      checkClock();
      bindMerchantProductCommandScope(
        {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.selectedStoreReference,
        },
        expected,
      );
      const command = parseProductPublicationCommandV2({
          ...raw,
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: scope.tenantReference,
          brandReference: scope.context.brand.brandReference,
          actorReference: scope.actorReference,
          actorKind: "User",
        }),
        canonical = canonicalizeRfc8785(command),
        authorize = scope.authorizeAction.bind(scope),
        query = tx.query;
      const currentAuthorization = createMerchantProductCurrentAuthorization({
        merchant: options.merchant,
        transaction: tx,
        scope,
        sessionCookie: request.sessionCookie,
        sessionReference: session.sessionReference,
        clock: { now: checkClock },
        originalValidUntil: validUntil,
        ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
      });
      const factoryHostBase = Object.freeze({
        transaction: tx,
        command,
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        actorReference: command.actorReference,
        storeReference: scope.selectedStoreReference,
        sessionReference: session.sessionReference,
        clock: Object.freeze({ now: checkClock }),
        originalValidUntil: validUntil,
        currentAuthorization,
        async authorizeMediaAccess() {
          try {
            checkClock();
            if (currentRuntime) {
              await currentAuthorization.authorizeActions(["media.asset.access"]);
              currentAuthorization.assertCurrent();
              checkClock();
              return;
            }
            const decision = await authorize("media.asset.access");
            checkClock();
            if (
              decision?.effect !== "Allow" ||
              decision.action !== "media.asset.access" ||
              decision.scopeKind !== "Brand"
            )
              return fail("CATALOG_PERMISSION_DENIED");
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        async registerBeforeCommit(actual, guard, finalAssert) {
          if (actual !== tx || typeof guard !== "function" || typeof finalAssert !== "function") {
            failed = true;
            return fail();
          }
          await host.registerBeforeCommit(actual, guard, finalAssert);
        },
      } satisfies MerchantProductPublicationSourceFactoryV2Input);
      const capability = currentRuntime
          ? createMerchantProductStoreCapabilityGuard(factoryHostBase)
          : undefined,
        factoryHost = Object.freeze({
          ...factoryHostBase,
          ...(capability === undefined ? {} : { capability }),
        });
      if (currentRuntime && typeof capability?.holdUntilCommit !== "function") return fail();
      const created = sourceFactory?.(factoryHost),
        runtimeAuthority = currentRuntime
          ? createMerchantProductPublicationRuntimeAuthority(factoryHost)
          : undefined,
        hold =
          runtimeAuthority?.publicationAuthority.holdUntilTransactionCompletes.bind(
            runtimeAuthority.publicationAuthority,
          ) ??
          suppliedHold ??
          fail();
      if (sourceFactory !== undefined) {
        readClosedRecord(created, ["sources", "editorContentAuthority"]);
        if (
          typeof created?.sources?.withHeldCurrentFacts !== "function" ||
          typeof created.sources.withCurrentPolicy !== "function" ||
          typeof created.editorContentAuthority !== "function"
        )
          return fail();
      }
      const sources =
          created === undefined
            ? (suppliedSources ?? fail())
            : Object.freeze({
                withHeldCurrentFacts: created.sources.withHeldCurrentFacts.bind(created.sources),
                withCurrentPolicy: created.sources.withCurrentPolicy.bind(created.sources),
              }),
        contentHold =
          created === undefined
            ? suppliedContentHold
            : created.editorContentAuthority.bind(created);
      checkClock();
      const retainDeadline = (value: unknown) => {
        const deadline = parseCatalogInstant(value);
        if (deadline < validUntil) validUntil = deadline;
        checkClock();
      };
      const boundedSources: ProductPublicationStoreOptionsV2["sources"] = {
        async withHeldCurrentFacts(actual, input, work) {
          if (
            actual !== tx ||
            canonicalizeRfc8785(parseProductPublicationCommandV2(input.command)) !== canonical
          )
            return fail();
          let calls = 0,
            completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
          const result = await sources.withHeldCurrentFacts(
            actual,
            input,
            async (value, details) => {
              if (++calls !== 1) {
                failed = true;
                return fail();
              }
              const facts = copyCategoryPersistenceValue(value) as typeof value;
              retainDeadline(parseProductPublicationValidationV2(facts.validation).validUntil);
              const capturedDetails =
                details === undefined ? undefined : copyCategoryPersistenceValue(details);
              const valueResult = await work(facts, capturedDetails);
              checkClock();
              completed = { value: valueResult };
              return completed;
            },
          );
          if (calls !== 1 || !completed || result !== completed) {
            failed = true;
            return fail();
          }
          checkClock();
          return completed.value;
        },
        async withCurrentPolicy(actual, input, work) {
          if (actual !== tx) return fail();
          let calls = 0,
            completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
          const result = await sources.withCurrentPolicy(actual, input, async (value) => {
            if (++calls !== 1) {
              failed = true;
              return fail();
            }
            const policy = copyCategoryPersistenceValue(value);
            if (!policy || typeof policy !== "object" || !("validUntil" in policy)) return fail();
            retainDeadline(policy.validUntil);
            const valueResult = await work(policy);
            checkClock();
            completed = { value: valueResult };
            return completed;
          });
          if (calls !== 1 || !completed || result !== completed) {
            failed = true;
            return fail();
          }
          checkClock();
          return completed.value;
        },
      };
      const admit = async (actions: readonly string[]) => {
        if (currentRuntime) {
          checkClock();
          await currentAuthorization.authorizeActions([...new Set(actions)]);
          currentAuthorization.assertCurrent();
          checkClock();
          return;
        }
        for (const action of new Set(actions)) {
          checkClock();
          const decision = await authorize(action);
          checkClock();
          if (
            decision?.effect !== "Allow" ||
            decision.action !== action ||
            decision.scopeKind !== "Brand"
          )
            return fail("CATALOG_PERMISSION_DENIED");
        }
      };
      let lastInput: AuthorityInput | undefined;
      const current = async (value: AuthorityInput) => {
        try {
          checkClock();
          if (tx.query !== query) return fail();
          const input = readClosedRecord(copyCategoryPersistenceValue(value), [
            "command",
            "requiredPermissions",
            "requiredFields",
            "requiredScope",
            "observedAt",
          ]);
          if (
            canonicalizeRfc8785(parseProductPublicationCommandV2(input.command)) !== canonical ||
            input.requiredScope !== "FullBrandScope" ||
            canonicalizeRfc8785(input.requiredFields) !==
              canonicalizeRfc8785(productPublicationWriteFieldsV2) ||
            !Array.isArray(input.requiredPermissions) ||
            input.requiredPermissions.length < 1 ||
            input.requiredPermissions.length > 16 ||
            input.requiredPermissions.some(
              (action) => typeof action !== "string" || !/^catalog\.[a-z_.]+$/.test(action),
            )
          )
            return fail();
          const observedAt = parseCatalogInstant(input.observedAt);
          if (observedAt > latest) return fail();
          const packet = Object.freeze({
            command,
            requiredPermissions: Object.freeze([...input.requiredPermissions]) as readonly string[],
            requiredFields: productPublicationWriteFieldsV2,
            requiredScope: "FullBrandScope" as const,
            observedAt,
          });
          await admit(["catalog.manage", "catalog.product.manage", ...packet.requiredPermissions]);
          await capability?.holdUntilCommit();
          if ((await hold(tx, packet)) !== undefined) return fail();
          checkClock();
          await admit(["catalog.manage", "catalog.product.manage", ...packet.requiredPermissions]);
          lastInput = packet;
        } catch (error) {
          failed = true;
          if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
            throw error;
          return fail();
        }
      };
      const authority: ProductPublicationStoreOptionsV2["authority"] = {
        async holdUntilTransactionCompletes(actual, input) {
          if (actual !== tx) {
            failed = true;
            return fail();
          }
          await current(input);
        },
      };
      const editorContentAuthority =
        contentHold === undefined
          ? undefined
          : createMerchantProductPublicationContentAuthorityV2({
              transaction: tx,
              scope,
              sessionReference: session.sessionReference,
              command,
              authority: contentHold,
              now: checkClock,
              registerBeforeCommit: host.registerBeforeCommit,
            });
      const currentUniqueScope =
        unique === undefined || command.action !== "Validate"
          ? undefined
          : createMerchantProductUniqueScopeFactsV2({
              configuration: unique,
              transaction: tx,
              command,
              sources: boundedSources,
              validationAuthority: authority,
              clock: { now: checkClock },
              assertAdmission: async (sourceReadsRequired, optionReadRequired) =>
                admit([
                  "catalog.manage",
                  "catalog.product.validate",
                  ...(sourceReadsRequired
                    ? ["catalog.product.read", "catalog.sku.read", "catalog.product.history.read"]
                    : []),
                  ...(optionReadRequired ? ["catalog.option_set.read"] : []),
                ]),
            });
      await host.registerBeforeCommit(
        tx,
        async () => {
          currentAuthorization.assertCurrent();
          if (!lastInput) return fail();
          await current({ ...lastInput, observedAt: checkClock() });
          await currentUniqueScope?.assertCurrent();
          editorContentAuthority?.assertCurrent();
          checkClock();
        },
        () => {
          currentAuthorization.assertCurrent();
          currentUniqueScope?.assertLeaseCurrent();
          editorContentAuthority?.assertCurrent();
          checkClock();
        },
      );
      const store = createPostgresProductPublicationStoreV2({
        tenantReference: scope.tenantReference,
        brandReference: scope.context.brand.brandReference,
        actorReference: scope.actorReference,
        actorKind: "User",
        maximumApprovalValiditySeconds,
        registerBeforeCommit: host.registerBeforeCommit,
        clock: { now: checkClock },
        transactions: { run: (work) => work(tx) },
        authority,
        ...(editorContentAuthority === undefined ? {} : { editorContentAuthority }),
        sources: currentUniqueScope?.sources ?? boundedSources,
        audit: {
          create(publication, action) {
            return {
              auditId: parseCatalogReference(auditReference(publication.operationReference)),
              brandId: publication.brandReference,
              actor: { type: "User", reference: publication.actorReference },
              actionCode: catalogProductPublicationAuditAction(action),
              targetType: "Product",
              targetId: publication.productReference,
              reasonCode: publication.reasonCode,
              correlationId: publication.operationReference,
              occurredAt: publication.occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "OPERATIONAL",
              retentionPolicyVersion: 1,
            };
          },
        },
      });
      const written = await store.execute(command);
      checkClock();
      const response = Object.freeze({
        profile: "CatalogProductPublicationCommandResultV2" as const,
        replacementIntentDigest: command.replacementIntentDigest,
        status: written.status,
        operationReference: command.operationReference,
        productReference: command.productReference,
        versionReference: command.versionReference,
        aggregateVersion: written.aggregate.aggregateVersion,
        publicationVersion: written.publication.publicationVersion,
        state: written.publication.state,
        scheduleVersion: written.publication.scheduleVersion,
        effectiveFrom: written.publication.effectivePeriod.effectiveFrom.instant,
        successorDraftVersionReference: written.publication.successorDraftVersionReference,
      });
      completed = { value: response };
      return response;
    });
    // A late response cannot present an expired admission. An already committed
    // operation remains recoverable only by retrying its unchanged full command.
    if (transactionCalls !== 1 || !completed || completed.value !== result) return fail();
    checkClock();
    return result;
  };
}
