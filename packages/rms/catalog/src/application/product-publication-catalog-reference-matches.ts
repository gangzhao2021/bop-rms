import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant } from "../contracts/product.js";
import { parseCatalogProductPublicationReferenceProvenance } from "../contracts/product-publication-reference-provenance.js";
import {
  parseProductPublicationMenuReferenceSourceSnapshotV2,
  parseProductWarningAcknowledgementMenuReferenceSourceSnapshot,
  type MenuPlacementReference,
} from "../contracts/menu-reference-source.js";
import {
  parseProductPublicationBundleReferenceSourceSnapshotV2,
  parseProductWarningAcknowledgementBundleReferenceSourceSnapshot,
} from "../contracts/bundle-reference-source.js";
import {
  parseProductPublicationAvailabilityReferenceSourceSnapshotV2,
  parseProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
} from "../contracts/availability-reference-source.js";
import { projectCatalogProductPublicationReferenceCoverage } from "./product-publication-reference-coverage.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const keys = [
  "request",
  "referenceProvenance",
  "publicationCoverage",
  "menuSource",
  "bundleSource",
  "availabilitySource",
  "now",
] as const;
export const catalogProductPublicationReferenceMatchMaximumRows = 10000;

/** Exact stored reference relations, independently of lifecycle applicability or
 * sale eligibility. The full owning publication projection identifies which
 * immutable configuration supplied each actual Published/Scheduled head. */
export function matchCatalogProductPublicationReferenceGraphs(input: {
  readonly request: unknown;
  readonly referenceProvenance: unknown;
  readonly publicationCoverage: unknown;
  readonly menuSource: unknown;
  readonly bundleSource: unknown;
  readonly availabilitySource: unknown;
  readonly now: unknown;
}) {
  try {
    // Capture only closed data descriptors here. Each owning parser applies its
    // own graph budget, avoiding an unrelated combined deep-copy limit.
    if (
      !input ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).length !== keys.length
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of keys)
      if (!descriptors[key]?.enumerable || !("value" in descriptors[key])) return fail();
    const values = Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
    const now = parseCatalogInstant(values.now),
      publicationCoverage = projectCatalogProductPublicationReferenceCoverage(
        values.request,
        values.referenceProvenance,
        values.publicationCoverage,
        now,
      ),
      request = publicationCoverage.request,
      provenance = parseCatalogProductPublicationReferenceProvenance(values.referenceProvenance),
      menu =
        request.profile === "CatalogProductPublicationReferenceRequestV2"
          ? parseProductPublicationMenuReferenceSourceSnapshotV2(values.menuSource, request, now)
          : parseProductWarningAcknowledgementMenuReferenceSourceSnapshot(
              values.menuSource,
              request,
              now,
            ),
      bundle =
        request.profile === "CatalogProductPublicationReferenceRequestV2"
          ? parseProductPublicationBundleReferenceSourceSnapshotV2(
              values.bundleSource,
              request,
              now,
            )
          : parseProductWarningAcknowledgementBundleReferenceSourceSnapshot(
              values.bundleSource,
              request,
              now,
            ),
      availability =
        request.profile === "CatalogProductPublicationReferenceRequestV2"
          ? parseProductPublicationAvailabilityReferenceSourceSnapshotV2(
              values.availabilitySource,
              request,
              now,
            )
          : parseProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot(
              values.availabilitySource,
              request,
              now,
            );
    const graphs = new Map(
        provenance.operationProvenance.map((entry) => [
          hash(entry.referenceConfiguration),
          entry.referenceConfiguration,
        ]),
      ),
      current = provenance.operationProvenance.at(-1),
      reviews = new Map<string, (typeof menu.reviews)[number]>(
        menu.reviews.map((r) => [r.reviewReference, r]),
      ),
      roots = new Map(bundle.bundles.map((r) => [r.bundleReference, r])),
      versions = new Map(bundle.versions.map((r) => [r.bundleVersionReference, r])),
      groups = new Map(bundle.groups.map((r) => [r.groupReference, r]));
    if (!current) return fail();
    let count = 0;
    function reserve(rows: number) {
      count += rows;
      if (count > catalogProductPublicationReferenceMatchMaximumRows) return fail();
    }
    reserve(
      publicationCoverage.entries.reduce((rows, entry) => rows + 1 + entry.retirements.length, 0),
    );
    function menuContexts(placements: readonly MenuPlacementReference[]) {
      const selected = new Map<string, MenuPlacementReference[]>();
      for (const placement of placements) {
        const list = selected.get(placement.reviewReference) ?? [];
        list.push(placement);
        selected.set(placement.reviewReference, list);
      }
      return Object.freeze(
        [...selected.entries()].map(([reviewReference, items]) => {
          const review = reviews.get(reviewReference);
          if (!review) return fail();
          const revisions = Object.freeze(
              menu.revisions.filter((r) => r.reviewReference === reviewReference),
            ),
            releases = Object.freeze(
              menu.releases.filter((r) => r.reviewReference === reviewReference),
            ),
            releaseIds = new Set(releases.map((r) => r.releaseReference)),
            periods = Object.freeze(menu.periods.filter((r) => releaseIds.has(r.releaseReference))),
            latest = revisions.at(-1);
          reserve(1 + items.length + revisions.length + releases.length + periods.length);
          return Object.freeze({
            review,
            placements: Object.freeze(items),
            revisions,
            releases,
            periods,
            lifecycle: latest
              ? Object.freeze({
                  state: latest.state,
                  version: latest.lifecycleVersion,
                  changedAt: latest.changedAt,
                })
              : null,
          });
        }),
      );
    }
    const storedBundles = bundle.members.map((member) => {
      const root = roots.get(member.bundleReference),
        version = versions.get(member.bundleVersionReference),
        group = groups.get(member.groupReference);
      if (!root || !version || !group) return fail();
      return Object.freeze({
        bundle: root,
        version,
        group,
        member,
        isCurrentBundleVersion: root.currentVersionReference === version.bundleVersionReference,
      });
    });
    const configurations = Object.freeze(
      [...graphs.entries()].map(([referenceConfigurationDigest, referenceConfiguration]) => {
        reserve(1);
        const skus = new Set(referenceConfiguration.skuReferences),
          menuReferences = menuContexts(
            menu.placements.filter(
              (p) =>
                p.productVersionReference === referenceConfiguration.versionReference &&
                skus.has(p.skuReference),
            ),
          ),
          bundleReferences = Object.freeze(
            storedBundles.filter((r) =>
              r.member.sellableType === "Product"
                ? r.member.sellableReference === request.command.productReference
                : skus.has(r.member.sellableReference),
            ),
          ),
          availabilityReferences = Object.freeze(
            availability.rules.filter((r) =>
              r.sellableType === "Product"
                ? r.sellableReference === request.command.productReference
                : r.sellableType === "Sku" && skus.has(r.sellableReference),
            ),
          ),
          bundleIds = new Set(bundleReferences.map((r) => r.bundle.bundleReference)),
          bundleAvailabilityReferences = Object.freeze(
            availability.rules
              .filter((r) => r.sellableType === "Bundle" && bundleIds.has(r.sellableReference))
              .map((rule) => Object.freeze({ rule, bundleReference: rule.sellableReference })),
          );
        // Count repeated expanded parents as well as their member/rule rows.
        reserve(
          bundleReferences.length * 4 +
            availabilityReferences.length +
            bundleAvailabilityReferences.length,
        );
        return Object.freeze({
          referenceConfiguration,
          referenceConfigurationDigest,
          menuReferences,
          bundleReferences,
          availabilityReferences,
          bundleAvailabilityReferences,
        });
      }),
    );
    const knownVersions = new Set([...graphs.values()].map((g) => g.versionReference)),
      knownSkus = new Set([...graphs.values()].flatMap((g) => g.skuReferences)),
      unresolvedMenuReferences = menuContexts(
        menu.placements.filter(
          (p) =>
            (knownVersions.has(p.productVersionReference) || knownSkus.has(p.skuReference)) &&
            ![...graphs.values()].some(
              (g) =>
                g.versionReference === p.productVersionReference &&
                g.skuReferences.includes(p.skuReference),
            ),
        ),
      );
    const body = {
      profile: "CatalogProductPublicationReferenceMatchesV1" as const,
      request,
      publicationCoverage,
      configurations,
      currentReferenceConfigurationDigest: hash(current.referenceConfiguration),
      unresolvedMenuReferences,
      sourceDigests: Object.freeze({
        referenceProvenance: provenance.digest,
        publicationCoverage: publicationCoverage.retirementCoverageDigest,
        menu: menu.digest,
        bundle: bundle.digest,
        availability: availability.digest,
      }),
      generations: Object.freeze({
        menu: menu.generation,
        bundle: bundle.generation,
        availability: availability.generation,
      }),
      observedAt: request.observedAt,
      validUntil: request.validUntil,
      applicability: "NotEvaluated" as const,
      saleEligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...body, digest: hash(body) });
  } catch {
    return fail();
  }
}
export type CatalogProductPublicationReferenceMatches = ReturnType<
  typeof matchCatalogProductPublicationReferenceGraphs
>;
