import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductContentRegistryStore,
  createPostgresProductValidationCandidateSource,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommand,
  validateCatalogProductRegisteredContent,
  type CatalogProductValidationCandidate,
} from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type RegistryOptions = Parameters<typeof createPostgresProductContentRegistryStore>[0];
type Transaction = Parameters<CandidateOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type RegisteredAssessment = ReturnType<typeof validateCatalogProductRegisteredContent>;
export type CurrentProductCandidateRegisteredContent = Omit<RegisteredAssessment, "profile"> & {
  readonly profile: "CurrentProductCandidateRegisteredContentV1";
  readonly candidate: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly productReference: string;
    readonly versionReference: string;
    readonly aggregateVersion: number;
    readonly contentDigest: CatalogProductValidationCandidate["contentDigest"];
    readonly configurationDigest: CatalogProductValidationCandidate["configurationDigest"];
    readonly originalIntentDigest: string;
  };
  readonly observedAt: string;
  readonly validUntil: string;
  readonly currentCandidate: "Bound";
  readonly publishValidation: "Incomplete";
  readonly digest: string;
};
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Existing public owning sources, one caller transaction. No supplied aggregate,
 * registry JSON or partial assessment substitutes for the complete current Draft. */
export function createCurrentProductCandidateRegisteredContentSource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly candidateAuthority: CandidateOptions["authority"];
  readonly registryAuthority: RegistryOptions["authority"];
  readonly categoryAssignments?: CandidateOptions["categoryAssignments"];
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    candidateAuthority = options.candidateAuthority,
    registryAuthority = options.registryAuthority,
    categoryAssignments = options.categoryAssignments;
  if (
    typeof candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof registryAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Transaction,
      value: unknown,
      work: (assessment: CurrentProductCandidateRegisteredContent) => Promise<T>,
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
        });
        const registrySource = createPostgresProductContentRegistryStore({
          tenantReference,
          brandReference,
          actorReference,
          actorKind: "User",
          clock: { now },
          authority: registryAuthority,
          transactions: { run: (callback) => callback(tx) },
        });
        let candidateCalls = 0,
          registryCalls = 0,
          workCalls = 0,
          finished = false,
          completed: T | undefined;
        let finalLease: CurrentProductCandidateRegisteredContent | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (!finalLease || at < finalLease.observedAt || at >= finalLease.validUntil)
            return fail();
        };
        const result = await candidateSource.withCurrentCandidate(
          command,
          async (candidate, currentTx) => {
            if (
              ++candidateCalls !== 1 ||
              currentTx !== tx ||
              candidate.completeContent !== "Present"
            )
              return fail();
            return registrySource.withCurrentRegistry(
              {
                originalIntentDigest: candidate.originalIntentDigest,
                observedAt: candidate.observedAt,
                validUntil: candidate.validUntil,
              },
              async (source, registryTx) => {
                if (
                  ++registryCalls !== 1 ||
                  registryTx !== tx ||
                  source.observation.originalIntentDigest !== candidate.originalIntentDigest ||
                  source.registry.tenantReference !== tenantReference ||
                  source.registry.brandReference !== brandReference
                )
                  return fail();
                const registered = validateCatalogProductRegisteredContent(
                    candidate.aggregate,
                    source.registry,
                  ),
                  body = {
                    ...registered,
                    profile: "CurrentProductCandidateRegisteredContentV1" as const,
                    candidate: Object.freeze({
                      tenantReference,
                      brandReference,
                      productReference: candidate.aggregate.productReference,
                      versionReference: candidate.aggregate.draft.versionReference,
                      aggregateVersion: candidate.aggregate.aggregateVersion,
                      contentDigest: candidate.contentDigest,
                      configurationDigest: candidate.configurationDigest,
                      originalIntentDigest: candidate.originalIntentDigest,
                    }),
                    observedAt: candidate.observedAt,
                    validUntil:
                      candidate.validUntil < source.observation.validUntil
                        ? candidate.validUntil
                        : source.observation.validUntil,
                    currentCandidate: "Bound" as const,
                    publishValidation: "Incomplete" as const,
                  };
                if (registered.snapshotDigest !== source.snapshotDigest) return fail();
                finalLease = Object.freeze({
                  ...body,
                  digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
                });
                check();
                if (++workCalls !== 1) return fail();
                const result = await work(finalLease);
                check();
                finished = true;
                completed = result;
                return result;
              },
            );
          },
        );
        if (
          candidateCalls !== 1 ||
          registryCalls !== 1 ||
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
