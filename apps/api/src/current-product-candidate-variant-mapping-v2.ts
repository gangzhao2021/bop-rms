import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  assertProductVariantIdentityHistory,
  bindCatalogProductValidationCandidateV2,
  copyCategoryPersistenceValue,
  createPostgresProductVariantIdentityHistorySource,
  parseCatalogInstant,
  parseProductPublicationCommandV2,
  parseProductVariantIdentityHistorySnapshot,
  type CatalogCurrentProductValidationCandidateV2,
} from "@rms/catalog";

type OwnerOptions = Parameters<typeof createPostgresProductVariantIdentityHistorySource>[0];
export type ProductCandidateVariantHistoryAuthorityV2 = OwnerOptions["authority"];
type Transaction = Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export interface CurrentProductVariantMappingV2 {
  readonly check: { readonly code: "VariantMapping"; readonly outcome: "Pass" | "HardError" };
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly historyDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const canonical = (value: unknown) => canonicalizeRfc8785(value);

/** Internal composition: call only while the owning complete Candidate is held.
 * The existing history owner supplies every committed revision in this same
 * transaction. Empty Variant definitions are legal, but never erase used IDs.
 */
export function createCurrentProductCandidateVariantMappingSourceV2(options: {
  readonly authority: ProductCandidateVariantHistoryAuthorityV2;
  readonly clock: { now(): string };
}) {
  if (
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return unavailable();
  const hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    now = options.clock.now.bind(options.clock),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  return Object.freeze({
    async withHeldCandidateAssessment<T>(
      tx: Transaction,
      commandValue: unknown,
      candidateValue: CatalogCurrentProductValidationCandidateV2,
      work: (value: CurrentProductVariantMappingV2) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      const fail = (): never => {
        if (tx && typeof tx === "object") failed.add(tx);
        return unavailable();
      };
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          failed.has(tx) ||
          active.has(tx) ||
          typeof work !== "function"
        )
          return fail();
        active.add(tx);
        entered = true;
        const command = parseProductPublicationCommandV2(commandValue),
          candidate = copyCategoryPersistenceValue(
            candidateValue,
          ) as CatalogCurrentProductValidationCandidateV2,
          rebound = bindCatalogProductValidationCandidateV2(
            command,
            candidate.aggregate,
            candidate.observedAt,
          ),
          intent = "sha256:" + sha256Hex(canonical(command)),
          query = tx.query;
        if (
          candidate.completeContent !== "Present" ||
          Object.keys(candidate).length !== Object.keys(rebound).length + 1 ||
          !Object.hasOwn(candidate, "internalCodeCheck") ||
          Object.entries(rebound).some(
            ([key, value]) =>
              key !== "validUntil" &&
              canonical(value) !== canonical(candidate[key as keyof typeof candidate]),
          )
        )
          return fail();
        const candidateAt = parseCatalogInstant(candidate.observedAt),
          candidateUntil = parseCatalogInstant(candidate.validUntil),
          startedAt = parseCatalogInstant(now());
        if (
          startedAt < candidateAt ||
          candidateUntil <= candidateAt ||
          candidateUntil > rebound.validUntil
        )
          return fail();
        let latest = startedAt,
          deadline =
            [candidateUntil, new Date(Date.parse(startedAt) + 5000).toISOString()].sort()[0] ??
            fail();
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= deadline) return fail();
          latest = at;
          return at;
        };
        const source = createPostgresProductVariantIdentityHistorySource({
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          actorReference: command.actorReference,
          clock: { now: check },
          transactions: {
            async run(callback) {
              check();
              const answer = await callback(tx);
              check();
              return answer;
            },
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              try {
                if (actual !== tx) return fail();
                check();
                if ((await hold(actual, input)) !== undefined) return fail();
                check();
              } catch (error) {
                failed.add(tx);
                throw error;
              }
            },
          },
        });
        let calls = 0,
          completed: { value: T } | undefined;
        const result = await source.withCurrentSnapshot(
          {
            productReference: command.productReference,
            expectedAggregateVersion: command.expectedProductAggregateVersion,
            originalIntentDigest: intent,
          },
          async (value) => {
            if (++calls !== 1) return fail();
            const history = parseProductVariantIdentityHistorySnapshot(value);
            if (
              history.brandReference !== command.brandReference ||
              history.productReference !== command.productReference ||
              history.aggregateVersion !== command.expectedProductAggregateVersion ||
              history.originalIntentDigest !== intent ||
              history.observedAt < candidateAt ||
              history.observedAt > check()
            )
              return fail();
            deadline =
              [deadline, new Date(Date.parse(history.observedAt) + 5000).toISOString()].sort()[0] ??
              fail();
            check();
            let compatible = true;
            try {
              assertProductVariantIdentityHistory(candidate.aggregate, history);
            } catch {
              compatible = false;
            }
            const outcome =
              compatible && candidate.variantMappingPrerequisite === "NoExplicitUnmappedCombination"
                ? ("Pass" as const)
                : ("HardError" as const);
            const answer = await work(
              Object.freeze({
                check: Object.freeze({ code: "VariantMapping" as const, outcome }),
                originalIntentDigest: intent,
                replacementIntentDigest: command.replacementIntentDigest,
                historyDigest: history.digest,
                observedAt: history.observedAt,
                validUntil: deadline,
              }),
            );
            check();
            completed = { value: answer };
            return completed;
          },
        );
        if (calls !== 1 || !completed || result !== completed) return fail();
        check();
        return completed.value;
      } catch (error) {
        if (tx && typeof tx === "object") failed.add(tx);
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return unavailable();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
