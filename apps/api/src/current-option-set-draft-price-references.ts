import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CatalogError, copyCategoryPersistenceValue, parseCatalogInstant } from "@rms/catalog";
import {
  createPostgresConfigurationReferenceSourceStore,
  matchOptionDraftPriceReferenceMetadata,
  parsePriceBookReferenceSourceRequest,
} from "@rms/pricing";
import { createCurrentOptionSetDraftGraphSource } from "./current-option-set-draft-graph.js";
type GraphOptions = Parameters<typeof createCurrentOptionSetDraftGraphSource>[0];
type PricingOptions = Parameters<typeof createPostgresConfigurationReferenceSourceStore>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentOptionSetDraftGraphSource>["withCurrentGraph"]
>[0];
type Assessment = ReturnType<typeof matchOptionDraftPriceReferenceMetadata>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual owning Draft and complete generation-fenced Pricing source; metadata
 * presence never grants per-Binding applicability or full reference eligibility. */
export function createCurrentOptionSetDraftPriceReferenceSource(options: {
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  clock: GraphOptions["clock"];
  readAuthority: GraphOptions["authority"];
  pricingAuthority: PricingOptions["authority"];
  priceBookAuthority: PricingOptions["priceBookAuthority"];
  optionPriceAuthority: PricingOptions["optionPriceAuthority"];
  promotionAuthority: PricingOptions["promotionAuthority"];
}) {
  const graphSource = createCurrentOptionSetDraftGraphSource({
      ...options,
      authority: options.readAuthority,
    }),
    now = options.clock.now.bind(options.clock),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  const capture = <I>(authority: {
    holdUntilTransactionCompletes(tx: Tx, input: I): Promise<void>;
  }) => {
    if (typeof authority?.holdUntilTransactionCompletes !== "function") return fail();
    const hold = authority.holdUntilTransactionCompletes.bind(authority);
    return (tx: Tx, input: I) => hold(tx, input);
  };
  const header = capture(options.pricingAuthority),
    book = capture(options.priceBookAuthority),
    price = capture(options.optionPriceAuthority),
    promo = capture(options.promotionAuthority);
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (
        value: Readonly<{
          profile: "CurrentOptionSetDraftPriceReferencesV1";
          tenantReference: string;
          brandReference: string;
          assessment: Assessment;
          originalObservedAt: string;
          rootObservedAt: string;
          validUntil: string;
          sourceAuthority: "CurrentDraftRootAndPricingMetadata";
          publishValidation: "Incomplete";
          eligibility: "NotEvaluated";
          digest: string;
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
            "pricingRequest",
            "activationAt",
          ]),
          graphRequest = readClosedRecord(input.graphRequest, [
            "optionSetReference",
            "versionReference",
            "expectedAggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "observedAt",
            "validUntil",
          ]),
          request = parsePriceBookReferenceSourceRequest(input.pricingRequest),
          originalObservedAt = parseCatalogInstant(graphRequest.observedAt),
          activationAt = parseCatalogInstant(input.activationAt),
          query = tx.query,
          sql = Object.freeze({ query: query.bind(tx) });
        if (
          request.brandReference !== graphSource.context.brandReference ||
          request.actorReference !== graphSource.context.actorReference ||
          activationAt < originalObservedAt
        )
          return fail();
        let until: string = parseCatalogInstant(graphRequest.validUntil),
          latest = originalObservedAt,
          graphCalls = 0,
          priceCalls = 0,
          completed = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
          latest = at;
          return at;
        };
        check();
        const result = await graphSource.withCurrentGraph(tx, graphRequest, async (root) => {
          if (++graphCalls !== 1) return fail();
          until = root.validUntil < until ? root.validUntil : until;
          check();
          const bridge = <I>(hold: (bound: Tx, input: I) => Promise<void>) => ({
            async holdUntilTransactionCompletes(actual: Tx, input: I) {
              check();
              if (actual !== sql) return fail();
              await hold(tx, input);
              check();
            },
          });
          const pricingSource = createPostgresConfigurationReferenceSourceStore({
            tenantReference: graphSource.context.tenantReference,
            brandReference: graphSource.context.brandReference,
            actorReference: graphSource.context.actorReference,
            clock: { now: check },
            transactions: { run: (action) => action(sql) },
            authority: bridge(header),
            priceBookAuthority: bridge(book),
            optionPriceAuthority: bridge(price),
            promotionAuthority: bridge(promo),
          });
          const pricingResult = await pricingSource.withCurrentSnapshot(request, async (source) => {
            if (++priceCalls !== 1) return fail();
            const freshUntil = new Date(Date.parse(source.observedAt) + 5000).toISOString();
            until = freshUntil < until ? freshUntil : until;
            check();
            const assessment = matchOptionDraftPriceReferenceMetadata(
              {
                profile: "CurrentFullOptionDraftPricePinsV1",
                brandReference: graphSource.context.brandReference,
                optionSetReference: root.graph.rootOptionSetReference,
                versionReference: root.graph.rootVersionReference,
                sourceDigest: root.sourceDigest,
                contentDigest: root.contentDigest,
                configurationDigest: root.configurationDigest,
                optionPins: root.graph.contents.flatMap((n) =>
                  n.optionDetails
                    .filter((d) => d.pricingRule !== null)
                    .map((d) => {
                      if (d.pricingRule === null) return fail();
                      return {
                        optionReference: d.optionReference,
                        ruleReference: d.pricingRule.reference,
                        versionReference: d.pricingRule.versionReference,
                      };
                    }),
                ),
              },
              source,
              request,
              check(),
              activationAt,
            );
            const evidence = {
              profile: "CurrentOptionSetDraftPriceReferencesV1" as const,
              tenantReference: graphSource.context.tenantReference,
              brandReference: graphSource.context.brandReference,
              assessment,
              originalObservedAt,
              rootObservedAt: root.observedAt,
              validUntil: until,
              sourceAuthority: "CurrentDraftRootAndPricingMetadata" as const,
              publishValidation: "Incomplete" as const,
              eligibility: "NotEvaluated" as const,
            };
            answer = await work(
              Object.freeze({
                ...evidence,
                digest: "sha256:" + sha256Hex(canonicalizeRfc8785(evidence)),
              }),
            );
            check();
            completed = true;
            return answer;
          });
          if (priceCalls !== 1 || !completed || !Object.is(pricingResult, answer)) return fail();
          check();
          return pricingResult;
        });
        if (graphCalls !== 1 || priceCalls !== 1 || !completed || !Object.is(result, answer))
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
