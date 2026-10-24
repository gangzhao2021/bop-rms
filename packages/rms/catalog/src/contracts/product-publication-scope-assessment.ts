import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseTenantStoreReferenceSnapshot, tenantStoreReferenceDigest } from "@bop/tenant";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  type ProductAggregate,
} from "./product.js";
import {
  type ProductPublicationCommandV2,
  type ProductPublicationVersionV2,
} from "./product-publication-v2.js";
import { type CatalogProductPublicationValidationReport } from "./product-publication-validation-report.js";
import { type CatalogProductPublicationWarningAcknowledgementCommand } from "./product-publication-warning-acknowledgement.js";
import {
  bindCatalogProductPublicationQualificationContext,
  bindCatalogProductWarningAcknowledgementQualificationContext,
  type CatalogProductPublicationQualificationInput,
  type CatalogProductWarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";
import {
  catalogProductRetirementSourceHeadDigest,
  parseCatalogProductRetirementCoverage,
} from "./product-publication-source-v2.js";
import { assessProductUniqueScopeRulesV2 } from "../domain/product-unique-scope-v2.js";

export interface CatalogProductPublicationScopeInput {
  readonly command:
    ProductPublicationCommandV2 | CatalogProductPublicationWarningAcknowledgementCommand;
  readonly aggregate: ProductAggregate;
  readonly current: ProductPublicationVersionV2 | null;
  readonly report: CatalogProductPublicationValidationReport | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function readClosedRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const ownKeys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}
function bind(value: unknown) {
  const r = readClosedRecord(value, [
      "command",
      "aggregate",
      "current",
      "report",
      "observedAt",
      "validUntil",
    ]),
    command = copyCategoryPersistenceValue(r.command);
  if (!command || typeof command !== "object" || Array.isArray(command)) return fail();
  if (
    (command as Record<string, unknown>).profile ===
    "CatalogProductPublicationWarningAcknowledgementCommandV1"
  )
    // The owning binder parses all fields, including the separately bounded
    // original report. This cast does not represent source acquisition.
    return bindCatalogProductWarningAcknowledgementQualificationContext(
      r as unknown as CatalogProductWarningAcknowledgementQualificationInput,
    );
  if (
    (command as Record<string, unknown>).profile !== "CatalogProductPublicationCommandV2" ||
    r.report !== null
  )
    return fail();
  return bindCatalogProductPublicationQualificationContext(
    {
      command: r.command,
      aggregate: r.aggregate,
      current: r.current,
      content: null,
      observedAt: r.observedAt,
    } as CatalogProductPublicationQualificationInput,
    parseCatalogInstant(r.validUntil),
  );
}

/** Pure qualification of the original publication/Ack target. Complete owning
 * coverage, roster, policy and permissions must be held by the caller. Active
 * members inherit this explicit unambiguous Product scope; this establishes no
 * price, inventory, availability, InternalCode, SKU-008 or sale qualification.
 */
export function assessCatalogProductPublicationScope(
  inputValue: unknown,
  coverageValue: unknown,
  storesValue: unknown,
  policyValue: unknown,
  nowValue: unknown,
) {
  try {
    const context = bind(inputValue),
      coverage = parseCatalogProductRetirementCoverage(coverageValue),
      stores = parseTenantStoreReferenceSnapshot(copyCategoryPersistenceValue(storesValue)),
      p = readClosedRecord(copyCategoryPersistenceValue(policyValue), [
        "content",
        "currentPublicationReference",
        "observedAt",
        "validUntil",
      ]),
      policy = parsePublishingProductPublicationPolicy(p.content),
      policyAt = parseCatalogInstant(p.observedAt),
      policyUntil = parseCatalogInstant(p.validUntil),
      policyPublicationReference = parseCatalogReference(p.currentPublicationReference),
      observedAt = context.observedAt,
      now = parseCatalogInstant(nowValue),
      policyAgeUntil = new Date(Date.parse(policyAt) + 5000).toISOString(),
      current = coverage.latest.find((head) => head.versionReference === context.versionReference),
      intent = context.replacementIntent,
      withdrawing =
        context.kind === "Publication" &&
        ["Reject", "CancelScheduledPublish"].includes(context.command.action),
      periodExpired =
        context.effectivePeriod.effectiveUntil !== null &&
        context.effectivePeriod.effectiveUntil.instant <= now;
    let validUntil =
      [
        context.validUntil,
        policyUntil,
        policyAgeUntil,
        ...(withdrawing || context.effectivePeriod.effectiveUntil === null
          ? []
          : [context.effectivePeriod.effectiveUntil.instant]),
      ].sort()[0] ?? fail();
    let replacementTargetNotCurrent = false;
    if (
      context.aggregate.draft.editorContent === undefined ||
      coverage.tenantReference !== context.tenantReference ||
      coverage.brandReference !== context.brandReference ||
      coverage.productReference !== context.productReference ||
      coverage.aggregateVersion !== context.aggregateVersion ||
      !equal(current ?? null, context.current) ||
      coverage.observedAt < observedAt ||
      coverage.observedAt > now ||
      stores.brandReference !== context.brandReference ||
      stores.originalIntentDigest !== context.originalIntentDigest ||
      stores.observedAt !== coverage.observedAt ||
      policy.tenantReference !== context.tenantReference ||
      policy.brandReference !== context.brandReference ||
      policyAt > coverage.observedAt ||
      policyAt > now ||
      policyUntil <= policyAt ||
      Date.parse(policyUntil) - Date.parse(policyAt) > 30000 ||
      parseCatalogInstant(policy.effectiveFrom) > policyAt ||
      (policy.effectiveUntil !== null &&
        policyUntil > parseCatalogInstant(policy.effectiveUntil)) ||
      now < observedAt ||
      now >= validUntil ||
      (context.recordedPolicy !== null &&
        !(context.kind === "Publication" && context.command.action === "Validate") &&
        (context.recordedPolicy.policyReference !== policy.policyReference ||
          context.recordedPolicy.policyVersion !== policy.policyVersion))
    )
      return fail();
    if (intent.mode === "PermanentSelectorRetirement") {
      const previous = coverage.latest.find(
          (head) => head.versionReference === intent.previousVersionReference,
        ),
        selector = previous?.scopeSet[intent.previousSelectorIndex];
      if (
        !previous ||
        previous.state !== "Published" ||
        previous.operationReference !== intent.previousPublicationOperationReference ||
        previous.publicationVersion !== intent.expectedPreviousPublicationVersion ||
        previous.intentDigest !== intent.previousIntentDigest ||
        previous.scopeDigest !== intent.previousScopeDigest ||
        previous.periodDigest !== intent.previousPeriodDigest ||
        previous.occurredAt > context.command.occurredAt ||
        previous.publishedAt === null ||
        previous.publishedAt > now ||
        previous.effectivePeriod.effectiveFrom.instant > now ||
        (previous.effectivePeriod.effectiveUntil !== null &&
          now >= previous.effectivePeriod.effectiveUntil.instant) ||
        previous.scopeSet.length < 1 ||
        previous.scopeSet.some((scope) => scope.level !== "Store") ||
        new Set(previous.scopeSet.map((scope) => scope.reference)).size !==
          previous.scopeSet.length ||
        !selector ||
        hash(selector) !== intent.previousSelectorDigest ||
        context.scopeSet.length !== 1 ||
        !equal(selector, context.scopeSet[0]) ||
        coverage.headers.some((header) =>
          header.retirements.some(
            (row) =>
              row.replacementIntent.previousPublicationOperationReference ===
                previous.operationReference &&
              row.replacementIntent.previousSelectorIndex === intent.previousSelectorIndex,
          ),
        )
      ) {
        if (!withdrawing) return fail();
        replacementTargetNotCurrent = true;
      }
      const previousUntil = previous?.effectivePeriod.effectiveUntil;
      if (!withdrawing && previousUntil && previousUntil.instant < validUntil)
        validUntil = previousUntil.instant;
    }
    const activeStores = new Set(
        stores.references
          .filter((store) => store.lifecycle === "Active")
          .map((store) => store.storeReference),
      ),
      assessedRules =
        periodExpired && withdrawing
          ? Object.freeze({
              check: Object.freeze({ code: "UniqueScope" as const, outcome: "HardError" as const }),
              findings: Object.freeze([
                Object.freeze({
                  reason: "PUBLICATION_PERIOD_EXPIRED" as const,
                  versionReference: null,
                  selectorIndex: 0,
                  counterpartIndex: null,
                }),
              ]),
              supportedTopology: "RegisteredBrandStoreOnly" as const,
              equalRankResolution: "NotEvaluatedForExpiredPeriod" as const,
            })
          : assessProductUniqueScopeRulesV2({
              command: {
                versionReference: context.versionReference,
                scopeSet: context.scopeSet,
                effectivePeriod: context.effectivePeriod,
              },
              latest: coverage.latest,
              scopeOrder: policy.scopeOrder,
              activeStores,
              brandActive: stores.brandLifecycle === "Active",
              registeredStoreCount: stores.references.length,
              observedAt: now,
              replacementIntent: replacementTargetNotCurrent ? { mode: "None" } : intent,
              retirementHeaders: coverage.headers,
            }),
      rules = replacementTargetNotCurrent
        ? Object.freeze({
            ...assessedRules,
            check: Object.freeze({ code: "UniqueScope" as const, outcome: "HardError" as const }),
            findings: Object.freeze([
              ...assessedRules.findings,
              Object.freeze({
                reason: "REPLACEMENT_TARGET_NOT_CURRENT" as const,
                versionReference:
                  intent.mode === "PermanentSelectorRetirement"
                    ? intent.previousVersionReference
                    : null,
                selectorIndex: 0,
                counterpartIndex:
                  intent.mode === "PermanentSelectorRetirement"
                    ? intent.previousSelectorIndex
                    : null,
              }),
            ]),
            equalRankResolution: "ReplacementTargetNotCurrent" as const,
          })
        : assessedRules,
      activeSkuReferences = Object.freeze(
        context.aggregate.draft.skus
          .filter((sku) => sku.lifecycle === "Active")
          .map((sku) => sku.skuReference)
          .sort(),
      ),
      scopeQualified = rules.check.outcome === "Pass" && activeStores.size > 0,
      skuQualification = !scopeQualified
        ? ("ScopeNotQualified" as const)
        : activeSkuReferences.length === 0
          ? ("NoActiveMember" as const)
          : ("ActiveMemberInRegisteredUnambiguousProductScope" as const),
      // Match the rule kernel's temporal candidate set. Do not fingerprint its
      // own Draft/review head, workflow counters, source clocks or generations.
      relevantHeads = coverage.latest.filter((head) => {
        if (
          head.versionReference === context.versionReference ||
          !["Published", "Superseded", "Scheduled"].includes(head.state)
        )
          return false;
        const from =
          [
            now,
            context.effectivePeriod.effectiveFrom.instant,
            head.effectivePeriod.effectiveFrom.instant,
            ...(head.state === "Scheduled" || head.publishedAt === null ? [] : [head.publishedAt]),
          ]
            .sort()
            .at(-1) ?? fail();
        const until = [
          context.effectivePeriod.effectiveUntil?.instant,
          head.effectivePeriod.effectiveUntil?.instant,
          head.supersededAt,
        ]
          .filter((value): value is string => value !== undefined && value !== null)
          .sort()[0];
        return until === undefined || until > from;
      }),
      relevantVersions = new Set(relevantHeads.map((head) => head.versionReference)),
      referencedStores = new Set(
        [...context.scopeSet, ...relevantHeads.flatMap((head) => head.scopeSet)].flatMap((scope) =>
          scope.level === "Store" && scope.reference !== null ? [scope.reference] : [],
        ),
      ),
      broadTarget = context.scopeSet.some((scope) => scope.level !== "Store"),
      relevantStores = broadTarget
        ? stores.references.map((store) => ({
            storeReference: store.storeReference,
            lifecycle: store.lifecycle,
          }))
        : [...referencedStores].sort().map((reference) => ({
            storeReference: reference,
            lifecycle:
              stores.references.find((store) => store.storeReference === reference)?.lifecycle ??
              null,
          })),
      storeRelevantDigest = hash({
        brandLifecycle: stores.brandLifecycle,
        registeredStoresPresent: stores.references.length > 0,
        scopeQualified,
        references: relevantStores,
      }),
      scopeRelevantDigest = hash({
        scopeOrder: policy.scopeOrder,
        heads: relevantHeads.map((head) => ({
          versionReference: head.versionReference,
          state: head.state,
          scopeSet: head.scopeSet,
          effectivePeriod: head.effectivePeriod,
          publishedAt: head.publishedAt,
          supersededAt: head.supersededAt,
        })),
        retirements: coverage.headers
          .flatMap((header) => header.retirements)
          .filter(
            (row) =>
              relevantVersions.has(row.replacementIntent.previousVersionReference) &&
              row.retiredAt <= now,
          )
          .map((row) => ({
            previousVersionReference: row.replacementIntent.previousVersionReference,
            previousPublicationOperationReference:
              row.replacementIntent.previousPublicationOperationReference,
            previousSelectorIndex: row.replacementIntent.previousSelectorIndex,
            previousSelectorDigest: row.replacementIntent.previousSelectorDigest,
            retiredAt: row.retiredAt,
          })),
      }),
      body = {
        profile: "CatalogProductPublicationScopeAssessmentV1" as const,
        tenantReference: context.tenantReference,
        brandReference: context.brandReference,
        productReference: context.productReference,
        versionReference: context.versionReference,
        aggregateVersion: context.aggregateVersion,
        contentDigest: context.contentDigest,
        configurationDigest: context.configurationDigest,
        originalIntentDigest: context.originalIntentDigest,
        replacementIntentDigest: context.replacementIntentDigest,
        sourceDigest: coverage.digest,
        sourceRevision: coverage.sourceRevision,
        sourceHeadDigest: catalogProductRetirementSourceHeadDigest({
          tenantReference: coverage.tenantReference,
          brandReference: coverage.brandReference,
          productReference: coverage.productReference,
          aggregateVersion: coverage.aggregateVersion,
          sourceRevision: coverage.sourceRevision,
          latest: coverage.latest,
        }),
        registeredStoreDigest: tenantStoreReferenceDigest(stores),
        policyReference: policy.policyReference,
        policyVersion: policy.policyVersion,
        policyContentDigest: publishingProductPublicationPolicyDigest(policy),
        policyPublicationReference,
        observedAt,
        validUntil,
        ...rules,
        activeSkuReferences,
        skuQualification,
        storeRelevantDigest,
        scopeRelevantDigest,
        relevantReferenceDigest: hash({ storeRelevantDigest, scopeRelevantDigest }),
        publishableSkuCheck: Object.freeze({
          code: "PublishableSku" as const,
          outcome:
            skuQualification === "ActiveMemberInRegisteredUnambiguousProductScope"
              ? ("Pass" as const)
              : ("HardError" as const),
        }),
        sourceAuthority: "NotEvaluated" as const,
        publishValidation: "Incomplete" as const,
        eligibility: "NotEvaluated" as const,
      };
    return Object.freeze({ ...body, digest: hash(body) });
  } catch {
    return fail();
  }
}
export type CatalogProductPublicationScopeAssessment = ReturnType<
  typeof assessCatalogProductPublicationScope
>;
