import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSource,
  parseCatalogInstant,
  parseProductPublicationCommand,
  type CatalogProductUniqueScopeAssessment,
  type CatalogCurrentProductValidationCandidate,
  type CatalogProductContentPolicyAssessment,
} from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createCurrentProductCandidateOptionRuleSource } from "./current-product-candidate-option-rules.js";
import { createCurrentProductUniqueScopeSource } from "./current-product-unique-scope.js";
import {
  createCurrentProductHeldContentPolicySource,
  type HeldProductContentPolicyConfiguration,
} from "./current-product-held-content-policy.js";
import type { CurrentProductPublicationPolicy } from "./current-product-publication-policy.js";
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type ScopeOptions = Parameters<typeof createCurrentProductUniqueScopeSource>[0];
type OptionOptions = Parameters<typeof createCurrentProductCandidateOptionRuleSource>[0];
type ScopeSource = ReturnType<typeof createCurrentProductUniqueScopeSource>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export type CurrentProductCandidateUniqueScope = Omit<
  CatalogProductUniqueScopeAssessment,
  "profile"
> & {
  readonly profile: "CurrentProductCandidateUniqueScopeV1";
  readonly scopeAssessmentDigest: string;
  readonly contentDigest: CatalogCurrentProductValidationCandidate["contentDigest"];
  readonly configurationDigest: CatalogCurrentProductValidationCandidate["configurationDigest"];
  readonly candidateObservedAt: CatalogCurrentProductValidationCandidate["observedAt"];
  readonly candidateValidUntil: CatalogCurrentProductValidationCandidate["validUntil"];
  readonly completeContent: CatalogCurrentProductValidationCandidate["completeContent"];
  readonly skuPrerequisite: CatalogCurrentProductValidationCandidate["skuPrerequisite"];
  readonly variantMappingPrerequisite: CatalogCurrentProductValidationCandidate["variantMappingPrerequisite"];
  readonly optionSelectionPrerequisite: CatalogCurrentProductValidationCandidate["optionSelectionPrerequisite"];
  readonly internalCodeCheck: CatalogCurrentProductValidationCandidate["internalCodeCheck"];
  readonly optionRulePrerequisite: "Unsatisfiable" | "NoMechanicalContradiction";
  readonly currentCandidate: "Bound";
  readonly contentPolicyAssessment?: CatalogProductContentPolicyAssessment;
};
function observation(
  candidate: CatalogCurrentProductValidationCandidate,
  scope: CatalogProductUniqueScopeAssessment,
  optionRulePrerequisite: CurrentProductCandidateUniqueScope["optionRulePrerequisite"],
  optionValidUntil: string,
  contentPolicyAssessment?: CatalogProductContentPolicyAssessment,
): CurrentProductCandidateUniqueScope {
  const { digest: scopeAssessmentDigest, ...scopeFields } = scope;
  const result = {
    ...scopeFields,
    profile: "CurrentProductCandidateUniqueScopeV1" as const,
    scopeAssessmentDigest,
    contentDigest: candidate.contentDigest,
    configurationDigest: candidate.configurationDigest,
    candidateObservedAt: candidate.observedAt,
    candidateValidUntil: candidate.validUntil,
    completeContent: candidate.completeContent,
    skuPrerequisite: candidate.skuPrerequisite,
    internalCodeCheck: candidate.internalCodeCheck,
    variantMappingPrerequisite: candidate.variantMappingPrerequisite,
    optionSelectionPrerequisite: candidate.optionSelectionPrerequisite,
    optionRulePrerequisite,
    currentCandidate: "Bound" as const,
    ...(contentPolicyAssessment === undefined ? {} : { contentPolicyAssessment }),
    validUntil:
      [
        candidate.validUntil,
        scope.validUntil,
        optionValidUntil,
        ...(contentPolicyAssessment === undefined ? [] : [contentPolicyAssessment.validUntil]),
      ].sort()[0] ?? fail(),
  };
  return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
}
/** Actual public owners in one transaction. No supplied Draft/body/source rows,
 * twelve-check receipt, or reconstructed historical result substitutes for them. */
export function createCurrentProductCandidateUniqueScopeSource(
  options: ScopeOptions & {
    readonly candidateAuthority: CandidateOptions["authority"];
    readonly optionAuthority?: OptionOptions["optionAuthority"];
    readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
    readonly contentPolicy?: HeldProductContentPolicyConfiguration;
  },
) {
  if (typeof options.candidateAuthority?.holdUntilTransactionCompletes !== "function")
    return fail();
  const scopeSource = createCurrentProductUniqueScopeSource(options),
    now = options.clock.now.bind(options.clock);
  const contentSource =
    options.contentPolicy === undefined
      ? undefined
      : createCurrentProductHeldContentPolicySource(options.contentPolicy, { now });
  const readPolicy =
    contentSource === undefined
      ? undefined
      : options.policySource.withCurrentPolicy.bind(options.policySource);
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<ScopeSource["withCurrentAssessment"]>[0],
      value: unknown,
      work: (assessment: CurrentProductCandidateUniqueScope) => Promise<T>,
    ): Promise<T> {
      try {
        const copied = copyCategoryPersistenceValue(value);
        if (
          !copied ||
          typeof copied !== "object" ||
          Array.isArray(copied) ||
          Object.keys(copied).length !== 3 ||
          ["command", "policyReference", "policyVersion"].some((k) => !Object.hasOwn(copied, k))
        )
          return fail();
        const input = copied as Record<string, unknown>,
          c = parseProductPublicationCommand(input.command);
        let heldPolicy: CurrentProductPublicationPolicy | undefined,
          policyCalls = 0,
          policyCallbacks = 0;
        const selectedScopeSource =
          contentSource === undefined
            ? scopeSource
            : createCurrentProductUniqueScopeSource({
                ...options,
                policySource: {
                  ...options.policySource,
                  async withCurrentPolicy(actual, request, callback) {
                    if (actual !== tx || ++policyCalls !== 1 || !readPolicy) return fail();
                    return readPolicy(actual, request, async (policy) => {
                      if (++policyCallbacks !== 1 || heldPolicy) return fail();
                      heldPolicy = Object.freeze(
                        copyCategoryPersistenceValue(policy),
                      ) as CurrentProductPublicationPolicy;
                      return callback(heldPolicy);
                    });
                  },
                },
              });
        const source = createPostgresProductValidationCandidateSource({
          tenantReference: options.tenantReference,
          brandReference: options.brandReference,
          actorReference: options.actorReference,
          clock: { now },
          authority: options.candidateAuthority,
          ...(options.categoryAssignments === undefined
            ? {}
            : { categoryAssignments: options.categoryAssignments }),
          transactions: { run: (work) => work(tx) },
        });
        let workCalls = 0,
          finished = false,
          completed: T | undefined,
          finalLease: CurrentProductCandidateUniqueScope | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (
            !finalLease ||
            at < finalLease.candidateObservedAt ||
            at < finalLease.observedAt ||
            at >= finalLease.validUntil
          )
            return fail();
        };
        const result = await source.withCurrentCandidate(c, async (candidate, actualTx) => {
          if (actualTx !== tx) return fail();
          const withScope = async (
            optionStatus: CurrentProductCandidateUniqueScope["optionRulePrerequisite"],
            optionUntil: string,
          ) =>
            selectedScopeSource.withCurrentAssessment(tx, input, async (scope) => {
              if (
                ++workCalls !== 1 ||
                scope.originalIntentDigest !== candidate.originalIntentDigest ||
                scope.tenantReference !== candidate.tenantReference ||
                scope.brandReference !== candidate.brandReference ||
                scope.productReference !== candidate.aggregate.productReference ||
                scope.versionReference !== candidate.aggregate.draft.versionReference ||
                scope.aggregateVersion !== candidate.aggregate.aggregateVersion
              )
                return fail();
              const deliver = async (assessment?: CatalogProductContentPolicyAssessment) => {
                finalLease = observation(candidate, scope, optionStatus, optionUntil, assessment);
                check();
                const result = await work(finalLease);
                check();
                finished = true;
                completed = result;
                return result;
              };
              if (!contentSource) return deliver();
              if (
                !heldPolicy ||
                policyCalls !== 1 ||
                heldPolicy.currentPublicationReference !== scope.policyPublicationReference ||
                heldPolicy.content.policyReference !== scope.policyReference ||
                heldPolicy.content.policyVersion !== scope.policyVersion
              )
                return fail();
              return contentSource.withHeldAssessment(tx, c, candidate, heldPolicy, deliver);
            });
          if (candidate.completeContent !== "Present") return fail();
          if (candidate.aggregate.draft.optionBindings.length === 0) {
            return withScope("NoMechanicalContradiction", candidate.validUntil);
          }
          if (!options.optionAuthority) return fail();
          const optionSource = createCurrentProductCandidateOptionRuleSource({
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            clock: { now },
            candidateAuthority: options.candidateAuthority,
            optionAuthority: options.optionAuthority,
          });
          return optionSource.withHeldCandidateAssessment(tx, c, candidate, async (assessment) => {
            const statuses = assessment.bindings.map((b) => b.rules.status);
            if (statuses.some((status) => status !== "Satisfiable" && status !== "Unsatisfiable"))
              return fail();
            return withScope(
              statuses.includes("Unsatisfiable") ? "Unsatisfiable" : "NoMechanicalContradiction",
              assessment.validUntil,
            );
          });
        });
        if (
          workCalls !== 1 ||
          !finished ||
          !Object.is(result, completed) ||
          (contentSource !== undefined && (policyCalls !== 1 || policyCallbacks !== 1))
        )
          return fail();
        check();
        return result;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
