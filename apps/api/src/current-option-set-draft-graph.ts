import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresCurrentFullOptionSetDraftStore,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  parseCatalogOptionSetEditorContent,
  parseCatalogReference,
} from "@rms/catalog";

type ReadOptions = Parameters<typeof createPostgresCurrentFullOptionSetDraftStore>[0];
type Tx = Parameters<ReadOptions["authority"]["holdUntilTransactionCompletes"]>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Actual held current Draft root only. No CurrentPublished child producer is
 * installed here: any trigger edge refuses rather than supplying a partial graph. */
export function createCurrentOptionSetDraftGraphSource(options: Omit<ReadOptions, "transactions">) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  return Object.freeze({
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User" as const,
    }),
    async withCurrentGraph<T>(
      tx: Tx,
      value: unknown,
      work: (
        source: Readonly<{
          profile: "CurrentOptionSetDraftGraphV1";
          graph: Readonly<{
            brandReference: string;
            rootOptionSetReference: string;
            rootVersionReference: string;
            contents: readonly ReturnType<typeof parseCatalogOptionSetEditorContent>["content"][];
          }>;
          aggregateVersion: number;
          sourceDigest: string;
          contentDigest: string;
          configurationDigest: string;
          graphDigest: string;
          originalObservedAt: string;
          observedAt: string;
          validUntil: string;
          sourceAuthority: "CurrentDraftRootOnly";
          referenceEligibility: "NotEvaluated";
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
          failed.has(tx) ||
          active.has(tx)
        )
          return fail();
        active.add(tx);
        entered = true;
        const r = readClosedRecord(copyCategoryPersistenceValue(value), [
            "optionSetReference",
            "versionReference",
            "expectedAggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "observedAt",
            "validUntil",
          ]),
          set = parseCatalogReference(r.optionSetReference),
          version = parseCatalogReference(r.versionReference),
          observedAt = parseCatalogInstant(r.observedAt),
          validUntil = parseCatalogInstant(r.validUntil),
          expected = r.expectedAggregateVersion,
          query = tx.query,
          sql = Object.freeze({ query: query.bind(tx) });
        if (
          !Number.isSafeInteger(expected) ||
          (expected as number) < 1 ||
          (expected as number) > 2147483647 ||
          validUntil <= observedAt ||
          Date.parse(validUntil) - Date.parse(observedAt) > 30000 ||
          [r.sourceDigest, r.contentDigest, r.configurationDigest].some(
            (h) => typeof h !== "string" || !/^sha256:[0-9a-f]{64}$/.test(h),
          )
        )
          return fail();
        let latest = observedAt,
          deadline = Date.parse(validUntil);
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || Date.parse(at) >= deadline)
            return fail();
          latest = at;
          return at;
        };
        const reader = createPostgresCurrentFullOptionSetDraftStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          transactions: { run: (callback) => callback(sql) },
          authority: {
            async holdUntilTransactionCompletes(actualTx, input) {
              check();
              if (actualTx !== sql) return fail();
              const lease = await hold(tx, input);
              check();
              return lease;
            },
          },
        });
        const read = async () => {
          check();
          const result = readClosedRecord(
              copyCategoryPersistenceValue(
                await reader.readCurrent({
                  optionSetReference: set,
                  expectedAggregateVersion: expected,
                }),
              ),
              [
                "content",
                "sourceDigest",
                "contentDigest",
                "configurationDigest",
                "observedAt",
                "validUntil",
                "referenceEligibility",
              ],
            ),
            body = readClosedRecord(result.content, [
              "profile",
              "sourceAggregate",
              "optionDetails",
              "conditionalRules",
              "conflictRules",
              "scopeSet",
              "effectivePeriod",
            ]),
            { sourceAggregate, ...additional } = body,
            prepared = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
            root = prepared.content.sourceAggregate,
            sourceAt = parseCatalogInstant(result.observedAt),
            until = parseCatalogInstant(result.validUntil);
          if (
            root.brandReference !== brand ||
            root.optionSetReference !== set ||
            root.draft.versionReference !== version ||
            root.aggregateVersion !== expected ||
            sourceAt < observedAt ||
            sourceAt > check() ||
            until <= sourceAt ||
            Date.parse(until) - Date.parse(sourceAt) > 30000 ||
            result.referenceEligibility !== "NotEvaluated" ||
            prepared.sourceDigest !== r.sourceDigest ||
            prepared.contentDigest !== r.contentDigest ||
            prepared.configurationDigest !== r.configurationDigest ||
            result.sourceDigest !== prepared.sourceDigest ||
            result.contentDigest !== prepared.contentDigest ||
            result.configurationDigest !== prepared.configurationDigest ||
            root.draft.options.some((o) => o.triggeredOptionSetReference !== null) ||
            prepared.content.optionDetails.some(
              (d) => d.triggeredOptionSetVersionReference !== null,
            )
          )
            return fail();
          deadline = Math.min(deadline, Date.parse(until));
          check();
          const graph = Object.freeze({
            brandReference: brand as string,
            rootOptionSetReference: set as string,
            rootVersionReference: version as string,
            contents: Object.freeze([prepared.content]),
          });
          const identity = evaluateCatalogOptionSetRuleSatisfiability(graph);
          return Object.freeze({
            graph,
            prepared,
            observedAt: sourceAt,
            graphDigest: identity.graphDigest,
          });
        };
        const initial = await read(),
          deliveredUntil = deadline;
        const result = await work(
          Object.freeze({
            profile: "CurrentOptionSetDraftGraphV1" as const,
            graph: initial.graph,
            aggregateVersion: expected as number,
            sourceDigest: initial.prepared.sourceDigest,
            contentDigest: initial.prepared.contentDigest,
            configurationDigest: initial.prepared.configurationDigest,
            graphDigest: initial.graphDigest,
            originalObservedAt: observedAt,
            observedAt: initial.observedAt,
            validUntil: new Date(deliveredUntil).toISOString(),
            sourceAuthority: "CurrentDraftRootOnly" as const,
            referenceEligibility: "NotEvaluated" as const,
            publishValidation: "Incomplete" as const,
            eligibility: "NotEvaluated" as const,
          }),
        );
        check();
        const final = await read();
        if (initial.graphDigest !== final.graphDigest || deadline < deliveredUntil) return fail();
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
