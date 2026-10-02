import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductOptionBinding,
  copyCategoryPersistenceValue,
  assessCatalogFullProductOptionBindingPrerequisites,
  evaluateCatalogFullProductOptionBindingRules,
  createPostgresFrozenFullOptionSetContentStore,
} from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
type ReaderOptions = Parameters<typeof createPostgresFrozenFullOptionSetContentStore>[0];
type Transaction = Parameters<ReaderOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type Observation = Awaited<
  ReturnType<ReturnType<typeof createPostgresFrozenFullOptionSetContentStore>["readPinned"]>
>;
type Evaluation = ReturnType<typeof assessCatalogFullProductOptionBindingPrerequisites>;
export interface FrozenFullOptionBindingRuleAssessment {
  readonly profile: "FrozenFullOptionBindingRuleAssessmentV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly bindingReference: string;
  readonly bindingDigest: string;
  readonly rootOptionSetReference: string;
  readonly rootVersionReference: string;
  readonly graphDigest: string;
  readonly sourceRecords: readonly {
    readonly optionSetReference: string;
    readonly versionReference: string;
    readonly recordDigest: string;
    readonly observedAt: string;
  }[];
  readonly rules: {
    readonly status: Evaluation["status"];
    readonly reason: string | null;
    readonly searchNodes: number;
  };
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publishValidation: "Incomplete";
  readonly referenceEligibility: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Exact immutable owning records in one caller transaction. Frozen history does
 * not establish current Published, applicability, approval or sale qualification. */
export function createFrozenFullOptionBindingRuleSource(
  options: Omit<ReaderOptions, "transactions"> & {
    readonly defaultQuantityAssessment?: "Prerequisites";
  },
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  const clock = options.clock,
    authority = options.authority;
  if (
    typeof clock?.now !== "function" ||
    typeof authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const evaluate =
    options.defaultQuantityAssessment === "Prerequisites"
      ? assessCatalogFullProductOptionBindingPrerequisites
      : evaluateCatalogFullProductOptionBindingRules;
  const now = () => parseCatalogInstant(clock.now());
  return Object.freeze({
    async withPinnedAssessment<T>(
      tx: Transaction,
      value: unknown,
      work: (assessment: FrozenFullOptionBindingRuleAssessment) => Promise<T>,
    ): Promise<T> {
      // Proposed Binding only. No client graph, currentness, lease or Ready flags.
      const binding = parseProductOptionBinding(copyCategoryPersistenceValue(value));
      try {
        const observedAt = now();
        let deadline = Date.parse(observedAt) + 30000,
          latest = observedAt;
        const check = () => {
          const at = now();
          if (at < latest || Date.parse(at) >= deadline) return fail();
        };
        const reader = createPostgresFrozenFullOptionSetContentStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now },
          authority,
          transactions: { run: (callback) => callback(tx) },
        });
        const observations = new Map<string, Observation>();
        const key = (set: string, version: string) => set + ":" + version;
        const pending = [
          {
            optionSetReference: binding.optionSetReference as string,
            versionReference: binding.optionSetVersionReference as string,
          },
        ];
        const accept = (observation: Observation, set: string, version: string) => {
          const s = observation.content.supportedContent,
            at = parseCatalogInstant(observation.observedAt),
            until = parseCatalogInstant(observation.validUntil);
          if (
            s.tenantReference !== tenant ||
            s.brandReference !== brand ||
            s.optionSetReference !== set ||
            s.versionReference !== version ||
            observation.eligibility !== "NotEvaluated" ||
            at < observedAt ||
            until <= at ||
            Date.parse(until) - Date.parse(at) > 30000
          )
            return fail();
          latest = at > latest ? at : latest;
          deadline = Math.min(deadline, Date.parse(until));
          check();
        };
        for (const pin of pending) {
          check();
          const id = key(pin.optionSetReference, pin.versionReference);
          if (observations.has(id)) continue;
          if (observations.size >= 32) return fail();
          const observation = await reader.readPinned({ ...pin, expectedRecordDigest: null });
          accept(observation, pin.optionSetReference, pin.versionReference);
          observations.set(id, observation);
          const content = observation.content.editorContent;
          for (const option of content.sourceAggregate.draft.options) {
            if (option.triggeredOptionSetReference === null) continue;
            const version = content.optionDetails.find(
              (d) => d.optionReference === option.optionReference,
            )?.triggeredOptionSetVersionReference;
            if (!version) return fail();
            const next = {
              optionSetReference: option.triggeredOptionSetReference as string,
              versionReference: version as string,
            };
            // Bound the queued unique records too, including disabled edges.
            if (
              !pending.some(
                (p) =>
                  key(p.optionSetReference, p.versionReference) ===
                  key(next.optionSetReference, next.versionReference),
              )
            ) {
              if (pending.length >= 32) return fail();
              pending.push(next);
            }
          }
        }
        const ordered = [...observations.values()].sort((a, b) =>
          key(
            a.content.supportedContent.optionSetReference,
            a.content.supportedContent.versionReference,
          ).localeCompare(
            key(
              b.content.supportedContent.optionSetReference,
              b.content.supportedContent.versionReference,
            ),
          ),
        );
        const evaluated = evaluate({
          binding,
          graph: {
            brandReference: brand,
            rootOptionSetReference: binding.optionSetReference,
            rootVersionReference: binding.optionSetVersionReference,
            contents: ordered.map((o) => o.content.editorContent),
          },
        });
        const body = {
          profile: "FrozenFullOptionBindingRuleAssessmentV1" as const,
          tenantReference: tenant as string,
          brandReference: brand as string,
          bindingReference: evaluated.bindingReference,
          bindingDigest: evaluated.bindingDigest,
          rootOptionSetReference: evaluated.rootOptionSetReference,
          rootVersionReference: evaluated.rootVersionReference,
          graphDigest: evaluated.graphDigest,
          sourceRecords: Object.freeze(
            ordered.map((o) =>
              Object.freeze({
                optionSetReference: o.content.supportedContent.optionSetReference as string,
                versionReference: o.content.supportedContent.versionReference as string,
                recordDigest: o.content.digest,
                observedAt: o.observedAt,
              }),
            ),
          ),
          rules: Object.freeze({
            status: evaluated.status,
            reason: "reason" in evaluated ? evaluated.reason : null,
            searchNodes: evaluated.searchNodes,
          }),
          observedAt,
          validUntil: new Date(deadline).toISOString(),
          publishValidation: "Incomplete" as const,
          referenceEligibility: "NotEvaluated" as const,
          eligibility: "NotEvaluated" as const,
        };
        const assessment: FrozenFullOptionBindingRuleAssessment = Object.freeze({
          ...body,
          digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
        });
        check();
        const result = await work(assessment);
        check();
        for (const original of ordered) {
          const s = original.content.supportedContent;
          const current = await reader.readPinned({
            optionSetReference: s.optionSetReference,
            versionReference: s.versionReference,
            expectedRecordDigest: original.content.digest,
          });
          accept(current, s.optionSetReference, s.versionReference);
          if (canonicalizeRfc8785(current.content) !== canonicalizeRfc8785(original.content))
            return fail();
          if (deadline < Date.parse(assessment.validUntil)) return fail();
          check();
        }
        check();
        return result;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
