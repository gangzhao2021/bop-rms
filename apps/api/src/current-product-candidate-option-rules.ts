import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSource,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductPublicationCommand,
  type CatalogCurrentProductValidationCandidate,
} from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createFrozenFullOptionBindingRuleSource,
  type FrozenFullOptionBindingRuleAssessment,
} from "./frozen-full-option-binding-rule-source.js";
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type OptionOptions = Parameters<typeof createFrozenFullOptionBindingRuleSource>[0];
type Transaction = Parameters<CandidateOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export interface CurrentProductCandidateOptionRules {
  readonly profile: "CurrentProductCandidateOptionRulesV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly originalIntentDigest: string;
  readonly candidateObservedAt: string;
  readonly bindingCount: number;
  readonly bindings: readonly {
    readonly bindingReference: string;
    readonly bindingDigest: string;
    readonly rootOptionSetReference: string;
    readonly rootVersionReference: string;
    readonly graphDigest: string;
    readonly assessmentDigest: string;
    readonly rules: FrozenFullOptionBindingRuleAssessment["rules"];
  }[];
  readonly validUntil: string;
  readonly publishValidation: "Incomplete";
  readonly referenceEligibility: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual current candidate supplies Bindings; exact owning history supplies rule
 * bodies. Neither a subset nor empty bindings establish publication eligibility. */
export function createCurrentProductCandidateOptionRuleSource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly candidateAuthority: CandidateOptions["authority"];
  readonly optionAuthority: OptionOptions["authority"];
  readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  const clock = options.clock,
    candidateAuthority = options.candidateAuthority,
    optionAuthority = options.optionAuthority,
    categoryAssignments = options.categoryAssignments;
  if (
    typeof clock?.now !== "function" ||
    typeof candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof optionAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const now = () => parseCatalogInstant(clock.now());
  const withHeldCandidateAssessment = async <T>(
    tx: Transaction,
    commandValue: unknown,
    candidate: CatalogCurrentProductValidationCandidate,
    work: (assessment: CurrentProductCandidateOptionRules) => Promise<T>,
  ): Promise<T> => {
    try {
      const command = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue));
      if (
        command.action !== "Validate" ||
        command.actorKind !== "User" ||
        command.tenantReference !== tenantReference ||
        command.brandReference !== brandReference ||
        command.actorReference !== actorReference ||
        candidate.completeContent !== "Present" ||
        candidate.tenantReference !== tenantReference ||
        candidate.brandReference !== brandReference ||
        candidate.actorReference !== actorReference ||
        candidate.aggregate.productReference !== command.productReference ||
        candidate.aggregate.draft.versionReference !== command.versionReference ||
        candidate.aggregate.aggregateVersion !== command.expectedProductAggregateVersion ||
        candidate.contentDigest !== command.contentDigest ||
        candidate.configurationDigest !== command.configurationDigest ||
        candidate.originalIntentDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(command))
      )
        return fail();
      const optionSource = createFrozenFullOptionBindingRuleSource({
        tenantReference,
        brandReference,
        actorReference,
        clock: { now },
        authority: optionAuthority,
        defaultQuantityAssessment: "Prerequisites",
      });
      let workCalls = 0,
        finished = false,
        completed: T | undefined,
        deadline = 0,
        latest = "";
      const observations: FrozenFullOptionBindingRuleAssessment[] = [];
      const calls: number[] = [];
      const check = () => {
        const at = now();
        if (!latest || at < latest || Date.parse(at) >= deadline) return fail();
      };
      const bindings = [...candidate.aggregate.draft.optionBindings].sort((a, b) =>
        a.bindingReference.localeCompare(b.bindingReference),
      );
      if (bindings.length > 32) return fail();
      const optionRules = candidate.aggregate.draft.editorContent?.optionRules;
      if (
        !optionRules ||
        bindings.some(
          (binding) =>
            optionRules.find((rule) => rule.bindingReference === binding.bindingReference)
              ?.versionResolution !== "Pinned",
        )
      )
        return fail();
      latest = candidate.observedAt;
      deadline = Date.parse(candidate.validUntil);
      check();
      const acquire = async (index: number): Promise<T> => {
        check();
        const binding = bindings[index];
        if (binding) {
          return optionSource.withPinnedAssessment(tx, binding, async (source) => {
            calls[index] = (calls[index] ?? 0) + 1;
            if (
              calls[index] !== 1 ||
              source.profile !== "FrozenFullOptionBindingRuleAssessmentV1" ||
              source.tenantReference !== tenantReference ||
              source.brandReference !== brandReference ||
              source.bindingReference !== binding.bindingReference ||
              source.bindingDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(binding)) ||
              source.rootOptionSetReference !== binding.optionSetReference ||
              source.rootVersionReference !== binding.optionSetVersionReference ||
              source.publishValidation !== "Incomplete" ||
              source.referenceEligibility !== "NotEvaluated" ||
              source.eligibility !== "NotEvaluated"
            )
              return fail();
            const at = parseCatalogInstant(source.observedAt),
              until = parseCatalogInstant(source.validUntil);
            if (until <= at || Date.parse(until) - Date.parse(at) > 30000) return fail();
            latest = at > latest ? at : latest;
            deadline = Math.min(deadline, Date.parse(until));
            check();
            observations.push(source);
            const answer = await acquire(index + 1);
            check();
            return answer;
          });
        }
        if (index !== bindings.length || observations.length !== bindings.length) return fail();
        const body = {
          profile: "CurrentProductCandidateOptionRulesV1" as const,
          tenantReference: tenantReference as string,
          brandReference: brandReference as string,
          productReference: candidate.aggregate.productReference as string,
          versionReference: candidate.aggregate.draft.versionReference as string,
          aggregateVersion: candidate.aggregate.aggregateVersion,
          contentDigest: candidate.contentDigest,
          configurationDigest: candidate.configurationDigest,
          originalIntentDigest: candidate.originalIntentDigest,
          candidateObservedAt: candidate.observedAt,
          bindingCount: bindings.length,
          bindings: Object.freeze(
            observations.map((s) =>
              Object.freeze({
                bindingReference: s.bindingReference,
                bindingDigest: s.bindingDigest,
                rootOptionSetReference: s.rootOptionSetReference,
                rootVersionReference: s.rootVersionReference,
                graphDigest: s.graphDigest,
                assessmentDigest: s.digest,
                rules: Object.freeze({ ...s.rules }),
              }),
            ),
          ),
          validUntil: new Date(deadline).toISOString(),
          publishValidation: "Incomplete" as const,
          referenceEligibility: "NotEvaluated" as const,
          eligibility: "NotEvaluated" as const,
        };
        const assessment: CurrentProductCandidateOptionRules = Object.freeze({
          ...body,
          digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
        });
        check();
        if (++workCalls !== 1) return fail();
        const answer = await work(assessment);
        check();
        finished = true;
        completed = answer;
        return answer;
      };
      const answer = await acquire(0);
      if (
        calls.length !== bindings.length ||
        calls.some((n) => n !== 1) ||
        !finished ||
        !Object.is(answer, completed)
      )
        return fail();
      check();
      return answer;
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  };
  return Object.freeze({
    // Internal composition stage: caller must retain the actual candidate owner's
    // barrier for this same transaction. This method never proves currentness.
    withHeldCandidateAssessment,
    async withCurrentAssessment<T>(
      tx: Transaction,
      value: unknown,
      work: (assessment: CurrentProductCandidateOptionRules) => Promise<T>,
    ): Promise<T> {
      try {
        const command = parseProductPublicationCommand(copyCategoryPersistenceValue(value));
        if (
          command.action !== "Validate" ||
          command.actorKind !== "User" ||
          command.tenantReference !== tenantReference ||
          command.brandReference !== brandReference ||
          command.actorReference !== actorReference
        )
          return fail();
        const source = createPostgresProductValidationCandidateSource({
          tenantReference,
          brandReference,
          actorReference,
          clock: { now },
          authority: candidateAuthority,
          ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
          transactions: { run: (callback) => callback(tx) },
        });
        let calls = 0,
          completed: { value: T } | undefined,
          lease: CurrentProductCandidateOptionRules | undefined;
        const result = await source.withCurrentCandidate(command, async (candidate, actualTx) => {
          if (++calls !== 1 || actualTx !== tx) return fail();
          return withHeldCandidateAssessment(tx, command, candidate, async (assessment) => {
            lease = assessment;
            completed = { value: await work(assessment) };
            return completed;
          });
        });
        const at = now();
        if (
          calls !== 1 ||
          !completed ||
          result !== completed ||
          !lease ||
          at < lease.candidateObservedAt ||
          at >= lease.validUntil
        )
          return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
