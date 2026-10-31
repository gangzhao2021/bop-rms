import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductPublicationVersion } from "../contracts/product-publication.js";
import { buildCatalogProductEditorSnapshot } from "../contracts/product-editor-snapshot.js";
import { buildProductPublicationSourceSnapshot } from "../contracts/product-publication-source.js";
import { buildCatalogProductPublicationManagement } from "../contracts/product-publication-management.js";
import { expect, it } from "vitest";
const id = (n: number) => "01902441-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T22:00:00.000Z";
function aggregate() {
  return {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "EDITOR",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 3,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic editor" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: { "en-CA": "Synthetic complete description" },
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  };
}

function fixture(historyAt = at) {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(20) },
    query = { productReference: id(5), expectedAggregateVersion: 3 };
  const editor = buildCatalogProductEditorSnapshot(aggregate(), scope, query, at);
  const history = buildProductPublicationSourceSnapshot(
    { aggregateVersion: 3, observedAt: historyAt, revisions: [] },
    scope,
    query,
    historyAt,
  );
  return { scope, query, editor, history };
}
it("joins exact current owning identities without manufacturing publication zero or qualification", () => {
  const f = fixture(),
    r = buildCatalogProductPublicationManagement(f.editor, f.history, f.scope, f.query, at);
  expect(r).toMatchObject({
    profile: "CatalogProductPublicationManagementV1",
    aggregateVersion: 3,
    storeReference: id(20),
    coverage: "CompleteRecordedPublicationManagement",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    validUntil: "2026-09-30T22:00:05.000Z",
    versions: [],
  });
  expect(r.draft).toEqual({
    versionReference: id(6),
    contentDigest: f.editor.contentDigest,
    configurationDigest: f.editor.configurationDigest,
    contentStatus: "Present",
  });
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.draft)).toBe(true);
});
it("uses latest observation and shortest exclusive original lease", () => {
  const f = fixture("2026-09-30T22:00:02.000Z"),
    r = buildCatalogProductPublicationManagement(
      f.editor,
      f.history,
      f.scope,
      f.query,
      "2026-09-30T22:00:04.999Z",
    );
  expect(r.observedAt).toBe("2026-09-30T22:00:02.000Z");
  expect(r.validUntil).toBe("2026-09-30T22:00:05.000Z");
  for (const t of [at, "2026-09-30T22:00:05.000Z"])
    expect(() =>
      buildCatalogProductPublicationManagement(f.editor, f.history, f.scope, f.query, t),
    ).toThrow();
});
it.each([
  "tenantReference",
  "brandReference",
  "productReference",
  "aggregateVersion",
  "digest",
  "eligibility",
  "coverage",
  "profile",
])("refuses rebound owning history %s", (key) => {
  const f = fixture(),
    v = { ...f.history, [key]: key === "aggregateVersion" ? 4 : id(99) };
  expect(() =>
    buildCatalogProductPublicationManagement(f.editor, v, f.scope, f.query, at),
  ).toThrow();
});
it.each([
  "contentDigest",
  "configurationDigest",
  "validUntil",
  "aggregateVersion",
  "digest",
  "publishValidation",
])("refuses rebound complete editor %s", (key) => {
  const f = fixture(),
    v = { ...f.editor, [key]: key === "aggregateVersion" ? 4 : id(99) };
  expect(() =>
    buildCatalogProductPublicationManagement(v, f.history, f.scope, f.query, at),
  ).toThrow();
});
it("retains unavailable legacy complete content without inferring eligibility", () => {
  const f = fixture(),
    a = aggregate();
  Reflect.deleteProperty(a.draft, "editorContent");
  const editor = buildCatalogProductEditorSnapshot(a, f.scope, f.query, at);
  expect(
    buildCatalogProductPublicationManagement(editor, f.history, f.scope, f.query, at).draft
      .contentStatus,
  ).toBe("Unavailable");
});
it("refuses missing Store and invalid current expected revision", () => {
  const f = fixture();
  expect(() =>
    buildCatalogProductPublicationManagement(
      f.editor,
      f.history,
      { ...f.scope, storeReference: "invalid" },
      f.query,
      at,
    ),
  ).toThrow();
  expect(() =>
    buildCatalogProductPublicationManagement(
      f.editor,
      f.history,
      f.scope,
      { ...f.query, expectedAggregateVersion: 4 },
      at,
    ),
  ).toThrow();
});
it("never invokes hostile snapshot getters", () => {
  const f = fixture(),
    getter = () => {
      throw Error("must not execute");
    };
  const editor = { ...f.editor };
  Object.defineProperty(editor, "contentDigest", { enumerable: true, get: getter });
  expect(() =>
    buildCatalogProductPublicationManagement(editor, f.history, f.scope, f.query, at),
  ).toThrow();
});

function recordedFixture() {
  const f = fixture(),
    scopeSet = [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod = {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    };
  const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const revisions = [1, 2].map((n) => {
    const a = { ...aggregate(), aggregateVersion: n + 1 };
    const v = parseProductPublicationVersion({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      versionReference: id(6),
      publicationVersion: n,
      productAggregateVersion: n,
      state: "Draft",
      contentDigest: f.editor.contentDigest,
      configurationDigest: f.editor.configurationDigest,
      scopeSet,
      scopeDigest: hash(scopeSet),
      effectivePeriod,
      periodDigest: hash(effectivePeriod),
      validationEvidenceReference: id(30 + n),
      validationDecision: "HardError",
      policyReference: id(40),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      reviewReference: null,
      reviewVersion: null,
      submittedByActorReference: null,
      approvalEvidenceReference: null,
      scheduleReference: null,
      scheduleVersion: 0,
      publishedAt: null,
      supersededAt: null,
      supersededByVersionReference: null,
      successorDraftVersionReference: null,
      operationReference: id(50 + n),
      intentDigest: hash(n),
      actorReference: id(3),
      actorKind: "User",
      occurredAt: at,
      reasonCode: "SYNTHETIC_RECORDED",
    });
    return {
      action: "Validate",
      publication: v,
      aggregate: a,
      content: null,
      coherent: true,
      snapshotDigest: hash(a),
    };
  });
  const history = buildProductPublicationSourceSnapshot(
    { aggregateVersion: 3, observedAt: at, revisions },
    f.scope,
    f.query,
    at,
  );
  return { ...f, history };
}
it("preserves exact final recorded parameters while never promoting stored validation decisions", () => {
  const f = recordedFixture(),
    view = buildCatalogProductPublicationManagement(f.editor, f.history, f.scope, f.query, at);
  expect(view.versions[0]).toMatchObject({
    versionReference: id(6),
    publicationVersion: 2,
    state: "Draft",
    scheduleVersion: 0,
    effectivePeriod: { timeZone: "UTC" },
  });
  const version = view.versions[0];
  if (!version) throw new Error("Missing recorded version");
  expect(Object.hasOwn(version, "validationDecision")).toBe(false);
  expect(view.publishValidation).toBe("Incomplete");
});
it.each(["older", "missing"])("rejects a resealed source with a %s latest head", (mode) => {
  const f = recordedFixture();
  const { digest: originalDigest, ...body } = f.history;
  expect(originalDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  const first = f.history.history[0];
  if (!first) throw new Error("Missing recorded history");
  const changed = { ...body, latest: mode === "older" ? [first.publication] : [] };
  const rebound = { ...changed, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(changed)) };
  expect(() =>
    buildCatalogProductPublicationManagement(f.editor, rebound, f.scope, f.query, at),
  ).toThrow();
});
