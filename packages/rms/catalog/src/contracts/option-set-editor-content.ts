import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogLocale,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseOptionSetAggregate, type OptionSetAggregate } from "./option-set.js";
import {
  createCatalogOptionSetPublicationMaterialization,
  deriveCatalogOptionSetPublicationContentIdentity,
  deriveCatalogOptionSetSupportedContentIdentity,
  parseCatalogOptionSetPublicationContent,
  type CatalogOptionSetPublicationContent,
} from "./option-set-publication-content.js";
import {
  productPublicationScopeLevels,
  type ProductPublicationScope,
} from "./product-publication.js";
import {
  validateOptionSetEditorRules,
  type OptionSetEditorContent,
  type OptionSetEditorContentDetails,
  type OptionSetOptionDetails,
} from "../domain/option-set-editor-content.js";
export type {
  OptionSetEditorContent,
  OptionSetEditorContentDetails,
  OptionSetOptionDetails,
  OptionSetConditionalRule,
  OptionSetConflictRule,
  OptionSetContentReference,
} from "../domain/option-set-editor-content.js";

const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k)))
    return fail();
  return r;
}
function list<T>(value: unknown, parse: (v: unknown) => T, minimum = 0): readonly T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) return fail();
  return Object.freeze(value.map(parse));
}
function unique<T>(items: readonly T[], key: (v: T) => string): readonly T[] {
  if (new Set(items.map(key)).size !== items.length) return fail();
  return items;
}
function refs(value: unknown, minimum = 0): readonly string[] {
  return Object.freeze([...unique(list(value, parseCatalogReference, minimum), (r) => r)].sort());
}
function code(value: unknown): string {
  const parsed = parseCatalogCode(value);
  if (value !== parsed) return fail();
  return parsed;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 999)
    return fail();
  return value as number;
}
function pinned(value: unknown) {
  if (value === null) return null;
  const r = record(value, ["reference", "versionReference"]);
  return Object.freeze({
    reference: parseCatalogReference(r.reference),
    versionReference: parseCatalogReference(r.versionReference),
  });
}
function positiveDecimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})$|^[1-9][0-9]{0,13}$/.test(value) ||
    BigInt(value.replace(".", "")) <= 0n
  )
    return fail();
  const [whole, fraction] = value.split("."),
    tail = fraction?.replace(/0+$/, "");
  return whole + (tail ? "." + tail : "");
}
function altText(value: unknown, defaultLocale: string): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  if (!Object.hasOwn(r, defaultLocale) || Object.keys(r).length > 32) return fail();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(r)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([locale, text]) => {
          if (
            typeof text !== "string" ||
            text.trim().length === 0 ||
            text.length > 240 ||
            /[<>{}\p{Cc}]|https?:\/\/|www\./u.test(text)
          )
            return fail();
          return [parseCatalogLocale(locale), text.trim().replace(/\s+/gu, " ")];
        }),
    ),
  );
}
function scopes(value: unknown): readonly ProductPublicationScope[] {
  const parsed = list(
    value,
    (v): ProductPublicationScope => {
      const r = record(v, ["level", "reference", "channelCodes", "orderTypeCodes"]);
      if (!(productPublicationScopeLevels as readonly unknown[]).includes(r.level)) return fail();
      const level = r.level as ProductPublicationScope["level"],
        reference =
          level === "Brand"
            ? r.reference === null
              ? null
              : fail()
            : level === "Channel" || level === "OrderType"
              ? code(r.reference)
              : parseCatalogReference(r.reference),
        channelCodes = Object.freeze([...unique(list(r.channelCodes, code), (c) => c)].sort()),
        orderTypeCodes = Object.freeze([...unique(list(r.orderTypeCodes, code), (c) => c)].sort());
      if (
        (level === "Channel" &&
          channelCodes.length > 0 &&
          (channelCodes.length !== 1 || channelCodes[0] !== reference)) ||
        (level === "OrderType" &&
          orderTypeCodes.length > 0 &&
          (orderTypeCodes.length !== 1 || orderTypeCodes[0] !== reference))
      )
        return fail();
      return Object.freeze({ level, reference, channelCodes, orderTypeCodes });
    },
    1,
  );
  return Object.freeze(
    [...unique(parsed, canonicalizeRfc8785)].sort((a, b) =>
      canonicalizeRfc8785(a).localeCompare(canonicalizeRfc8785(b), "en"),
    ),
  );
}
function details(value: unknown, source: OptionSetAggregate): OptionSetEditorContentDetails {
  const r = record(value, [
    "profile",
    "optionDetails",
    "conditionalRules",
    "conflictRules",
    "scopeSet",
    "effectivePeriod",
  ]);
  if (r.profile !== "CatalogOptionSetEditorContentV1") return fail();
  const optionDetails = list(r.optionDetails, (v): OptionSetOptionDetails => {
    const o = record(v, [
        "optionReference",
        "quantityRule",
        "media",
        "pricingRule",
        "consumption",
        "triggeredOptionSetVersionReference",
      ]),
      q = record(o.quantityRule, ["minimumQuantity", "maximumQuantity"]),
      minimumQuantity = integer(q.minimumQuantity, 0),
      maximumQuantity = integer(q.maximumQuantity, 1);
    if (minimumQuantity > maximumQuantity) return fail();
    let media: OptionSetOptionDetails["media"] = null;
    if (o.media !== null) {
      const m = record(o.media, [
        "mediaReference",
        "assetReference",
        "assetVersionReference",
        "altText",
      ]);
      media = Object.freeze({
        mediaReference: parseCatalogReference(m.mediaReference),
        assetReference: parseCatalogReference(m.assetReference),
        assetVersionReference: parseCatalogReference(m.assetVersionReference),
        altText: altText(m.altText, source.draft.defaultLocale),
      });
    }
    let consumption: OptionSetOptionDetails["consumption"] = null;
    if (o.consumption !== null) {
      const c = record(o.consumption, [
        "kind",
        "reference",
        "versionReference",
        "quantity",
        "unitCode",
      ]);
      if (c.kind !== "Inventory" && c.kind !== "Recipe") return fail();
      consumption = Object.freeze({
        kind: c.kind,
        reference: parseCatalogReference(c.reference),
        versionReference: parseCatalogReference(c.versionReference),
        quantity: positiveDecimal(c.quantity),
        unitCode: code(c.unitCode),
      });
    }
    return Object.freeze({
      optionReference: parseCatalogReference(o.optionReference),
      quantityRule: Object.freeze({ minimumQuantity, maximumQuantity }),
      media,
      pricingRule: pinned(o.pricingRule),
      consumption,
      triggeredOptionSetVersionReference:
        o.triggeredOptionSetVersionReference === null
          ? null
          : parseCatalogReference(o.triggeredOptionSetVersionReference),
    });
  });
  unique(optionDetails, (o) => o.optionReference);
  const conditionalRules = list(r.conditionalRules, (v) => {
      const c = record(v, ["ruleReference", "whenAllSelected", "requiredOptionReferences"]);
      return Object.freeze({
        ruleReference: parseCatalogReference(c.ruleReference),
        whenAllSelected: refs(c.whenAllSelected, 1),
        requiredOptionReferences: refs(c.requiredOptionReferences, 1),
      });
    }),
    conflictRules = list(r.conflictRules, (v) => {
      const c = record(v, ["ruleReference", "forbiddenTogether"]);
      return Object.freeze({
        ruleReference: parseCatalogReference(c.ruleReference),
        forbiddenTogether: refs(c.forbiddenTogether, 2),
      });
    });
  unique([...conditionalRules, ...conflictRules], (r) => r.ruleReference);
  unique(conditionalRules, (c) =>
    canonicalizeRfc8785([c.whenAllSelected, c.requiredOptionReferences]),
  );
  unique(conflictRules, (c) => canonicalizeRfc8785(c.forbiddenTogether));
  let effectivePeriod: EffectivePeriod;
  try {
    effectivePeriod = createEffectivePeriod(r.effectivePeriod as EffectivePeriod);
  } catch {
    return fail();
  }
  const content: OptionSetEditorContentDetails = Object.freeze({
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: Object.freeze(
      [...optionDetails].sort((a, b) => a.optionReference.localeCompare(b.optionReference)),
    ),
    conditionalRules: Object.freeze(
      [...conditionalRules].sort((a, b) => a.ruleReference.localeCompare(b.ruleReference)),
    ),
    conflictRules: Object.freeze(
      [...conflictRules].sort((a, b) => a.ruleReference.localeCompare(b.ruleReference)),
    ),
    scopeSet: scopes(r.scopeSet),
    effectivePeriod,
  });
  validateOptionSetEditorRules(source, content);
  return content;
}

export function parseCatalogOptionSetEditorContent(sourceValue: unknown, detailsValue: unknown) {
  const source = parseOptionSetAggregate(copyCategoryPersistenceValue(sourceValue)),
    supportedIdentity = deriveCatalogOptionSetSupportedContentIdentity(source),
    parsed = details(copyCategoryPersistenceValue(detailsValue), source),
    content: OptionSetEditorContent = Object.freeze({ ...parsed, sourceAggregate: source }),
    configuration = {
      ...parsed,
      optionDetails: parsed.optionDetails.map((o) => ({
        ...o,
        media:
          o.media === null
            ? null
            : {
                mediaReference: o.media.mediaReference,
                assetReference: o.media.assetReference,
                assetVersionReference: o.media.assetVersionReference,
              },
      })),
      supportedConfigurationDigest: supportedIdentity.configurationDigest,
    };
  return Object.freeze({
    content,
    sourceDigest: hash(content),
    contentDigest: hash({ sourceDraft: source.draft, ...parsed }),
    configurationDigest: hash(configuration),
    referenceEligibility: "NotEvaluated" as const,
  });
}

export interface CatalogFullOptionSetPublicationContent {
  readonly profile: "CatalogFullOptionSetDraftContentV2";
  readonly supportedContent: CatalogOptionSetPublicationContent;
  readonly editorContent: OptionSetEditorContent;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const transitionKeys = [
  "tenantReference",
  "brandReference",
  "optionSetReference",
  "versionReference",
  "sourceAggregateVersion",
  "publicationOperationReference",
  "publicationIntentDigest",
  "successorDraftVersionReference",
  "sealedAt",
  "sourceDigest",
  "contentDigest",
  "configurationDigest",
] as const;
export function createCatalogFullOptionSetPublicationMaterialization(
  sourceValue: unknown,
  detailsValue: unknown,
  transitionValue: unknown,
) {
  const prepared = parseCatalogOptionSetEditorContent(sourceValue, detailsValue),
    t = record(copyCategoryPersistenceValue(transitionValue), transitionKeys);
  if (
    t.sourceDigest !== prepared.sourceDigest ||
    t.contentDigest !== prepared.contentDigest ||
    t.configurationDigest !== prepared.configurationDigest
  )
    return fail();
  const supported = createCatalogOptionSetPublicationMaterialization(
      prepared.content.sourceAggregate,
      {
        ...t,
        ...deriveCatalogOptionSetPublicationContentIdentity(prepared.content.sourceAggregate),
      },
    ),
    base = {
      profile: "CatalogFullOptionSetDraftContentV2" as const,
      supportedContent: supported.content,
      editorContent: prepared.content,
      sourceDigest: prepared.sourceDigest,
      contentDigest: prepared.contentDigest,
      configurationDigest: prepared.configurationDigest,
      eligibility: "NotEvaluated" as const,
    },
    { sourceAggregate, ...additional } = prepared.content;
  void sourceAggregate;
  return Object.freeze({
    content: Object.freeze({ ...base, digest: hash(base) }),
    successor: supported.successor,
    successorEditorContent: parseCatalogOptionSetEditorContent(supported.successor, additional)
      .content,
  });
}
export function parseCatalogFullOptionSetPublicationContent(
  value: unknown,
): CatalogFullOptionSetPublicationContent {
  const r = record(copyCategoryPersistenceValue(value), [
      "profile",
      "supportedContent",
      "editorContent",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "eligibility",
      "digest",
    ]),
    supportedContent = parseCatalogOptionSetPublicationContent(r.supportedContent),
    editor = record(r.editorContent, [
      "profile",
      "sourceAggregate",
      "optionDetails",
      "conditionalRules",
      "conflictRules",
      "scopeSet",
      "effectivePeriod",
    ]),
    { sourceAggregate, ...additional } = editor,
    prepared = parseCatalogOptionSetEditorContent(supportedContent.sourceAggregate, additional);
  if (
    r.profile !== "CatalogFullOptionSetDraftContentV2" ||
    r.eligibility !== "NotEvaluated" ||
    canonicalizeRfc8785(sourceAggregate) !==
      canonicalizeRfc8785(supportedContent.sourceAggregate) ||
    r.sourceDigest !== prepared.sourceDigest ||
    r.contentDigest !== prepared.contentDigest ||
    r.configurationDigest !== prepared.configurationDigest
  )
    return fail();
  const base = {
      profile: "CatalogFullOptionSetDraftContentV2" as const,
      supportedContent,
      editorContent: prepared.content,
      sourceDigest: prepared.sourceDigest,
      contentDigest: prepared.contentDigest,
      configurationDigest: prepared.configurationDigest,
      eligibility: "NotEvaluated" as const,
    },
    digest = hash(base);
  if (r.digest !== digest) return fail();
  return Object.freeze({ ...base, digest });
}
