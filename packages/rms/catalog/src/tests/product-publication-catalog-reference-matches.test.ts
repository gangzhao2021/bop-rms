import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate, type ProductAggregate } from "../contracts/product.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import {
  createCatalogProductPublicationMaterializationV2,
  deriveCatalogProductPublicationContentIdentity,
} from "../contracts/product-publication-content.js";
import { bindCatalogProductPublicationValidationContextV2 } from "../contracts/product-publication-validation-context-v2.js";
import { buildCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
import { parseCatalogProductWarningAcknowledgementReferenceRequest } from "../contracts/product-warning-acknowledgement-reference-request.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import { buildCatalogProductPublicationReferenceProvenance } from "../contracts/product-publication-reference-provenance.js";
import {
  buildCatalogProductRetirementCoverage,
  catalogProductRetirementSourceHeadDigest,
  type CatalogProductRetirementHistoryEntry,
} from "../contracts/product-publication-source-v2.js";
import {
  buildCatalogProductScopeRetirementHeader,
  type CatalogProductScopeRetirementHeader,
} from "../contracts/product-scope-retirement.js";
import {
  buildProductPublicationMenuReferenceSourceSnapshotV2,
  buildProductWarningAcknowledgementMenuReferenceSourceSnapshot,
} from "../contracts/menu-reference-source.js";
import {
  buildProductPublicationBundleReferenceSourceSnapshotV2,
  buildProductWarningAcknowledgementBundleReferenceSourceSnapshot,
} from "../contracts/bundle-reference-source.js";
import {
  buildProductPublicationAvailabilityReferenceSourceSnapshotV2,
  buildProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
} from "../contracts/availability-reference-source.js";
import { matchCatalogProductPublicationReferenceGraphs as match } from "../application/product-publication-catalog-reference-matches.js";

const id = (n: number) => "019a2421-0014-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-03T10:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const noneBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
const none = { ...noneBody, digest: hash(noneBody) };
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing synthetic fixture");
  return value;
}
function reseal<T extends { readonly digest: string }>(value: T) {
  const { digest, ...body } = value;
  void digest;
  return { ...body, digest: hash(body) };
}
function sku(n: number) {
  return {
    skuReference: id(n),
    productReference: id(1),
    brandReference: id(2),
    skuCode: "MEMBER_" + n,
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic member" },
    variantSelections: [],
    unitOfSale: "EA",
    unitQuantity: "1",
    createdAt: at,
    createdByActorReference: id(3),
  };
}
const editor = {
  profile: "CatalogProductEditorContentV1",
  localizedShortDescriptions: {},
  localizedDescriptions: {},
  preparationNotes: {},
  tagReferences: [],
  attributeValues: [],
  media: [],
  variantDimensions: [],
  variantCombinations: [],
  optionRules: [],
  allergenReferences: [],
  nutritionProfile: null,
};
// Controlled immutable histories and explicit synthetic qualification. Real owning
// parsers/planners bind the records; these fixtures do not claim actual SQL authority.
function fixture(full = true) {
  let root = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "REFERENCE_MATCHES",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(3),
    draft: {
      versionReference: id(40),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [sku(60)],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      ...(full ? { editorContent: editor } : {}),
    },
  });
  const history: CatalogProductRetirementHistoryEntry[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [],
    operations: {
      aggregate: ProductAggregate;
      operationReference: string;
      snapshotDigest: string;
      coherent: boolean;
    }[] = [];
  function commit(operationReference: string) {
    operations.push({
      aggregate: root,
      operationReference,
      snapshotDigest: hash(root),
      coherent: true,
    });
  }
  commit(id(100));
  function current() {
    const p =
      [...history]
        .reverse()
        .find((h) => h.publication.versionReference === root.draft.versionReference)?.publication ??
      null;
    if (p && !("profile" in p)) throw Error("V2 fixture only");
    return p;
  }
  function coverage() {
    return buildCatalogProductRetirementCoverage({
      tenantReference: id(10),
      brandReference: id(2),
      productReference: id(1),
      aggregateVersion: root.aggregateVersion,
      sourceRevision: String(root.aggregateVersion),
      observedAt: at,
      history,
      headers,
    });
  }
  function command(action: "Validate" | "SubmitReview" | "Publish" = "Validate") {
    const head = current(),
      identity = deriveCatalogProductPublicationContentIdentity(root);
    return parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(1000 + root.aggregateVersion),
      productReference: id(1),
      versionReference: root.draft.versionReference,
      expectedProductAggregateVersion: root.aggregateVersion,
      expectedPublicationVersion: head?.publicationVersion ?? 0,
      action,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(at), effectiveUntil: null },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: action === "Publish" ? id(40 + root.aggregateVersion) : null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
      replacementIntent: none,
      replacementIntentDigest: none.digest,
    });
  }
  function transition(action: "Validate" | "SubmitReview" | "Publish") {
    const c = command(action),
      before = coverage(),
      publication = planCatalogProductPublicationV2(c, current(), {
        now: at,
        productAggregateVersion: root.aggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        validation: {
          profile: "CatalogProductPublicationValidationV2",
          replacementIntentDigest: none.digest,
          evidenceReference: id(90),
          productAggregateVersion: root.aggregateVersion,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
          scopeDigest: hash(c.scopeSet),
          periodDigest: hash(c.effectivePeriod),
          policyReference: id(91),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: at,
          validUntil: plus(4000),
        },
        approval: null,
        reviewReference: action === "SubmitReview" ? id(92) : null,
        replacement: null,
      });
    headers.push(
      buildCatalogProductScopeRetirementHeader({
        publicationAction: action,
        publication,
        previousPublication: null,
        observedSourceRevision: before.sourceRevision,
        observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
          tenantReference: before.tenantReference,
          brandReference: before.brandReference,
          productReference: before.productReference,
          aggregateVersion: before.aggregateVersion,
          sourceRevision: before.sourceRevision,
          latest: before.latest,
        }),
      }),
    );
    root =
      publication.state === "Published"
        ? createCatalogProductPublicationMaterializationV2(root, publication).successor
        : parseProductAggregate({ ...root, aggregateVersion: root.aggregateVersion + 1 });
    history.push({ publicationAction: action, publication });
    commit(publication.operationReference);
    return publication;
  }
  function edit(skus = [60], tax: number | null = null) {
    root = parseProductAggregate({
      ...root,
      aggregateVersion: root.aggregateVersion + 1,
      draft: {
        ...root.draft,
        skus: skus.map(sku),
        taxClassificationReference: tax === null ? null : id(tax),
        editorContent: editor,
      },
    });
    commit(id(100 + root.aggregateVersion));
  }
  function packet(ack = false) {
    const c = command(),
      head = current(),
      publicationRequest = buildCatalogProductPublicationReferenceRequestV2(
        bindCatalogProductPublicationValidationContextV2({
          command: c,
          aggregate: root,
          current: head,
          content: null,
          observedAt: at,
        }),
        plus(3000),
      );
    let request:
      | typeof publicationRequest
      | ReturnType<typeof parseCatalogProductWarningAcknowledgementReferenceRequest> =
      publicationRequest;
    if (ack) {
      const p = required(head),
        a = parseCatalogProductPublicationWarningAcknowledgementCommand({
          profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
          action: "AcknowledgeProductPublicationWarnings",
          tenantReference: id(10),
          brandReference: id(2),
          actorReference: id(3),
          actorKind: "User",
          operationReference: id(8000),
          productReference: id(1),
          versionReference: root.draft.versionReference,
          expectedProductAggregateVersion: root.aggregateVersion,
          reportOperationReference: p.operationReference,
          reportDigest: hash("synthetic report"),
          warningBindingDigest: hash("synthetic warnings"),
          warningCodes: ["ChangeImpact"],
          reasonCode: "SYNTHETIC_ACK",
          occurredAt: at,
        });
      request = parseCatalogProductWarningAcknowledgementReferenceRequest({
        profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
        command: a,
        originalIntentDigest: hash(a),
        replacementIntentDigest: p.replacementIntentDigest,
        aggregateSnapshotDigest: hash(root),
        currentPublicationDigest: hash(p),
        publicationVersion: p.publicationVersion,
        contentDigest: p.contentDigest,
        configurationDigest: p.configurationDigest,
        scopeDigest: p.scopeDigest,
        periodDigest: p.periodDigest,
        policyReference: p.policyReference,
        policyVersion: p.policyVersion,
        observedAt: at,
        validUntil: plus(3000),
      });
    }
    return {
      request,
      referenceProvenance: buildCatalogProductPublicationReferenceProvenance(
        { aggregateVersion: root.aggregateVersion, observedAt: at, history: operations },
        request,
        at,
      ),
      publicationCoverage: coverage(),
    };
  }
  return { edit, transition, packet, root: () => root };
}
function placement(n: number, skuNumber = 60, version = 40) {
  return {
    reviewReference: id(200),
    sectionReference: id(201),
    placementReference: id(n),
    skuReference: id(skuNumber),
    productVersionReference: id(version),
  };
}
function menuRaw(placements = [placement(220)]) {
  const parent = {
    reviewReference: id(200),
    brandReference: id(2),
    menuReference: id(202),
    menuVersionReference: id(203),
    snapshotDigest: hash("menu"),
  };
  return {
    generation: "7",
    observedAt: at,
    counts: {
      reviews: "1",
      placements: String(placements.length),
      revisions: "2",
      releases: "1",
      periods: "1",
    },
    reviews: [{ ...parent, createdAt: at, precise: true }],
    placements,
    revisions: [
      { ...parent, lifecycleVersion: 3, state: "Published", changedAt: at, precise: true },
      { ...parent, lifecycleVersion: 4, state: "Superseded", changedAt: at, precise: true },
    ],
    releases: [
      {
        ...parent,
        releaseReference: id(204),
        lifecycleVersion: 3,
        releaseSequence: 1,
        previousReleaseReference: null,
        releaseKind: "Publish",
        createdAt: at,
        precise: true,
      },
    ],
    periods: [
      {
        timingReference: id(205),
        releaseReference: id(204),
        brandReference: id(2),
        menuReference: id(202),
        timeZone: "UTC",
        effectiveFrom: "2027-01-01T00:00:00.000Z",
        effectiveUntil: null,
        periodDigest: hash("menu period"),
        createdAt: at,
        precise: true,
      },
    ],
  };
}
function bundleRaw() {
  const group = (old = false) => ({
    groupReference: id(old ? 305 : 304),
    bundleVersionReference: id(old ? 303 : 302),
    bundleReference: id(300),
    brandReference: id(2),
  });
  const members = [
    { ...group(), sellableType: "Product", sellableReference: id(1) },
    { ...group(), sellableType: "Sku", sellableReference: id(60) },
    { ...group(true), sellableType: "Sku", sellableReference: id(61) },
    { ...group(), sellableType: "Product", sellableReference: id(999) },
  ];
  return {
    generation: "8",
    observedAt: at,
    counts: { bundles: "1", versions: "2", groups: "2", members: String(members.length) },
    bundles: [
      {
        bundleReference: id(300),
        brandReference: id(2),
        aggregateVersion: 2,
        lifecycle: "Draft",
        currentVersionReference: id(302),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [false, true].map((old) => ({
      bundleVersionReference: id(old ? 303 : 302),
      bundleReference: id(300),
      brandReference: id(2),
      versionStatus: old ? "Published" : "Draft",
      versionUpdatedAt: at,
      publishedAt: old ? at : null,
      validationDigest: old ? hash("bundle validation") : null,
      precise: true,
    })),
    groups: [group(), group(true)],
    members,
  };
}
function rule(n: number, sellableType = "Product", target = 1) {
  return {
    ruleReference: id(n),
    brandReference: id(2),
    sellableType,
    sellableReference: id(target),
    storeReference: id(20),
    aggregateVersion: 1,
    lifecycle: "Inactive",
    effectiveFrom: "2027-01-01T00:00:00.000Z",
    effectiveUntil: null,
    updatedAt: at,
    precise: true,
  };
}
function availabilityRaw(
  rules = [
    rule(400),
    rule(401, "Sku", 60),
    rule(402, "Sku", 61),
    rule(403, "Bundle", 300),
    rule(404, "Bundle", 999),
    rule(405, "Product", 999),
  ],
) {
  return { generation: "9", observedAt: at, rootCount: String(rules.length), rules };
}
function inputs(
  packet: ReturnType<ReturnType<typeof fixture>["packet"]>,
  menu = menuRaw(),
  availability = availabilityRaw(),
) {
  const request = packet.request;
  return {
    ...packet,
    menuSource:
      request.profile === "CatalogProductPublicationReferenceRequestV2"
        ? buildProductPublicationMenuReferenceSourceSnapshotV2(menu, request, at)
        : buildProductWarningAcknowledgementMenuReferenceSourceSnapshot(menu, request, at),
    bundleSource:
      request.profile === "CatalogProductPublicationReferenceRequestV2"
        ? buildProductPublicationBundleReferenceSourceSnapshotV2(bundleRaw(), request, at)
        : buildProductWarningAcknowledgementBundleReferenceSourceSnapshot(bundleRaw(), request, at),
    availabilitySource:
      request.profile === "CatalogProductPublicationReferenceRequestV2"
        ? buildProductPublicationAvailabilityReferenceSourceSnapshotV2(availability, request, at)
        : buildProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot(
            availability,
            request,
            at,
          ),
    now: at,
  };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });

it("keeps same-version configurations separate and requires the version and SKU in the same graph", () => {
  const f = fixture();
  f.edit([61]);
  const r = match(
    inputs(
      f.packet(),
      menuRaw([
        placement(220),
        placement(221, 61),
        placement(222, 60, 999),
        placement(223, 99),
        placement(224, 99, 999),
      ]),
    ),
  );
  expect(r.configurations).toHaveLength(2);
  expect(
    r.configurations.map((c) =>
      c.menuReferences.flatMap((m) => m.placements.map((p) => p.placementReference)),
    ),
  ).toEqual([[id(220)], [id(221)]]);
  expect(
    r.unresolvedMenuReferences.flatMap((m) => m.placements.map((p) => p.placementReference)),
  ).toEqual([id(222), id(223)]);
  expect(r.currentReferenceConfigurationDigest).toBe(
    r.configurations[1]?.referenceConfigurationDigest,
  );
  expect(r.publicationCoverage.entries).toEqual([]);
  expect(r.configurations[0]?.menuReferences[0]).toMatchObject({
    lifecycle: { state: "Superseded", version: 4 },
    releases: [{ releaseKind: "Publish" }],
    periods: [{ effectiveFrom: "2027-01-01T00:00:00.000Z" }],
  });
  expect(r).toMatchObject({
    applicability: "NotEvaluated",
    saleEligibility: "NotEvaluated",
    observedAt: at,
    validUntil: plus(3000),
  });
});
it("deduplicates identical reference graphs across later roots without inventing publication coverage", () => {
  const f = fixture();
  f.edit();
  f.edit();
  const p = f.packet(),
    r = match(inputs(p));
  expect(p.referenceProvenance.operationProvenance).toHaveLength(3);
  expect(r.configurations).toHaveLength(1);
  expect(r.configurations[0]?.menuReferences[0]?.placements).toHaveLength(1);
  expect(r.publicationCoverage.entries).toEqual([]);
});
it("accepts owner-proved complete empty graphs while refusing a missing source", () => {
  const packet = fixture().packet(),
    request = packet.request;
  if (request.profile !== "CatalogProductPublicationReferenceRequestV2")
    throw Error("Publication fixture required");
  const input = {
      ...packet,
      menuSource: buildProductPublicationMenuReferenceSourceSnapshotV2(
        {
          generation: null,
          observedAt: at,
          counts: { reviews: "0", placements: "0", revisions: "0", releases: "0", periods: "0" },
          reviews: [],
          placements: [],
          revisions: [],
          releases: [],
          periods: [],
        },
        request,
        at,
      ),
      bundleSource: buildProductPublicationBundleReferenceSourceSnapshotV2(
        {
          generation: null,
          observedAt: at,
          counts: { bundles: "0", versions: "0", groups: "0", members: "0" },
          bundles: [],
          versions: [],
          groups: [],
          members: [],
        },
        request,
        at,
      ),
      availabilitySource: buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
        { generation: null, observedAt: at, rootCount: "0", rules: [] },
        request,
        at,
      ),
      now: at,
    },
    result = match(input);
  expect(result.generations).toEqual({ menu: "0", bundle: "0", availability: "0" });
  expect(result.configurations[0]).toMatchObject({
    menuReferences: [],
    bundleReferences: [],
    availabilityReferences: [],
    bundleAvailabilityReferences: [],
  });
  expect(() => match({ ...input, menuSource: null })).toThrow(denied);
});
it("binds actual Published content to the exact historical root rather than the current successor", () => {
  const f = fixture();
  f.edit([61], 50);
  f.transition("Validate");
  f.transition("SubmitReview");
  const published = f.transition("Publish");
  f.edit([62], 51);
  const r = match(
      inputs(
        f.packet(),
        menuRaw([
          placement(220),
          placement(221, 61),
          placement(
            222,
            62,
            Number.parseInt(required(published.successorDraftVersionReference).slice(-12), 16),
          ),
        ]),
      ),
    ),
    entry = required(r.publicationCoverage.entries[0]);
  expect(entry.sourceOperation.resultAggregateVersion).toBe(published.productAggregateVersion);
  expect(entry.referenceConfiguration).toMatchObject({
    versionReference: id(40),
    skuReferences: [id(61)],
    taxClassificationReference: id(50),
  });
  expect(entry.referenceConfiguration.versionReference).not.toBe(f.root().draft.versionReference);
  const configuration = required(
    r.configurations.find(
      (c) => c.referenceConfigurationDigest === hash(entry.referenceConfiguration),
    ),
  );
  expect(
    configuration.menuReferences.flatMap((m) => m.placements.map((p) => p.placementReference)),
  ).toEqual([id(221)]);
  expect(
    r.configurations.find(
      (c) => c.referenceConfigurationDigest === r.currentReferenceConfigurationDigest,
    )?.referenceConfiguration.skuReferences,
  ).toEqual([id(62)]);
});
it("retains historical Bundle contexts and joins Bundle Availability once per actual rule", () => {
  const f = fixture();
  f.edit([61]);
  const r = match(inputs(f.packet())),
    old = required(r.configurations[0]),
    current = required(r.configurations[1]);
  expect(old.bundleReferences.map((v) => v.member.sellableReference)).toEqual([id(1), id(60)]);
  expect(current.bundleReferences.map((v) => v.member.sellableReference)).toEqual([id(1), id(61)]);
  expect(current.bundleReferences.find((v) => v.member.sellableReference === id(61))).toMatchObject(
    {
      isCurrentBundleVersion: false,
      version: { versionStatus: "Published" },
      bundle: { lifecycle: "Draft" },
    },
  );
  expect(old.availabilityReferences.map((v) => v.ruleReference)).toEqual([id(400), id(401)]);
  expect(current.availabilityReferences.map((v) => v.ruleReference)).toEqual([id(400), id(402)]);
  expect(old.bundleAvailabilityReferences).toHaveLength(1);
  expect(old.bundleAvailabilityReferences[0]).toMatchObject({
    bundleReference: id(300),
    rule: { ruleReference: id(403), lifecycle: "Inactive" },
  });
  expect(r.generations).toEqual({ menu: "7", bundle: "8", availability: "9" });
});
it("uses the independent Ack request and refuses a publication source substituted into its packet", () => {
  const f = fixture();
  f.transition("Validate");
  const p = inputs(f.packet()),
    a = inputs(f.packet(true)),
    r = match(a);
  expect(r.request.profile).toBe("CatalogProductWarningAcknowledgementReferenceRequestV1");
  expect(r.request.command.purposeCode).toBe("CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT");
  expect(r.configurations.map((c) => c.referenceConfiguration)).toEqual(
    match(p).configurations.map((c) => c.referenceConfiguration),
  );
  expect(() => match({ ...a, menuSource: p.menuSource })).toThrow(denied);
});
it("preserves unrelated legacy graphs but rejects an actually Published head without full source identity", () => {
  const f = fixture(false);
  f.edit([61]);
  f.transition("Validate");
  f.transition("SubmitReview");
  const published = f.transition("Publish"),
    packet = f.packet(),
    r = match(inputs(packet));
  expect(packet.referenceProvenance.operationProvenance[0]?.fullIdentity.coverage).toBe(
    "Unavailable",
  );
  expect(
    r.configurations.some((c) => c.referenceConfiguration.skuReferences.includes(id(60))),
  ).toBe(true);
  const bad = structuredClone(packet.referenceProvenance);
  Object.assign(required(bad.operationProvenance[published.productAggregateVersion - 1]), {
    fullIdentity: { coverage: "Unavailable", reason: "LegacyEditorContentAbsent" },
  });
  expect(() => match(inputs({ ...packet, referenceProvenance: reseal(bad) }))).toThrow(denied);
});
it.each([-1, 3000, 4000])("rejects time outside the original request lease (%s)", (offset) => {
  const p = inputs(fixture().packet());
  expect(() => match({ ...p, now: plus(offset) })).toThrow(denied);
});
it.each(["head", "root", "operation", "target"])(
  "refuses independently altered request %s",
  (kind) => {
    const p = inputs(fixture().packet()),
      request = structuredClone(p.request);
    if (kind === "head") Object.assign(request, { currentPublicationDigest: hash("other head") });
    if (kind === "root") Object.assign(request, { aggregateSnapshotDigest: hash("other root") });
    if (kind === "operation") Object.assign(request.command, { operationReference: id(9999) });
    if (kind === "target")
      Object.assign(request, { replacementIntentDigest: hash("other target") });
    expect(() => match({ ...p, request })).toThrow(denied);
  },
);
it("rejects resealed orphan source relations and does not invoke descriptor getters", () => {
  const p = inputs(fixture().packet()),
    bad = structuredClone(p.menuSource),
    getter = vi.fn(() => p.menuSource);
  Object.assign(required(bad.placements[0]), { reviewReference: id(999) });
  expect(() => match({ ...p, menuSource: reseal(bad) })).toThrow(denied);
  const accessor = { ...p };
  Object.defineProperty(accessor, "menuSource", { enumerable: true, get: getter });
  expect(() => match(accessor)).toThrow(denied);
  expect(getter).not.toHaveBeenCalled();
  expect(() => match(Object.assign({ ...p }, { unexpected: null }))).toThrow(denied);
});
it("detaches and freezes the complete derived result and binds every source digest", () => {
  const p = structuredClone(inputs(fixture().packet())),
    result = match(p);
  Object.assign(required(p.menuSource.placements[0]), { skuReference: id(999) });
  expect(result.configurations[0]?.menuReferences[0]?.placements[0]?.skuReference).toBe(id(60));
  expect(result.sourceDigests.menu).toBe(p.menuSource.digest);
  expect(result.sourceDigests.publicationCoverage).toBe(p.publicationCoverage.digest);
  expect(result.digest).toBe(reseal(result).digest);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.configurations)).toBe(true);
  expect(Object.isFrozen(result.configurations[0]?.bundleReferences[0]?.member)).toBe(true);
});
it("rejects the aggregate derived-output budget rather than truncating multiplied references", () => {
  const f = fixture();
  f.edit([60], 50);
  f.edit([60], 51);
  const raw = availabilityRaw(Array.from({ length: 3500 }, (_, i) => rule(10000 + i)));
  expect(() => match(inputs(f.packet(), menuRaw(), raw))).toThrow(denied);
  const one = fixture();
  one.edit();
  one.edit();
  const result = match(inputs(one.packet(), menuRaw(), raw));
  expect(result.configurations).toHaveLength(1);
  expect(result.configurations[0]?.availabilityReferences).toHaveLength(3500);
});
