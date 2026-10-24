import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
import { parseCatalogProductWarningAcknowledgementReferenceRequest } from "../contracts/product-warning-acknowledgement-reference-request.js";
import {
  buildCatalogProductPublicationReferenceProvenance as build,
  parseCatalogProductPublicationReferenceProvenance as parse,
  bindCatalogProductPublicationReferenceProvenanceToPublication as bind,
} from "../contracts/product-publication-reference-provenance.js";
import { buildProductVariantIdentityHistory } from "../contracts/product-variant-identity-history.js";
const id = (n: number) => "01902500-0004-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-03T12:00:00.000Z",
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// Controlled immutable history and command metadata; no publication qualification is asserted.
function fixture(kind: "User" | "System" | "Ack" = "User", legacy = false) {
  const editorContent = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: {},
    localizedDescriptions: { "en-CA": "Private prose" },
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
  const first = parseProductAggregate({
    productReference: id(4),
    brandReference: id(2),
    internalCode: "PROVENANCE",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(3),
    draft: {
      versionReference: id(5),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "First" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      ...(legacy ? {} : { editorContent }),
    },
  });
  const second = parseProductAggregate({
    ...first,
    aggregateVersion: 2,
    updatedAt: time(1),
    draft: { ...first.draft, updatedAt: time(1), localizedNames: { "en-CA": "Second" } },
  });
  const aggregate = parseProductAggregate({ ...second, aggregateVersion: 3, updatedAt: time(2) });
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const command = parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: kind === "System" ? "System" : "User",
    operationReference: id(8),
    productReference: id(4),
    versionReference: id(5),
    expectedProductAggregateVersion: 3,
    expectedPublicationVersion: kind === "System" ? 1 : 0,
    action: kind === "System" ? "ActivateScheduled" : "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Store", reference: id(6), channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: kind === "System" ? id(12) : null,
    replacementVersionReference: null,
    successorDraftVersionReference: kind === "System" ? id(13) : null,
    occurredAt: time(3),
    reasonCode: "SYNTHETIC",
    replacementIntent: { ...body, digest: hash(body) },
    replacementIntentDigest: hash(body),
  });
  const ack = {
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    action: "AcknowledgeProductPublicationWarnings",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(8),
    productReference: id(4),
    versionReference: id(5),
    expectedProductAggregateVersion: 3,
    reportOperationReference: id(20),
    reportDigest: hash("report"),
    warningBindingDigest: hash("warning"),
    warningCodes: ["ChangeImpact"],
    reasonCode: "EXPLICIT_REVIEW",
    occurredAt: time(3),
  };
  const common = {
    originalIntentDigest: hash(kind === "Ack" ? ack : command),
    replacementIntentDigest: command.replacementIntentDigest,
    aggregateSnapshotDigest: hash(aggregate),
    observedAt: time(3),
    validUntil: time(1000),
  };
  const request =
    kind === "Ack"
      ? parseCatalogProductWarningAcknowledgementReferenceRequest({
          ...common,
          profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
          command: ack,
          currentPublicationDigest: hash("held publication"),
          publicationVersion: 1,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeDigest: hash(command.scopeSet),
          periodDigest: hash(command.effectivePeriod),
          policyReference: id(21),
          policyVersion: 1,
        })
      : parseCatalogProductPublicationReferenceRequestV2({
          ...common,
          profile: "CatalogProductPublicationReferenceRequestV2",
          command,
          currentPublicationDigest: kind === "System" ? hash("held publication") : null,
        });
  const source = {
    aggregateVersion: 3,
    observedAt: time(3),
    history: [first, second, aggregate].map((value, i) => ({
      aggregate: value,
      operationReference: id(30 + i),
      snapshotDigest: hash(value),
      coherent: true,
    })),
  };
  return { request, source, aggregate, first, second, command };
}

it.each(["User", "System", "Ack"] as const)(
  "%s retains exact original request and unchanged Variant bytes from one history",
  (kind) => {
    const f = fixture(kind),
      snapshot = build(f.source, f.request, time(3));
    expect(parse(snapshot)).toEqual(snapshot);
    expect(snapshot.request).toEqual(f.request);
    expect(snapshot.variantHistory).toEqual(
      buildProductVariantIdentityHistory(f.source, id(2), {
        productReference: id(4),
        expectedAggregateVersion: 3,
        originalIntentDigest: f.request.originalIntentDigest,
      }),
    );
    expect(snapshot.operationProvenance).toHaveLength(3);
    expect(snapshot.operationProvenance[0]?.fullIdentity).not.toEqual(
      snapshot.operationProvenance[1]?.fullIdentity,
    );
    expect(snapshot.operationProvenance[0]?.referenceConfiguration).toEqual(
      snapshot.operationProvenance[1]?.referenceConfiguration,
    );
    expect(JSON.stringify(snapshot)).not.toContain("Private prose");
    expect(Object.isFrozen(snapshot.operationProvenance[0]?.fullIdentity)).toBe(true);
  },
);
it("legacy editor absence is explicitly unavailable rather than promoted fallback hashes", () => {
  const f = fixture("User", true),
    snapshot = build(f.source, f.request, time(3));
  expect(
    snapshot.operationProvenance.every((entry) => entry.fullIdentity.coverage === "Unavailable"),
  ).toBe(true);
  expect(snapshot.operationProvenance[0]?.fullIdentity).toEqual({
    coverage: "Unavailable",
    reason: "LegacyEditorContentAbsent",
  });
});
it.each(["gap", "hash", "coherence", "operation", "lastHash", "future", "expired"])(
  "rejects %s before exposing a companion",
  (kind) => {
    const f = fixture(),
      raw = structuredClone(f.source);
    const first = raw.history[0],
      last = raw.history[2];
    if (!first || !last) throw new Error("Missing fixture row");
    if (kind === "gap") raw.history.splice(1, 1);
    if (kind === "hash") first.snapshotDigest = hash("transplant");
    if (kind === "coherence") first.coherent = false;
    if (kind === "operation") last.operationReference = first.operationReference;
    if (kind === "future") raw.observedAt = time(1001);
    const request =
      kind === "lastHash" ? { ...f.request, aggregateSnapshotDigest: hash("other") } : f.request;
    expect(() => build(raw, request, kind === "expired" ? time(1000) : time(3))).toThrow();
  },
);
it("independently parses entries without invoking accessors and binds actual SQL observation", () => {
  const f = fixture(),
    snapshot = build(f.source, f.request, time(3));
  let reads = 0;
  const hostile = { ...snapshot };
  Object.defineProperty(hostile, "operationProvenance", {
    enumerable: true,
    get() {
      reads++;
      return snapshot.operationProvenance;
    },
  });
  expect(() => parse(hostile)).toThrow();
  expect(reads).toBe(0);
  expect(() => parse({ ...snapshot, observedAt: time(4) })).toThrow();
  const raw = structuredClone(snapshot),
    entry = raw.operationProvenance[0];
  if (!entry) throw new Error("Missing fixture row");
  Object.assign(entry, { resultAggregateVersion: 2 });
  const { digest: _digest, ...body } = raw;
  void _digest;
  expect(() => parse({ ...body, digest: hash(body) })).toThrow();
});
it("the last full identity must bind the actual full command target, even if its request hash is recomputed", () => {
  const f = fixture();
  const command = parseProductPublicationCommandV2({
    ...f.command,
    contentDigest: hash("wrong target"),
  });
  const request = parseCatalogProductPublicationReferenceRequestV2({
    ...f.request,
    command,
    originalIntentDigest: hash(command),
  });
  expect(() => build(f.source, request, time(3))).toThrow();
});
function publication(f: ReturnType<typeof fixture>, state: "Scheduled" | "Published") {
  const identity = deriveCatalogProductPublicationContentIdentity(f.second);
  return parseProductPublicationVersionV2({
    profile: "CatalogProductPublicationVersionV2",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    versionReference: id(5),
    publicationVersion: 3,
    productAggregateVersion: 2,
    state,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: f.command.scopeSet,
    scopeDigest: hash(f.command.scopeSet),
    effectivePeriod: f.command.effectivePeriod,
    periodDigest: hash(f.command.effectivePeriod),
    validationEvidenceReference: id(40),
    validationDecision: "Pass",
    approvalPolicy: "NotRequired",
    policyReference: id(41),
    policyVersion: 1,
    reviewReference: id(42),
    reviewVersion: 1,
    submittedByActorReference: id(3),
    approvalEvidenceReference: null,
    scheduleReference: state === "Scheduled" ? id(43) : null,
    scheduleVersion: state === "Scheduled" ? 1 : 0,
    publishedAt: state === "Published" ? time(2) : null,
    supersededAt: null,
    supersededByVersionReference: null,
    successorDraftVersionReference: state === "Published" ? id(44) : null,
    operationReference: id(32),
    intentDigest: hash("actual original publication"),
    actorReference: id(3),
    actorKind: "User",
    occurredAt: time(2),
    reasonCode: "SYNTHETIC",
    replacementIntent: f.command.replacementIntent,
    replacementIntentDigest: f.command.replacementIntentDigest,
  });
}
it.each(["Scheduled", "Published"] as const)(
  "%s uses exact pre-root identity plus next root operation, not same version",
  (state) => {
    const f = fixture(),
      snapshot = build(f.source, f.request, time(3)),
      p = publication(f, state);
    expect(bind(snapshot, p)).toEqual(snapshot.operationProvenance[1]);
    const old = deriveCatalogProductPublicationContentIdentity(f.first);
    for (const patch of [
      { contentDigest: old.contentDigest },
      { productAggregateVersion: 1 },
      { operationReference: id(99) },
      { occurredAt: time(3) },
      { productReference: id(99) },
    ])
      expect(() => bind(snapshot, { ...p, ...patch })).toThrow();
  },
);
it("a legacy relevant publication retains unavailable identity explicitly", () => {
  const f = fixture("User", true),
    snapshot = build(f.source, f.request, time(3));
  expect(bind(snapshot, publication(f, "Scheduled")).fullIdentity.coverage).toBe("Unavailable");
});
it("Published binds its pre-root even when the result root is a different successor Draft", () => {
  const f = fixture(),
    p = publication(f, "Published");
  const successor = parseProductAggregate({
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      versionReference: id(44),
      baseVersionReference: id(5),
      localizedNames: { "en-CA": "New successor" },
    },
  });
  const identity = deriveCatalogProductPublicationContentIdentity(successor);
  const command = parseProductPublicationCommandV2({
    ...f.command,
    versionReference: id(44),
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
  });
  const request = parseCatalogProductPublicationReferenceRequestV2({
    ...f.request,
    command,
    originalIntentDigest: hash(command),
    aggregateSnapshotDigest: hash(successor),
  });
  const last = f.source.history[2];
  if (!last) throw new Error("Missing fixture row");
  const source = {
    ...f.source,
    history: [
      ...f.source.history.slice(0, 2),
      { ...last, aggregate: successor, snapshotDigest: hash(successor) },
    ],
  };
  const snapshot = build(source, request, time(3));
  expect(bind(snapshot, p)).toEqual(snapshot.operationProvenance[1]);
  expect(snapshot.operationProvenance[2]?.versionReference).toBe(id(44));
  expect(bind(snapshot, p).fullIdentity).not.toEqual(snapshot.operationProvenance[2]?.fullIdentity);
});
