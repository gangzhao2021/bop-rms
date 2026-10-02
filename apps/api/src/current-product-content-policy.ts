import {
  parseTenantBrandConfigurationContentRequest,
  type TenantBrandConfigurationContentRequest,
} from "@bop/tenant";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogProductContentPolicyBinding,
  assessCatalogProductContentPolicy,
  type CatalogProductContentPolicyBinding,
  type CatalogProductContentPolicyAssessment,
} from "@rms/catalog";
import type { createCurrentBrandConfigurationContentSource } from "./current-brand-configuration-content.js";
import type { createCurrentProductPublicationPolicySource } from "./current-product-publication-policy.js";
type BrandSource = ReturnType<typeof createCurrentBrandConfigurationContentSource>;
type PolicySource = ReturnType<typeof createCurrentProductPublicationPolicySource>;
/** Sources must use the same outer UoW. Catalog supplies its held owning candidate;
 * the returned partial assessment supplies neither caller permission nor sale. */
export function createCurrentProductContentPolicySource(options: {
  readonly brandSource: BrandSource;
  readonly policySource: PolicySource;
  readonly clock: { now(): string };
}) {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      input: {
        readonly aggregate: unknown;
        readonly binding: CatalogProductContentPolicyBinding;
        readonly brandRequest: TenantBrandConfigurationContentRequest;
        readonly policyRequest: Parameters<PolicySource["withCurrentPolicy"]>[1];
      },
      work: (
        assessment: CatalogProductContentPolicyAssessment,
        policyPublicationReference: string,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        if (
          !input ||
          typeof input !== "object" ||
          Object.getPrototypeOf(input) !== Object.prototype ||
          Reflect.ownKeys(input).length !== 4
        )
          return fail();
        const keys = ["aggregate", "binding", "brandRequest", "policyRequest"] as const,
          descriptors = Object.getOwnPropertyDescriptors(input);
        if (keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key])))
          return fail();
        const brandRequest = parseTenantBrandConfigurationContentRequest(
            descriptors.brandRequest?.value,
          ),
          binding = parseCatalogProductContentPolicyBinding(descriptors.binding?.value),
          aggregate = descriptors.aggregate?.value,
          policyRequest = descriptors.policyRequest?.value;
        if (
          policyRequest === undefined ||
          brandRequest.tenantReference !== options.policySource.context.tenantReference ||
          brandRequest.brandReference !== options.policySource.context.brandReference ||
          brandRequest.actorReference !== options.policySource.context.actorReference
        )
          return fail();
        let brandCalls = 0,
          policyCalls = 0,
          workCalls = 0;
        let finalLease: CatalogProductContentPolicyAssessment | undefined;
        let finished = false,
          completed: T | undefined;
        const check = () => {
          const now = parseCatalogInstant(options.clock.now());
          if (!finalLease || now < finalLease.observedAt || now >= finalLease.validUntil)
            return fail();
        };
        const result = await options.brandSource.withCurrentContent(
          brandRequest,
          async (brand, sourceTx) => {
            if (++brandCalls !== 1 || sourceTx !== tx) return fail(); // No nested commit may stand in for the caller's held UoW.
            return options.policySource.withCurrentPolicy(tx, policyRequest, async (policy) => {
              if (
                ++policyCalls !== 1 ||
                brand.tenantReference !== brandRequest.tenantReference ||
                brand.brandReference !== brandRequest.brandReference ||
                brand.originalIntentDigest !== brandRequest.originalIntentDigest ||
                brand.observedAt !== brandRequest.observedAt ||
                policy.observedAt !== brandRequest.observedAt ||
                policy.content.tenantReference !== brand.tenantReference ||
                policy.content.brandReference !== brand.brandReference
              )
                return fail();
              const validUntil = [
                brand.validUntil,
                policy.validUntil,
                parseCatalogInstant(binding.validUntil),
              ].sort()[0];
              if (!validUntil) return fail();
              const assessment = assessCatalogProductContentPolicy(
                aggregate,
                {
                  tenantReference: brand.tenantReference,
                  brandReference: brand.brandReference,
                  brandVersion: brand.brandVersion,
                  configurationVersionReference: brand.configurationVersionReference,
                  contentDigest: brand.contentDigest,
                  currentPublicationReference: brand.currentPublicationReference,
                  supportedLocales: brand.supportedLocales,
                  originalIntentDigest: brand.originalIntentDigest,
                  observedAt: brand.observedAt,
                  validUntil: brand.validUntil,
                },
                policy.content,
                { ...binding, validUntil },
              );
              finalLease = assessment;
              check();
              if (++workCalls !== 1) return fail();
              const result = await work(assessment, policy.currentPublicationReference);
              check();
              finished = true;
              completed = result;
              return result;
            });
          },
        );
        if (
          brandCalls !== 1 ||
          policyCalls !== 1 ||
          workCalls !== 1 ||
          !finished ||
          !Object.is(result, completed)
        )
          return fail();
        check();
        return result;
      } catch {
        return fail();
      }
    },
  });
}
