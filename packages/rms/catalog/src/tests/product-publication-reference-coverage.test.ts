import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate, type ProductAggregate } from "../contracts/product.js";
import {
  planCatalogProductPublication,
  productPublicationCheckCodes,
  type ProductPublicationAction,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import {
  createCatalogProductPublicationMaterialization,
  createCatalogProductPublicationMaterializationV2,
  deriveCatalogProductPublicationContentIdentity,
} from "../contracts/product-publication-content.js";
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
import { bindCatalogProductPublicationValidationContextV2 } from "../contracts/product-publication-validation-context-v2.js";
import { buildCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
import { buildCatalogProductPublicationReferenceProvenance } from "../contracts/product-publication-reference-provenance.js";
import { parseCatalogProductWarningAcknowledgementReferenceRequest } from "../contracts/product-warning-acknowledgement-reference-request.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import { projectCatalogProductPublicationReferenceCoverage } from "../application/product-publication-reference-coverage.js";

const id = (n: number) => "019a2421-0013-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-03T10:00:00.000Z",
  future = "2026-10-03T11:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const period = (from = at) => ({
  timeZone: "UTC",
  effectiveFrom: boundary(from),
  effectiveUntil: null,
});
const selector = (n: number) => ({
  level: "Store" as const,
  reference: id(n),
  channelCodes: [],
  orderTypeCodes: [],
});
const none = () => {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseCatalogProductPublicationReplacementIntent({ ...body, digest: hash(body) });
};
function required<T>(v: T | null | undefined): T {
  if (v === undefined || v === null) throw Error("Missing synthetic value");
  return v;
}
function reseal<T extends { readonly digest: string }>(value: T) {
  const { digest, ...body } = value;
  void digest;
  return { ...body, digest: hash(body) };
}
function aggregate(full = true) {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "SYNTHETIC_PROVENANCE",
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
      localizedNames: { "en-CA": "Synthetic source" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [],
      ...(full
        ? {
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
          }
        : {}),
    },
  });
}
// Synthetic complete immutable histories use the real parsers, materializers and
// publication planners. Coherent flags model the owning reader, not actual SQL.
function fixture(initialFull = true) {
  let root = aggregate(initialFull);
  const history: CatalogProductRetirementHistoryEntry[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [],
    operations: {
      aggregate: ProductAggregate;
      operationReference: string;
      snapshotDigest: string;
      coherent: boolean;
    }[] = [];
  const commit = (operationReference: string) =>
    operations.push({
      aggregate: root,
      operationReference,
      snapshotDigest: hash(root),
      coherent: true,
    });
  commit(id(100));
  const coverage = () =>
    buildCatalogProductRetirementCoverage({
      tenantReference: id(10),
      brandReference: id(2),
      productReference: id(1),
      aggregateVersion: root.aggregateVersion,
      sourceRevision: String(root.aggregateVersion),
      observedAt: at,
      history,
      headers,
    });
  const latest = (version = root.draft.versionReference) =>
    [...history].reverse().find((entry) => entry.publication.versionReference === version)
      ?.publication ?? null;
  const save = (tax: number, full = true) => {
    root = parseProductAggregate({
      ...root,
      aggregateVersion: root.aggregateVersion + 1,
      draft: {
        ...root.draft,
        taxClassificationReference: id(tax),
        ...(full ? { editorContent: required(aggregate().draft.editorContent) } : {}),
      },
    });
    commit(id(100 + root.aggregateVersion));
  };
  const transition = (
    action: ProductPublicationAction,
    options: {
      legacy?: boolean;
      current?: CatalogProductRetirementPublication;
      intent?: CatalogProductPublicationReplacementIntent;
      period?: ReturnType<typeof period>;
      replacement?: CatalogProductRetirementPublication;
    } = {},
  ) => {
    const current = options.current ?? latest(),
      identity = deriveCatalogProductPublicationContentIdentity(root),
      intent =
        options.intent ??
        (current && "replacementIntent" in current ? current.replacementIntent : none()),
      c: ProductPublicationCommand = {
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(10),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: action === "Supersede" ? "System" : "User",
        operationReference: id(1000 + root.aggregateVersion),
        productReference: id(1),
        versionReference:
          action === "Supersede" ? required(current).versionReference : root.draft.versionReference,
        expectedProductAggregateVersion: root.aggregateVersion,
        expectedPublicationVersion: current?.publicationVersion ?? 0,
        action,
        contentDigest:
          action === "Supersede" ? required(current).contentDigest : identity.contentDigest,
        configurationDigest:
          action === "Supersede"
            ? required(current).configurationDigest
            : identity.configurationDigest,
        scopeSet: current?.scopeSet ?? [selector(20)],
        effectivePeriod: options.period ?? current?.effectivePeriod ?? period(),
        scheduleReference: [
          "SchedulePublish",
          "CancelScheduledPublish",
          "ReschedulePublish",
        ].includes(action)
          ? id(90)
          : null,
        replacementVersionReference: options.replacement?.versionReference ?? null,
        successorDraftVersionReference: action === "Publish" ? id(40 + history.length + 1) : null,
        occurredAt: at,
        reasonCode: "SYNTHETIC_PROVENANCE",
      },
      facts: ProductPublicationFacts = {
        now: at,
        productAggregateVersion: root.aggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        validation: {
          evidenceReference: id(91),
          productAggregateVersion: root.aggregateVersion,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
          scopeDigest: hash(c.scopeSet),
          periodDigest: hash(c.effectivePeriod),
          policyReference: id(92),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: at,
          validUntil: plus(4000),
        },
        approval: null,
        reviewReference: action === "SubmitReview" ? id(93) : null,
        replacement: options.replacement
          ? {
              productReference: id(1),
              versionReference: options.replacement.versionReference,
              state: "Published",
              scopeDigest: options.replacement.scopeDigest,
              publishedAt: required(options.replacement.publishedAt),
            }
          : null,
      },
      before = coverage(),
      v2Command = options.legacy
        ? null
        : parseProductPublicationCommandV2({
            ...c,
            profile: "CatalogProductPublicationCommandV2",
            replacementIntent: intent,
            replacementIntentDigest: intent.digest,
          }),
      publication = v2Command
        ? planCatalogProductPublicationV2(
            v2Command,
            current as ProductPublicationVersionV2 | null,
            {
              ...facts,
              replacement: null,
              validation: {
                ...facts.validation,
                profile: "CatalogProductPublicationValidationV2",
                replacementIntentDigest: intent.digest,
              },
            },
          )
        : planCatalogProductPublication(
            c,
            current as Parameters<typeof planCatalogProductPublication>[1],
            facts,
          );
    if (v2Command)
      headers.push(
        buildCatalogProductScopeRetirementHeader({
          publicationAction: action,
          publication,
          previousPublication:
            action === "Publish" && intent.mode === "PermanentSelectorRetirement"
              ? (before.latest.find(
                  (p) => p.operationReference === intent.previousPublicationOperationReference,
                ) ?? null)
              : null,
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
        ? (v2Command
            ? createCatalogProductPublicationMaterializationV2(root, publication)
            : createCatalogProductPublicationMaterialization(root, publication)
          ).successor
        : parseProductAggregate({ ...root, aggregateVersion: root.aggregateVersion + 1 });
    history.push({ publicationAction: action, publication });
    commit(publication.operationReference);
    return publication;
  };
  const packet = () => {
    const current = latest(),
      identity = deriveCatalogProductPublicationContentIdentity(root);
    if (current && !("profile" in current))
      throw Error("Fixture request requires V2 current or a new successor");
    const command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(9000),
      productReference: id(1),
      versionReference: root.draft.versionReference,
      expectedProductAggregateVersion: root.aggregateVersion,
      expectedPublicationVersion: current?.publicationVersion ?? 0,
      action: current?.state === "Scheduled" ? "CancelScheduledPublish" : "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: current?.scopeSet ?? [selector(20)],
      effectivePeriod: current?.effectivePeriod ?? period(),
      scheduleReference: current?.state === "Scheduled" ? current.scheduleReference : null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_REQUEST",
      replacementIntent: current?.replacementIntent ?? none(),
      replacementIntentDigest: current?.replacementIntentDigest ?? none().digest,
    });
    const request = buildCatalogProductPublicationReferenceRequestV2(
        bindCatalogProductPublicationValidationContextV2({
          command,
          aggregate: root,
          current,
          content: null,
          observedAt: at,
        }),
        plus(3000),
      ),
      provenance = buildCatalogProductPublicationReferenceProvenance(
        { aggregateVersion: root.aggregateVersion, observedAt: at, history: operations },
        request,
        at,
      );
    return { request, provenance, coverage: coverage() };
  };
  return { save, transition, packet, history, operations, latest, root: () => root };
}
const project = (p: ReturnType<ReturnType<typeof fixture>["packet"]>, now = at) =>
  projectCatalogProductPublicationReferenceCoverage(p.request, p.provenance, p.coverage, now);
function publish(f: ReturnType<typeof fixture>, legacy = false) {
  f.transition("Validate", { legacy });
  f.transition("SubmitReview", { legacy });
  return f.transition("Publish", { legacy });
}

it.each([false, true])(
  "binds the exact V1/V2 publication pre-root, never an earlier same-version edit or successor (%s)",
  (legacy) => {
    const f = fixture();
    f.save(50);
    f.transition("Validate", { legacy });
    f.save(51);
    f.transition("Validate", { legacy });
    f.transition("SubmitReview", { legacy });
    const publication = f.transition("Publish", { legacy });
    f.save(52);
    const p = f.packet(),
      result = project(p),
      entry = required(result.entries[0]);
    expect(entry.referenceConfiguration.taxClassificationReference).toBe(id(51));
    expect(entry.referenceConfiguration.versionReference).toBe(publication.versionReference);
    expect(entry.sourceOperation.resultAggregateVersion).toBe(publication.productAggregateVersion);
    expect(entry.resultOperation.operationReference).toBe(publication.operationReference);
    expect(entry.resultOperation.versionReference).toBe(publication.successorDraftVersionReference);
    expect(result.currentOperation.resultAggregateVersion).toBe(f.root().aggregateVersion);
    expect(entry.fullIdentity.configurationDigest).toBe(publication.configurationDigest);
    expect(entry.fullIdentity.configurationDigest).not.toBe(hash(entry.referenceConfiguration));
    expect(result).toMatchObject({
      sourceAuthority: "NotEvaluated",
      applicability: "NotEvaluated",
      changeImpact: "NotEvaluated",
      eligibility: "NotEvaluated",
    });
    expect(result.digest).toBe(
      hash(
        (({ digest, ...body }) => {
          void digest;
          return body;
        })(result),
      ),
    );
  },
);
it("traces a legacy Supersede to its original Published root and binds the separate Supersede result", () => {
  const f = fixture();
  f.save(50);
  const old = publish(f, true);
  f.save(51);
  const replacement = publish(f, true);
  f.save(52);
  const superseded = f.transition("Supersede", { legacy: true, current: old, replacement }),
    result = project(f.packet()),
    entry = required(result.entries.find((v) => v.publication.state === "Superseded"));
  expect(entry.referenceConfiguration.taxClassificationReference).toBe(id(50));
  expect(entry.configurationPublicationOperationReference).toBe(old.operationReference);
  expect(entry.configurationPublicationDigest).toBe(hash(old));
  expect(entry.sourceOperation.resultAggregateVersion).toBe(old.productAggregateVersion);
  expect(entry.resultOperation.operationReference).toBe(superseded.operationReference);
  expect(entry.resultOperation.versionReference).toBe(f.root().draft.versionReference);
  expect(entry.resultOperation.resultAggregateVersion).toBe(superseded.productAggregateVersion + 1);
});
it("uses exact Scheduled content and removes a cancelled reservation without substituting later Draft edits", () => {
  const f = fixture();
  f.save(50);
  f.transition("Validate", { period: period(future) });
  f.transition("SubmitReview");
  const scheduled = f.transition("SchedulePublish");
  const first = project(f.packet());
  expect(first.entries).toHaveLength(1);
  expect(first.entries[0]?.publication.operationReference).toBe(scheduled.operationReference);
  expect(first.entries[0]?.referenceConfiguration.taxClassificationReference).toBe(id(50));
  f.transition("CancelScheduledPublish");
  f.save(51);
  const cancelled = project(f.packet());
  expect(cancelled.entries).toEqual([]);
  expect(cancelled.currentOperation.resultAggregateVersion).toBe(f.root().aggregateVersion);
});
it("retains actual retired ordinal evidence beside unchanged original scope bytes", () => {
  const f = fixture(),
    old = publish(f, true),
    target = {
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
    intent = parseCatalogProductScopeReplacementIntent({ ...target, digest: hash(target) });
  f.transition("Validate", { intent });
  f.transition("SubmitReview");
  const replacement = f.transition("Publish"),
    result = project(f.packet()),
    entry = required(
      result.entries.find((v) => v.publication.versionReference === old.versionReference),
    );
  expect(entry.publication.scopeSet).toEqual(old.scopeSet);
  expect(entry.retirements).toHaveLength(1);
  expect(entry.retirements[0]?.headerOperationReference).toBe(replacement.operationReference);
  expect(entry.retirements[0]?.retirement.replacementIntent.previousSelectorIndex).toBe(0);
});
it("allows unrelated legacy Draft provenance but refuses missing full identity for an actually selected head", () => {
  const f = fixture(false);
  f.save(50);
  publish(f);
  const p = f.packet();
  expect(p.provenance.operationProvenance[0]?.fullIdentity.coverage).toBe("Unavailable");
  expect(project(p).entries).toHaveLength(1);
  const bad = structuredClone(p.provenance),
    publication = required(p.coverage.latest.find((head) => head.state === "Published")),
    source = required(bad.operationProvenance[publication.productAggregateVersion - 1]);
  Object.assign(source, {
    fullIdentity: { coverage: "Unavailable", reason: "LegacyEditorContentAbsent" },
  });
  expect(() => project({ ...p, provenance: reseal(bad) })).toThrow();
});
it.each(["source-identity", "result-operation", "successor-version"])(
  "refuses resealed %s provenance",
  (mode) => {
    const f = fixture();
    f.save(50);
    const publication = publish(f);
    const p = f.packet(),
      bad = structuredClone(p.provenance),
      source = required(bad.operationProvenance[publication.productAggregateVersion - 1]),
      result = required(bad.operationProvenance[publication.productAggregateVersion]);
    if (mode === "source-identity")
      Object.assign(source.fullIdentity, {
        configurationDigest: hash("wrong same-version configuration"),
      });
    if (mode === "result-operation") Object.assign(result, { operationReference: id(9990) });
    if (mode === "successor-version") {
      Object.assign(result, {
        versionReference: id(9989),
        referenceConfiguration: { ...result.referenceConfiguration, versionReference: id(9989) },
      });
    }
    expect(() => project({ ...p, provenance: reseal(bad) })).toThrow();
  },
);
it("requires the original request, current head and original deadline", () => {
  const f = fixture();
  f.transition("Validate");
  const p = f.packet();
  expect(project(p).entries).toEqual([]);
  expect(() => project(p, plus(3000))).toThrow();
  expect(() =>
    projectCatalogProductPublicationReferenceCoverage(
      { ...p.request, currentPublicationDigest: hash("another current head") },
      p.provenance,
      p.coverage,
      at,
    ),
  ).toThrow();
  const changed = { ...p.request, currentPublicationDigest: hash("another current head") },
    bad = reseal({ ...p.provenance, request: changed });
  expect(() => project({ ...p, request: changed, provenance: bad })).toThrow();
});
it("preserves independent Ack request identity and validates every compact current binding", () => {
  const f = fixture();
  publish(f);
  f.transition("Validate");
  const p = f.packet(),
    current = required(f.latest()),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(9500),
      productReference: id(1),
      versionReference: f.root().draft.versionReference,
      expectedProductAggregateVersion: f.root().aggregateVersion,
      reportOperationReference: id(9501),
      reportDigest: hash("synthetic displayed report"),
      warningBindingDigest: hash("synthetic binding"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "SYNTHETIC_ACK",
      occurredAt: at,
    }),
    request = parseCatalogProductWarningAcknowledgementReferenceRequest({
      profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
      command,
      originalIntentDigest: hash(command),
      replacementIntentDigest:
        "replacementIntentDigest" in current ? current.replacementIntentDigest : hash("invalid"),
      aggregateSnapshotDigest: p.request.aggregateSnapshotDigest,
      currentPublicationDigest: hash(current),
      publicationVersion: current.publicationVersion,
      contentDigest: current.contentDigest,
      configurationDigest: current.configurationDigest,
      scopeDigest: current.scopeDigest,
      periodDigest: current.periodDigest,
      policyReference: current.policyReference,
      policyVersion: current.policyVersion,
      observedAt: at,
      validUntil: plus(3000),
    }),
    provenance = buildCatalogProductPublicationReferenceProvenance(
      { aggregateVersion: f.root().aggregateVersion, observedAt: at, history: f.operations },
      request,
      at,
    ),
    result = projectCatalogProductPublicationReferenceCoverage(request, provenance, p.coverage, at);
  expect(result.request).toEqual(request);
  expect(result.entries).toHaveLength(1);
  const changed = parseCatalogProductWarningAcknowledgementReferenceRequest({
    ...request,
    periodDigest: hash("other period"),
  });
  expect(() =>
    projectCatalogProductPublicationReferenceCoverage(
      changed,
      reseal({ ...provenance, request: changed }),
      p.coverage,
      at,
    ),
  ).toThrow();
});
it("rejects descriptor access without invocation and detaches projected records", () => {
  const f = fixture();
  publish(f);
  const p = f.packet(),
    bad = { ...p.request },
    getter = vi.fn();
  Object.defineProperty(bad, "profile", { enumerable: true, get: getter });
  expect(() =>
    projectCatalogProductPublicationReferenceCoverage(bad, p.provenance, p.coverage, at),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const input = structuredClone(p.provenance),
    result = project({ ...p, provenance: input }),
    original = canonicalizeRfc8785(result);
  Object.assign(required(input.operationProvenance[0]).referenceConfiguration, {
    taxClassificationReference: id(9999),
  });
  expect(canonicalizeRfc8785(result)).toBe(original);
  expect(Object.isFrozen(result.entries)).toBe(true);
});
