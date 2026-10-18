import { canonicalizeRfc8785 } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseCatalogFullOptionSetPublicationContent,
  parseCatalogOptionSetEditorContent,
} from "./option-set-editor-content.js";

export type OptionSetHistoryKind = "DraftSnapshot" | "FrozenSeal" | "OperationOnly";
export interface OptionSetHistoryPosition {
  readonly resultAggregateVersion: number;
  readonly operationReference: string;
  readonly kind: OptionSetHistoryKind;
}
export interface OptionSetHistoryRequest {
  readonly optionSetReference: string;
  readonly expectedAggregateVersion: number | null;
  readonly before: OptionSetHistoryPosition | null;
  readonly limit: number;
}
export interface OptionSetHistoricalDraftRequest {
  readonly optionSetReference: string;
  readonly operationReference: string;
  readonly versionReference: string;
  readonly resultAggregateVersion: number;
  readonly expectedSourceDigest: string;
  readonly expectedContentDigest: string;
  readonly expectedConfigurationDigest: string;
}
export interface OptionSetHistoryEntry extends OptionSetHistoryPosition {
  readonly action: "Create" | "ReplaceDraft" | "Archive" | "Publish";
  readonly occurredAt: string;
  readonly availability: "Complete" | "UnavailableLegacy";
  readonly versionReference: string | null;
  readonly sourceAggregateVersion: number | null;
  readonly sourceDigest: string | null;
  readonly contentDigest: string | null;
  readonly configurationDigest: string | null;
  readonly recordDigest: string | null;
}
export interface OptionSetHistoryResult {
  readonly profile: "CatalogOptionSetHistoryV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly optionSetReference: string;
  readonly currentAggregateVersion: number;
  readonly entries: readonly OptionSetHistoryEntry[];
  readonly nextBefore: OptionSetHistoryPosition | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publicationStatus: "NotEvaluated";
}
export interface OptionSetHistoricalDraftResult {
  readonly profile: "CatalogOptionSetHistoricalDraftV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly optionSetReference: string;
  readonly originalTuple: Readonly<{
    operationReference: string;
    versionReference: string;
    resultAggregateVersion: number;
    action: "Create" | "ReplaceDraft" | "Publish";
    intentDigest: string;
    occurredAt: string;
  }>;
  readonly content: ReturnType<typeof parseCatalogOptionSetEditorContent>["content"];
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const copied = copyCategoryPersistenceValue(value);
  if (
    copied === null ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.getPrototypeOf(copied) !== Object.prototype ||
    Reflect.ownKeys(copied).length !== keys.length ||
    Reflect.ownKeys(copied).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  return copied as Record<string, unknown>;
}
function integer(v: unknown, maximum = 2147483647): number {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > maximum) return fail();
  return v as number;
}
function digest(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(v)) return fail();
  return v;
}
function kind(v: unknown): OptionSetHistoryKind {
  if (v !== "DraftSnapshot" && v !== "FrozenSeal" && v !== "OperationOnly") return fail();
  return v;
}
function position(v: unknown): OptionSetHistoryPosition {
  const r = closed(v, ["resultAggregateVersion", "operationReference", "kind"]);
  return Object.freeze({
    resultAggregateVersion: integer(r.resultAggregateVersion),
    operationReference: parseCatalogReference(r.operationReference),
    kind: kind(r.kind),
  });
}
function action(v: unknown): OptionSetHistoryEntry["action"] {
  if (v !== "Create" && v !== "ReplaceDraft" && v !== "Archive" && v !== "Publish") return fail();
  return v;
}
function descending(a: OptionSetHistoryPosition, b: OptionSetHistoryPosition): number {
  return (
    b.resultAggregateVersion - a.resultAggregateVersion ||
    (a.operationReference < b.operationReference
      ? 1
      : a.operationReference > b.operationReference
        ? -1
        : 0) ||
    (a.kind < b.kind ? 1 : a.kind > b.kind ? -1 : 0)
  );
}
export function parseCatalogOptionSetHistoryRequest(v: unknown): OptionSetHistoryRequest {
  try {
    const r = closed(v, ["optionSetReference", "expectedAggregateVersion", "before", "limit"]);
    const before = r.before === null ? null : position(r.before);
    const expected =
      r.expectedAggregateVersion === null ? null : integer(r.expectedAggregateVersion);
    if (before !== null && (expected === null || before.resultAggregateVersion > expected))
      return fail();
    return Object.freeze({
      optionSetReference: parseCatalogReference(r.optionSetReference),
      expectedAggregateVersion: expected,
      before,
      limit: integer(r.limit, 50),
    });
  } catch {
    return fail();
  }
}
export function parseCatalogOptionSetHistoricalDraftRequest(
  v: unknown,
): OptionSetHistoricalDraftRequest {
  try {
    const r = closed(v, [
      "optionSetReference",
      "operationReference",
      "versionReference",
      "resultAggregateVersion",
      "expectedSourceDigest",
      "expectedContentDigest",
      "expectedConfigurationDigest",
    ]);
    return Object.freeze({
      optionSetReference: parseCatalogReference(r.optionSetReference),
      operationReference: parseCatalogReference(r.operationReference),
      versionReference: parseCatalogReference(r.versionReference),
      resultAggregateVersion: integer(r.resultAggregateVersion),
      expectedSourceDigest: digest(r.expectedSourceDigest),
      expectedContentDigest: digest(r.expectedContentDigest),
      expectedConfigurationDigest: digest(r.expectedConfigurationDigest),
    });
  } catch {
    return fail();
  }
}
export function parseCatalogOptionSetHistoryResult(
  v: unknown,
  requestValue: unknown,
): OptionSetHistoryResult {
  try {
    const request = parseCatalogOptionSetHistoryRequest(requestValue);
    const r = closed(v, [
      "profile",
      "tenantReference",
      "brandReference",
      "optionSetReference",
      "currentAggregateVersion",
      "entries",
      "nextBefore",
      "observedAt",
      "validUntil",
      "publicationStatus",
    ]);
    if (
      r.profile !== "CatalogOptionSetHistoryV1" ||
      r.publicationStatus !== "NotEvaluated" ||
      !Array.isArray(r.entries) ||
      r.entries.length > request.limit
    )
      return fail();
    const currentAggregateVersion = integer(r.currentAggregateVersion),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      (request.expectedAggregateVersion !== null &&
        currentAggregateVersion !== request.expectedAggregateVersion)
    )
      return fail();
    const entries = r.entries.map((v): OptionSetHistoryEntry => {
      const e = closed(v, [
        "resultAggregateVersion",
        "operationReference",
        "kind",
        "action",
        "occurredAt",
        "availability",
        "versionReference",
        "sourceAggregateVersion",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "recordDigest",
      ]);
      const p = position({
          resultAggregateVersion: e.resultAggregateVersion,
          operationReference: e.operationReference,
          kind: e.kind,
        }),
        a = action(e.action),
        occurredAt = parseCatalogInstant(e.occurredAt);
      if (p.resultAggregateVersion > currentAggregateVersion || occurredAt > observedAt)
        return fail();
      const complete = e.availability === "Complete";
      if (!complete && e.availability !== "UnavailableLegacy") return fail();
      if (complete !== (p.kind !== "OperationOnly")) return fail();
      if (
        !complete &&
        [
          e.versionReference,
          e.sourceAggregateVersion,
          e.sourceDigest,
          e.contentDigest,
          e.configurationDigest,
          e.recordDigest,
        ].some((v) => v !== null)
      )
        return fail();
      const sourceAggregateVersion =
        e.sourceAggregateVersion === null ? null : integer(e.sourceAggregateVersion);
      if (
        p.kind === "DraftSnapshot" &&
        (a === "Archive" ||
          sourceAggregateVersion !== p.resultAggregateVersion ||
          e.recordDigest !== null)
      )
        return fail();
      if (
        p.kind === "FrozenSeal" &&
        (a !== "Publish" ||
          sourceAggregateVersion === null ||
          sourceAggregateVersion + 1 !== p.resultAggregateVersion)
      )
        return fail();
      return Object.freeze({
        ...p,
        action: a,
        occurredAt,
        availability: complete ? "Complete" : "UnavailableLegacy",
        versionReference:
          e.versionReference === null ? null : parseCatalogReference(e.versionReference),
        sourceAggregateVersion,
        sourceDigest: e.sourceDigest === null ? null : digest(e.sourceDigest),
        contentDigest: e.contentDigest === null ? null : digest(e.contentDigest),
        configurationDigest: e.configurationDigest === null ? null : digest(e.configurationDigest),
        recordDigest: e.recordDigest === null ? null : digest(e.recordDigest),
      });
    });
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (
        !e ||
        (e.availability === "Complete" &&
          (e.versionReference === null ||
            e.sourceDigest === null ||
            e.contentDigest === null ||
            e.configurationDigest === null ||
            (e.kind === "FrozenSeal" && e.recordDigest === null)))
      )
        return fail();
      const previous = i === 0 ? request.before : entries[i - 1];
      if (previous && descending(previous, e) >= 0) return fail();
    }
    const nextBefore = r.nextBefore === null ? null : position(r.nextBefore);
    const last = entries.at(-1);
    if (
      nextBefore !== null &&
      (!last ||
        entries.length !== request.limit ||
        canonicalizeRfc8785(nextBefore) !==
          canonicalizeRfc8785({
            resultAggregateVersion: last.resultAggregateVersion,
            operationReference: last.operationReference,
            kind: last.kind,
          }))
    )
      return fail();
    const optionSetReference = parseCatalogReference(r.optionSetReference);
    if (optionSetReference !== request.optionSetReference) return fail();
    return Object.freeze({
      profile: "CatalogOptionSetHistoryV1",
      tenantReference: parseCatalogReference(r.tenantReference),
      brandReference: parseCatalogReference(r.brandReference),
      optionSetReference,
      currentAggregateVersion,
      entries: Object.freeze(entries),
      nextBefore,
      observedAt,
      validUntil,
      publicationStatus: "NotEvaluated",
    });
  } catch {
    return fail();
  }
}
export function parseCatalogOptionSetHistoricalDraftResult(
  v: unknown,
  requestValue: unknown,
): OptionSetHistoricalDraftResult {
  try {
    const request = parseCatalogOptionSetHistoricalDraftRequest(requestValue);
    const r = closed(v, [
      "profile",
      "tenantReference",
      "brandReference",
      "optionSetReference",
      "originalTuple",
      "content",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "observedAt",
      "validUntil",
      "referenceEligibility",
    ]);
    const t = closed(r.originalTuple, [
      "operationReference",
      "versionReference",
      "resultAggregateVersion",
      "action",
      "intentDigest",
      "occurredAt",
    ]);
    const c = closed(r.content, [
      "profile",
      "sourceAggregate",
      "optionDetails",
      "conditionalRules",
      "conflictRules",
      "scopeSet",
      "effectivePeriod",
    ]);
    const { sourceAggregate, ...details } = c,
      full = parseCatalogOptionSetEditorContent(sourceAggregate, details);
    const originalAction = action(t.action),
      occurredAt = parseCatalogInstant(t.occurredAt),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    const source = full.content.sourceAggregate,
      optionSetReference = parseCatalogReference(r.optionSetReference),
      brandReference = parseCatalogReference(r.brandReference);
    if (
      r.profile !== "CatalogOptionSetHistoricalDraftV1" ||
      r.referenceEligibility !== "NotEvaluated" ||
      originalAction === "Archive" ||
      source.optionSetReference !== optionSetReference ||
      source.brandReference !== brandReference ||
      optionSetReference !== request.optionSetReference ||
      t.operationReference !== request.operationReference ||
      t.versionReference !== request.versionReference ||
      t.resultAggregateVersion !== request.resultAggregateVersion ||
      source.aggregateVersion !== request.resultAggregateVersion ||
      source.draft.versionReference !== request.versionReference ||
      source.updatedAt !== occurredAt ||
      occurredAt > observedAt ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      full.sourceDigest !== request.expectedSourceDigest ||
      full.contentDigest !== request.expectedContentDigest ||
      full.configurationDigest !== request.expectedConfigurationDigest ||
      r.sourceDigest !== full.sourceDigest ||
      r.contentDigest !== full.contentDigest ||
      r.configurationDigest !== full.configurationDigest
    )
      return fail();
    return Object.freeze({
      profile: "CatalogOptionSetHistoricalDraftV1",
      tenantReference: parseCatalogReference(r.tenantReference),
      brandReference,
      optionSetReference,
      originalTuple: Object.freeze({
        operationReference: parseCatalogReference(t.operationReference),
        versionReference: parseCatalogReference(t.versionReference),
        resultAggregateVersion: integer(t.resultAggregateVersion),
        action: originalAction,
        intentDigest: digest(t.intentDigest),
        occurredAt,
      }),
      ...full,
      observedAt,
      validUntil,
      referenceEligibility: "NotEvaluated",
    });
  } catch {
    return fail();
  }
}

export interface OptionSetHistoricalFrozenRequest extends OptionSetHistoricalDraftRequest {
  readonly expectedRecordDigest: string;
}
export interface OptionSetHistoricalFrozenResult {
  readonly profile: "CatalogOptionSetHistoricalFrozenV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly optionSetReference: string;
  readonly originalTuple: Readonly<{
    operationReference: string;
    versionReference: string;
    resultAggregateVersion: number;
    action: "Publish";
    intentDigest: string;
    occurredAt: string;
  }>;
  readonly content: ReturnType<typeof parseCatalogFullOptionSetPublicationContent>;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly recordDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly recordingStatus: "RecordedFrozen";
  readonly referenceEligibility: "NotEvaluated";
}
export function parseCatalogOptionSetHistoricalFrozenRequest(
  value: unknown,
): OptionSetHistoricalFrozenRequest {
  try {
    const r = closed(value, [
      "optionSetReference",
      "operationReference",
      "versionReference",
      "resultAggregateVersion",
      "expectedSourceDigest",
      "expectedContentDigest",
      "expectedConfigurationDigest",
      "expectedRecordDigest",
    ]);
    const { expectedRecordDigest, ...selected } = r;
    return Object.freeze({
      ...parseCatalogOptionSetHistoricalDraftRequest(selected),
      expectedRecordDigest: digest(expectedRecordDigest),
    });
  } catch {
    return fail();
  }
}
export function parseCatalogOptionSetHistoricalFrozenResult(
  value: unknown,
  requestValue: unknown,
): OptionSetHistoricalFrozenResult {
  try {
    const request = parseCatalogOptionSetHistoricalFrozenRequest(requestValue);
    const r = closed(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "optionSetReference",
      "originalTuple",
      "content",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "recordDigest",
      "observedAt",
      "validUntil",
      "recordingStatus",
      "referenceEligibility",
    ]);
    const t = closed(r.originalTuple, [
      "operationReference",
      "versionReference",
      "resultAggregateVersion",
      "action",
      "intentDigest",
      "occurredAt",
    ]);
    const content = parseCatalogFullOptionSetPublicationContent(r.content),
      supported = content.supportedContent;
    const tenantReference = parseCatalogReference(r.tenantReference),
      brandReference = parseCatalogReference(r.brandReference),
      optionSetReference = parseCatalogReference(r.optionSetReference);
    const occurredAt = parseCatalogInstant(t.occurredAt),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogOptionSetHistoricalFrozenV1" ||
      r.recordingStatus !== "RecordedFrozen" ||
      r.referenceEligibility !== "NotEvaluated" ||
      t.action !== "Publish" ||
      optionSetReference !== request.optionSetReference ||
      supported.optionSetReference !== optionSetReference ||
      supported.tenantReference !== tenantReference ||
      supported.brandReference !== brandReference ||
      t.operationReference !== request.operationReference ||
      t.versionReference !== request.versionReference ||
      t.resultAggregateVersion !== request.resultAggregateVersion ||
      supported.publicationOperationReference !== request.operationReference ||
      supported.versionReference !== request.versionReference ||
      supported.sourceAggregateVersion + 1 !== request.resultAggregateVersion ||
      supported.publicationIntentDigest !== t.intentDigest ||
      supported.sealedAt !== occurredAt ||
      occurredAt > observedAt ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      content.sourceDigest !== request.expectedSourceDigest ||
      content.contentDigest !== request.expectedContentDigest ||
      content.configurationDigest !== request.expectedConfigurationDigest ||
      content.digest !== request.expectedRecordDigest ||
      r.sourceDigest !== content.sourceDigest ||
      r.contentDigest !== content.contentDigest ||
      r.configurationDigest !== content.configurationDigest ||
      r.recordDigest !== content.digest
    )
      return fail();
    return Object.freeze({
      profile: "CatalogOptionSetHistoricalFrozenV1",
      tenantReference,
      brandReference,
      optionSetReference,
      originalTuple: Object.freeze({
        operationReference: parseCatalogReference(t.operationReference),
        versionReference: parseCatalogReference(t.versionReference),
        resultAggregateVersion: integer(t.resultAggregateVersion),
        action: "Publish",
        intentDigest: digest(t.intentDigest),
        occurredAt,
      }),
      content,
      sourceDigest: content.sourceDigest,
      contentDigest: content.contentDigest,
      configurationDigest: content.configurationDigest,
      recordDigest: content.digest,
      observedAt,
      validUntil,
      recordingStatus: "RecordedFrozen",
      referenceEligibility: "NotEvaluated",
    });
  } catch {
    return fail();
  }
}
