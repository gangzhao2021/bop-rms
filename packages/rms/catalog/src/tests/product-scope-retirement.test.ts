import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseProductPublicationVersion,
  type ProductPublicationVersion,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationVersionV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import {
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import {
  bindCatalogProductScopeRetirementHeader,
  buildCatalogProductScopeRetirementHeader,
  parseCatalogProductScopeRetirementHeader,
} from "../contracts/product-scope-retirement.js";

const id = (n: number) => "01902431-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  before = "2026-10-02T10:00:00.000Z",
  at = "2026-10-02T12:00:00.000Z",
  end = "2026-10-02T13:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
function fixture() {
  const scopes = [30, 31].map((n) => ({
      level: "Store" as const,
      reference: id(n),
      channelCodes: ["WEB"],
      orderTypeCodes: ["PICKUP"],
    })),
    period = { timeZone: "UTC", effectiveFrom: boundary(before), effectiveUntil: null },
    previous = parseProductPublicationVersion({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(3),
      versionReference: id(4),
      publicationVersion: 3,
      productAggregateVersion: 5,
      state: "Published",
      contentDigest: hash("old content"),
      configurationDigest: hash("configuration"),
      scopeSet: scopes,
      scopeDigest: hash(scopes),
      effectivePeriod: period,
      periodDigest: hash(period),
      validationEvidenceReference: id(10),
      validationDecision: "Pass",
      policyReference: id(11),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      reviewReference: id(12),
      reviewVersion: 2,
      submittedByActorReference: id(13),
      approvalEvidenceReference: null,
      scheduleReference: null,
      scheduleVersion: 0,
      publishedAt: before,
      supersededAt: null,
      supersededByVersionReference: null,
      successorDraftVersionReference: id(15),
      operationReference: id(16),
      intentDigest: hash("old command"),
      actorReference: id(13),
      actorKind: "User",
      occurredAt: before,
      reasonCode: "SYNTHETIC_PUBLISH",
    });
  const intentBody = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: previous.versionReference,
      previousPublicationOperationReference: previous.operationReference,
      expectedPreviousPublicationVersion: previous.publicationVersion,
      previousIntentDigest: previous.intentDigest,
      previousScopeDigest: previous.scopeDigest,
      previousPeriodDigest: previous.periodDigest,
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(scopes[0]),
    },
    replacementIntent = parseCatalogProductScopeReplacementIntent({
      ...intentBody,
      digest: hash(intentBody),
    }),
    incomingPeriod = { ...period, effectiveFrom: boundary(at), effectiveUntil: boundary(end) },
    publication = parseProductPublicationVersionV2({
      ...previous,
      profile: "CatalogProductPublicationVersionV2",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
      versionReference: id(20),
      operationReference: id(21),
      intentDigest: hash("new full V2 command"),
      productAggregateVersion: 10,
      scopeSet: [scopes[0]],
      scopeDigest: hash([scopes[0]]),
      effectivePeriod: incomingPeriod,
      periodDigest: hash(incomingPeriod),
      contentDigest: hash("new content"),
      occurredAt: at,
      publishedAt: at,
      successorDraftVersionReference: id(22),
    });
  return {
    previous,
    publication,
    observedSourceRevision: "12",
    observedSourceHeadDigest: hash("held original source"),
  };
}
function build(patch: Record<string, unknown> = {}) {
  const f = fixture();
  return buildCatalogProductScopeRetirementHeader({
    publicationAction: "Publish",
    publication: f.publication,
    previousPublication: f.previous,
    observedSourceRevision: f.observedSourceRevision,
    observedSourceHeadDigest: f.observedSourceHeadDigest,
    ...patch,
  });
}
function rehash<T extends { digest: string }>(value: T): T {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: hash(body) } as T;
}
it("binds actual execution, full V2 result and unchanged canonical V1 target into one frozen retirement", () => {
  const f = fixture(),
    bytes = canonicalizeRfc8785(f.previous),
    header = build();
  expect(header.retirements).toHaveLength(1);
  expect(header).toMatchObject({
    publicationAction: "Publish",
    publicationSnapshotDigest: hash(f.publication),
    publicationIntentDigest: f.publication.intentDigest,
    recordedAt: at,
    sourceAggregateVersion: 10,
    resultAggregateVersion: 11,
  });
  expect(header.retirements[0]).toMatchObject({
    replacementIntent: f.publication.replacementIntent,
    previousPublicationDigest: hash(f.previous),
    retiredAt: at,
  });
  expect(
    bindCatalogProductScopeRetirementHeader(header, {
      publicationAction: "Publish",
      publication: f.publication,
      previousPublication: f.previous,
    }),
  ).toEqual(header);
  expect(canonicalizeRfc8785(f.previous)).toBe(bytes);
  expect(Object.isFrozen(header)).toBe(true);
  expect(Object.isFrozen(header.retirements)).toBe(true);
  expect(Object.isFrozen(header.retirements[0]?.replacementIntent)).toBe(true);
  const raw = structuredClone({ ...header, retirements: [...header.retirements] }),
    parsed = parseCatalogProductScopeRetirementHeader(raw);
  raw.retirements.splice(0);
  expect(parsed.retirements).toHaveLength(1);
  expect(parsed.retirements[0]).not.toBe(header.retirements[0]);
});
it("records an explicit empty header for non-publishing V2 transitions without consuming the proposed target", () => {
  const f = fixture(),
    draft = parseProductPublicationVersionV2({
      ...f.publication,
      state: "Draft",
      reviewReference: null,
      reviewVersion: null,
      submittedByActorReference: null,
      publishedAt: null,
      successorDraftVersionReference: null,
    });
  const header = build({
    publicationAction: "Validate",
    publication: draft,
    previousPublication: null,
  });
  expect(header.retirements).toEqual([]);
  expect(header.publicationSnapshotDigest).toBe(hash(draft));
  expect(draft.replacementIntentDigest).toBe(f.publication.replacementIntentDigest);
  expect(() => build({ publicationAction: "Validate", publication: draft })).toThrow();
  expect(() =>
    build({ publicationAction: "Publish", publication: draft, previousPublication: null }),
  ).toThrow();
});
it("requires an active original head and exact original tuple at actual publication time", () => {
  const f = fixture();
  const oldChanges: Partial<ProductPublicationVersion>[] = [
    { brandReference: id(99) },
    { operationReference: id(99) },
    { publicationVersion: 4 },
    { productAggregateVersion: 10 },
    { contentDigest: hash("changed") },
  ];
  for (const patch of oldChanges) {
    if (patch.contentDigest) {
      const header = build();
      expect(() =>
        bindCatalogProductScopeRetirementHeader(header, {
          publicationAction: "Publish",
          publication: f.publication,
          previousPublication: { ...f.previous, ...patch },
        }),
      ).toThrow();
    } else expect(() => build({ previousPublication: { ...f.previous, ...patch } })).toThrow();
  }
  const oldExpiry = { ...f.previous.effectivePeriod, effectiveUntil: boundary(at) };
  expect(() =>
    build({
      previousPublication: {
        ...f.previous,
        effectivePeriod: oldExpiry,
        periodDigest: hash(oldExpiry),
      },
    }),
  ).toThrow();
  expect(() => build({ publication: { ...f.publication, occurredAt: end } })).toThrow();
  expect(() => build({ publication: { ...f.publication, publishedAt: before } })).toThrow();
  expect(() =>
    build({ previousPublication: { ...f.previous, scopeSet: [...f.previous.scopeSet].reverse() } }),
  ).toThrow();
});
it("binds System activation to its schedule and actual instant, never its planned start", () => {
  const f = fixture(),
    activated: ProductPublicationVersionV2 = {
      ...f.publication,
      actorKind: "System",
      scheduleReference: id(40),
      scheduleVersion: 1,
    };
  expect(
    build({ publicationAction: "ActivateScheduled", publication: activated }).retirements[0]
      ?.retiredAt,
  ).toBe(at);
  expect(() => build({ publicationAction: "Publish", publication: activated })).toThrow();
  expect(() =>
    build({
      publicationAction: "ActivateScheduled",
      publication: { ...activated, scheduleReference: null, scheduleVersion: 0 },
    }),
  ).toThrow();
  expect(() => build({ publicationAction: "Supersede" })).toThrow();
});
it("rejects closed-shape, digest, cardinality, root and revision corruption without invoking accessors", () => {
  const header = build();
  for (const invalid of [
    { ...header, extra: true },
    { ...header, digest: hash("tamper") },
    { ...header, profile: undefined },
    rehash({ ...header, retirements: [...header.retirements, ...header.retirements] }),
    rehash({ ...header, resultAggregateVersion: header.resultAggregateVersion + 1 }),
    ...["0", "01", "9223372036854775808", 1].map((observedSourceRevision) =>
      rehash({ ...header, observedSourceRevision }),
    ),
    { ...header, observedSourceRevision: undefined },
    rehash({
      ...header,
      retirements: header.retirements.map((row) => rehash({ ...row, retiredAt: before })),
    }),
  ])
    expect(() => parseCatalogProductScopeRetirementHeader(invalid)).toThrow();
  const getter = vi.fn(() => at),
    hostile = { ...header };
  Object.defineProperty(hostile, "recordedAt", { enumerable: true, get: getter });
  expect(() => parseCatalogProductScopeRetirementHeader(hostile)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

function noneIntent() {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseCatalogProductPublicationReplacementIntent({ ...body, digest: hash(body) });
}
it.each(["Publish", "ActivateScheduled"] as const)(
  "binds an explicit zero-row None %s header, never an absent header",
  (publicationAction) => {
    const f = fixture(),
      replacementIntent = noneIntent();
    const publication = parseProductPublicationVersionV2({
      ...f.publication,
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
      ...(publicationAction === "ActivateScheduled"
        ? { actorKind: "System", scheduleReference: id(40), scheduleVersion: 1 }
        : {}),
    });
    const input = { publicationAction, publication, previousPublication: null };
    const header = build({ ...input });
    expect(header.retirements).toEqual([]);
    expect(bindCatalogProductScopeRetirementHeader(header, input)).toEqual(header);
    expect(header.publicationSnapshotDigest).toBe(hash(publication));
    expect(() => build({ ...input, previousPublication: f.previous })).toThrow();
    expect(() => bindCatalogProductScopeRetirementHeader(null, input)).toThrow();
    expect(() =>
      bindCatalogProductScopeRetirementHeader(
        rehash({ ...header, retirements: build().retirements }),
        input,
      ),
    ).toThrow();
    expect(() =>
      build({ ...input, publication: { ...publication, publishedAt: before } }),
    ).toThrow();
    expect(() =>
      build({ ...input, publication: { ...publication, occurredAt: end, publishedAt: end } }),
    ).toThrow();
  },
);
it("defers publishing cardinality to full intent binding without weakening Exact's required row", () => {
  const f = fixture(),
    empty = rehash({ ...build(), retirements: [] });
  expect(parseCatalogProductScopeRetirementHeader(empty).retirements).toEqual([]);
  expect(() =>
    bindCatalogProductScopeRetirementHeader(empty, {
      publicationAction: "Publish",
      publication: f.publication,
      previousPublication: f.previous,
    }),
  ).toThrow();
  const draft = parseProductPublicationVersionV2({
    ...f.publication,
    state: "Draft",
    reviewReference: null,
    reviewVersion: null,
    submittedByActorReference: null,
    publishedAt: null,
    successorDraftVersionReference: null,
  });
  const header = build({
    publicationAction: "Validate",
    publication: draft,
    previousPublication: null,
  });
  expect(() =>
    parseCatalogProductScopeRetirementHeader(
      rehash({ ...header, retirements: build().retirements }),
    ),
  ).toThrow();
});
it.each(["V1", "V2"] as const)(
  "binds a current canonical %s single-Store target without rewriting its bytes",
  (profile) => {
    const f = fixture(),
      selector = f.previous.scopeSet[0];
    if (!selector) throw new Error("Missing synthetic selector");
    const replacementIntent = noneIntent();
    const previous =
      profile === "V1"
        ? parseProductPublicationVersion({
            ...f.previous,
            scopeSet: [selector],
            scopeDigest: hash([selector]),
          })
        : parseProductPublicationVersionV2({
            ...f.previous,
            scopeSet: [selector],
            scopeDigest: hash([selector]),
            profile: "CatalogProductPublicationVersionV2",
            replacementIntent,
            replacementIntentDigest: replacementIntent.digest,
          });
    const exactBody = {
      ...parseCatalogProductScopeReplacementIntent(f.publication.replacementIntent),
      previousScopeDigest: previous.scopeDigest,
      previousIntentDigest: previous.intentDigest,
    };
    const exact = rehash(exactBody);
    const publication = parseProductPublicationVersionV2({
      ...f.publication,
      replacementIntent: exact,
      replacementIntentDigest: exact.digest,
    });
    const beforeBytes = canonicalizeRfc8785(previous);
    const header = build({ publication, previousPublication: previous });
    expect(header.retirements[0]?.previousPublicationDigest).toBe(hash(previous));
    expect(
      bindCatalogProductScopeRetirementHeader(header, {
        publicationAction: "Publish",
        publication,
        previousPublication: previous,
      }),
    ).toEqual(header);
    expect(canonicalizeRfc8785(previous)).toBe(beforeBytes);
    expect(() =>
      build({
        publication,
        previousPublication: { ...previous, profile: "CatalogProductPublicationVersionV3" },
      }),
    ).toThrow();
    const wrongOrdinal = rehash({ ...exact, previousSelectorIndex: 1 });
    expect(() =>
      build({
        publication: {
          ...publication,
          replacementIntent: wrongOrdinal,
          replacementIntentDigest: wrongOrdinal.digest,
        },
        previousPublication: previous,
      }),
    ).toThrow();
  },
);
