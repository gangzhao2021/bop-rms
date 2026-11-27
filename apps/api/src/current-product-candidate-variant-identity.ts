import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSource,
  createPostgresProductVariantIdentityHistorySource,
  assertProductVariantIdentityHistory,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductPublicationCommand,
} from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type VariantOptions = Parameters<typeof createPostgresProductVariantIdentityHistorySource>[0];
type Transaction = Parameters<CandidateOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export interface CurrentProductCandidateVariantIdentity {
  readonly profile: "CurrentProductCandidateVariantIdentityV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly originalIntentDigest: string;
  readonly candidateObservedAt: string;
  readonly historyObservedAt: string;
  readonly historyDigest: string;
  readonly validUntil: string;
  readonly variantIdentity: "Preserved";
  readonly publishValidation: "Incomplete";
  readonly referenceEligibility: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual current Draft and complete owning Variant history, held in one caller
 * transaction. Supplied body/history or identity equality never grants a sale. */
export function createCurrentProductCandidateVariantIdentitySource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly candidateAuthority: CandidateOptions["authority"];
  readonly variantAuthority: VariantOptions["authority"];
  readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    candidateAuthority = options.candidateAuthority,
    variantAuthority = options.variantAuthority,
    categoryAssignments = options.categoryAssignments;
  if (
    typeof candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof variantAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Transaction,
      value: unknown,
      work: (assessment: CurrentProductCandidateVariantIdentity) => Promise<T>,
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
        const candidateSource = createPostgresProductValidationCandidateSource({
            tenantReference,
            brandReference,
            actorReference,
            clock: { now },
            authority: candidateAuthority,
            ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
            transactions: { run: (callback) => callback(tx) },
          }),
          variantSource = createPostgresProductVariantIdentityHistorySource({
            tenantReference,
            brandReference,
            actorReference,
            clock: { now },
            authority: variantAuthority,
            transactions: { run: (callback) => callback(tx) },
          });
        let candidateCalls = 0,
          historyCalls = 0,
          workCalls = 0,
          finished = false,
          completed: T | undefined;
        let lease: CurrentProductCandidateVariantIdentity | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (
            !lease ||
            at < lease.candidateObservedAt ||
            at < lease.historyObservedAt ||
            at >= lease.validUntil
          )
            return fail();
        };
        const result = await candidateSource.withCurrentCandidate(
          command,
          async (candidate, actualTx) => {
            if (
              ++candidateCalls !== 1 ||
              actualTx !== tx ||
              candidate.completeContent !== "Present"
            )
              return fail();
            return variantSource.withCurrentSnapshot(
              {
                productReference: command.productReference,
                expectedAggregateVersion: command.expectedProductAggregateVersion,
                originalIntentDigest: candidate.originalIntentDigest,
              },
              async (history) => {
                if (
                  ++historyCalls !== 1 ||
                  history.aggregateVersion !== candidate.aggregate.aggregateVersion ||
                  history.productReference !== candidate.aggregate.productReference ||
                  history.brandReference !== brandReference ||
                  history.originalIntentDigest !== candidate.originalIntentDigest
                )
                  return fail();
                assertProductVariantIdentityHistory(candidate.aggregate, history);
                const historyUntil = new Date(Date.parse(history.observedAt) + 5000).toISOString(),
                  body = {
                    profile: "CurrentProductCandidateVariantIdentityV1" as const,
                    tenantReference,
                    brandReference,
                    productReference: candidate.aggregate.productReference,
                    versionReference: candidate.aggregate.draft.versionReference,
                    aggregateVersion: candidate.aggregate.aggregateVersion,
                    contentDigest: candidate.contentDigest,
                    configurationDigest: candidate.configurationDigest,
                    originalIntentDigest: candidate.originalIntentDigest,
                    candidateObservedAt: candidate.observedAt,
                    historyObservedAt: history.observedAt,
                    historyDigest: history.digest,
                    validUntil:
                      candidate.validUntil < historyUntil ? candidate.validUntil : historyUntil,
                    variantIdentity: "Preserved" as const,
                    publishValidation: "Incomplete" as const,
                    referenceEligibility: "NotEvaluated" as const,
                    eligibility: "NotEvaluated" as const,
                  };
                lease = Object.freeze({
                  ...body,
                  digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
                });
                check();
                if (++workCalls !== 1) return fail();
                const value = await work(lease);
                check();
                finished = true;
                completed = value;
                return value;
              },
            );
          },
        );
        if (
          candidateCalls !== 1 ||
          historyCalls !== 1 ||
          workCalls !== 1 ||
          !finished ||
          !Object.is(result, completed)
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
