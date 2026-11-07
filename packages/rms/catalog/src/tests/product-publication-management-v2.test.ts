import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { expect, it, vi } from "vitest";
import { buildCatalogProductEditorSnapshot } from "../contracts/product-editor-snapshot.js";
import {
  buildCatalogProductPublicationManagementV2,
  parseCatalogProductPublicationManagementV2,
} from "../contracts/product-publication-management-v2.js";
import {
  buildCatalogProductRetirementCoverage,
  catalogProductRetirementSourceHeadDigest,
  type CatalogProductRetirementHistoryEntry,
  type CatalogProductRetirementPublication,
} from "../contracts/product-publication-source-v2.js";
import {
  buildCatalogProductScopeRetirementHeader,
  type CatalogProductScopeRetirementHeader,
} from "../contracts/product-scope-retirement.js";
import {
  parseCatalogProductPublicationReplacementIntent,
  parseCatalogProductScopeReplacementIntent,
  type CatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import {
  planCatalogProductPublication,
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  productPublicationCheckCodes,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
} from "../contracts/product-publication.js";
import {
  planCatalogProductPublicationV2,
  parseProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";

const id = (n: number) => "01902441-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T12:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const selector = (n: number) => ({
  level: "Store" as const,
  reference: id(n),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
});
function required<T>(value: T | undefined | null): T {
  if (value == null) throw Error("Missing synthetic record");
  return value;
}
function aggregate(aggregateVersion: number) {
  return {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "EDITOR",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(99),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic management" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
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
      },
    },
  };
}
/** Pure recorded history with synthetic validation, not a current authority proof. */
function fixture(
  options: {
    empty?: boolean;
    retired?: boolean;
    oldV2?: boolean;
    pending?: boolean;
    repeatedStore?: boolean;
    large?: boolean;
    until?: string;
    store?: number;
    observedAt?: string;
    editorObservedAt?: string;
  } = {},
) {
  const history: CatalogProductRetirementHistoryEntry[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [],
    latest = new Map<string, CatalogProductRetirementPublication>(),
    noneBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    none = parseCatalogProductPublicationReplacementIntent({ ...noneBody, digest: hash(noneBody) });
  function add(
    version: number,
    scopes: ReturnType<typeof selector>[],
    intent?: CatalogProductPublicationReplacementIntent,
    previous: CatalogProductRetirementPublication | null = null,
    pending = false,
  ) {
    let current: CatalogProductRetirementPublication | null = null;
    for (const action of pending
      ? (["Validate"] as const)
      : (["Validate", "SubmitReview", "Publish"] as const)) {
      const command: ProductPublicationCommand = parseProductPublicationCommand({
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(5),
        versionReference: id(version),
        actorReference: id(3),
        actorKind: "User",
        operationReference: id(100 + history.length),
        expectedProductAggregateVersion: history.length + 1,
        expectedPublicationVersion: current?.publicationVersion ?? 0,
        action,
        contentDigest: hash(version),
        configurationDigest: hash("config"),
        scopeSet: scopes,
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: boundary(at),
          effectiveUntil: options.until ? boundary(options.until) : null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: action === "Publish" ? id(version + 1000) : null,
        occurredAt: at,
        reasonCode: "SYNTHETIC_MANAGEMENT",
      });
      const facts: ProductPublicationFacts = {
        now: at,
        productAggregateVersion: command.expectedProductAggregateVersion,
        contentDigest: command.contentDigest,
        configurationDigest: command.configurationDigest,
        scopeDigest: hash(command.scopeSet),
        periodDigest: hash(command.effectivePeriod),
        validation: {
          evidenceReference: id(200 + history.length),
          productAggregateVersion: command.expectedProductAggregateVersion,
          contentDigest: command.contentDigest,
          configurationDigest: command.configurationDigest,
          scopeDigest: hash(command.scopeSet),
          periodDigest: hash(command.effectivePeriod),
          policyReference: id(8),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: at,
          validUntil: "2026-10-02T13:00:00.000Z",
        },
        approval: null,
        reviewReference: action === "SubmitReview" ? id(7) : null,
        replacement: null,
      };
      if (intent) {
        current = planCatalogProductPublicationV2(
          {
            ...command,
            profile: "CatalogProductPublicationCommandV2",
            replacementIntent: intent,
            replacementIntentDigest: intent.digest,
          },
          current === null ? null : parseProductPublicationVersionV2(current),
          {
            ...facts,
            replacement: null,
            validation: {
              ...facts.validation,
              profile: "CatalogProductPublicationValidationV2",
              replacementIntentDigest: intent.digest,
              approvalPolicy: pending ? "Required" : "NotRequired",
              checks: facts.validation.checks.map((check) =>
                pending && check.code === "ApprovalPolicy"
                  ? { code: check.code, outcome: "Pending" as const }
                  : check,
              ),
            },
          },
        );
        headers.push(
          buildCatalogProductScopeRetirementHeader({
            publicationAction: action,
            publication: current,
            previousPublication: action === "Publish" ? previous : null,
            observedSourceRevision: String(history.length + 1),
            observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
              tenantReference: id(1),
              brandReference: id(2),
              productReference: id(5),
              aggregateVersion: current.productAggregateVersion,
              sourceRevision: String(history.length + 1),
              latest: [...latest.values()],
            }),
          }),
        );
      } else
        current = planCatalogProductPublication(
          command,
          current === null ? null : parseProductPublicationVersion(current),
          facts,
        );
      latest.set(current.versionReference, current);
      history.push({ publicationAction: action, publication: current });
    }
    return required(current);
  }
  if (!options.empty) {
    const old = add(
      6,
      options.large
        ? Array.from({ length: 300 }, (_, i) => ({
            ...selector(i + 5000),
            channelCodes: Array.from(
              { length: 100 },
              (_, j) => "CHANNEL_CODE_" + j.toString().padStart(3, "0"),
            ),
          }))
        : options.repeatedStore
          ? [selector(20), { ...selector(20), channelCodes: ["KIOSK"] }]
          : [selector(20), selector(21)],
      options.oldV2 ? none : undefined,
    );
    add(10, [selector(22)], none);
    if (options.retired) {
      const body = {
          profile: "CatalogProductExactStoreSelectorReplacementV1",
          mode: "PermanentSelectorRetirement",
          previousVersionReference: old.versionReference,
          previousPublicationOperationReference: old.operationReference,
          expectedPreviousPublicationVersion: old.publicationVersion,
          previousIntentDigest: old.intentDigest,
          previousScopeDigest: old.scopeDigest,
          previousPeriodDigest: old.periodDigest,
          previousSelectorIndex: 0,
          previousSelectorDigest: hash(old.scopeSet[0]),
        },
        intent = parseCatalogProductScopeReplacementIntent({ ...body, digest: hash(body) });
      add(11, [required(old.scopeSet[0]) as ReturnType<typeof selector>], intent, old);
    }
  }
  if (options.pending) add(99, [selector(20)], none, null, true);
  const scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(options.store ?? 20),
    },
    query = { productReference: id(5), expectedAggregateVersion: history.length + 1 },
    editor = buildCatalogProductEditorSnapshot(
      aggregate(query.expectedAggregateVersion),
      scope,
      query,
      options.editorObservedAt ?? at,
    ),
    coverage = buildCatalogProductRetirementCoverage({
      productReference: query.productReference,
      tenantReference: id(1),
      brandReference: id(2),
      aggregateVersion: query.expectedAggregateVersion,
      sourceRevision: String(history.length + 1),
      observedAt: options.observedAt ?? at,
      history,
      headers,
    });
  return { scope, query, editor, coverage, none };
}
function view(f: ReturnType<typeof fixture>, now = at) {
  return buildCatalogProductPublicationManagementV2(f.editor, f.coverage, f.scope, f.query, now);
}
function reseal<T extends { digest: string }>(value: T): T {
  const { digest: old, ...body } = value;
  expect(old).toMatch(/^sha256:/u);
  return { ...body, digest: hash(body) } as T;
}

it("exposes explicit None for a first draft without inventing a publication, target or eligibility", () => {
  const r = view(fixture({ empty: true }));
  expect(r).toMatchObject({
    profile: "CatalogProductPublicationManagementV2",
    versions: [],
    history: [],
    scopeRetirementHeaders: [],
    replacementTargets: [],
    noReplacementIntent: { mode: "None" },
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    draft: { versionReference: id(99), contentStatus: "Present" },
  });
  expect(parseCatalogProductPublicationManagementV2(r)).toEqual(r);
});
it.each([false, true])(
  "retains original mixed records and derives exact selected Store tuple from V2=%s",
  (oldV2) => {
    const f = fixture({ oldV2 }),
      r = view(f),
      target = required(r.replacementTargets[0]),
      old = required(r.versions.find((p) => p.versionReference === id(6)));
    expect(r.versions).toEqual(f.coverage.latest);
    expect(r.history).toEqual(f.coverage.history);
    expect(r.scopeRetirementHeaders).toEqual(f.coverage.headers);
    expect(r.replacementTargets).toHaveLength(1);
    expect(target.selector).toEqual(selector(20));
    expect(target.replacementIntent).toMatchObject({
      previousVersionReference: old.versionReference,
      previousPublicationOperationReference: old.operationReference,
      expectedPreviousPublicationVersion: old.publicationVersion,
      previousIntentDigest: old.intentDigest,
      previousScopeDigest: old.scopeDigest,
      previousPeriodDigest: old.periodDigest,
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(old.scopeSet[0]),
    });
    expect(parseCatalogProductPublicationManagementV2(r)).toEqual(r);
    expect(Object.isFrozen(target.replacementIntent)).toBe(true);
  },
);
it("removes only the retired selector target and retains the old other Store and new V2 head", () => {
  const a = view(fixture({ retired: true })),
    b = view(fixture({ retired: true, store: 21 }));
  expect(a.replacementTargets.map((t) => t.replacementIntent.previousVersionReference)).toEqual([
    id(11),
  ]);
  expect(b.replacementTargets.map((t) => t.replacementIntent.previousVersionReference)).toEqual([
    id(6),
  ]);
  expect(a.versions).toHaveLength(3);
  expect(a.scopeRetirementHeaders.some((h) => h.retirements.length === 1)).toBe(true);
  expect(parseCatalogProductPublicationManagementV2(a)).toEqual(a);
});
it("offers no target outside the selected Store or at the exclusive period end", () => {
  expect(view(fixture({ store: 50 })).replacementTargets).toEqual([]);
  const expiry = "2026-10-02T12:00:02.000Z",
    f = fixture({ until: expiry });
  expect(view(f, expiry).replacementTargets).toEqual([]);
  expect(parseCatalogProductPublicationManagementV2(view(f, expiry)).replacementTargets).toEqual(
    [],
  );
});
it("retains the earliest original source deadline after later read and projection observations", () => {
  const historyAt = "2026-10-02T12:00:02.000Z",
    now = "2026-10-02T12:00:04.999Z",
    f = fixture({ observedAt: historyAt }),
    r = view(f, now);
  expect(r).toMatchObject({
    observedAt: now,
    editorObservedAt: at,
    sourceObservedAt: historyAt,
    validUntil: "2026-10-02T12:00:05.000Z",
  });
  for (const bad of [at, "2026-10-02T12:00:05.000Z"]) expect(() => view(f, bad)).toThrow();
});
it.each(["latest", "headers", "history"])(
  "rebuilds owning coverage rather than trusting a resealed %s",
  (key) => {
    const f = fixture({ retired: true }),
      corrupted = reseal({ ...f.coverage, [key]: [] });
    expect(() =>
      buildCatalogProductPublicationManagementV2(f.editor, corrupted, f.scope, f.query, at),
    ).toThrow();
  },
);
it.each([
  "profile",
  "eligibility",
  "publishValidation",
  "validUntil",
  "storeReference",
  "replacementTargets",
  "noReplacementIntent",
])("refuses resealed DTO changes to %s", (key) => {
  const r = view(fixture()),
    changed = reseal({
      ...r,
      [key]:
        key === "replacementTargets"
          ? []
          : key === "storeReference"
            ? id(21)
            : key === "validUntil"
              ? "2026-10-02T12:00:06.000Z"
              : "Forged",
    });
  expect(() => parseCatalogProductPublicationManagementV2(changed)).toThrow();
});
it("rejects a rehashed incorrect target ordinal even when it points to another valid Store", () => {
  const r = view(fixture()),
    target = required(r.replacementTargets[0]),
    intent = reseal({
      ...target.replacementIntent,
      previousSelectorIndex: 1,
      previousSelectorDigest: hash(selector(21)),
    }),
    changed = reseal({
      ...r,
      replacementTargets: [{ selector: selector(21), replacementIntent: intent }],
    });
  expect(() => parseCatalogProductPublicationManagementV2(changed)).toThrow();
});
it("keeps historical V2 Pending intact instead of pretending it is a V1 Pass", () => {
  const f = fixture({ pending: true }),
    current = required(f.coverage.latest.find((p) => p.versionReference === id(99)));
  expect(current).toMatchObject({
    profile: "CatalogProductPublicationVersionV2",
    state: "Draft",
    validationDecision: "ApprovalPending",
  });
  // Exact original full records are exposed; the management DTO never rewrites decisions.
  expect(view(f).versions).toEqual(f.coverage.latest);
});
it("rejects foreign ownership, expected version changes and unsafe input without invoking getters", () => {
  const f = fixture(),
    getter = vi.fn(() => []),
    corrupted = { ...f.coverage };
  Object.defineProperty(corrupted, "history", { enumerable: true, get: getter });
  expect(() =>
    buildCatalogProductPublicationManagementV2(f.editor, corrupted, f.scope, f.query, at),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    buildCatalogProductPublicationManagementV2(
      f.editor,
      f.coverage,
      { ...f.scope, brandReference: id(90) },
      f.query,
      at,
    ),
  ).toThrow();
  expect(() =>
    buildCatalogProductPublicationManagementV2(
      f.editor,
      f.coverage,
      f.scope,
      { ...f.query, expectedAggregateVersion: 100 },
      at,
    ),
  ).toThrow();
  const r = view(f);
  expect(() => parseCatalogProductPublicationManagementV2({ ...r, extra: true })).toThrow();
});

it("does not offer exact replacement for a head with repeated Store selectors", () => {
  expect(view(fixture({ repeatedStore: true })).replacementTargets).toEqual([]);
});

it("preserves the bounded 2 MiB management response instead of raising source or transport limits", () => {
  const f = fixture({ large: true });
  expect(() => view(f)).toThrow();
});
