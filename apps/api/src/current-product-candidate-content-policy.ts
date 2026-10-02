import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseProductPublicationCommand,
  parseCatalogInstant,
  type createPostgresProductValidationCandidateSource,
  type CatalogProductContentPolicyAssessment,
} from "@rms/catalog";
import type { createCurrentBrandConfigurationContentSource } from "./current-brand-configuration-content.js";
import type { createCurrentProductPublicationPolicySource } from "./current-product-publication-policy.js";
import { createCurrentProductContentPolicySource } from "./current-product-content-policy.js";
type CandidateSource = ReturnType<typeof createPostgresProductValidationCandidateSource>;
type PolicySource = ReturnType<typeof createCurrentProductPublicationPolicySource>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Public owner composition: no supplied aggregate, body or validation receipt. */
export function createCurrentProductCandidateContentPolicySource(options: {
  readonly candidateSource: Pick<CandidateSource, "context" | "withCurrentCandidate">;
  readonly brandSource: ReturnType<typeof createCurrentBrandConfigurationContentSource>;
  readonly policySource: PolicySource;
  readonly clock: { now(): string };
}) {
  if (
    typeof options.candidateSource?.withCurrentCandidate !== "function" ||
    typeof options.brandSource?.withCurrentContent !== "function" ||
    typeof options.policySource?.withCurrentPolicy !== "function" ||
    typeof options.policySource?.withHeldScopePolicy !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return fail();
  const candidateSource = Object.freeze({
      context: Object.freeze(
        copyCategoryPersistenceValue(options.candidateSource.context),
      ) as CandidateSource["context"],
      withCurrentCandidate: options.candidateSource.withCurrentCandidate.bind(
        options.candidateSource,
      ),
    }),
    brandSource = Object.freeze({
      withCurrentContent: options.brandSource.withCurrentContent.bind(options.brandSource),
    }),
    policySource = Object.freeze({
      context: Object.freeze(
        copyCategoryPersistenceValue(options.policySource.context),
      ) as PolicySource["context"],
      withCurrentPolicy: options.policySource.withCurrentPolicy.bind(options.policySource),
      withHeldScopePolicy: options.policySource.withHeldScopePolicy.bind(options.policySource),
    }),
    now = options.clock.now.bind(options.clock);
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      value: unknown,
      work: (
        value: CatalogProductContentPolicyAssessment,
        policyPublicationReference: string,
      ) => Promise<T>,
    ): Promise<T> {
      let failed = false;
      const refuse = (): never => {
        failed = true;
        return fail();
      };
      try {
        const original = parseCatalogInstant(now()),
          query = tx.query,
          deadline = new Date(Date.parse(original) + 30000).toISOString();
        let latest = original;
        let finalLease:
          Pick<CatalogProductContentPolicyAssessment, "observedAt" | "validUntil"> | undefined;
        const check = (requireLease = false) => {
          try {
            const at = parseCatalogInstant(now());
            if (
              failed ||
              typeof query !== "function" ||
              tx.query !== query ||
              at < latest ||
              at >= deadline ||
              (requireLease &&
                (!finalLease || at < finalLease.observedAt || at >= finalLease.validUntil))
            )
              return refuse();
            latest = at;
            return at;
          } catch {
            return refuse();
          }
        };
        check();
        const assessment = createCurrentProductContentPolicySource({
          brandSource,
          policySource,
          clock: { now: () => check() },
        });
        const copied = copyCategoryPersistenceValue(value);
        const keys = [
          "command",
          "configurationVersionReference",
          "expectedBrandVersion",
          "policyReference",
          "policyVersion",
        ];
        if (
          !copied ||
          typeof copied !== "object" ||
          Array.isArray(copied) ||
          Object.keys(copied).length !== keys.length ||
          keys.some((k) => !Object.hasOwn(copied, k))
        )
          return refuse();
        const input = copied as Record<string, unknown>,
          c = parseProductPublicationCommand(input.command),
          ctx = candidateSource.context,
          policy = policySource.context;
        if (
          c.action !== "Validate" ||
          c.actorKind !== "User" ||
          ctx.actorKind !== "User" ||
          policy.actorKind !== "User" ||
          c.tenantReference !== ctx.tenantReference ||
          c.brandReference !== ctx.brandReference ||
          c.actorReference !== ctx.actorReference ||
          ctx.tenantReference !== policy.tenantReference ||
          ctx.brandReference !== policy.brandReference ||
          ctx.actorReference !== policy.actorReference
        )
          return refuse();
        let calls = 0,
          finished = false,
          completed: T | undefined,
          workCalls = 0;
        const result = await candidateSource.withCurrentCandidate(
          c,
          async (candidate, currentTx) => {
            if (
              ++calls !== 1 ||
              currentTx !== tx ||
              candidate.tenantReference !== c.tenantReference ||
              candidate.brandReference !== c.brandReference ||
              candidate.actorReference !== c.actorReference
            )
              return refuse();
            check();
            const value = await assessment.withCurrentAssessment(
              tx,
              {
                aggregate: candidate.aggregate,
                binding: {
                  tenantReference: candidate.tenantReference,
                  productReference: c.productReference,
                  versionReference: c.versionReference,
                  expectedAggregateVersion: c.expectedProductAggregateVersion,
                  contentDigest: c.contentDigest,
                  configurationDigest: c.configurationDigest,
                  originalIntentDigest: candidate.originalIntentDigest,
                  observedAt: candidate.observedAt,
                  validUntil: candidate.validUntil,
                },
                brandRequest: {
                  tenantReference: c.tenantReference,
                  brandReference: c.brandReference,
                  actorReference: c.actorReference,
                  purposeCode: "CATALOG_PRODUCT_CONTENT",
                  configurationVersionReference: input.configurationVersionReference as string,
                  expectedBrandVersion: input.expectedBrandVersion as number,
                  originalIntentDigest: candidate.originalIntentDigest,
                  observedAt: candidate.observedAt,
                  validUntil: candidate.validUntil,
                },
                policyRequest: {
                  policyReference: input.policyReference as string,
                  policyVersion: input.policyVersion as number,
                  observedAt: candidate.observedAt,
                },
              },
              async (current, publicationReference) => {
                if (++workCalls !== 1) return refuse();
                finalLease = Object.freeze({
                  observedAt: parseCatalogInstant(current.observedAt),
                  validUntil: parseCatalogInstant(current.validUntil),
                });
                check(true);
                const result = await work(current, publicationReference);
                check(true);
                return result;
              },
            );
            finished = true;
            completed = value;
            return value;
          },
        );
        if (calls !== 1 || workCalls !== 1 || !finished || !Object.is(result, completed))
          return refuse();
        check(true);
        return result;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return refuse();
      }
    },
  });
}
