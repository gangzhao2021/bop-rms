import { expect, it } from "vitest";
import {
  matchProductVersionBrandTaxReferences as match,
  buildBrandTaxReferenceSnapshot,
} from "../index.js";
import { brandFixture, id, at } from "./brand-tax-classification-reference-matches.fixture.js";
it("matches both Store lifecycles/all stored versions and preserves retired/unresolved roots", () => {
  const f = brandFixture(),
    r = match(f);
  expect(r.crossStoreCoverage).toBe("CompleteRegisteredReferences");
  expect(r.configurations[0]?.references).toHaveLength(2);
  expect(r.configurations[0]?.references?.map((r) => r.storeLifecycle)).toEqual([
    "Active",
    "Archived",
  ]);
  expect(r.configurations[0]?.references?.[1]?.temporalStatus).toBe("Future");
  expect(r.retiredRootReferences[0]?.configurationReference).toBe(id(1000));
  expect(r.unresolvedRoots[0]?.configurationReference).toBe(id(41));
  expect(r.publicationCoverage).toBe("Unavailable");
  expect(r.skuTaxOverrideCoverage).toBe("Unavailable");
});
it("keeps null/default unknown and removed SKU membership distinct across recorded configurations", () => {
  const f = brandFixture(),
    c = f.target.configurations[0];
  if (!c) throw new Error("fixture");
  const r = match({
    ...f,
    target: {
      ...f.target,
      profile: "RecordedDraftConfigurations",
      configurations: [
        c,
        {
          ...c,
          catalogConfigurationDigest: "sha256:" + "b".repeat(64),
          skuReferences: [],
          taxClassificationReference: null,
        },
      ],
    },
  });
  expect(r.classificationCoverage).toBe("DefaultUnavailable");
  expect(r.configurations.find((c) => c.taxClassificationReference === null)?.references).toBe(
    null,
  );
  const sku = match({
    ...f,
    target: {
      ...f.target,
      profile: "RecordedDraftConfigurations",
      skuReference: c.skuReferences[0] ?? null,
      configurations: [
        c,
        {
          ...c,
          catalogConfigurationDigest: "sha256:" + "b".repeat(64),
          skuReferences: [],
          taxClassificationReference: null,
        },
      ],
    },
  });
  expect(sku.configurations.find((c) => c.taxClassificationReference === null)?.membership).toBe(
    "SkuAbsent",
  );
  expect(sku.classificationCoverage).toBe("CompleteExplicit");
});
it("does not infer no-tax from complete zero rule matches or an empty registered Store inventory", () => {
  const f = brandFixture(),
    c = f.target.configurations[0];
  if (!c) throw new Error("fixture");
  expect(
    match({
      ...f,
      target: { ...f.target, configurations: [{ ...c, taxClassificationReference: id(999) }] },
    }).configurations[0]?.references,
  ).toEqual([]);
  const empty = buildBrandTaxReferenceSnapshot(
    {
      storeInventory: {
        ...f.taxConfigurations.storeInventory,
        referenceCount: "0",
        references: [],
      },
      generation: "0",
      referenceCount: "0",
      rootScope: [],
      stores: [],
    },
    f.request,
    f.now,
  );
  expect(match({ ...f, taxConfigurations: empty }).configurations[0]?.references).toEqual([]);
  expect(
    match({
      ...f,
      taxConfigurations: empty,
      target: { ...f.target, configurations: [{ ...c, taxClassificationReference: null }] },
    }).classificationCoverage,
  ).toBe("DefaultUnavailable");
});
it("rejects altered original context/partial coverage/digest, stale data and target getters", () => {
  const f = brandFixture();
  for (const changed of [
    { ...f, request: { ...f.request, actorReference: id(99) } },
    { ...f, taxConfigurations: { ...f.taxConfigurations, scopeCoverage: "SelectedStoreOnly" } },
    { ...f, taxConfigurations: { ...f.taxConfigurations, digest: "sha256:" + "f".repeat(64) } },
    { ...f, now: "2026-09-29T12:00:06.000Z" },
  ])
    expect(() => match(changed)).toThrow();
  let calls = 0;
  const target = { ...f.target };
  Object.defineProperty(target, "configurations", {
    enumerable: true,
    get() {
      calls++;
      return f.target.configurations;
    },
  });
  expect(() => match({ ...f, target })).toThrow();
  expect(calls).toBe(0);
});
it("rejects target multiplication instead of returning partial reference rows", () => {
  const f = brandFixture(),
    c = f.target.configurations[0];
  if (!c) throw new Error("fixture");
  const configurations = Array.from({ length: 1000 }, (_, n) => ({
    ...c,
    catalogConfigurationDigest: "sha256:" + n.toString(16).padStart(64, "0"),
    skuReferences: Array.from({ length: 100 }, (_, i) => id(10000 + n * 100 + i)),
  }));
  expect(() =>
    match({
      ...f,
      target: { ...f.target, profile: "RecordedDraftConfigurations", configurations },
    }),
  ).toThrow();
  expect(at).toBe(f.now);
});

it("rejects aggregate output multiplication even when each Store output fits", async () => {
  const { buildTaxConfigurationReferenceSourceSnapshot } = await import("../index.js");
  const f = brandFixture(),
    c = f.target.configurations[0];
  if (!c) throw new Error("fixture");
  const stores = f.taxConfigurations.stores.map((s, i) =>
    buildTaxConfigurationReferenceSourceSnapshot(
      {
        observedAt: f.now,
        references: s.roots.flatMap<unknown>((root) => {
          const versions = s.versions.filter(
            (v) => v.configurationReference === root.configurationReference,
          );
          return versions.length
            ? versions.map((v) => {
                const { configurationReference, isCurrentVersion, temporalStatus, ...version } = v;
                void configurationReference;
                void isCurrentVersion;
                void temporalStatus;
                return {
                  root,
                  version: {
                    ...version,
                    rules: version.rules.flatMap((r) =>
                      r.taxClassificationReference === id(11)
                        ? Array.from({ length: 6 }, (_, n) => ({
                            ...r,
                            ruleReference: id(500 + i * 100 + n),
                            taxComponentCode: "SYNTHETIC_" + n,
                          }))
                        : [r],
                    ),
                  },
                  precise: true,
                };
              })
            : [{ root, version: null, precise: true }];
        }),
      },
      s.request,
      f.now,
    ),
  );
  const taxConfigurations = buildBrandTaxReferenceSnapshot(
    {
      storeInventory: f.taxConfigurations.storeInventory,
      generation: f.taxConfigurations.generation,
      referenceCount: f.taxConfigurations.referenceCount,
      rootScope: f.taxConfigurations.rootScope,
      stores,
    },
    f.request,
    f.now,
  );
  const configurations = Array.from({ length: 1000 }, (_, n) => ({
    ...c,
    catalogConfigurationDigest: "sha256:" + n.toString(16).padStart(64, "0"),
  }));
  expect(() =>
    match({
      ...f,
      taxConfigurations,
      target: { ...f.target, profile: "RecordedDraftConfigurations", configurations },
    }),
  ).toThrow();
});

it("refuses conflicting global version identity across otherwise valid Store snapshots", async () => {
  const { buildTaxConfigurationReferenceSourceSnapshot } = await import("../index.js");
  const f = brandFixture(),
    source = f.taxConfigurations.stores[1],
    first = f.taxConfigurations.stores[0]?.versions[0];
  if (!source || !first) throw new Error("fixture");
  const roots = source.roots.map((r) =>
    r.configurationReference === id(40)
      ? { ...r, currentVersionReference: first.versionReference }
      : r,
  );
  const references: unknown[] = roots.flatMap<unknown>((root) => {
    const rows: unknown[] = source.versions
      .filter((v) => v.configurationReference === root.configurationReference)
      .map((v) => {
        const { configurationReference, isCurrentVersion, temporalStatus, ...version } = v;
        void configurationReference;
        void isCurrentVersion;
        void temporalStatus;
        return {
          root,
          version: { ...version, versionReference: first.versionReference },
          precise: true,
        };
      });
    if (root.currentVersionReference === null) {
      rows.push({ root, version: null, precise: true });
    }
    return rows;
  });
  const second = buildTaxConfigurationReferenceSourceSnapshot(
    { observedAt: f.now, references },
    source.request,
    f.now,
  );
  const taxConfigurations = buildBrandTaxReferenceSnapshot(
    {
      storeInventory: f.taxConfigurations.storeInventory,
      generation: f.taxConfigurations.generation,
      referenceCount: f.taxConfigurations.referenceCount,
      rootScope: f.taxConfigurations.rootScope.map((r) =>
        r.configurationReference === id(40)
          ? { ...r, currentVersionReference: first.versionReference }
          : r,
      ),
      stores: [f.taxConfigurations.stores[0], second],
    },
    f.request,
    f.now,
  );
  expect(() => match({ ...f, taxConfigurations })).toThrow();
});
