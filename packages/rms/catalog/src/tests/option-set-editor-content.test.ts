import { expect, it, vi } from "vitest";
import {
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogFullOptionSetPublicationContent,
} from "../contracts/option-set-editor-content.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z";
function fixture() {
  const source = {
    optionSetReference: id(1),
    brandReference: id(2),
    internalCode: "MILK",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic milk" },
      localizedDescriptions: { "en-CA": "Synthetic choices" },
      displayStyle: "Quantity",
      minimumSelection: 1,
      maximumSelection: 3,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: 3,
      createdAt: at,
      updatedAt: at,
      options: [5, 6, 7].map((n) => ({
        optionReference: id(n),
        optionSetReference: id(1),
        brandReference: id(2),
        stableCode: "OPTION_" + n,
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic option" },
        localizedDescriptions: {},
        sortOrder: n - 5,
        defaultEligible: true,
        triggeredOptionSetReference: n === 5 ? id(50) : null,
        conflictOptionReferences: n === 6 ? [id(7)] : [],
        createdAt: at,
        createdByActorReference: id(3),
      })),
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [5, 6, 7].map((n) => ({
      optionReference: id(n),
      quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
      media:
        n === 5
          ? {
              mediaReference: id(100),
              assetReference: id(101),
              assetVersionReference: id(102),
              altText: { "en-CA": "Synthetic milk image" },
            }
          : null,
      pricingRule: n === 5 ? { reference: id(110), versionReference: id(111) } : null,
      consumption:
        n === 7
          ? null
          : {
              kind: n === 5 ? "Inventory" : "Recipe",
              reference: id(120 + n),
              versionReference: id(130 + n),
              quantity: n === 5 ? "0.125000" : "1.000000",
              unitCode: "GRAM",
            },
      triggeredOptionSetVersionReference: n === 5 ? id(51) : null,
    })),
    conditionalRules: [
      { ruleReference: id(200), whenAllSelected: [id(5)], requiredOptionReferences: [id(6)] },
    ],
    conflictRules: [{ ruleReference: id(201), forbiddenTogether: [id(5), id(7)] }],
    scopeSet: [
      {
        level: "Brand",
        reference: null as string | null,
        channelCodes: ["POS", "CUSTOMER_PWA"],
        orderTypeCodes: [] as string[],
      },
    ],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null as null | {
        instant: string;
        localDateTime: string;
        utcOffsetMinutes: number;
      },
    },
  };
  return { source, details };
}
function first(f: ReturnType<typeof fixture>) {
  const detail = f.details.optionDetails[0];
  if (!detail) throw new Error("missing synthetic option details");
  return detail;
}
function transition(f: ReturnType<typeof fixture>) {
  const p = parseCatalogOptionSetEditorContent(f.source, f.details);
  return {
    tenantReference: id(10),
    brandReference: id(2),
    optionSetReference: id(1),
    versionReference: id(4),
    sourceAggregateVersion: 7,
    publicationOperationReference: id(11),
    publicationIntentDigest: "sha256:" + "a".repeat(64),
    successorDraftVersionReference: id(12),
    sealedAt: "2026-09-30T12:01:00.000Z",
    sourceDigest: p.sourceDigest,
    contentDigest: p.contentDigest,
    configurationDigest: p.configurationDigest,
  };
}
it("preserves all additional fields with explicit source eligibility and canonical decimals", () => {
  const f = fixture(),
    p = parseCatalogOptionSetEditorContent(f.source, f.details);
  expect(p.referenceEligibility).toBe("NotEvaluated");
  expect(p.content.sourceAggregate).toEqual(f.source);
  expect(p.content.optionDetails[0]).toMatchObject({
    quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
    consumption: { kind: "Inventory", quantity: "0.125", unitCode: "GRAM" },
    triggeredOptionSetVersionReference: id(51),
  });
  expect(p.content.optionDetails[1]?.consumption).toMatchObject({ kind: "Recipe", quantity: "1" });
  expect(p.content.conditionalRules).toEqual(f.details.conditionalRules);
  expect(p.content.scopeSet[0]?.channelCodes).toEqual(["CUSTOMER_PWA", "POS"]);
  expect(Object.isFrozen(p.content.optionDetails[0]?.media?.altText)).toBe(true);
  const media = first(f).media;
  if (!media) throw new Error("missing synthetic media");
  media.altText["en-CA"] = "Later input";
  expect(p.content.optionDetails[0]?.media?.altText["en-CA"]).toBe("Synthetic milk image");
});
it("separates alt prose from reference configuration", () => {
  const f = fixture(),
    before = parseCatalogOptionSetEditorContent(f.source, f.details),
    media = first(f).media;
  if (!media) throw new Error("missing synthetic media");
  media.altText["en-CA"] = "Different alt text";
  const after = parseCatalogOptionSetEditorContent(f.source, f.details);
  expect(after.contentDigest).not.toBe(before.contentDigest);
  expect(after.sourceDigest).not.toBe(before.sourceDigest);
  expect(after.configurationDigest).toBe(before.configurationDigest);
  media.assetVersionReference = id(103);
  expect(parseCatalogOptionSetEditorContent(f.source, f.details).configurationDigest).not.toBe(
    after.configurationDigest,
  );
});
it("canonicalizes unordered details and selector restrictions deterministically", () => {
  const f = fixture(),
    before = parseCatalogOptionSetEditorContent(f.source, f.details);
  f.details.optionDetails.reverse();
  const scope = f.details.scopeSet[0];
  if (!scope) throw new Error("missing synthetic scope");
  scope.channelCodes.reverse();
  expect(parseCatalogOptionSetEditorContent(f.source, f.details)).toEqual(before);
});
it("materializes and recovers full V2 with an unchanged supported snapshot and full successor", () => {
  const f = fixture(),
    result = createCatalogFullOptionSetPublicationMaterialization(
      f.source,
      f.details,
      transition(f),
    );
  expect(result.content.profile).toBe("CatalogFullOptionSetDraftContentV2");
  expect(result.content.supportedContent.profile).toBe("CatalogSupportedOptionSetDraftContentV1");
  expect(result.content.eligibility).toBe("NotEvaluated");
  expect(result.successor.draft.versionReference).toBe(id(12));
  expect(result.successorEditorContent.optionDetails).toEqual(
    result.content.editorContent.optionDetails,
  );
  expect(result.successorEditorContent.sourceAggregate).toEqual(result.successor);
  const saved = JSON.stringify(result.content);
  expect(parseCatalogFullOptionSetPublicationContent(JSON.parse(saved))).toEqual(result.content);
  f.details.optionDetails.pop();
  expect(JSON.stringify(result.content)).toBe(saved);
});
it("retains full content in the final legal Draft revision while refusing a further publication", () => {
  const f = fixture();
  f.source.aggregateVersion = 2147483646;
  const t = { ...transition(f), sourceAggregateVersion: 2147483646 },
    result = createCatalogFullOptionSetPublicationMaterialization(f.source, f.details, t);
  expect(result.successor.aggregateVersion).toBe(2147483647);
  expect(result.successorEditorContent.sourceAggregate.aggregateVersion).toBe(2147483647);
  const full = parseCatalogOptionSetEditorContent(result.successor, f.details);
  expect(full.referenceEligibility).toBe("NotEvaluated");
  expect(() =>
    createCatalogFullOptionSetPublicationMaterialization(result.successor, f.details, {
      ...t,
      versionReference: result.successor.draft.versionReference,
      sourceAggregateVersion: 2147483647,
      successorDraftVersionReference: id(13),
      sourceDigest: full.sourceDigest,
      contentDigest: full.contentDigest,
      configurationDigest: full.configurationDigest,
    }),
  ).toThrow();
});
it.each([
  "missing",
  "duplicate",
  "dangling",
  "trigger-missing",
  "trigger-unexpected",
  "quantity",
  "media-version",
  "alt",
  "markup",
  "pricing-version",
  "consumption-version",
  "unit",
])("refuses invalid %s option detail", (kind) => {
  const f = fixture(),
    o = first(f);
  if (kind === "missing") f.details.optionDetails.pop();
  if (kind === "duplicate") f.details.optionDetails.push(o);
  if (kind === "dangling") o.optionReference = id(99);
  if (kind === "trigger-missing") o.triggeredOptionSetVersionReference = null;
  if (kind === "trigger-unexpected") {
    const other = f.details.optionDetails[1];
    if (!other) throw new Error("missing synthetic detail");
    other.triggeredOptionSetVersionReference = id(51);
  }
  if (kind === "quantity") o.quantityRule.maximumQuantity = 3;
  if (kind === "media-version" && o.media) o.media.assetVersionReference = "invalid";
  if (kind === "alt" && o.media) o.media.altText = { "en-CA": "" };
  if (kind === "markup" && o.media) o.media.altText = { "en-CA": "<b>Milk</b>" };
  if (kind === "pricing-version" && o.pricingRule) o.pricingRule.versionReference = "invalid";
  if (kind === "consumption-version" && o.consumption) o.consumption.versionReference = "invalid";
  if (kind === "unit" && o.consumption) o.consumption.unitCode = "unknown unit";
  expect(() => parseCatalogOptionSetEditorContent(f.source, f.details)).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
});
it.each(["0", "-1", "1e3", "0.000000", "1.0000001", "01.5"])(
  "refuses nonpositive or inexact consumption %s",
  (quantity) => {
    const f = fixture(),
      consumption = first(f).consumption;
    if (!consumption) throw new Error("missing synthetic consumption");
    consumption.quantity = quantity;
    expect(() => parseCatalogOptionSetEditorContent(f.source, f.details)).toThrow();
  },
);
it.each([
  "unknown",
  "duplicate-id",
  "duplicate-combination",
  "empty-condition",
  "direct-conflict",
  "existing-conflict",
])("refuses %s rule", (kind) => {
  const f = fixture(),
    r = f.details.conditionalRules[0];
  if (!r) throw new Error("missing synthetic rule");
  if (kind === "unknown") r.requiredOptionReferences = [id(99)];
  if (kind === "duplicate-id")
    f.details.conflictRules.push({
      ruleReference: r.ruleReference,
      forbiddenTogether: [id(5), id(6)],
    });
  if (kind === "duplicate-combination")
    f.details.conditionalRules.push({ ...r, ruleReference: id(202) });
  if (kind === "empty-condition") r.whenAllSelected = [];
  if (kind === "direct-conflict") r.requiredOptionReferences = [id(7)];
  if (kind === "existing-conflict") r.requiredOptionReferences = [id(6), id(7)];
  expect(() => parseCatalogOptionSetEditorContent(f.source, f.details)).toThrow();
});
it.each(["duplicate", "brand-reference", "channel", "zone", "offset", "end"])(
  "refuses invalid %s scope/period",
  (kind) => {
    const f = fixture(),
      s = f.details.scopeSet[0];
    if (!s) throw new Error("missing synthetic scope");
    if (kind === "duplicate") f.details.scopeSet.push(s);
    if (kind === "brand-reference") s.reference = id(2);
    if (kind === "channel") {
      s.level = "Channel";
      s.reference = "POS";
      s.channelCodes = ["CUSTOMER_PWA"];
    }
    if (kind === "zone") f.details.effectivePeriod.timeZone = "Unknown/Zone";
    if (kind === "offset") f.details.effectivePeriod.effectiveFrom.utcOffsetMinutes = 60;
    if (kind === "end")
      f.details.effectivePeriod.effectiveUntil = { ...f.details.effectivePeriod.effectiveFrom };
    expect(() => parseCatalogOptionSetEditorContent(f.source, f.details)).toThrow();
  },
);
it("refuses accessors, sparse/oversized content and client source status without evaluating getters", () => {
  const f = fixture(),
    getter = vi.fn(() => []),
    d = { ...f.details };
  Object.defineProperty(d, "optionDetails", { get: getter, enumerable: true });
  expect(() => parseCatalogOptionSetEditorContent(f.source, d)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  delete f.details.optionDetails[0];
  expect(() => parseCatalogOptionSetEditorContent(f.source, f.details)).toThrow();
  const complete = fixture();
  expect(() =>
    parseCatalogOptionSetEditorContent(complete.source, {
      ...complete.details,
      currentSourceStatus: "Ready",
    }),
  ).toThrow();
  expect(() =>
    parseCatalogOptionSetEditorContent(complete.source, {
      ...complete.details,
      conditionalRules: Array.from({ length: 101 }, (_, n) => ({
        ruleReference: id(300 + n),
        whenAllSelected: [id(5)],
        requiredOptionReferences: [id(6)],
      })),
    }),
  ).toThrow();
});
it.each(["source", "content", "configuration"])(
  "refuses a mismatched full transition %s fingerprint",
  (kind) => {
    const f = fixture(),
      t = transition(f);
    if (kind === "source") t.sourceDigest = "sha256:" + "b".repeat(64);
    if (kind === "content") t.contentDigest = "sha256:" + "b".repeat(64);
    if (kind === "configuration") t.configurationDigest = "sha256:" + "b".repeat(64);
    expect(() =>
      createCatalogFullOptionSetPublicationMaterialization(f.source, f.details, t),
    ).toThrow();
  },
);
it.each(["media", "borrowed-core", "operation", "eligibility", "legacy"])(
  "refuses %s stored full content tampering",
  (kind) => {
    const f = fixture(),
      result = createCatalogFullOptionSetPublicationMaterialization(
        f.source,
        f.details,
        transition(f),
      ),
      c = JSON.parse(JSON.stringify(result.content));
    if (kind === "media") c.editorContent.optionDetails[0].media.assetVersionReference = id(999);
    if (kind === "borrowed-core") c.editorContent.sourceAggregate.aggregateVersion++;
    if (kind === "operation") c.supportedContent.publicationOperationReference = id(999);
    if (kind === "eligibility") c.eligibility = "Pass";
    if (kind === "legacy") c.profile = "CatalogSupportedOptionSetDraftContentV1";
    expect(() => parseCatalogFullOptionSetPublicationContent(c)).toThrow();
  },
);
