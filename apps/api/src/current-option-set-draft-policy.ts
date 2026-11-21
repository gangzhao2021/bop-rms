import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogOptionSetContentPolicyBinding,
} from "@rms/catalog";
import { createCurrentOptionSetDraftGraphSource } from "./current-option-set-draft-graph.js";
import { createCurrentOptionSetContentPolicySource } from "./current-option-set-content-policy.js";

type GraphOptions = Parameters<typeof createCurrentOptionSetDraftGraphSource>[0];
type PolicyOptions = Parameters<typeof createCurrentOptionSetContentPolicySource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentOptionSetDraftGraphSource>["withCurrentGraph"]
>[0];
type Assessment = Parameters<
  ReturnType<typeof createCurrentOptionSetContentPolicySource>["withCurrentAssessment"]
>[2] extends (value: infer A) => unknown
  ? A
  : never;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Current singleton Draft root plus current owning policy, in the caller UoW.
 * This limited assessment cannot grant full seal, publication or sale admission. */
export function createCurrentOptionSetDraftPolicySource(options: {
  tenantReference: GraphOptions["tenantReference"];
  brandReference: GraphOptions["brandReference"];
  actorReference: GraphOptions["actorReference"];
  clock: GraphOptions["clock"];
  readAuthority: GraphOptions["authority"];
  policyAuthority: PolicyOptions["authority"];
}) {
  const graphSource = createCurrentOptionSetDraftGraphSource({
      ...options,
      authority: options.readAuthority,
    }),
    policySource = createCurrentOptionSetContentPolicySource({
      ...options,
      actorKind: "User",
      authority: options.policyAuthority,
    }),
    now = options.clock.now.bind(options.clock),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (
        value: Readonly<{
          profile: "CurrentOptionSetDraftPolicyAssessmentV1";
          assessment: Assessment;
          currentRootEvidence: Readonly<{
            sourceAuthority: "CurrentDraftRootOnly";
            observedAt: string;
            validUntil: string;
            optionSetReference: string;
            versionReference: string;
            aggregateVersion: number;
            sourceDigest: string;
            contentDigest: string;
            configurationDigest: string;
            graphDigest: string;
          }>;
          originalObservedAt: string;
          validUntil: string;
          digest: string;
          publishValidation: "Incomplete";
          eligibility: "NotEvaluated";
        }>,
      ) => Promise<T>,
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
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
            "graphRequest",
            "policyRequest",
            "originalIntentDigest",
            "activationAt",
          ]),
          r = readClosedRecord(input.graphRequest, [
            "optionSetReference",
            "versionReference",
            "expectedAggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "observedAt",
            "validUntil",
          ]),
          p = readClosedRecord(input.policyRequest, [
            "optionSetReference",
            "policyReference",
            "policyVersion",
            "observedAt",
          ]),
          originalObservedAt = parseCatalogInstant(r.observedAt),
          activationAt = parseCatalogInstant(input.activationAt),
          query = tx.query;
        let until = parseCatalogInstant(r.validUntil),
          latest = originalObservedAt,
          roots = 0,
          policies = 0,
          completed = false,
          answer: T | undefined;
        if (
          p.optionSetReference !== r.optionSetReference ||
          p.observedAt !== originalObservedAt ||
          activationAt < originalObservedAt ||
          typeof input.originalIntentDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(input.originalIntentDigest) ||
          until <= originalObservedAt ||
          Date.parse(until) - Date.parse(originalObservedAt) > 30000
        )
          return fail();
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
          latest = at;
          return at;
        };
        check();
        const result = await graphSource.withCurrentGraph(tx, r, async (root) => {
          if (
            ++roots !== 1 ||
            root.profile !== "CurrentOptionSetDraftGraphV1" ||
            root.sourceAuthority !== "CurrentDraftRootOnly" ||
            root.referenceEligibility !== "NotEvaluated" ||
            root.publishValidation !== "Incomplete" ||
            root.eligibility !== "NotEvaluated" ||
            root.originalObservedAt !== originalObservedAt ||
            root.observedAt < originalObservedAt ||
            root.observedAt > check()
          )
            return fail();
          const rootUntil = parseCatalogInstant(root.validUntil);
          until = rootUntil < until ? rootUntil : until;
          const binding = parseCatalogOptionSetContentPolicyBinding({
            tenantReference: graphSource.context.tenantReference,
            brandReference: graphSource.context.brandReference,
            optionSetReference: root.graph.rootOptionSetReference,
            versionReference: root.graph.rootVersionReference,
            expectedAggregateVersion: root.aggregateVersion,
            sourceDigest: root.sourceDigest,
            contentDigest: root.contentDigest,
            configurationDigest: root.configurationDigest,
            graphDigest: root.graphDigest,
            originalIntentDigest: input.originalIntentDigest,
            observedAt: originalObservedAt,
            validUntil: until,
            activationAt,
          });
          if (
            binding.optionSetReference !== r.optionSetReference ||
            binding.versionReference !== r.versionReference ||
            binding.expectedAggregateVersion !== r.expectedAggregateVersion ||
            binding.sourceDigest !== r.sourceDigest ||
            binding.contentDigest !== r.contentDigest ||
            binding.configurationDigest !== r.configurationDigest
          )
            return fail();
          check();
          const currentRootEvidence = Object.freeze({
            sourceAuthority: "CurrentDraftRootOnly" as const,
            observedAt: root.observedAt,
            validUntil: rootUntil,
            optionSetReference: binding.optionSetReference as string,
            versionReference: binding.versionReference as string,
            aggregateVersion: binding.expectedAggregateVersion,
            sourceDigest: root.sourceDigest,
            contentDigest: root.contentDigest,
            configurationDigest: root.configurationDigest,
            graphDigest: root.graphDigest,
          });
          const policyResult = await policySource.withCurrentAssessment(
            tx,
            { graph: root.graph, binding, policyRequest: p },
            async (assessment) => {
              if (
                ++policies !== 1 ||
                assessment.originalObservedAt !== originalObservedAt ||
                assessment.originalIntentDigest !== input.originalIntentDigest ||
                assessment.graphDigest !== root.graphDigest ||
                assessment.optionSetReference !== binding.optionSetReference ||
                assessment.versionReference !== binding.versionReference ||
                assessment.publishValidation !== "Incomplete" ||
                assessment.eligibility !== "NotEvaluated"
              )
                return fail();
              const assessedUntil = parseCatalogInstant(assessment.validUntil);
              until = assessedUntil < until ? assessedUntil : until;
              check();
              const evidence = {
                profile: "CurrentOptionSetDraftPolicyAssessmentV1" as const,
                assessment,
                currentRootEvidence,
                originalObservedAt,
                validUntil: until,
                publishValidation: "Incomplete" as const,
                eligibility: "NotEvaluated" as const,
              };
              const delivered = Object.freeze({
                ...evidence,
                digest: "sha256:" + sha256Hex(canonicalizeRfc8785(evidence)),
              });
              answer = await work(delivered);
              check();
              completed = true;
              return answer;
            },
          );
          if (policies !== 1 || !completed || !Object.is(policyResult, answer)) return fail();
          check();
          return policyResult;
        });
        if (roots !== 1 || policies !== 1 || !completed || !Object.is(result, answer))
          return fail();
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
