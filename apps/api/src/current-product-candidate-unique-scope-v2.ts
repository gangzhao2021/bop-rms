import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSourceV2,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommandV2,
  type CatalogCurrentProductValidationCandidateV2,
  type CatalogProductUniqueScopeAssessmentV2,
  type CatalogProductContentPolicyAssessmentV2,
} from "@rms/catalog";
import {
  createCurrentProductUniqueScopeSourceV2,
  type CurrentProductUniqueScopeSourceOptionsV2,
} from "./current-product-unique-scope-v2.js";

import {
  createCurrentProductCandidateOptionRuleSourceV2,
  type CurrentProductCandidateOptionRulesV2,
} from "./current-product-candidate-option-rules-v2.js";
import {
  createCurrentProductHeldContentPolicySourceV2,
  type HeldProductContentPolicyConfigurationV2,
} from "./current-product-held-content-policy-v2.js";
import {
  createCurrentProductCandidateVariantMappingSourceV2,
  type CurrentProductVariantMappingV2,
  type ProductCandidateVariantHistoryAuthorityV2,
} from "./current-product-candidate-variant-mapping-v2.js";
import type { CurrentProductPublicationPolicy } from "./current-product-publication-policy.js";
type OptionOptions = Parameters<typeof createCurrentProductCandidateOptionRuleSourceV2>[0];

type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSourceV2>[0];
type ScopeSource = ReturnType<typeof createCurrentProductUniqueScopeSourceV2>;
export type CurrentProductCandidateUniqueScopeV2 = Omit<
  CatalogProductUniqueScopeAssessmentV2,
  "profile" | "digest"
> & {
  readonly profile: "CurrentProductCandidateUniqueScopeV2";
  readonly currentCandidate: "Bound";
  readonly scopeAssessment: CatalogProductUniqueScopeAssessmentV2;
  readonly scopeAssessmentDigest: string;
  readonly candidateObservedAt: CatalogCurrentProductValidationCandidateV2["observedAt"];
  readonly candidateValidUntil: CatalogCurrentProductValidationCandidateV2["validUntil"];
  readonly completeContent: "Present";
  readonly skuPrerequisite: CatalogCurrentProductValidationCandidateV2["skuPrerequisite"];
  readonly variantMappingPrerequisite: CatalogCurrentProductValidationCandidateV2["variantMappingPrerequisite"];
  readonly optionSelectionPrerequisite: CatalogCurrentProductValidationCandidateV2["optionSelectionPrerequisite"];
  readonly optionRulePrerequisite: "NoMechanicalContradiction" | "Unsatisfiable";
  readonly optionRulesAssessment?: CurrentProductCandidateOptionRulesV2;
  readonly contentPolicyAssessment?: CatalogProductContentPolicyAssessmentV2;
  readonly variantMappingAssessment?: CurrentProductVariantMappingV2;
  readonly internalCodeCheck: CatalogCurrentProductValidationCandidateV2["internalCodeCheck"];
  readonly digest: string;
};
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
/** Held complete Draft, retirement-aware scope, and configured owning Option
 * and content-policy prerequisites. Other qualification facts remain mandatory. */
export function createCurrentProductCandidateUniqueScopeSourceV2(
  options: CurrentProductUniqueScopeSourceOptionsV2 & {
    readonly candidateAuthority: CandidateOptions["authority"];
    readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
    readonly optionAuthority?: OptionOptions["optionAuthority"];
    readonly contentPolicy?: HeldProductContentPolicyConfigurationV2;
    readonly variantHistoryAuthority?: ProductCandidateVariantHistoryAuthorityV2;
  },
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.validationAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.tenantAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof options.tenantAuthority?.isCurrent !== "function" ||
    typeof options.policySource?.withCurrentPolicy !== "function" ||
    (options.contentPolicy !== undefined &&
      (typeof options.contentPolicy.brandAuthority?.withCurrentContentRead !== "function" ||
        typeof options.contentPolicy.brandAuthority?.isCurrent !== "function")) ||
    (options.variantHistoryAuthority !== undefined &&
      typeof options.variantHistoryAuthority.holdUntilTransactionCompletes !== "function") ||
    (options.optionAuthority !== undefined &&
      typeof options.optionAuthority.holdUntilTransactionCompletes !== "function") ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    variantHistoryAuthority =
      options.variantHistoryAuthority === undefined
        ? undefined
        : Object.freeze({
            holdUntilTransactionCompletes:
              options.variantHistoryAuthority.holdUntilTransactionCompletes.bind(
                options.variantHistoryAuthority,
              ),
          }),
    optionAuthority =
      options.optionAuthority === undefined
        ? undefined
        : Object.freeze({
            holdUntilTransactionCompletes:
              options.optionAuthority.holdUntilTransactionCompletes.bind(options.optionAuthority),
          }),
    contentConfiguration =
      options.contentPolicy === undefined
        ? undefined
        : Object.freeze({
            configurationVersionReference: parseCatalogReference(
              options.contentPolicy.configurationVersionReference,
            ),
            expectedBrandVersion: options.contentPolicy.expectedBrandVersion,
            brandAuthority: Object.freeze({
              withCurrentContentRead:
                options.contentPolicy.brandAuthority.withCurrentContentRead.bind(
                  options.contentPolicy.brandAuthority,
                ),
              isCurrent: options.contentPolicy.brandAuthority.isCurrent.bind(
                options.contentPolicy.brandAuthority,
              ),
            }),
          }),
    candidateAuthority = Object.freeze({
      holdUntilTransactionCompletes: options.candidateAuthority.holdUntilTransactionCompletes.bind(
        options.candidateAuthority,
      ),
    }),
    categoryAssignments =
      options.categoryAssignments === undefined
        ? undefined
        : Object.freeze({
            holdUntilTransactionCompletes:
              options.categoryAssignments.holdUntilTransactionCompletes.bind(
                options.categoryAssignments,
              ),
          }),
    scopeOptions = Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      validationAuthority: Object.freeze({
        holdUntilTransactionCompletes:
          options.validationAuthority.holdUntilTransactionCompletes.bind(
            options.validationAuthority,
          ),
      }),
      historyAuthority: Object.freeze({
        holdUntilTransactionCompletes: options.historyAuthority.holdUntilTransactionCompletes.bind(
          options.historyAuthority,
        ),
      }),
      tenantAuthority: Object.freeze({
        withCurrentBrandReferenceRead: options.tenantAuthority.withCurrentBrandReferenceRead.bind(
          options.tenantAuthority,
        ),
        isCurrent: options.tenantAuthority.isCurrent.bind(options.tenantAuthority),
      }),
      policySource: Object.freeze({
        context: Object.freeze(
          copyCategoryPersistenceValue(options.policySource.context),
        ) as CurrentProductUniqueScopeSourceOptionsV2["policySource"]["context"],
        withCurrentPolicy: options.policySource.withCurrentPolicy.bind(options.policySource),
      }),
    }),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  // Validate captured context before admitting any transaction. Each invocation
  // below forwards the same monotonic clock through every nested source.
  createCurrentProductUniqueScopeSourceV2({ ...scopeOptions, clock: { now } });
  if (contentConfiguration !== undefined)
    createCurrentProductHeldContentPolicySourceV2(contentConfiguration, { now });
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<ScopeSource["withCurrentAssessment"]>[0],
      value: unknown,
      work: (assessment: CurrentProductCandidateUniqueScopeV2) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          typeof work !== "function" ||
          active.has(tx) ||
          failed.has(tx)
        )
          return fail();
        active.add(tx);
        entered = true;
        const raw = copyCategoryPersistenceValue(value);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).length !== 3 ||
          ["command", "policyReference", "policyVersion"].some((key) => !Object.hasOwn(raw, key))
        )
          return fail();
        const input = raw as Record<string, unknown>,
          c = parseProductPublicationCommandV2(input.command),
          policyReference = parseCatalogReference(input.policyReference),
          policyVersion = input.policyVersion;
        if (
          c.action !== "Validate" ||
          c.actorKind !== "User" ||
          c.tenantReference !== tenant ||
          c.brandReference !== brand ||
          c.actorReference !== actor ||
          !Number.isSafeInteger(policyVersion) ||
          (policyVersion as number) < 1 ||
          (policyVersion as number) > 2147483647
        )
          return fail();
        const startedAt = parseCatalogInstant(now()),
          query = tx.query;
        let latest = startedAt,
          deadline = new Date(Date.parse(startedAt) + 5000).toISOString();
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= deadline) return fail();
          latest = at;
          return at;
        };
        let heldPolicy: CurrentProductPublicationPolicy | undefined,
          policyCalls = 0;
        const policySource =
          contentConfiguration === undefined
            ? scopeOptions.policySource
            : {
                context: scopeOptions.policySource.context,
                async withCurrentPolicy<R>(
                  actual: typeof tx,
                  request: Parameters<typeof scopeOptions.policySource.withCurrentPolicy>[1],
                  callback: (policy: CurrentProductPublicationPolicy) => Promise<R>,
                ): Promise<R> {
                  if (actual !== tx) return fail();
                  check();
                  const result = await scopeOptions.policySource.withCurrentPolicy(
                    actual,
                    request,
                    async (value) => {
                      if (++policyCalls !== 1) return fail();
                      const record = readClosedRecord(copyCategoryPersistenceValue(value), [
                        "content",
                        "currentPublicationReference",
                        "observedAt",
                        "validUntil",
                      ]);
                      heldPolicy = Object.freeze({
                        content: parsePublishingProductPublicationPolicy(record.content),
                        currentPublicationReference: parseCatalogReference(
                          record.currentPublicationReference,
                        ),
                        observedAt: parseCatalogInstant(record.observedAt),
                        validUntil: parseCatalogInstant(record.validUntil),
                      });
                      if (
                        heldPolicy.content.policyReference !== request.policyReference ||
                        heldPolicy.content.policyVersion !== request.policyVersion ||
                        heldPolicy.observedAt !== request.observedAt ||
                        heldPolicy.observedAt > check()
                      )
                        return fail();
                      deadline = [deadline, heldPolicy.validUntil].sort()[0] ?? fail();
                      check();
                      const result = await callback(heldPolicy);
                      check();
                      return result;
                    },
                  );
                  check();
                  return result;
                },
              };
        const scope = createCurrentProductUniqueScopeSourceV2({
            ...scopeOptions,
            policySource,
            clock: { now: check },
          }),
          source = createPostgresProductValidationCandidateSourceV2({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            authority: candidateAuthority,
            clock: { now: check },
            ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
            transactions: {
              async run<R>(callback: (actual: typeof tx) => Promise<R>) {
                check();
                const result = await callback(tx);
                check();
                return result;
              },
            },
          });
        let candidateCalls = 0,
          scopeCalls = 0,
          deliverCalls = 0,
          completed: { value: T } | undefined;
        const result = await source.withCurrentCandidate(c, async (candidate, actual) => {
          if (
            actual !== tx ||
            ++candidateCalls !== 1 ||
            candidate.completeContent !== "Present" ||
            candidate.profile !== "CatalogProductValidationCandidateV2" ||
            candidate.tenantReference !== tenant ||
            candidate.brandReference !== brand ||
            candidate.actorReference !== actor ||
            candidate.aggregate.productReference !== c.productReference ||
            candidate.aggregate.draft.versionReference !== c.versionReference ||
            candidate.aggregate.aggregateVersion !== c.expectedProductAggregateVersion ||
            candidate.contentDigest !== c.contentDigest ||
            candidate.configurationDigest !== c.configurationDigest ||
            candidate.originalIntentDigest !== hash(c) ||
            candidate.replacementIntentDigest !== c.replacementIntentDigest
          )
            return fail();
          deadline = [deadline, candidate.validUntil].sort()[0] ?? fail();
          check();
          const withScope = async (
            optionRulePrerequisite: "NoMechanicalContradiction" | "Unsatisfiable",
            optionRulesAssessment?: CurrentProductCandidateOptionRulesV2,
          ) =>
            scope.withCurrentAssessment(
              tx,
              { command: c, policyReference, policyVersion },
              async (assessment) => {
                if (
                  ++scopeCalls !== 1 ||
                  assessment.originalIntentDigest !== candidate.originalIntentDigest ||
                  assessment.replacementIntentDigest !== candidate.replacementIntentDigest ||
                  assessment.tenantReference !== candidate.tenantReference ||
                  assessment.brandReference !== candidate.brandReference ||
                  assessment.productReference !== candidate.aggregate.productReference ||
                  assessment.versionReference !== candidate.aggregate.draft.versionReference ||
                  assessment.aggregateVersion !== candidate.aggregate.aggregateVersion ||
                  assessment.contentDigest !== candidate.contentDigest ||
                  assessment.configurationDigest !== candidate.configurationDigest
                )
                  return fail();
                deadline = [deadline, assessment.validUntil].sort()[0] ?? fail();
                check();
                const deliver = async (
                  contentPolicyAssessment?: CatalogProductContentPolicyAssessmentV2,
                  variantMappingAssessment?: CurrentProductVariantMappingV2,
                ) => {
                  if (
                    ++deliverCalls !== 1 ||
                    (contentConfiguration !== undefined && contentPolicyAssessment === undefined)
                  )
                    return fail();
                  if (contentPolicyAssessment !== undefined) {
                    if (
                      contentPolicyAssessment.profile !==
                        "CatalogProductContentPolicyAssessmentV2" ||
                      contentPolicyAssessment.tenantReference !== c.tenantReference ||
                      contentPolicyAssessment.brandReference !== c.brandReference ||
                      contentPolicyAssessment.productReference !== c.productReference ||
                      contentPolicyAssessment.versionReference !== c.versionReference ||
                      contentPolicyAssessment.aggregateVersion !==
                        c.expectedProductAggregateVersion ||
                      contentPolicyAssessment.contentDigest !== c.contentDigest ||
                      contentPolicyAssessment.configurationDigest !== c.configurationDigest ||
                      contentPolicyAssessment.originalIntentDigest !==
                        candidate.originalIntentDigest ||
                      contentPolicyAssessment.replacementIntentDigest !==
                        candidate.replacementIntentDigest ||
                      String(contentPolicyAssessment.policyReference) !==
                        assessment.policyReference ||
                      contentPolicyAssessment.policyVersion !== assessment.policyVersion ||
                      contentPolicyAssessment.policyContentDigest !== assessment.policyContentDigest
                    )
                      return fail();
                    deadline = [deadline, contentPolicyAssessment.validUntil].sort()[0] ?? fail();
                  }
                  check();
                  const body = {
                      ...Object.fromEntries(
                        Object.entries(assessment).filter(([key]) => key !== "digest"),
                      ),
                      profile: "CurrentProductCandidateUniqueScopeV2" as const,
                      currentCandidate: "Bound" as const,
                      scopeAssessment: assessment,
                      scopeAssessmentDigest: assessment.digest,
                      candidateObservedAt: candidate.observedAt,
                      candidateValidUntil: candidate.validUntil,
                      validUntil: parseCatalogInstant(deadline),
                      completeContent: "Present" as const,
                      skuPrerequisite: candidate.skuPrerequisite,
                      variantMappingPrerequisite: candidate.variantMappingPrerequisite,
                      optionSelectionPrerequisite: candidate.optionSelectionPrerequisite,
                      optionRulePrerequisite,
                      ...(optionRulesAssessment === undefined ? {} : { optionRulesAssessment }),
                      ...(contentPolicyAssessment === undefined ? {} : { contentPolicyAssessment }),
                      ...(variantMappingAssessment === undefined
                        ? {}
                        : { variantMappingAssessment }),
                      internalCodeCheck: candidate.internalCodeCheck,
                    },
                    proof: CurrentProductCandidateUniqueScopeV2 = Object.freeze({
                      ...assessment,
                      ...body,
                      digest: hash(body),
                    });
                  const value = await work(proof);
                  check();
                  completed = Object.freeze({ value });
                  return completed;
                };
                const withVariant = async (content?: CatalogProductContentPolicyAssessmentV2) => {
                  if (variantHistoryAuthority === undefined) return deliver(content);
                  return createCurrentProductCandidateVariantMappingSourceV2({
                    authority: variantHistoryAuthority,
                    clock: { now: check },
                  }).withHeldCandidateAssessment(tx, c, candidate, async (variant) => {
                    if (
                      variant.originalIntentDigest !== hash(c) ||
                      variant.replacementIntentDigest !== c.replacementIntentDigest
                    )
                      return fail();
                    deadline = [deadline, variant.validUntil].sort()[0] ?? fail();
                    check();
                    return deliver(content, variant);
                  });
                };
                if (contentConfiguration === undefined) return withVariant();
                if (
                  policyCalls !== 1 ||
                  heldPolicy === undefined ||
                  heldPolicy.currentPublicationReference !==
                    assessment.policyPublicationReference ||
                  String(heldPolicy.content.policyReference) !== assessment.policyReference ||
                  heldPolicy.content.policyVersion !== assessment.policyVersion ||
                  publishingProductPublicationPolicyDigest(heldPolicy.content) !==
                    assessment.policyContentDigest ||
                  heldPolicy.observedAt !== assessment.observedAt
                )
                  return fail();
                return createCurrentProductHeldContentPolicySourceV2(contentConfiguration, {
                  now: check,
                }).withHeldAssessment(tx, c, candidate, heldPolicy, withVariant);
              },
            );
          if (candidate.aggregate.draft.optionBindings.length === 0)
            return withScope("NoMechanicalContradiction");
          if (optionAuthority === undefined) return fail();
          const optionSource = createCurrentProductCandidateOptionRuleSourceV2({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            candidateAuthority,
            optionAuthority,
            clock: { now: check },
            ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
          });
          let optionCalls = 0;
          const result = await optionSource.withHeldCandidateAssessment(
            tx,
            c,
            candidate,
            async (proof) => {
              if (
                ++optionCalls !== 1 ||
                proof.profile !== "CurrentProductCandidateOptionRulesV2" ||
                proof.tenantReference !== tenant ||
                proof.brandReference !== brand ||
                proof.productReference !== c.productReference ||
                proof.versionReference !== c.versionReference ||
                proof.aggregateVersion !== c.expectedProductAggregateVersion ||
                proof.contentDigest !== c.contentDigest ||
                proof.configurationDigest !== c.configurationDigest ||
                proof.originalIntentDigest !== hash(c) ||
                proof.replacementIntentDigest !== c.replacementIntentDigest ||
                proof.candidateObservedAt !== candidate.observedAt ||
                proof.candidateValidUntil !== candidate.validUntil ||
                proof.bindingCount !== candidate.aggregate.draft.optionBindings.length ||
                proof.bindings.length !== proof.bindingCount ||
                proof.bindings.some(
                  (binding) => !["Satisfiable", "Unsatisfiable"].includes(binding.rules.status),
                )
              )
                return fail();
              deadline = [deadline, proof.validUntil].sort()[0] ?? fail();
              check();
              return withScope(
                proof.bindings.some((binding) => binding.rules.status === "Unsatisfiable")
                  ? "Unsatisfiable"
                  : "NoMechanicalContradiction",
                proof,
              );
            },
          );
          if (optionCalls !== 1) return fail();
          check();
          return result;
        });
        if (
          candidateCalls !== 1 ||
          scopeCalls !== 1 ||
          deliverCalls !== 1 ||
          (contentConfiguration !== undefined && policyCalls !== 1) ||
          !completed ||
          result !== completed
        )
          return fail();
        check();
        return completed.value;
      } catch (error) {
        if (tx && typeof tx === "object") failed.add(tx);
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
