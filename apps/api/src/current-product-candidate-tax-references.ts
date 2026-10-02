import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSource,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductPublicationCommand,
} from "@rms/catalog";
import {
  createPostgresBrandTaxReferenceSourceStore,
  matchProductVersionBrandTaxReferences,
} from "@rms/pricing";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type TaxOptions = Parameters<typeof createPostgresBrandTaxReferenceSourceStore>[0];
type Transaction = Parameters<CandidateOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export interface CurrentProductCandidateTaxReferences {
  readonly profile: "CurrentProductCandidateTaxReferencesV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly originalIntentDigest: string;
  readonly candidateObservedAt: string;
  readonly taxObservedAt: string;
  readonly validUntil: string;
  readonly taxSourceDigest: string;
  readonly matchDigest: string;
  readonly registeredStoreCount: number;
  readonly matchingReferenceCount: number;
  readonly unresolvedRootCount: number;
  readonly retiredRootCount: number;
  readonly classificationCoverage: "CompleteExplicit" | "DefaultUnavailable";
  readonly completeContent: "Present" | "Unavailable";
  readonly taxResolution: "Unavailable";
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual current Draft and complete registered rule references. Reference
 * matches include noncurrent/Draft/expired rules; they never resolve tax. */
export function createCurrentProductCandidateTaxReferenceSource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly candidateAuthority: CandidateOptions["authority"];
  readonly tenantAuthority: TaxOptions["tenantAuthority"];
  readonly taxAuthority: TaxOptions["taxAuthority"];
  readonly brandTaxAuthority: TaxOptions["brandAuthority"];
  readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    candidateAuthority = options.candidateAuthority,
    tenantAuthority = options.tenantAuthority,
    taxAuthority = options.taxAuthority,
    brandAuthority = options.brandTaxAuthority,
    categoryAssignments = options.categoryAssignments;
  if (
    typeof candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof tenantAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof tenantAuthority?.isCurrent !== "function" ||
    typeof taxAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof brandAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Transaction,
      value: unknown,
      work: (assessment: CurrentProductCandidateTaxReferences) => Promise<T>,
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
        let taxRuns = 0;
        const candidateSource = createPostgresProductValidationCandidateSource({
            tenantReference,
            brandReference,
            actorReference,
            clock: { now },
            authority: candidateAuthority,
            ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
            transactions: { run: (callback) => callback(tx) },
          }),
          taxSource = createPostgresBrandTaxReferenceSourceStore({
            tenantReference,
            brandReference,
            actorReference,
            clock: { now },
            tenantAuthority,
            taxAuthority,
            brandAuthority,
            transactions: {
              run: (callback) => {
                if (++taxRuns !== 1) return fail();
                return callback(tx);
              },
            },
          });
        let candidateCalls = 0,
          taxCalls = 0,
          workCalls = 0,
          finished = false,
          completed: T | undefined,
          lease: CurrentProductCandidateTaxReferences | undefined;
        let observations: readonly string[] = [];
        const check = () => {
          const at = parseCatalogInstant(now());
          if (!lease || observations.some((observed) => at < observed) || at >= lease.validUntil)
            return fail();
        };
        const result = await candidateSource.withCurrentCandidate(
          command,
          async (candidate, actualTx) => {
            if (++candidateCalls !== 1 || actualTx !== tx) return fail();
            const request = {
              purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
              brandReference,
              actorReference,
              operationReference: command.operationReference,
              catalogIntentDigest: candidate.originalIntentDigest,
            };
            return taxSource.withCurrentSnapshot(request, async (tax) => {
              if (++taxCalls !== 1) return fail();
              const identity = {
                tenantReference,
                brandReference,
                productReference: candidate.aggregate.productReference,
                versionReference: candidate.aggregate.draft.versionReference,
                aggregateVersion: candidate.aggregate.aggregateVersion,
                contentDigest: candidate.contentDigest,
                configurationDigest: candidate.configurationDigest,
                originalIntentDigest: candidate.originalIntentDigest,
                candidateObservedAt: candidate.observedAt,
              };
              const matches = matchProductVersionBrandTaxReferences({
                request,
                target: {
                  profile: "CurrentDraftBindings",
                  catalogSourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(identity)),
                  productReference: candidate.aggregate.productReference,
                  skuReference: null,
                  configurations: [
                    {
                      catalogConfigurationDigest: candidate.configurationDigest,
                      versionReference: candidate.aggregate.draft.versionReference,
                      skuReferences: candidate.aggregate.draft.skus.map((sku) => sku.skuReference),
                      taxClassificationReference:
                        candidate.aggregate.draft.taxClassificationReference,
                    },
                  ],
                },
                taxConfigurations: tax,
                now: now(),
              });
              observations = [
                candidate.observedAt,
                tax.observedAt,
                ...tax.stores.map((s) => s.observedAt),
              ];
              const validUntil = [
                candidate.validUntil,
                ...observations.slice(1).map((at) => new Date(Date.parse(at) + 5000).toISOString()),
              ].sort()[0];
              if (!validUntil) return fail();
              const body = {
                profile: "CurrentProductCandidateTaxReferencesV1" as const,
                ...identity,
                taxObservedAt: tax.observedAt,
                validUntil,
                taxSourceDigest: tax.digest,
                matchDigest: matches.digest,
                registeredStoreCount: matches.stores.length,
                matchingReferenceCount: matches.configurations.reduce(
                  (sum, c) => sum + (c.references?.length ?? 0),
                  0,
                ),
                unresolvedRootCount: matches.unresolvedRoots.length,
                retiredRootCount: matches.retiredRootReferences.length,
                classificationCoverage: matches.classificationCoverage,
                completeContent: candidate.completeContent,
                taxResolution: "Unavailable" as const,
                publishValidation: "Incomplete" as const,
                eligibility: "NotEvaluated" as const,
              };
              lease = Object.freeze({
                ...body,
                digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
              });
              check();
              if (++workCalls !== 1) return fail();
              const output = await work(lease);
              check();
              finished = true;
              completed = output;
              return output;
            });
          },
        );
        if (
          candidateCalls !== 1 ||
          taxRuns !== 1 ||
          taxCalls !== 1 ||
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
