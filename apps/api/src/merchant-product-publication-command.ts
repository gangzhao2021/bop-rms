import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  parseProductPublicationCommand,
  createPostgresProductPublicationStore,
  catalogProductPublicationAuditAction,
  parseCatalogReference,
  type ProductPublicationStoreOptions,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  parseMerchantProductCommandScope,
  bindMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  captureMerchantProductApprovalDecisionConfiguration,
  createMerchantProductApprovalDecisionFacts,
  type MerchantProductApprovalDecisionConfiguration,
} from "./merchant-product-approval-decision-facts.js";
import {
  captureMerchantProductScopePolicyConfiguration,
  createMerchantProductScopePolicy,
  type MerchantProductScopePolicyConfiguration,
} from "./merchant-product-scope-policy.js";
import {
  captureMerchantProductCurrentApprovalConfiguration,
  createMerchantProductCurrentApprovalFacts,
  type MerchantProductCurrentApprovalConfiguration,
} from "./merchant-product-current-approval-facts.js";
import {
  createMerchantProductPublicationContentAuthority,
  type MerchantProductPublicationContentAuthority,
} from "./merchant-product-publication-content-authority.js";
import {
  captureMerchantProductUniqueScopeConfiguration,
  createMerchantProductUniqueScopeFacts,
  type MerchantProductUniqueScopeConfiguration,
} from "./merchant-product-unique-scope-facts.js";
const fields = [
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
] as const;
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export interface MerchantProductPublicationOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
  /** Current target/field/Phase/source/policy leases are server composition only. */
  readonly authority: ProductPublicationStoreOptions["authority"];
  readonly sources: ProductPublicationStoreOptions["sources"];
  /** Actual owning review/current policy decision; full remaining facts stay mandatory. */
  readonly approvalDecision?: MerchantProductApprovalDecisionConfiguration;
  /** Actual current Publishing policy for the ordinary Publish scope journal. */
  readonly currentScopePolicy?: MerchantProductScopePolicyConfiguration;
  /** Owning original approval/current policy for new publication or timing intent. */
  readonly currentApproval?: MerchantProductCurrentApprovalConfiguration;
  /** Independent complete fields/references; absent holder refuses stored full content. */
  readonly editorContentAuthority?: MerchantProductPublicationContentAuthority;
  /** Current candidate/history/registered roster/policy for the sole UniqueScope check. */
  readonly currentUniqueScope?: MerchantProductUniqueScopeConfiguration;
}
/** Merchant commands derive Tenant/Brand/Actor from current persisted scope. The
 * system-only activation command is reserved for the owning scheduler. Original
 * body intent/time stays stable on replay; body carries no permission/evidence. */
export function createMerchantProductPublicationCommand(
  options: MerchantProductPublicationOptions,
) {
  const resolveScope = createMerchantBrandScope(options.merchant),
    host = createMerchantCategoryTransactions(options.merchant.transactions);
  const approvalDecision =
    options.approvalDecision === undefined
      ? undefined
      : captureMerchantProductApprovalDecisionConfiguration(options.approvalDecision);
  const scopePolicy =
    options.currentScopePolicy === undefined
      ? undefined
      : captureMerchantProductScopePolicyConfiguration(options.currentScopePolicy);
  const approvalSource =
    options.currentApproval === undefined
      ? undefined
      : captureMerchantProductCurrentApprovalConfiguration(options.currentApproval);
  const uniqueScopeConfiguration =
    options.currentUniqueScope === undefined
      ? undefined
      : captureMerchantProductUniqueScopeConfiguration(options.currentUniqueScope);
  if (scopePolicy !== undefined && options.sources?.withHeldScopePolicy !== undefined)
    return fail();
  if (
    (approvalDecision !== undefined ||
      scopePolicy !== undefined ||
      approvalSource !== undefined ||
      uniqueScopeConfiguration !== undefined) &&
    typeof options.sources?.withHeldCurrentFacts !== "function"
  )
    return fail();
  const decisionSources =
    approvalDecision === undefined &&
    scopePolicy === undefined &&
    approvalSource === undefined &&
    uniqueScopeConfiguration === undefined
      ? undefined
      : Object.freeze({
          withHeldCurrentFacts: options.sources.withHeldCurrentFacts.bind(options.sources),
          ...(options.sources.withHeldScopePolicy === undefined
            ? {}
            : { withHeldScopePolicy: options.sources.withHeldScopePolicy.bind(options.sources) }),
        });
  const editorAuthority = options.editorContentAuthority;
  if (editorAuthority !== undefined && typeof editorAuthority !== "function") return fail();
  const contentAuthority = editorAuthority?.bind(options);
  const decisionNow = options.merchant.now.bind(options.merchant);
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }) => {
    const expected = parseMerchantProductCommandScope(request.expectedScope);
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(request.command, fields);
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    if (raw.action === "ActivateScheduled") return fail("CATALOG_PERMISSION_DENIED");
    const session = await options.authentication.authorize({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    return host.transactions.run(async (tx) => {
      const scope = await resolveScope(tx, request.sessionCookie, session.sessionReference);
      bindMerchantProductCommandScope(
        {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.selectedStoreReference,
        },
        expected,
      );
      const command = parseProductPublicationCommand({
        ...raw,
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: scope.tenantReference,
        brandReference: scope.context.brand.brandReference,
        actorReference: scope.actorReference,
        actorKind: "User",
      });
      const editorContentAuthority =
        contentAuthority === undefined
          ? undefined
          : createMerchantProductPublicationContentAuthority({
              transaction: tx,
              scope,
              sessionReference: session.sessionReference,
              command,
              authority: contentAuthority,
              now: decisionNow,
              registerBeforeCommit: host.registerBeforeCommit,
            });
      const currentDecision =
        approvalDecision === undefined || command.action !== "Approve"
          ? undefined
          : createMerchantProductApprovalDecisionFacts({
              configuration: approvalDecision,
              sources: decisionSources ?? fail(),
              transaction: tx,
              command,
              clock: { now: decisionNow },
              assertAdmission: async () => {
                for (const action of ["catalog.manage", "catalog.product.approve"]) {
                  const current = await scope.authorizeAction(action);
                  if (
                    current?.effect !== "Allow" ||
                    current.action !== action ||
                    current.scopeKind !== "Brand"
                  )
                    return fail("CATALOG_PERMISSION_DENIED");
                }
              },
            });
      const currentPolicy =
        scopePolicy === undefined || command.action !== "Publish"
          ? undefined
          : createMerchantProductScopePolicy({
              configuration: scopePolicy,
              transaction: tx,
              command,
              clock: { now: decisionNow },
              assertAdmission: async () => {
                for (const action of ["catalog.manage", "catalog.product.publish"]) {
                  const current = await scope.authorizeAction(action);
                  if (
                    current?.effect !== "Allow" ||
                    current.action !== action ||
                    current.scopeKind !== "Brand"
                  )
                    return fail("CATALOG_PERMISSION_DENIED");
                }
              },
            });
      const currentApproval =
        approvalSource === undefined ||
        !["Publish", "SchedulePublish", "ReschedulePublish"].includes(command.action)
          ? undefined
          : createMerchantProductCurrentApprovalFacts({
              configuration: approvalSource,
              sources: decisionSources ?? fail(),
              transaction: tx,
              command,
              clock: { now: decisionNow },
              assertAdmission: async (approvalReadRequired) => {
                for (const action of [
                  "catalog.manage",
                  "catalog.product.publish",
                  ...(approvalReadRequired ? ["catalog.product.approval.read"] : []),
                ]) {
                  const current = await scope.authorizeAction(action);
                  if (
                    current?.effect !== "Allow" ||
                    current.action !== action ||
                    current.scopeKind !== "Brand"
                  )
                    return fail("CATALOG_PERMISSION_DENIED");
                }
              },
            });
      const check = async (
        input: Parameters<
          ProductPublicationStoreOptions["authority"]["holdUntilTransactionCompletes"]
        >[1],
      ) => {
        for (const action of new Set([
          "catalog.manage",
          "catalog.product.manage",
          ...input.requiredPermissions,
        ])) {
          const d = await scope.authorizeAction(action);
          if (d?.effect !== "Allow" || d.action !== action || d.scopeKind !== "Brand")
            return fail("CATALOG_PERMISSION_DENIED");
        }
        if (typeof options.authority?.holdUntilTransactionCompletes !== "function") return fail();
        await options.authority.holdUntilTransactionCompletes(tx, input);
      };
      let lastInput: Parameters<typeof check>[0] | undefined;
      const authority: ProductPublicationStoreOptions["authority"] = {
        async holdUntilTransactionCompletes(_tx, input) {
          if (
            input.command !== command &&
            (input.command.operationReference !== command.operationReference ||
              input.command.actorReference !== scope.actorReference)
          )
            return fail();
          lastInput = input;
          await check(input);
        },
      };
      const currentUniqueScope =
        uniqueScopeConfiguration === undefined || command.action !== "Validate"
          ? undefined
          : createMerchantProductUniqueScopeFacts({
              configuration: uniqueScopeConfiguration,
              transaction: tx,
              command,
              sources: decisionSources ?? fail(),
              validationAuthority: authority,
              clock: { now: decisionNow },
              assertAdmission: async (sourceReadsRequired, optionReadRequired) => {
                const actions = [
                  "catalog.manage",
                  "catalog.product.validate",
                  ...(sourceReadsRequired
                    ? ["catalog.product.read", "catalog.sku.read", "catalog.product.history.read"]
                    : []),
                  ...(optionReadRequired ? ["catalog.option_set.read"] : []),
                ];
                if (typeof scope.authorizeActions === "function") {
                  const decisions = await scope.authorizeActions(actions);
                  if (
                    !decisions ||
                    decisions.length !== actions.length ||
                    decisions.some(
                      (current, index) =>
                        current?.effect !== "Allow" ||
                        current.action !== actions[index] ||
                        current.scopeKind !== "Brand",
                    )
                  )
                    return fail("CATALOG_PERMISSION_DENIED");
                  return;
                }
                for (const action of actions) {
                  const current = await scope.authorizeAction(action);
                  if (
                    current?.effect !== "Allow" ||
                    current.action !== action ||
                    current.scopeKind !== "Brand"
                  )
                    return fail("CATALOG_PERMISSION_DENIED");
                }
              },
            });
      await host.registerBeforeCommit(tx, async () => {
        if (!lastInput) return fail();
        await check({ ...lastInput, observedAt: options.merchant.now() });
        await currentDecision?.assertCurrent();
        await currentPolicy?.assertCurrent();
        await currentApproval?.assertCurrent();
        await currentUniqueScope?.assertCurrent();
      });
      const store = createPostgresProductPublicationStore({
        tenantReference: scope.tenantReference,
        brandReference: scope.context.brand.brandReference,
        actorReference: scope.actorReference,
        actorKind: "User",
        clock: { now: options.merchant.now },
        transactions: { run: (work) => work(tx) },
        authority,
        ...(editorContentAuthority === undefined ? {} : { editorContentAuthority }),
        sources:
          currentPolicy === undefined
            ? (currentUniqueScope?.sources ??
              currentApproval?.sources ??
              currentDecision?.sources ??
              options.sources)
            : {
                ...(currentApproval?.sources ?? decisionSources ?? fail()),
                withHeldScopePolicy: currentPolicy.withHeldScopePolicy,
              },
        audit: {
          create(publication, action) {
            return {
              auditId: parseCatalogReference(
                options.auditReference(publication.operationReference),
              ),
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
      const result = await store.execute(command);
      await currentApproval?.assertReceiptAdmission(result.publication);
      return Object.freeze({
        status: result.status,
        operationReference: command.operationReference,
        productReference: command.productReference,
        versionReference: command.versionReference,
        aggregateVersion: result.aggregate.aggregateVersion,
        publicationVersion: result.publication.publicationVersion,
        state: result.publication.state,
        scheduleVersion: result.publication.scheduleVersion,
        effectiveFrom: result.publication.effectivePeriod.effectiveFrom.instant,
        successorDraftVersionReference: result.publication.successorDraftVersionReference,
      });
    });
  };
}
