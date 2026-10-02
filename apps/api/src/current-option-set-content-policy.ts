import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  assessCatalogOptionSetContentPolicy,
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogOptionSetContentPolicyBinding,
  parseCatalogReference,
  type CatalogOptionSetContentPolicyAssessment,
} from "@rms/catalog";
import { createCurrentOptionSetPublicationPolicySource } from "./current-option-set-publication-policy.js";

type Options = Parameters<typeof createCurrentOptionSetPublicationPolicySource>[0];
type PolicySource = ReturnType<typeof createCurrentOptionSetPublicationPolicySource>;
type Assessment = CatalogOptionSetContentPolicyAssessment &
  Readonly<{
    originalObservedAt: string;
    currentPolicyPublicationReference: string;
    currentAssessmentDigest: string;
  }>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Current policy plus supplied candidate mechanics. The graph is not an owning
 * current producer; every unassessed seal prerequisite remains mandatory. */
export function createCurrentOptionSetContentPolicySource(options: Options) {
  const policySource = createCurrentOptionSetPublicationPolicySource(options),
    now = options.clock.now.bind(options.clock),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      value: unknown,
      work: (assessment: Assessment) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          typeof work !== "function" ||
          failed.has(tx) ||
          active.has(tx)
        )
          return fail();
        active.add(tx);
        entered = true;
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
            "graph",
            "binding",
            "policyRequest",
          ]),
          binding = parseCatalogOptionSetContentPolicyBinding(input.binding),
          request = readClosedRecord(input.policyRequest, [
            "optionSetReference",
            "policyReference",
            "policyVersion",
            "observedAt",
          ]),
          query = tx.query;
        if (
          binding.tenantReference !== policySource.context.tenantReference ||
          binding.brandReference !== policySource.context.brandReference ||
          request.optionSetReference !== binding.optionSetReference ||
          request.observedAt !== binding.observedAt
        )
          return fail();
        let latest = binding.observedAt,
          until = binding.validUntil,
          calls = 0,
          completed = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
          latest = at;
          return at;
        };
        check();
        const result = await policySource.withCurrentPolicy(tx, request, async (supplied) => {
          if (++calls !== 1) return fail();
          const source = readClosedRecord(copyCategoryPersistenceValue(supplied), [
              "profile",
              "content",
              "currentPublicationReference",
              "optionSetReference",
              "originalObservedAt",
              "observedAt",
              "validUntil",
              "publishValidation",
              "eligibility",
            ]),
            observedAt = parseCatalogInstant(source.observedAt),
            validUntil = parseCatalogInstant(source.validUntil),
            currentPolicyPublicationReference = parseCatalogReference(
              source.currentPublicationReference,
            );
          if (
            source.profile !== "CurrentOptionSetPublicationPolicyV1" ||
            source.optionSetReference !== binding.optionSetReference ||
            source.originalObservedAt !== binding.observedAt ||
            observedAt < binding.observedAt ||
            observedAt > check() ||
            validUntil <= observedAt ||
            Date.parse(validUntil) > Date.parse(binding.observedAt) + 30000 ||
            source.publishValidation !== "Incomplete" ||
            source.eligibility !== "NotEvaluated"
          )
            return fail();
          until = validUntil < until ? validUntil : until;
          check();
          const assessment = assessCatalogOptionSetContentPolicy(input.graph, source.content, {
            ...binding,
            observedAt,
            validUntil: until,
          });
          if (
            String(assessment.policyReference) !== request.policyReference ||
            assessment.policyVersion !== request.policyVersion
          )
            return fail();
          const provenance = {
            assessmentDigest: assessment.digest,
            originalObservedAt: binding.observedAt,
            currentPolicyPublicationReference,
          };
          const delivered = Object.freeze({
            ...assessment,
            originalObservedAt: binding.observedAt,
            currentPolicyPublicationReference,
            currentAssessmentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(provenance)),
          });
          check();
          answer = await work(delivered);
          check();
          completed = true;
          return answer;
        });
        if (calls !== 1 || !completed || !Object.is(result, answer)) return fail();
        check();
        return result;
      } catch {
        if (tx && typeof tx === "object") failed.add(tx);
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
