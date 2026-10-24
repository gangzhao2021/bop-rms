import { expect, it, vi } from "vitest";
import {
  matchRecordedPricingConfigurationReferences as match,
  type RecordedPricingReferenceTarget,
} from "../index.js";
import { fixture, id } from "./configuration-reference-matches.fixture.js";
const unavailable = { code: "PRICING_REFERENCE_MATCH_UNAVAILABLE" };
const hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
function inputs() {
  const f = fixture(),
    old = {
      catalogConfigurationDigest: hash(1),
      versionReference: id(15),
      skuReferences: f.target.skuReferences,
      categoryReferences: f.target.categoryReferences,
      bindings: f.target.bindings,
    };
  const changed = {
    catalogConfigurationDigest: hash(2),
    versionReference: id(15),
    skuReferences: [id(12)],
    categoryReferences: [],
    bindings: f.target.bindings.map((b) => ({
      ...b,
      enabledOptionReferences: [],
      includedSkuReferences: [id(12)],
      excludedSkuReferences: [],
      channelCodes: ["WEB"],
    })),
  };
  const target: RecordedPricingReferenceTarget = {
    mappingProfile: "RecordedDraftConfigurations",
    catalogSourceDigest: f.target.catalogSourceDigest,
    productReference: f.target.productReference,
    skuReference: null,
    configurations: [old, changed],
  };
  return { ...f, target };
}
it("preserves each recorded configuration and its old SKU/category/binding membership", () => {
  const f = inputs(),
    r = match(f);
  expect(r.coverage).toBe("RecordedDraftHistoryOnly");
  expect(r.publicationCoverage).toBe("Unavailable");
  expect(r.futureScheduleCoverage).toBe("Unavailable");
  const old = r.configurations.find((c) => c.catalogConfigurationDigest === hash(1)),
    changed = r.configurations.find((c) => c.catalogConfigurationDigest === hash(2));
  expect(old?.matches?.priceEntries).toHaveLength(1);
  expect(changed?.matches?.priceEntries).toHaveLength(0);
  expect(old?.matches?.optionVersions[0]?.matchedSkuReferences).toEqual([id(11)]);
  expect(old?.matches?.optionVersions[0]?.bindingChannelCodes).toEqual(["CUSTOMER_PWA"]);
  expect(changed?.matches?.optionVersions).toHaveLength(0);
  expect(
    changed?.matches?.unresolvedOptionRoots.find((o) => o.reference.ruleReference === id(200)),
  ).toMatchObject({
    reason: "OptionNotEnabledInRecordedConfiguration",
    versions: [{ temporalStatus: "Future" }],
  });
  expect(old?.matches?.promotions.some((p) => p.matchedBy.includes("Category"))).toBe(true);
  expect(changed?.matches?.promotions.some((p) => p.matchedBy.includes("Category"))).toBe(false);
  expect(JSON.stringify(r)).not.toMatch(/CurrentDraftOnly|Allowed|activeReferenceCount/);
  expect(
    match({ ...f, target: { ...f.target, configurations: [...f.target.configurations].reverse() } })
      .digest,
  ).toBe(r.digest);
});
it("never combines old enabled option with another configuration SKU/channel qualification", () => {
  const f = inputs(),
    r = match({ ...f, target: { ...f.target, skuReference: id(12) } });
  expect(r.configurations.every((c) => c.matches?.optionVersions.length === 0)).toBe(true);
  expect(r.configurations.every((c) => c.matches?.priceEntries.length === 0)).toBe(true);
  const removed = match({ ...f, target: { ...f.target, skuReference: id(11) } });
  expect(
    removed.configurations.find((c) => c.catalogConfigurationDigest === hash(1))?.matches
      ?.optionVersions,
  ).toHaveLength(1);
  expect(
    removed.configurations.find((c) => c.catalogConfigurationDigest === hash(2)),
  ).toMatchObject({ membership: "SkuAbsent", matches: null });
});
it("does not guess unknown recorded categories; unrelated absent-SKU configuration remains explicit", () => {
  const f = inputs(),
    changed = f.target.configurations[1];
  if (!changed) throw new Error("missing synthetic history fixture");
  const target = {
    ...f.target,
    configurations: [f.target.configurations[0], { ...changed, categoryReferences: null }],
  } as RecordedPricingReferenceTarget;
  expect(() => match({ ...f, target })).toThrow(expect.objectContaining(unavailable));
  expect(
    match({ ...f, target: { ...target, skuReference: id(11) } }).configurations.some(
      (c) => c.membership === "SkuAbsent",
    ),
  ).toBe(true);
});
it.each(["priceBooks", "optionPrices", "promotions"] as const)(
  "rejects altered %s request/digest or stale sources",
  (key) => {
    const f = inputs();
    for (const altered of [
      { digest: hash(999) },
      { coverage: "Partial" },
      { request: { ...f.request, actorReference: id(99) } },
    ])
      expect(() => match({ ...f, [key]: { ...f[key], ...altered } })).toThrow(
        expect.objectContaining(unavailable),
      );
    expect(() => match({ ...f, now: "2026-09-29T12:00:06.000Z" })).toThrow(
      expect.objectContaining(unavailable),
    );
  },
);
it("rejects empty/duplicate/oversized/unknown graphs and absent requested SKU", () => {
  const f = inputs(),
    old = f.target.configurations[0];
  if (!old) throw new Error("missing synthetic fixture");
  for (const target of [
    { ...f.target, configurations: [] },
    { ...f.target, configurations: [old, old] },
    { ...f.target, skuReference: id(99) },
    { ...f.target, configurations: new Array(1) },
    { ...f.target, configurations: Array.from({ length: 1001 }, () => old) },
    { ...f.target, mappingProfile: "CurrentDraftBindings" },
    { ...f.target, configurations: [{ ...old, approval: true }] },
  ])
    expect(() => match({ ...f, target: target as RecordedPricingReferenceTarget })).toThrow(
      expect.objectContaining(unavailable),
    );
});
it("rejects getters without invocation and excessive multiplied output", () => {
  const f = inputs(),
    get = vi.fn(() => []),
    target = { ...f.target };
  Object.defineProperty(target, "configurations", { enumerable: true, get });
  expect(() => match({ ...f, target })).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
  const old = f.target.configurations[0];
  if (!old) throw new Error("missing synthetic fixture");
  expect(() =>
    match({
      ...f,
      target: {
        ...f.target,
        configurations: Array.from({ length: 1000 }, (_, i) => ({
          ...old,
          catalogConfigurationDigest: hash(i + 1),
        })),
      },
    }),
  ).toThrow(expect.objectContaining(unavailable));
});
