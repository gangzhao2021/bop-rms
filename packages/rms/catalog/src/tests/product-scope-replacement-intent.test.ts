import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import {
  bindCatalogProductScopeReplacementIntent,
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  type ProductPublicationScope,
  type ProductPublicationVersion,
} from "../contracts/product-publication.js";

const id = (n: number) => `01902440-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  at = "2026-10-02T12:00:00.000Z",
  later = "2026-10-02T12:01:00.000Z";
const store = (
  n: number,
  channelCodes: readonly string[] = ["POS", "WEB"],
  orderTypeCodes: readonly string[] = ["DINE_IN", "PICKUP"],
): ProductPublicationScope => ({ level: "Store", reference: id(n), channelCodes, orderTypeCodes });
function command(scopeSet: readonly ProductPublicationScope[]) {
  return parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(11),
    productReference: id(4),
    versionReference: id(6),
    expectedProductAggregateVersion: 5,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash("synthetic incoming content"),
    configurationDigest: hash("synthetic configuration"),
    scopeSet,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: later,
    reasonCode: "SYNTHETIC_EXACT_REPLACEMENT",
  });
}
/** Parsed persisted shapes only; not an actual current head or permission source. */
function fixture(scopeSet: readonly ProductPublicationScope[] = [store(21), store(20)]) {
  const original = command(scopeSet),
    previous = parseProductPublicationVersion({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(4),
      versionReference: id(5),
      publicationVersion: 3,
      productAggregateVersion: 4,
      state: "Published",
      contentDigest: hash("synthetic old content"),
      configurationDigest: original.configurationDigest,
      scopeSet: original.scopeSet,
      scopeDigest: hash(original.scopeSet),
      effectivePeriod: original.effectivePeriod,
      periodDigest: hash(original.effectivePeriod),
      validationEvidenceReference: id(30),
      validationDecision: "Pass",
      policyReference: id(31),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      reviewReference: id(32),
      reviewVersion: 1,
      submittedByActorReference: id(3),
      approvalEvidenceReference: null,
      scheduleReference: null,
      scheduleVersion: 0,
      publishedAt: at,
      supersededAt: null,
      supersededByVersionReference: null,
      successorDraftVersionReference: id(6),
      operationReference: id(10),
      intentDigest: hash("synthetic original publication intent"),
      actorReference: id(3),
      actorKind: "User",
      occurredAt: at,
      reasonCode: "SYNTHETIC_ORIGINAL_PUBLICATION",
    });
  return { previous, incoming: command([store(20)]) };
}
function intentFor(
  previous = fixture().previous,
  previousSelectorIndex = 0,
  changes: Record<string, unknown> = {},
) {
  const body = {
    profile: "CatalogProductExactStoreSelectorReplacementV1",
    mode: "PermanentSelectorRetirement",
    previousVersionReference: previous.versionReference,
    previousPublicationOperationReference: previous.operationReference,
    expectedPreviousPublicationVersion: previous.publicationVersion,
    previousIntentDigest: previous.intentDigest,
    previousScopeDigest: previous.scopeDigest,
    previousPeriodDigest: previous.periodDigest,
    previousSelectorIndex,
    previousSelectorDigest: hash(previous.scopeSet[previousSelectorIndex] ?? null),
    ...changes,
  };
  return { ...body, digest: hash(body) };
}
const rejects = (work: () => unknown) =>
  expect(work).toThrow(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

describe("exact Store selector replacement intent", () => {
  it("captures a detached frozen body and verifies its canonical digest", () => {
    const raw = intentFor(),
      original = canonicalizeRfc8785(raw),
      result = parseCatalogProductScopeReplacementIntent(raw);
    expect(result).toEqual(raw);
    expect(result).not.toBe(raw);
    expect(Object.isFrozen(result)).toBe(true);
    expect(canonicalizeRfc8785(raw)).toBe(original);
    expect(
      parseCatalogProductScopeReplacementIntent(Object.fromEntries(Object.entries(raw).reverse())),
    ).toEqual(result);
    raw.previousSelectorIndex = 1;
    expect(result.previousSelectorIndex).toBe(0);
    rejects(() => parseCatalogProductScopeReplacementIntent(raw));
  });

  it.each(Object.keys(intentFor()))("refuses a missing %s", (field) => {
    const raw = Object.fromEntries(Object.entries(intentFor()).filter(([key]) => key !== field));
    rejects(() => parseCatalogProductScopeReplacementIntent(raw));
  });

  it.each([null, undefined, [], true, "intent", 1])("refuses a non-record %s", (value) => {
    rejects(() => parseCatalogProductScopeReplacementIntent(value));
  });

  it("refuses prototypes, accessors, hidden or symbol fields without invoking getters", () => {
    const getter = vi.fn(() => id(5)),
      accessor = { ...intentFor() };
    Object.defineProperty(accessor, "previousVersionReference", { get: getter, enumerable: true });
    for (const value of [
      accessor,
      Object.assign(Object.create(null), intentFor()),
      Object.assign(Object.create({ synthetic: true }), intentFor()),
      { ...intentFor(), extra: true },
      { ...intentFor(), [Symbol("synthetic")]: true },
      Object.defineProperty({ ...intentFor() }, "extra", { value: true, enumerable: false }),
    ])
      rejects(() => parseCatalogProductScopeReplacementIntent(value));
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["profile", "CatalogProductExactStoreSelectorReplacementV2"],
    ["mode", "TemporaryOverlay"],
    ["previousVersionReference", "not-a-reference"],
    ["previousPublicationOperationReference", id(10).toUpperCase()],
    ["previousIntentDigest", "sha256:" + "A".repeat(64)],
    ["previousScopeDigest", "1".repeat(64)],
    ["previousPeriodDigest", "sha256:" + "a".repeat(63)],
    ["previousSelectorDigest", "sha512:" + "a".repeat(64)],
    ["previousVersionReference", "a".repeat(4097)],
  ])("refuses malformed %s even with a recomputed body digest", (field, value) => {
    rejects(() =>
      parseCatalogProductScopeReplacementIntent(intentFor(undefined, 0, { [field]: value })),
    );
  });

  it.each([
    ["expectedPreviousPublicationVersion", 0],
    ["expectedPreviousPublicationVersion", 2147483648],
    ["expectedPreviousPublicationVersion", 1.5],
    ["expectedPreviousPublicationVersion", "3"],
    ["previousSelectorIndex", -1],
    ["previousSelectorIndex", 1000],
    ["previousSelectorIndex", 0.5],
    ["previousSelectorIndex", "0"],
  ])("bounds numeric %s without coercion (%s)", (field, value) => {
    rejects(() =>
      parseCatalogProductScopeReplacementIntent(intentFor(undefined, 0, { [field]: value })),
    );
  });

  it("accepts both integer boundaries without claiming that an index exists in a source", () => {
    for (const expectedPreviousPublicationVersion of [1, 2147483647])
      for (const previousSelectorIndex of [0, 999])
        expect(
          parseCatalogProductScopeReplacementIntent(
            intentFor(undefined, 0, {
              expectedPreviousPublicationVersion,
              previousSelectorIndex,
            }),
          ),
        ).toMatchObject({ expectedPreviousPublicationVersion, previousSelectorIndex });
    for (const value of [NaN, Infinity, -Infinity])
      rejects(() =>
        parseCatalogProductScopeReplacementIntent({ ...intentFor(), previousSelectorIndex: value }),
      );
    rejects(() =>
      parseCatalogProductScopeReplacementIntent({ ...intentFor(), digest: hash("changed") }),
    );
  });
});

describe("exact original publication and selector binding", () => {
  it.each([0, 1])(
    "binds canonical selector %s without mutating V1 bytes or asserting retirement",
    (index) => {
      const { previous } = fixture(),
        selected = previous.scopeSet[index];
      if (!selected) throw new Error("Synthetic selector missing");
      const incoming = command([selected]),
        intent = intentFor(previous, index),
        before = canonicalizeRfc8785({ previous, incoming });
      expect(bindCatalogProductScopeReplacementIntent(intent, previous, incoming)).toEqual(intent);
      expect(canonicalizeRfc8785({ previous, incoming })).toBe(before);
      expect(parseProductPublicationVersion(previous)).toEqual(previous);
      expect(parseProductPublicationCommand(incoming)).toEqual(incoming);
      expect(previous.state).toBe("Published");
      expect(previous.scopeSet).toHaveLength(2);
    },
  );

  it.each([
    ["previousVersionReference", id(99)],
    ["previousPublicationOperationReference", id(99)],
    ["expectedPreviousPublicationVersion", 4],
    ["previousIntentDigest", hash("different original intent")],
    ["previousScopeDigest", hash("different old union")],
    ["previousPeriodDigest", hash("different old period")],
    ["previousSelectorIndex", 999],
    ["previousSelectorDigest", hash("different old selector")],
  ])("refuses an altered original %s", (field, value) => {
    const { previous, incoming } = fixture();
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(
        intentFor(previous, 0, { [field]: value }),
        previous,
        incoming,
      ),
    );
  });

  it.each(["tenantReference", "brandReference", "productReference"])(
    "refuses foreign %s",
    (field) => {
      const { previous, incoming } = fixture();
      rejects(() =>
        bindCatalogProductScopeReplacementIntent(intentFor(previous), previous, {
          ...incoming,
          [field]: id(99),
        }),
      );
    },
  );

  it("refuses same version/operation, non-previous roots and reversed original history", () => {
    const { previous, incoming } = fixture();
    for (const changes of [
      { versionReference: previous.versionReference },
      { operationReference: previous.operationReference },
      { expectedProductAggregateVersion: previous.productAggregateVersion },
      { expectedProductAggregateVersion: previous.productAggregateVersion - 1 },
      { occurredAt: "2026-10-02T11:59:59.000Z" },
      { action: "Supersede", actorKind: "System", replacementVersionReference: id(99) },
    ])
      rejects(() =>
        bindCatalogProductScopeReplacementIntent(intentFor(previous), previous, {
          ...incoming,
          ...changes,
        }),
      );
  });

  it("refuses a Superseded or unpublished head even with a matching intent", () => {
    const { previous, incoming } = fixture();
    const otherHeads: ProductPublicationVersion[] = [
      parseProductPublicationVersion({
        ...previous,
        state: "Superseded",
        supersededAt: at,
        supersededByVersionReference: id(99),
      }),
      parseProductPublicationVersion({
        ...previous,
        state: "Scheduled",
        publishedAt: null,
        successorDraftVersionReference: null,
        scheduleReference: id(99),
        scheduleVersion: 1,
      }),
    ];
    for (const head of otherHeads)
      rejects(() => bindCatalogProductScopeReplacementIntent(intentFor(head), head, incoming));
  });

  it.each(
    (
      [
        [store(20)],
        [store(20), store(20, ["APP"])],
        [store(20), { level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        [store(20), { level: "Region", reference: id(30), channelCodes: [], orderTypeCodes: [] }],
        [
          store(20),
          { level: "StoreGroup", reference: id(30), channelCodes: [], orderTypeCodes: [] },
        ],
        [store(20), { level: "Channel", reference: "WEB", channelCodes: [], orderTypeCodes: [] }],
        [
          store(20),
          { level: "OrderType", reference: "PICKUP", channelCodes: [], orderTypeCodes: [] },
        ],
      ] satisfies readonly (readonly ProductPublicationScope[])[]
    ).map((scopeSet) => ({ scopeSet })),
  )("refuses unsupported old coverage %#", ({ scopeSet }) => {
    const { previous, incoming } = fixture(scopeSet);
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(intentFor(previous), previous, incoming),
    );
  });

  it.each(
    (
      [
        [store(21)],
        [store(20), store(21)],
        [store(20, [])],
        [store(20, ["WEB"])],
        [store(20, ["APP"])],
        [store(20, ["POS", "WEB"], [])],
        [store(20, ["POS", "WEB"], ["PICKUP"])],
        [store(20, ["POS", "WEB"], ["DELIVERY"])],
        [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      ] satisfies readonly (readonly ProductPublicationScope[])[]
    ).map((scopeSet) => ({ scopeSet })),
  )("refuses narrower, wider or different incoming selectors %#", ({ scopeSet }) => {
    const { previous } = fixture();
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(intentFor(previous), previous, command(scopeSet)),
    );
  });

  it("preserves exact empty filter dimensions without authorizing a narrower selector", () => {
    const { previous } = fixture([store(20, [], []), store(21, [], []), store(22, [], [])]),
      intent = intentFor(previous);
    expect(
      bindCatalogProductScopeReplacementIntent(intent, previous, command([store(20, [], [])])),
    ).toEqual(intent);
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(intent, previous, command([store(20, ["WEB"], [])])),
    );
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(
        intent,
        previous,
        command([store(20, [], ["PICKUP"])]),
      ),
    );
  });

  it("does not silently reindex a noncanonical persisted scope array", () => {
    const { previous, incoming } = fixture();
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(
        intentFor(previous),
        {
          ...previous,
          scopeSet: [...previous.scopeSet].reverse(),
        },
        incoming,
      ),
    );
  });

  it("accepts canonical-equivalent incoming filters but not an ordinal targeting the other Store", () => {
    const { previous, incoming } = fixture();
    expect(
      bindCatalogProductScopeReplacementIntent(intentFor(previous), previous, {
        ...incoming,
        scopeSet: [store(20, ["WEB", "POS"], ["PICKUP", "DINE_IN"])],
      }),
    ).toEqual(intentFor(previous));
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(intentFor(previous, 1), previous, incoming),
    );
  });

  it("rejects accessor publication/command inputs without reading them", () => {
    const { previous, incoming } = fixture(),
      getter = vi.fn(() => previous.scopeSet),
      forgedPrevious = Object.defineProperty({ ...previous }, "scopeSet", {
        get: getter,
        enumerable: true,
      }),
      forgedIncoming = Object.defineProperty({ ...incoming }, "scopeSet", {
        get: getter,
        enumerable: true,
      });
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(intentFor(previous), forgedPrevious, incoming),
    );
    rejects(() =>
      bindCatalogProductScopeReplacementIntent(intentFor(previous), previous, forgedIncoming),
    );
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("explicit publication disposition union", () => {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const none = () => ({ ...body, digest: hash(body) });
  it("preserves Exact canonical bytes and adds a detached closed None intent", () => {
    const exact = intentFor(),
      bytes = canonicalizeRfc8785(exact);
    expect(canonicalizeRfc8785(parseCatalogProductPublicationReplacementIntent(exact))).toBe(bytes);
    const raw = none(),
      parsed = parseCatalogProductPublicationReplacementIntent(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    raw.digest = hash("changed");
    expect(parsed.digest).toBe(hash(body));
    rejects(() => parseCatalogProductScopeReplacementIntent(none()));
  });
  it("refuses implicit absence, mixed target fields and forged discriminator or digest", () => {
    for (const value of [
      null,
      undefined,
      {},
      [],
      { ...none(), previousVersionReference: id(5) },
      { ...intentFor(), profile: body.profile, mode: body.mode },
      { ...none(), digest: hash("wrong") },
      { ...none(), mode: "PermanentSelectorRetirement" },
      { ...none(), profile: "CatalogProductNoReplacementIntentV2" },
      ...Object.keys(none()).map((field) =>
        Object.fromEntries(Object.entries(none()).filter(([key]) => key !== field)),
      ),
    ])
      rejects(() => parseCatalogProductPublicationReplacementIntent(value));
  });
  it("does not evaluate None discriminator accessors or accept hidden/symbol fields", () => {
    const getter = vi.fn(() => body.profile),
      input = { ...none() };
    Object.defineProperty(input, "profile", { enumerable: true, get: getter });
    for (const value of [
      input,
      { ...none(), [Symbol("target")]: id(5) },
      Object.assign(Object.create(null), none()),
      Object.defineProperty({ ...none() }, "target", { value: id(5), enumerable: false }),
    ])
      rejects(() => parseCatalogProductPublicationReplacementIntent(value));
    expect(getter).not.toHaveBeenCalled();
  });
});
