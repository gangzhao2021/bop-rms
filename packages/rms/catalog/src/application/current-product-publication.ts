import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  parseProductPublicationSourceRequest,
  type ProductPublicationSourceSnapshot,
} from "../contracts/product-publication-source.js";
import {
  parseProductPublicationValidation,
  parseProductPublicationApproval,
  resolveCatalogProductPublication,
  productPublicationScopeLevels,
  type ProductPublicationScopeLevel,
} from "../contracts/product-publication.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function closed(value: unknown, keys: readonly string[]) {
  const v = copyCategoryPersistenceValue(value);
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v as Record<string, unknown>;
}
export interface CurrentProductPublicationRequest {
  readonly productReference: string;
  readonly expectedAggregateVersion: number;
  readonly channelCode: string;
  readonly orderTypeCode: string;
}
export interface CurrentProductPublicationPorts {
  readonly clock: { now(): string };
  readonly snapshots: {
    withCurrentSnapshot<T>(
      input: { productReference: string; expectedAggregateVersion: number },
      work: (snapshot: ProductPublicationSourceSnapshot) => Promise<T>,
    ): Promise<T>;
  };
  /** Tenant owns topology; Publishing owns the accepted policy. These public
   * sources hold current scope/permission/topology/policy/validation/approval
   * leases through work and the enclosing owning transaction COMMIT. */
  readonly eligibility: {
    withHeldCurrentFacts<T>(
      input: CurrentProductPublicationRequest & {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        observedAt: string;
        snapshot: ProductPublicationSourceSnapshot;
      },
      work: (facts: unknown) => Promise<T>,
    ): Promise<T>;
  };
}
/** An effective observation is not a sale grant or scheduler receipt. Callers
 * must consume inside the callback; no supplied policy/Store/evidence is accepted. */
export function createCurrentProductPublicationService(
  ports: CurrentProductPublicationPorts,
  scope: { tenantReference: string; brandReference: string; storeReference: string },
) {
  const tenantReference = parseCatalogReference(scope.tenantReference),
    brandReference = parseCatalogReference(scope.brandReference),
    storeReference = parseCatalogReference(scope.storeReference);
  return Object.freeze({
    async withCurrentPublication<T>(
      value: unknown,
      work: (view: {
        readonly productReference: string;
        readonly aggregateVersion: number;
        readonly observedAt: string;
        readonly current: ReturnType<typeof resolveCatalogProductPublication>;
        readonly future: readonly {
          versionReference: string;
          publicationVersion: number;
          scheduleReference: string;
          scheduleVersion: number;
          effectiveFrom: string;
          effectiveUntil: string | null;
          eligibility: "NotEvaluated";
          currentValidation: "Pass" | "Unavailable";
          activation: "Pending" | "Due" | "Expired";
        }[];
      }) => Promise<T>,
    ): Promise<T> {
      try {
        const r = closed(value, [
          "productReference",
          "expectedAggregateVersion",
          "channelCode",
          "orderTypeCode",
        ]);
        const sourceRequest = parseProductPublicationSourceRequest({
          productReference: r.productReference,
          expectedAggregateVersion: r.expectedAggregateVersion,
        });
        const request = Object.freeze({
          ...sourceRequest,
          channelCode: parseCatalogCode(r.channelCode),
          orderTypeCode: parseCatalogCode(r.orderTypeCode),
        });
        let started = parseCatalogInstant(ports.clock.now());
        const entered = started;
        let sourceCalls = 0,
          factCalls = 0;
        let completed: { value: T } | undefined;
        const result = await ports.snapshots.withCurrentSnapshot(
          sourceRequest,
          async (snapshot) => {
            started = parseCatalogInstant(ports.clock.now());
            if (started < entered || Date.parse(started) - Date.parse(entered) > 5000)
              return fail();
            if (
              ++sourceCalls !== 1 ||
              snapshot.tenantReference !== tenantReference ||
              snapshot.brandReference !== brandReference ||
              snapshot.productReference !== request.productReference ||
              snapshot.aggregateVersion !== request.expectedAggregateVersion ||
              snapshot.coverage !== "Complete" ||
              snapshot.eligibility !== "NotEvaluated" ||
              snapshot.observedAt > started ||
              Date.parse(started) - Date.parse(snapshot.observedAt) > 5000
            )
              return fail();
            return ports.eligibility.withHeldCurrentFacts(
              {
                ...request,
                tenantReference,
                brandReference,
                storeReference,
                observedAt: started,
                snapshot,
              },
              async (value) => {
                if (++factCalls !== 1) return fail();
                const f = closed(value, [
                  "tenantReference",
                  "brandReference",
                  "storeReference",
                  "observedAt",
                  "validUntil",
                  "coverage",
                  "storeGroupReferences",
                  "regionReferences",
                  "policyReference",
                  "policyVersion",
                  "scopeOrder",
                  "versions",
                ]);
                const until = parseCatalogInstant(f.validUntil);
                if (
                  f.tenantReference !== tenantReference ||
                  f.brandReference !== brandReference ||
                  f.storeReference !== storeReference ||
                  f.observedAt !== started ||
                  until <= started ||
                  f.coverage !== "Complete" ||
                  !Number.isSafeInteger(f.policyVersion) ||
                  (f.policyVersion as number) < 1 ||
                  (f.policyVersion as number) > 2147483647 ||
                  !Array.isArray(f.versions) ||
                  f.versions.length !== snapshot.latest.length
                )
                  return fail();
                parseCatalogReference(f.policyReference);
                const order = f.scopeOrder;
                if (
                  !Array.isArray(order) ||
                  order.length !== 6 ||
                  new Set(order).size !== 6 ||
                  productPublicationScopeLevels.some((l) => !order.includes(l))
                )
                  return fail();
                const context = {
                  storeReference,
                  storeGroupReferences: f.storeGroupReferences,
                  regionReferences: f.regionReferences,
                  channelCode: request.channelCode,
                  orderTypeCode: request.orderTypeCode,
                  at: started,
                };
                // The owning resolver validates topology identities, selector policy and ambiguity.
                let current = resolveCatalogProductPublication(
                  snapshot.latest,
                  context,
                  f.scopeOrder as ProductPublicationScopeLevel[],
                );
                const eligible = new Map<string, boolean>(),
                  seen = new Set<string>();
                let expires: string = until;
                for (const raw of f.versions) {
                  const e = closed(raw, ["versionReference", "validation", "approval"]),
                    id = parseCatalogReference(e.versionReference),
                    publication = snapshot.latest.find((p) => p.versionReference === id);
                  if (!publication || seen.has(id)) return fail();
                  seen.add(id);
                  if (e.validation === null) {
                    if (e.approval !== null) return fail();
                    eligible.set(id, false);
                    continue;
                  }
                  const v = parseProductPublicationValidation(e.validation);
                  if (
                    v.productAggregateVersion !== snapshot.aggregateVersion ||
                    v.contentDigest !== publication.contentDigest ||
                    v.configurationDigest !== publication.configurationDigest ||
                    v.scopeDigest !== publication.scopeDigest ||
                    v.periodDigest !== publication.periodDigest ||
                    v.policyReference !== f.policyReference ||
                    v.policyVersion !== f.policyVersion ||
                    v.checkedAt > started ||
                    v.validUntil <= started
                  )
                    return fail();
                  if (v.validUntil < expires) expires = v.validUntil;
                  const warnings = v.checks
                    .filter((c) => c.outcome === "Warning")
                    .map((c) => c.code)
                    .sort();
                  let ok =
                    !v.checks.some((c) => c.outcome === "HardError") &&
                    (warnings.length === 0 ||
                      (v.warningAcknowledgement !== null &&
                        v.warningAcknowledgement.actorReference ===
                          publication.submittedByActorReference &&
                        canonicalizeRfc8785(v.warningAcknowledgement.warningCodes) ===
                          canonicalizeRfc8785(warnings)));
                  if (v.approvalPolicy === "Required") {
                    if (e.approval === null) ok = false;
                    else {
                      const a = parseProductPublicationApproval(e.approval);
                      if (
                        a.approvedAt > started ||
                        a.validUntil <= started ||
                        a.policyReference !== f.policyReference ||
                        a.policyVersion !== f.policyVersion ||
                        a.contentDigest !== publication.contentDigest ||
                        a.configurationDigest !== publication.configurationDigest ||
                        a.scopeDigest !== publication.scopeDigest ||
                        a.periodDigest !== publication.periodDigest ||
                        a.reviewReference !== publication.reviewReference ||
                        a.reviewVersion !== publication.reviewVersion ||
                        a.requestedByActorReference !== publication.submittedByActorReference ||
                        a.approvedByActorReference === a.requestedByActorReference
                      )
                        return fail();
                      if (a.validUntil < expires) expires = a.validUntil;
                    }
                  } else if (e.approval !== null) return fail();
                  eligible.set(id, ok);
                }
                if (
                  current.outcome === "Selected" &&
                  eligible.get(current.versionReference) !== true
                )
                  current = Object.freeze({
                    outcome: "Unavailable",
                    reason: "NO_EFFECTIVE_PRODUCT_VERSION",
                  });
                const future = Object.freeze(
                  snapshot.latest
                    .filter((p) => p.state === "Scheduled")
                    .map((p) =>
                      Object.freeze({
                        versionReference: p.versionReference,
                        publicationVersion: p.publicationVersion,
                        scheduleReference: parseCatalogReference(p.scheduleReference),
                        scheduleVersion: p.scheduleVersion,
                        effectiveFrom: p.effectivePeriod.effectiveFrom.instant,
                        effectiveUntil: p.effectivePeriod.effectiveUntil?.instant ?? null,
                        activation:
                          p.effectivePeriod.effectiveUntil !== null &&
                          p.effectivePeriod.effectiveUntil.instant <= started
                            ? ("Expired" as const)
                            : p.effectivePeriod.effectiveFrom.instant <= started
                              ? ("Due" as const)
                              : ("Pending" as const),
                        eligibility: "NotEvaluated" as const,
                        currentValidation:
                          eligible.get(p.versionReference) === true
                            ? ("Pass" as const)
                            : ("Unavailable" as const),
                      }),
                    )
                    .sort(
                      (a, b) =>
                        a.effectiveFrom.localeCompare(b.effectiveFrom) ||
                        a.versionReference.localeCompare(b.versionReference),
                    ),
                );
                const assertFresh = () => {
                  const at = parseCatalogInstant(ports.clock.now());
                  if (at < started || at >= expires || Date.parse(at) - Date.parse(started) > 5000)
                    return fail();
                };
                assertFresh();
                const output = await work(
                  Object.freeze({
                    productReference: request.productReference,
                    aggregateVersion: snapshot.aggregateVersion,
                    observedAt: started,
                    current,
                    future,
                  }),
                );
                assertFresh();
                completed = Object.freeze({ value: output });
                return completed;
              },
            );
          },
        );
        if (sourceCalls !== 1 || factCalls !== 1 || !completed || result !== completed)
          return fail();
        return completed.value;
      } catch {
        return fail();
      }
    },
  });
}
