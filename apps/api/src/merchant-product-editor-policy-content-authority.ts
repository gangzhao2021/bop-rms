import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { createPostgresTenantBrandConfigurationContentSource } from "@bop/tenant";
import {
  CatalogError,
  assessCatalogProductDraftContentPolicy,
  copyCategoryPersistenceValue,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
} from "@rms/catalog";
import { createCurrentBrandConfigurationContentSource } from "./current-brand-configuration-content.js";
import { createCurrentProductDraftContentPolicySource } from "./current-product-content-policy.js";
import {
  createCurrentProductPublicationPolicySource,
  currentProductPolicyFields,
  type CurrentProductPublicationPolicy,
} from "./current-product-publication-policy.js";
import type { createMerchantProductEditorRuntimeBrandSources } from "./merchant-product-editor-runtime-brand-sources.js";
import {
  remainingProductEditorVariantReferenceChecks,
  type MerchantProductEditorVariantRemainingAuthority,
} from "./merchant-product-editor-variant-content-authority.js";

type BrandOptions = Parameters<typeof createPostgresTenantBrandConfigurationContentSource>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];

/** Actual locale/media-presence prerequisite inside the Variant remaining holder.
 * Full Brand field requirements and all five checks remain independent mandatory
 * holders. Server pins are expected-current selectors, never source authority.
 */
export function createMerchantProductEditorPolicyContentAuthority(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly configurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly brandAuthority: BrandOptions["authority"];
  /** Internal actual-host composition; never part of caller authoring selectors. */
  readonly runtimeBrandSources?: Pick<
    ReturnType<typeof createMerchantProductEditorRuntimeBrandSources>,
    "withCurrentBrandContent"
  >;
  readonly policyAuthority: PolicyOptions["authority"];
  readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
  readonly clock: { now(): string };
}): MerchantProductEditorVariantRemainingAuthority {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.brandAuthority?.withCurrentContentRead !== "function" ||
    typeof options.brandAuthority?.isCurrent !== "function" ||
    typeof options.policyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.clock?.now !== "function" ||
    (options.runtimeBrandSources !== undefined &&
      typeof options.runtimeBrandSources.withCurrentBrandContent !== "function") ||
    !Number.isSafeInteger(options.expectedBrandVersion) ||
    options.expectedBrandVersion < 1 ||
    options.expectedBrandVersion > 2147483647 ||
    !Number.isSafeInteger(options.policyVersion) ||
    options.policyVersion < 1 ||
    options.policyVersion > 2147483647
  )
    return fail();
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    configurationVersionReference = parseCatalogReference(options.configurationVersionReference),
    policyReference = parseCatalogReference(options.policyReference),
    expectedBrandVersion = options.expectedBrandVersion,
    policyVersion = options.policyVersion,
    now = options.clock.now.bind(options.clock),
    brandRead = options.brandAuthority.withCurrentContentRead.bind(options.brandAuthority),
    brandCurrent = options.brandAuthority.isCurrent.bind(options.brandAuthority),
    policyHold = options.policyAuthority.holdUntilTransactionCompletes.bind(
      options.policyAuthority,
    ),
    remainingHold = options.remainingAuthority,
    failed = new WeakSet<object>();
  const heldBrandRead = options.runtimeBrandSources?.withCurrentBrandContent.bind(
    options.runtimeBrandSources,
  );
  interface HeldPolicy {
    readonly fingerprint: string;
    readonly query: Parameters<MerchantProductEditorVariantRemainingAuthority>[0]["query"];
    readonly brandFingerprint: string;
    readonly policy: CurrentProductPublicationPolicy;
  }
  const heldPolicies = new WeakMap<object, HeldPolicy>();
  return async (tx, value) => {
    try {
      if (!tx || typeof tx !== "object" || typeof tx.query !== "function" || failed.has(tx))
        return fail();
      const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
          "sessionReference",
          "productReference",
          "operationReference",
          "permission",
          "owningAction",
          "purposeCode",
          "observedAt",
          "validUntil",
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]),
        aggregate = parseProductAggregate(raw.aggregate),
        observedAt = parseCatalogInstant(raw.observedAt),
        validUntil = parseCatalogInstant(raw.validUntil);
      if (
        (raw.mode !== "Read" && raw.mode !== "DraftWrite") ||
        raw.tenantReference !== tenantReference ||
        raw.brandReference !== brandReference ||
        raw.actorReference !== actorReference ||
        raw.permission !== "catalog.manage" ||
        raw.owningAction !== "catalog.product.manage" ||
        (raw.purposeCode !== "CATALOG_PRODUCT_DRAFT_REPLACE" &&
          raw.purposeCode !== "CATALOG_PRODUCT_CREATE") ||
        (raw.purposeCode === "CATALOG_PRODUCT_CREATE" &&
          (raw.mode !== "DraftWrite" ||
            aggregate.aggregateVersion !== 1 ||
            aggregate.lifecycle !== "Draft" ||
            aggregate.draft.status !== "Draft")) ||
        Date.parse(validUntil) - Date.parse(observedAt) !== 5000 ||
        JSON.stringify(raw.requiredFields) !== JSON.stringify(productEditorContentFields) ||
        JSON.stringify(raw.requiredReferenceChecks) !==
          JSON.stringify(raw.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks) ||
        aggregate.brandReference !== brandReference ||
        aggregate.productReference !== raw.productReference ||
        aggregate.draft.editorContent === undefined ||
        Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 8 * 1024 * 1024
      )
        return fail();
      const input = Object.freeze({
        tenantReference,
        brandReference,
        actorReference,
        storeReference: parseCatalogReference(raw.storeReference),
        sessionReference: parseCatalogReference(raw.sessionReference),
        productReference: parseCatalogReference(raw.productReference),
        operationReference: parseCatalogReference(raw.operationReference),
        permission: "catalog.manage" as const,
        owningAction: "catalog.product.manage" as const,
        purposeCode: raw.purposeCode as "CATALOG_PRODUCT_DRAFT_REPLACE" | "CATALOG_PRODUCT_CREATE",
        observedAt,
        validUntil,
        mode: raw.mode,
        aggregate,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          raw.mode === "Read" ? Object.freeze([]) : remainingProductEditorVariantReferenceChecks,
      });
      const check = () => {
        const at = parseCatalogInstant(now());
        if (failed.has(tx) || at < observedAt || at >= validUntil) return fail();
      };
      const holdRemaining = async () => {
        check();
        if ((await remainingHold(tx, input)) !== undefined) return fail();
        check();
      };
      check();
      if (raw.mode === "Read") return await holdRemaining();
      if (heldBrandRead !== undefined) {
        const fingerprint = canonicalizeRfc8785(input),
          query = tx.query,
          retained = heldPolicies.get(tx),
          identity = deriveCatalogProductPublicationContentIdentity(aggregate);
        if (retained && (retained.fingerprint !== fingerprint || retained.query !== query))
          return fail();
        let brandCalls = 0,
          policyCalls = 0,
          finished = false,
          proof: HeldPolicy | undefined;
        const answer = await heldBrandRead(tx, async (brand) => {
          check();
          if (
            ++brandCalls !== 1 ||
            tx.query !== query ||
            brand.tenantReference !== tenantReference ||
            brand.brandReference !== brandReference ||
            brand.brandVersion !== expectedBrandVersion ||
            brand.configurationVersionReference !== configurationVersionReference ||
            brand.eligibility !== "NotEvaluated" ||
            brand.observedAt > observedAt ||
            brand.validUntil > validUntil ||
            brand.validUntil <= parseCatalogInstant(now())
          )
            return fail();
          const brandFingerprint = canonicalizeRfc8785(brand);
          if (retained && retained.brandFingerprint !== brandFingerprint) return fail();
          const holdPolicy = async () => {
            check();
            if (tx.query !== query) return fail();
            if (
              (await policyHold(
                tx,
                Object.freeze({
                  tenantReference,
                  brandReference,
                  actorReference,
                  actorKind: "User",
                  purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
                  policyReference,
                  requiredFields: currentProductPolicyFields,
                  observedAt: parseCatalogInstant(now()),
                }),
              )) !== undefined
            )
              return fail();
            check();
          };
          const assess = async (policy: CurrentProductPublicationPolicy) => {
            if (
              ++policyCalls !== 1 ||
              parseCatalogReference(policy.content.tenantReference) !== tenantReference ||
              parseCatalogReference(policy.content.brandReference) !== brandReference ||
              parseCatalogReference(policy.content.policyReference) !== policyReference ||
              policy.content.policyVersion !== policyVersion ||
              policy.observedAt !== brand.observedAt ||
              policy.validUntil <= parseCatalogInstant(now())
            )
              return fail();
            const end = [validUntil, brand.validUntil, policy.validUntil].sort()[0];
            if (!end) return fail();
            // This is a pure assessment summary at the freshly held read time,
            // not a replacement for the original immutable Brand source proof.
            // Both original source observations and their deadlines remain intact.
            const assessmentAt = parseCatalogInstant(now());
            const assessment = assessCatalogProductDraftContentPolicy(
              aggregate,
              {
                tenantReference: brand.tenantReference,
                brandReference: brand.brandReference,
                brandVersion: brand.brandVersion,
                configurationVersionReference: brand.configurationVersionReference,
                contentDigest: brand.contentDigest,
                currentPublicationReference: brand.currentPublicationReference,
                supportedLocales: brand.supportedLocales,
                originalIntentDigest: brand.originalIntentDigest,
                observedAt: assessmentAt,
                validUntil: brand.validUntil,
              },
              policy.content,
              {
                tenantReference,
                productReference: input.productReference,
                versionReference: aggregate.draft.versionReference,
                expectedAggregateVersion: aggregate.aggregateVersion,
                contentDigest: identity.contentDigest,
                configurationDigest: identity.configurationDigest,
                originalIntentDigest: brand.originalIntentDigest,
                observedAt: assessmentAt,
                validUntil: end,
              },
            );
            if (assessment.decision !== "PassForAssessedDraftRules")
              throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
            check();
            await holdRemaining();
            check();
            finished = true;
            proof = Object.freeze({ fingerprint, query, brandFingerprint, policy });
          };
          if (retained) {
            await holdPolicy();
            await assess(retained.policy);
            await holdPolicy();
            return;
          }
          // Publishing's actual owner holds its policy/current-release table fence
          // in this exact outer transaction until COMMIT.
          await createCurrentProductPublicationPolicySource({
            tenantReference,
            brandReference,
            actorReference,
            actorKind: "User",
            clock: { now },
            authority: {
              async holdUntilTransactionCompletes(actual, request) {
                check();
                if (
                  actual !== tx ||
                  tx.query !== query ||
                  (await policyHold(actual, request)) !== undefined
                )
                  return fail();
                check();
              },
            },
          }).withCurrentPolicy(
            tx,
            {
              policyReference,
              policyVersion,
              observedAt: brand.observedAt,
            },
            async (current) => {
              const policy = Object.freeze({
                content: parsePublishingProductPublicationPolicy(
                  copyCategoryPersistenceValue(current.content),
                ),
                currentPublicationReference: parseCatalogReference(
                  current.currentPublicationReference,
                ),
                observedAt: parseCatalogInstant(current.observedAt),
                validUntil: parseCatalogInstant(current.validUntil),
              });
              await assess(policy);
            },
          );
        });
        if (brandCalls !== 1 || policyCalls !== 1 || !finished || answer !== undefined || !proof)
          return fail();
        check();
        if (tx.query !== query) return fail();
        heldPolicies.set(tx, proof);
        return;
      }
      const sourceAt = parseCatalogInstant(now()),
        identity = deriveCatalogProductPublicationContentIdentity(aggregate),
        originalIntentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785({ input, identity })),
        source = createCurrentProductDraftContentPolicySource({
          clock: { now },
          brandSource: createCurrentBrandConfigurationContentSource(
            createPostgresTenantBrandConfigurationContentSource({
              brandReference,
              clock: now,
              transactions: { run: (work) => work(tx) },
              authority: {
                withCurrentContentRead: (...args) => brandRead(...args),
                isCurrent: (...args) => brandCurrent(...args),
              },
            }),
          ),
          policySource: createCurrentProductPublicationPolicySource({
            tenantReference,
            brandReference,
            actorReference,
            actorKind: "User",
            clock: { now },
            authority: {
              async holdUntilTransactionCompletes(actualTx, request) {
                check();
                if ((await policyHold(actualTx, request)) !== undefined) return fail();
                check();
              },
            },
          }),
        });
      let calls = 0,
        completed = false,
        hardError = false,
        remainingConflict = false,
        remainingDenied = false;
      const answer = await source.withCurrentAssessment(
        tx,
        {
          aggregate,
          binding: {
            tenantReference,
            productReference: input.productReference,
            versionReference: aggregate.draft.versionReference,
            expectedAggregateVersion: aggregate.aggregateVersion,
            contentDigest: identity.contentDigest,
            configurationDigest: identity.configurationDigest,
            originalIntentDigest,
            observedAt: sourceAt,
            validUntil,
          },
          brandRequest: {
            tenantReference,
            brandReference,
            actorReference,
            purposeCode: "CATALOG_PRODUCT_CONTENT",
            configurationVersionReference,
            expectedBrandVersion,
            originalIntentDigest,
            observedAt: sourceAt,
            validUntil,
          },
          policyRequest: { policyReference, policyVersion, observedAt: sourceAt },
        },
        async (assessment) => {
          if (++calls !== 1) return fail();
          check();
          if (
            assessment.profile !== "CatalogProductDraftContentPolicyAssessmentV1" ||
            assessment.tenantReference !== tenantReference ||
            assessment.brandReference !== brandReference ||
            assessment.productReference !== input.productReference ||
            assessment.versionReference !== aggregate.draft.versionReference ||
            assessment.aggregateVersion !== aggregate.aggregateVersion ||
            assessment.contentDigest !== identity.contentDigest ||
            assessment.configurationDigest !== identity.configurationDigest ||
            assessment.originalIntentDigest !== originalIntentDigest ||
            assessment.observedAt !== sourceAt ||
            assessment.validUntil > validUntil ||
            assessment.validUntil <= sourceAt ||
            assessment.eligibility !== "NotEvaluated" ||
            assessment.publishValidation !== "Incomplete"
          )
            return fail();
          if (assessment.decision === "HardError") {
            hardError = true;
            completed = true;
            return;
          }
          if (assessment.decision !== "PassForAssessedDraftRules") return fail();
          try {
            await holdRemaining();
          } catch (error) {
            if (
              !(error instanceof CatalogError) ||
              (error.code !== "CATALOG_LIFECYCLE_CONFLICT" &&
                error.code !== "CATALOG_PERMISSION_DENIED")
            )
              throw error;
            remainingDenied = error.code === "CATALOG_PERMISSION_DENIED";
            remainingConflict = error.code === "CATALOG_LIFECYCLE_CONFLICT";
          }
          completed = true;
        },
      );
      if (calls !== 1 || !completed || answer !== undefined) return fail();
      check();
      // Surface a known business conflict only after owning final holds return.
      if (remainingDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      if (hardError || remainingConflict) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    } catch (error) {
      if (tx && typeof tx === "object") failed.add(tx);
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
}
