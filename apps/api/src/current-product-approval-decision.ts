import {
  CatalogError,
  parseProductPublicationCommand,
  parseCatalogInstant,
  parseCatalogApprovalValiditySeconds,
  createCatalogProductApprovalDecision,
  type createPostgresProductPublicationSourceStore,
} from "@rms/catalog";
import type { createCurrentProductPublicationPolicySource } from "./current-product-publication-policy.js";
type ReviewSource = ReturnType<typeof createPostgresProductPublicationSourceStore>;
type PolicySource = ReturnType<typeof createCurrentProductPublicationPolicySource>;
/** Actual authenticated owning Approve is the decision. Policy and review are
 * server current sources held in the caller UoW, never supplied client evidence. */
export function createCurrentProductApprovalDecisionSource(options: {
  readonly reviewSource: Pick<ReviewSource, "context" | "withCurrentReview">;
  readonly policySource: PolicySource;
  readonly maximumApprovalValiditySeconds: number;
  readonly clock: { now(): string };
}) {
  const maximum = parseCatalogApprovalValiditySeconds(options.maximumApprovalValiditySeconds);
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  return Object.freeze({
    async withCurrentDecision<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      value: unknown,
      work: (decision: ReturnType<typeof createCatalogProductApprovalDecision>) => Promise<T>,
    ): Promise<T> {
      try {
        const c = parseProductPublicationCommand(value),
          r = options.reviewSource.context,
          p = options.policySource.context;
        if (
          c.action !== "Approve" ||
          c.actorKind !== "User" ||
          r.actorKind !== "User" ||
          p.actorKind !== "User" ||
          c.tenantReference !== r.tenantReference ||
          c.brandReference !== r.brandReference ||
          c.actorReference !== r.actorReference ||
          r.tenantReference !== p.tenantReference ||
          r.brandReference !== p.brandReference ||
          r.actorReference !== p.actorReference
        )
          return fail();
        let reviewCalls = 0,
          policyCalls = 0,
          completed: { value: T } | undefined,
          finalLease: ReturnType<typeof createCatalogProductApprovalDecision> | undefined;
        const result = await options.reviewSource.withCurrentReview(c, async (review, sourceTx) => {
          if (++reviewCalls !== 1 || sourceTx !== tx) return fail();
          return options.policySource.withCurrentPolicy(
            tx,
            {
              policyReference: review.review.policyReference,
              policyVersion: review.review.policyVersion,
              observedAt: review.observedAt,
            },
            async (policy) => {
              if (++policyCalls !== 1) return fail();
              const decision = createCatalogProductApprovalDecision(
                c,
                review,
                policy,
                options.clock.now(),
                maximum,
              );
              finalLease = decision;
              const value = await work(decision),
                now = parseCatalogInstant(options.clock.now());
              if (now < decision.observedAt || now >= decision.validUntil) return fail();
              completed = Object.freeze({ value });
              return completed;
            },
          );
        });
        if (reviewCalls !== 1 || policyCalls !== 1 || !completed || result !== completed)
          return fail();
        const now = parseCatalogInstant(options.clock.now());
        if (!finalLease || now < finalLease.observedAt || now >= finalLease.validUntil)
          return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
