import {
  buildBrandTaxReferenceSnapshot,
  buildTaxConfigurationReferenceSourceSnapshot,
  type PriceBookReferenceSourceRequest,
} from "../index.js";
import { fixture as single, id, at } from "./tax-classification-reference-matches.fixture.js";
export { id, at };
export function brandFixture(input?: PriceBookReferenceSourceRequest) {
  const f = single(input ? { ...input, storeReference: id(9) } : undefined);
  const { storeReference: _, ...request } = f.request;
  void _;
  const first = f.taxConfigurations.roots[0],
    old = f.taxConfigurations.versions[0];
  if (!first || !old) throw new Error("synthetic fixture missing");
  const root = {
    ...first,
    configurationReference: id(40),
    storeReference: id(90),
    currentVersionReference: id(47),
  };
  const version = {
    versionReference: id(47),
    versionNumber: old.versionNumber,
    snapshotDigest: old.snapshotDigest,
    lifecycle: "Draft",
    timeZone: old.timeZone,
    effectiveFrom: "2027-01-01T00:00:00.000Z",
    effectiveUntil: null,
    createdAt: old.createdAt,
    rules: old.rules.map((r) => ({ ...r, ruleReference: id(50) })),
  };
  const unresolved = {
    ...root,
    configurationReference: id(41),
    aggregateVersion: 1,
    currentVersionReference: null,
  };
  const second = buildTaxConfigurationReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [
        { root, version, precise: true },
        { root: unresolved, version: null, precise: true },
      ],
    },
    { ...request, storeReference: id(90) },
    at,
  );
  const rootScope = [...f.taxConfigurations.roots, ...second.roots].map((r) => ({
    configurationReference: r.configurationReference,
    storeReference: r.storeReference,
    present: true,
    aggregateVersion: String(r.aggregateVersion),
    currentVersionReference: r.currentVersionReference,
  }));
  rootScope.push({
    configurationReference: id(1000),
    storeReference: id(90),
    present: false,
    aggregateVersion: "1",
    currentVersionReference: null,
  });
  rootScope.sort((a, b) =>
    (a.storeReference + ":" + a.configurationReference).localeCompare(
      b.storeReference + ":" + b.configurationReference,
    ),
  );
  const taxConfigurations = buildBrandTaxReferenceSnapshot(
    {
      storeInventory: {
        profile: "TenantStoreReferenceV1",
        brandReference: request.brandReference,
        brandLifecycle: "Active",
        brandVersion: "1",
        generation: "2",
        referenceCount: "2",
        originalIntentDigest: request.catalogIntentDigest,
        observedAt: at,
        references: [9, 90].map((n, i) => ({
          storeReference: id(n),
          lifecycle: i === 0 ? "Active" : "Archived",
          version: "1",
          createdAt: first.rootCreatedAt,
          updatedAt: first.updatedAt,
        })),
      },
      generation: "6",
      referenceCount: String(rootScope.length),
      rootScope,
      stores: [f.taxConfigurations, second],
    },
    request,
    at,
  );
  const explicit = f.target.configurations.find((c) => c.taxClassificationReference === id(11));
  if (!explicit) throw new Error("synthetic explicit target missing");
  return {
    request,
    target: { ...f.target, profile: "CurrentDraftBindings" as const, configurations: [explicit] },
    taxConfigurations,
    now: at,
  };
}
