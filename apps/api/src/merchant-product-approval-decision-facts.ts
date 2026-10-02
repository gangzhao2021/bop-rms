import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductPublicationSourceStore,
  parseCatalogApprovalValiditySeconds,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommand,
  productApprovalReviewFields,
  type ProductPublicationFacts,
  type ProductPublicationStoreOptions,
} from "@rms/catalog";
import {
  createCurrentProductPublicationPolicySource,
  currentProductPolicyFields,
} from "./current-product-publication-policy.js";
import { createCurrentProductApprovalDecisionSource } from "./current-product-approval-decision.js";

type SourceOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
type Tx = Parameters<ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"]>[0];
export interface MerchantProductApprovalDecisionConfiguration {
  readonly maximumApprovalValiditySeconds: number;
  readonly reviewAuthority: NonNullable<SourceOptions["reviewAuthority"]>;
  readonly policyAuthority: PolicyOptions["authority"];
}
export function captureMerchantProductApprovalDecisionConfiguration(
  value: MerchantProductApprovalDecisionConfiguration,
): MerchantProductApprovalDecisionConfiguration {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof value?.reviewAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.policyAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  return Object.freeze({
    maximumApprovalValiditySeconds: parseCatalogApprovalValiditySeconds(
      value.maximumApprovalValiditySeconds,
    ),
    reviewAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.reviewAuthority.holdUntilTransactionCompletes.bind(
        value.reviewAuthority,
      ),
    }),
    policyAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.policyAuthority.holdUntilTransactionCompletes.bind(
        value.policyAuthority,
      ),
    }),
  });
}

/** Actual owning decision only. Complete validation/topology/fields still belong
 * to the mandatory remaining source; an approval DTO cannot replace the owners. */
export function createMerchantProductApprovalDecisionFacts(options: {
  readonly configuration: MerchantProductApprovalDecisionConfiguration;
  readonly sources: ProductPublicationStoreOptions["sources"];
  readonly transaction: Tx;
  readonly command: Parameters<
    ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"]
  >[1]["command"];
  readonly clock: { now(): string };
  readonly assertAdmission: () => Promise<void>;
}) {
  const fail = (
    code:
      | "CATALOG_DEPENDENCY_UNAVAILABLE"
      | "CATALOG_PERMISSION_DENIED" = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new CatalogError(code);
  };
  const configuration = captureMerchantProductApprovalDecisionConfiguration(options.configuration);
  if (
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.assertAdmission !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    command = parseProductPublicationCommand(copyCategoryPersistenceValue(options.command)),
    now = options.clock.now.bind(options.clock),
    admission = options.assertAdmission,
    remaining = options.sources.withHeldCurrentFacts.bind(options.sources),
    observedAt = parseCatalogInstant(now()),
    validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
  if (command.action !== "Approve" || command.actorKind !== "User") return fail();
  let latest = observedAt,
    failed = false,
    active = false;
  let sourceValidUntil: string | undefined,
    heldReview:
      | Parameters<
          NonNullable<SourceOptions["reviewAuthority"]>["holdUntilTransactionCompletes"]
        >[1]
      | undefined,
    heldPolicy:
      Parameters<PolicyOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (
      failed ||
      tx.query !== query ||
      at < latest ||
      at >= validUntil ||
      (sourceValidUntil !== undefined && at >= sourceValidUntil)
    )
      return fail();
    latest = at;
    return at;
  };
  const assertNative = async () => {
    try {
      check();
      await admission();
      check();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const assertCurrent = async () => {
    try {
      await assertNative();
      if (heldReview) {
        if (
          (await configuration.reviewAuthority.holdUntilTransactionCompletes(tx, {
            ...heldReview,
            observedAt: check(),
          })) !== undefined
        )
          return fail();
        await assertNative();
      }
      if (heldPolicy) {
        if (
          (await configuration.policyAuthority.holdUntilTransactionCompletes(tx, {
            ...heldPolicy,
            observedAt: check(),
          })) !== undefined
        )
          return fail();
        await assertNative();
      }
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const reviewSource = createPostgresProductPublicationSourceStore({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: "User",
    clock: { now: check },
    transactions: { run: (work) => work(tx) },
    authority: {
      async holdUntilTransactionCompletes() {
        return fail();
      },
    },
    reviewAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          input.tenantReference !== command.tenantReference ||
          input.brandReference !== command.brandReference ||
          input.actorReference !== command.actorReference ||
          input.productReference !== command.productReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_APPROVAL_DECISION" ||
          input.permission !== "catalog.manage" ||
          input.owningAction !== "catalog.product.approve" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(productApprovalReviewFields)
        )
          return fail();
        await assertNative();
        const captured = Object.freeze({ ...input, requiredFields: productApprovalReviewFields });
        if (
          (await configuration.reviewAuthority.holdUntilTransactionCompletes(tx, input)) !==
          undefined
        )
          return fail();
        heldReview = captured;
        await assertNative();
      },
    },
  });
  const policySource = createCurrentProductPublicationPolicySource({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: "User",
    clock: { now: check },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          input.tenantReference !== command.tenantReference ||
          input.brandReference !== command.brandReference ||
          input.actorReference !== command.actorReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_VERSION_PUBLICATION" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(currentProductPolicyFields)
        )
          return fail();
        parseCatalogReference(input.policyReference);
        await assertNative();
        const captured = Object.freeze({ ...input, requiredFields: currentProductPolicyFields });
        if (
          (await configuration.policyAuthority.holdUntilTransactionCompletes(tx, input)) !==
          undefined
        )
          return fail();
        heldPolicy = captured;
        await assertNative();
      },
    },
  });
  const decision = createCurrentProductApprovalDecisionSource({
    reviewSource,
    policySource,
    maximumApprovalValiditySeconds: configuration.maximumApprovalValiditySeconds,
    clock: { now: check },
  });
  const withHeldCurrentFacts: ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"] =
    async (actual, input, work) => {
      try {
        if (
          actual !== tx ||
          active ||
          canonicalCommand(input.command) !== canonicalCommand(command)
        )
          return fail();
        active = true;
        await assertNative();
        let calls = 0,
          completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
        const result = await decision.withCurrentDecision(tx, command, async (proof) => {
          sourceValidUntil = parseCatalogInstant(proof.validUntil);
          check();
          const answer = await remaining(tx, input, async (value) => {
            if (++calls !== 1) return fail();
            check();
            const stableFacts = copyCategoryPersistenceValue(value) as ProductPublicationFacts;
            const facts = readClosedRecord(stableFacts, [
              "now",
              "productAggregateVersion",
              "contentDigest",
              "configurationDigest",
              "scopeDigest",
              "periodDigest",
              "validation",
              "approval",
              "reviewReference",
              "replacement",
            ]);
            if (facts.approval !== null) return fail();
            await assertNative();
            const valueResult = await work({ ...stableFacts, approval: proof.approval });
            await assertNative();
            completed = { value: valueResult };
            return completed;
          });
          if (calls !== 1 || !completed || answer !== completed) return fail();
          return completed;
        });
        await assertCurrent();
        if (!completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        active = false;
      }
    };
  return Object.freeze({
    sources: Object.freeze({
      withHeldCurrentFacts,
      ...(options.sources.withHeldScopePolicy === undefined
        ? {}
        : { withHeldScopePolicy: options.sources.withHeldScopePolicy.bind(options.sources) }),
    }),
    assertCurrent,
  });
}
function canonicalCommand(value: unknown) {
  return JSON.stringify(parseProductPublicationCommand(copyCategoryPersistenceValue(value)));
}
