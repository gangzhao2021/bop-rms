import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  bindCatalogProductValidationCandidateV2,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSourceV2,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommandV2,
  type ProductPublicationCommandV2,
} from "@rms/catalog";
import {
  createFrozenFullOptionBindingRuleSource,
  type FrozenFullOptionBindingRuleAssessment,
} from "./frozen-full-option-binding-rule-source.js";

type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSourceV2>[0];
type OptionOptions = Parameters<typeof createFrozenFullOptionBindingRuleSource>[0];
type OptionHold = OptionOptions["authority"]["holdUntilTransactionCompletes"];
type Transaction = Parameters<OptionHold>[0];
export interface ProductCandidateOptionRuleAuthorityV2 {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: Parameters<OptionHold>[1] & {
      readonly command: ProductPublicationCommandV2;
      readonly originalIntentDigest: string;
      readonly replacementIntentDigest: string;
    },
  ): ReturnType<OptionHold>;
}
export interface CurrentProductCandidateOptionRulesV2 {
  readonly profile: "CurrentProductCandidateOptionRulesV2";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly candidateObservedAt: string;
  readonly candidateValidUntil: string;
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
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}

/** Actual owning candidate and exact pinned Frozen Option graphs in one caller
 * transaction. Mechanical prerequisites do not establish current publication,
 * reference eligibility, pricing or complete publication validation. */
export function createCurrentProductCandidateOptionRuleSourceV2(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly candidateAuthority: CandidateOptions["authority"];
  readonly optionAuthority: ProductCandidateOptionRuleAuthorityV2;
  readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.optionAuthority?.holdUntilTransactionCompletes !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    candidateAuthority = Object.freeze({
      holdUntilTransactionCompletes: options.candidateAuthority.holdUntilTransactionCompletes.bind(
        options.candidateAuthority,
      ),
    }),
    holdOption = options.optionAuthority.holdUntilTransactionCompletes.bind(
      options.optionAuthority,
    ),
    categoryAssignments =
      options.categoryAssignments === undefined
        ? undefined
        : Object.freeze({
            holdUntilTransactionCompletes:
              options.categoryAssignments.holdUntilTransactionCompletes.bind(
                options.categoryAssignments,
              ),
          }),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();

  async function run<T>(
    tx: Transaction,
    commandValue: unknown,
    mode: "Current" | "Held",
    candidateValue: unknown,
    work: (assessment: CurrentProductCandidateOptionRulesV2) => Promise<T>,
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
      const command = parseProductPublicationCommandV2(commandValue);
      if (
        command.action !== "Validate" ||
        command.actorKind !== "User" ||
        command.tenantReference !== tenant ||
        command.brandReference !== brand ||
        command.actorReference !== actor
      )
        return fail();
      const query = tx.query,
        startedAt = parseCatalogInstant(now());
      let latest = startedAt,
        deadline = new Date(Date.parse(startedAt) + 30000).toISOString();
      const check = () => {
        const at = parseCatalogInstant(now());
        if (failed.has(tx) || tx.query !== query || at < latest || at >= deadline) return fail();
        latest = at;
        return at;
      };
      interface Completion {
        readonly value: T;
      }
      let completed: Completion | undefined,
        candidateCalls = 0;
      const assessHeld = async (value: unknown): Promise<Completion> => {
        if (++candidateCalls !== 1) return fail();
        const copied = copyCategoryPersistenceValue(value);
        if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
        const raw = copied as Record<string, unknown>,
          code = record(raw.internalCodeCheck, ["code", "outcome"]);
        if (code.code !== "InternalCode" || !["Pass", "HardError"].includes(code.outcome as string))
          return fail();
        const candidate = bindCatalogProductValidationCandidateV2(
          command,
          raw.aggregate,
          raw.observedAt,
        );
        // Rebinding validates every detached candidate field, including the
        // original lease. It is not a substitute for the caller's current hold.
        if (
          candidate.completeContent !== "Present" ||
          !equal(raw, { ...candidate, internalCodeCheck: code })
        )
          return fail();
        const at = check();
        if (at < candidate.observedAt) return fail();
        deadline = [deadline, candidate.validUntil].sort()[0] ?? fail();
        check();
        const bindings = [...candidate.aggregate.draft.optionBindings].sort((a, b) =>
            a.bindingReference.localeCompare(b.bindingReference),
          ),
          rules = candidate.aggregate.draft.editorContent?.optionRules;
        if (
          bindings.length > 32 ||
          !rules ||
          bindings.some(
            (binding) =>
              rules.find((rule) => rule.bindingReference === binding.bindingReference)
                ?.versionResolution !== "Pinned",
          )
        )
          return fail();
        const source = createFrozenFullOptionBindingRuleSource({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          defaultQuantityAssessment: "Prerequisites",
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              check();
              if (
                actual !== tx ||
                input.tenantReference !== tenant ||
                input.brandReference !== brand ||
                input.actorReference !== actor ||
                input.actorKind !== "User"
              )
                return fail();
              const result = await holdOption(
                actual,
                Object.freeze({
                  ...input,
                  command,
                  originalIntentDigest: candidate.originalIntentDigest,
                  replacementIntentDigest: candidate.replacementIntentDigest,
                }),
              );
              check();
              return result;
            },
          },
        });
        const observations: FrozenFullOptionBindingRuleAssessment[] = [],
          calls: number[] = [];
        let workCalls = 0;
        const acquire = async (index: number): Promise<Completion> => {
          check();
          const binding = bindings[index];
          if (binding) {
            const result = await source.withPinnedAssessment(tx, binding, async (observation) => {
              calls[index] = (calls[index] ?? 0) + 1;
              if (calls[index] !== 1) return fail();
              const s = copyCategoryPersistenceValue(
                observation,
              ) as FrozenFullOptionBindingRuleAssessment;
              record(s, [
                "profile",
                "tenantReference",
                "brandReference",
                "bindingReference",
                "bindingDigest",
                "rootOptionSetReference",
                "rootVersionReference",
                "graphDigest",
                "sourceRecords",
                "rules",
                "observedAt",
                "validUntil",
                "publishValidation",
                "referenceEligibility",
                "eligibility",
                "digest",
              ]);
              record(s.rules, ["status", "reason", "searchNodes"]);
              if (
                !s ||
                s.profile !== "FrozenFullOptionBindingRuleAssessmentV1" ||
                s.tenantReference !== tenant ||
                s.brandReference !== brand ||
                s.bindingReference !== binding.bindingReference ||
                s.bindingDigest !== hash(binding) ||
                s.rootOptionSetReference !== binding.optionSetReference ||
                s.rootVersionReference !== binding.optionSetVersionReference ||
                s.publishValidation !== "Incomplete" ||
                s.referenceEligibility !== "NotEvaluated" ||
                s.eligibility !== "NotEvaluated" ||
                s.digest !==
                  hash(Object.fromEntries(Object.entries(s).filter(([key]) => key !== "digest")))
              )
                return fail();
              const observedAt = parseCatalogInstant(s.observedAt),
                until = parseCatalogInstant(s.validUntil),
                current = check();
              if (
                observedAt < candidate.observedAt ||
                observedAt > current ||
                until <= observedAt ||
                Date.parse(until) - Date.parse(observedAt) > 30000 ||
                !/^sha256:[0-9a-f]{64}$/.test(s.graphDigest) ||
                !["Satisfiable", "Unsatisfiable", "Indeterminate"].includes(s.rules.status) ||
                !Number.isSafeInteger(s.rules.searchNodes) ||
                s.rules.searchNodes < 0 ||
                s.rules.searchNodes > 65536 ||
                (s.rules.reason !== null &&
                  (typeof s.rules.reason !== "string" || s.rules.reason.length > 256)) ||
                !Array.isArray(s.sourceRecords) ||
                s.sourceRecords.length < 1 ||
                s.sourceRecords.length > 32
              )
                return fail();
              const records = new Set<string>();
              for (const item of s.sourceRecords) {
                record(item, [
                  "optionSetReference",
                  "versionReference",
                  "recordDigest",
                  "observedAt",
                ]);
                const key =
                    parseCatalogReference(item.optionSetReference) +
                    ":" +
                    parseCatalogReference(item.versionReference),
                  recordAt = parseCatalogInstant(item.observedAt);
                if (
                  records.has(key) ||
                  !/^sha256:[0-9a-f]{64}$/.test(item.recordDigest) ||
                  recordAt < observedAt ||
                  recordAt > current
                )
                  return fail();
                records.add(key);
              }
              if (
                !records.has(binding.optionSetReference + ":" + binding.optionSetVersionReference)
              )
                return fail();
              deadline = [deadline, until].sort()[0] ?? fail();
              check();
              observations.push(s);
              const answer = await acquire(index + 1);
              check();
              return answer;
            });
            if (!completed || result !== completed) return fail();
            check();
            return result;
          }
          if (
            index !== bindings.length ||
            observations.length !== bindings.length ||
            ++workCalls !== 1
          )
            return fail();
          const body = {
            profile: "CurrentProductCandidateOptionRulesV2" as const,
            tenantReference: tenant,
            brandReference: brand,
            productReference: candidate.aggregate.productReference,
            versionReference: candidate.aggregate.draft.versionReference,
            aggregateVersion: candidate.aggregate.aggregateVersion,
            contentDigest: candidate.contentDigest,
            configurationDigest: candidate.configurationDigest,
            originalIntentDigest: candidate.originalIntentDigest,
            replacementIntentDigest: candidate.replacementIntentDigest,
            candidateObservedAt: candidate.observedAt,
            candidateValidUntil: candidate.validUntil,
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
            validUntil: deadline,
            publishValidation: "Incomplete" as const,
            referenceEligibility: "NotEvaluated" as const,
            eligibility: "NotEvaluated" as const,
          };
          const assessment: CurrentProductCandidateOptionRulesV2 = Object.freeze({
            ...body,
            digest: hash(body),
          });
          check();
          const answer = await work(assessment);
          check();
          completed = Object.freeze({ value: answer });
          return completed;
        };
        const result = await acquire(0);
        if (
          calls.length !== bindings.length ||
          calls.some((n) => n !== 1) ||
          workCalls !== 1 ||
          !completed ||
          result !== completed
        )
          return fail();
        check();
        return result;
      };
      const candidateSource =
        mode === "Current"
          ? createPostgresProductValidationCandidateSourceV2({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now: check },
              authority: candidateAuthority,
              ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
              transactions: {
                async run<R>(callback: (actual: Transaction) => Promise<R>) {
                  check();
                  const result = await callback(tx);
                  check();
                  return result;
                },
              },
            })
          : undefined;
      const result =
        candidateSource === undefined
          ? await assessHeld(candidateValue)
          : await candidateSource.withCurrentCandidate(command, async (candidate, actual) => {
              if (actual !== tx) return fail();
              return assessHeld(candidate);
            });
      if (candidateCalls !== 1 || !completed || result !== completed) return fail();
      check();
      return completed.value;
    } catch (error) {
      if (tx && typeof tx === "object") failed.add(tx);
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    } finally {
      if (entered) active.delete(tx);
    }
  }
  return Object.freeze({
    withCurrentAssessment<T>(
      tx: Transaction,
      command: unknown,
      work: (assessment: CurrentProductCandidateOptionRulesV2) => Promise<T>,
    ): Promise<T> {
      return run(tx, command, "Current", undefined, work);
    },
    /** Internal composition only: caller must retain the actual owning candidate
     * callback/barrier on this same transaction through completion. */
    withHeldCandidateAssessment<T>(
      tx: Transaction,
      command: unknown,
      candidate: unknown,
      work: (assessment: CurrentProductCandidateOptionRulesV2) => Promise<T>,
    ): Promise<T> {
      return run(tx, command, "Held", candidate, work);
    },
  });
}
