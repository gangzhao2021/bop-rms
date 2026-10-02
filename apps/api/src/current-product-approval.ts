import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogProductApprovalRequest,
  bindCatalogProductApprovalToCurrentPolicy,
  type CatalogProductApprovalPolicyObservation,
  type createPostgresProductPublicationSourceStore,
} from "@rms/catalog";
import type { createCurrentProductPublicationPolicySource } from "./current-product-publication-policy.js";
type ApprovalSource = ReturnType<typeof createPostgresProductPublicationSourceStore>;
type PolicySource = ReturnType<typeof createCurrentProductPublicationPolicySource>;
/** Public-owner composition only. Both owners must use the caller's outer UoW. */
export function createCurrentProductApprovalSource(options: {
  readonly approvalSource: Pick<ApprovalSource, "context" | "withCurrentApproval">;
  readonly policySource: PolicySource;
  readonly clock: { now(): string };
}) {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  return Object.freeze({
    async withCurrentApproval<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      value: unknown,
      work: (source: CatalogProductApprovalPolicyObservation) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseCatalogProductApprovalRequest(value),
          a = options.approvalSource.context,
          p = options.policySource.context;
        if (
          a.tenantReference !== p.tenantReference ||
          a.brandReference !== p.brandReference ||
          a.actorReference !== p.actorReference ||
          a.actorKind !== p.actorKind
        )
          return fail();
        let approvalCalls = 0,
          policyCalls = 0;
        let completed: { value: T } | undefined;
        let finalLease: CatalogProductApprovalPolicyObservation | undefined;
        const result = await options.approvalSource.withCurrentApproval(
          request,
          async (approval, sourceTx) => {
            if (
              ++approvalCalls !== 1 ||
              sourceTx !== tx ||
              approval.receipt.tenantReference !== a.tenantReference ||
              approval.receipt.brandReference !== a.brandReference
            )
              return fail();
            return options.policySource.withCurrentPolicy(
              tx,
              {
                policyReference: request.policyReference,
                policyVersion: request.policyVersion,
                observedAt: request.observedAt,
              },
              async (policy) => {
                if (++policyCalls !== 1) return fail();
                const proof = bindCatalogProductApprovalToCurrentPolicy(
                  approval,
                  policy,
                  request,
                  options.clock.now(),
                );
                finalLease = proof;
                const result = await work(proof);
                const now = parseCatalogInstant(options.clock.now());
                if (now < proof.observedAt || now >= proof.validUntil) return fail();
                completed = Object.freeze({ value: result });
                return completed;
              },
            );
          },
        );
        if (approvalCalls !== 1 || policyCalls !== 1 || !completed || result !== completed)
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
