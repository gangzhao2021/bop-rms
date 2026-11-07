import { parseCanonicalInstant } from "../domain/brand-store.js";
import { parsePlatformTenantReference } from "./platform-tenant-administration.js";

export class PlatformBrandTemplateError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_TEMPLATE_INPUT_INVALID"
      | "PLATFORM_TEMPLATE_PERMISSION_DENIED"
      | "PLATFORM_TEMPLATE_VERSION_CONFLICT"
      | "PLATFORM_TEMPLATE_INTENT_CONFLICT"
      | "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Platform Brand template is unavailable");
    this.name = "PlatformBrandTemplateError";
  }
}
const fail = (): never => {
  throw new PlatformBrandTemplateError("PLATFORM_TEMPLATE_INPUT_INVALID");
};
/** Bounded detached data; accessors, hidden keys and mutated caller arrays are never accepted. */
export function copyPlatformBrandTemplateValue(value: unknown): unknown {
  let nodes = 0;
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 10) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 8192 ? v : fail();
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 100 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      const values: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return fail();
        values.push(copy(d.value, depth + 1));
      }
      return Object.freeze(values);
    }
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return fail();
    const r: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string" || key === "__proto__") return fail();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      r[key] = copy(d.value, depth + 1);
    }
    return Object.freeze(r);
  }
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32768) return fail();
  return result;
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const v = copyPlatformBrandTemplateValue(value);
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Reflect.ownKeys(v).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v as Record<string, unknown>;
}
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof PlatformBrandTemplateError) throw e;
    return fail();
  }
}
const ref = (v: unknown): string => safe(() => parsePlatformTenantReference(v));
const instant = (v: unknown): string => safe(() => parseCanonicalInstant(v));
const integer = (v: unknown, min = 1, max = 2147483647): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail();
const digest = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const code = (v: unknown): string =>
  typeof v === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(v) ? v : fail();
const locale = (v: unknown): string =>
  typeof v === "string" && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u.test(v)
    ? v
    : fail();
const list = (v: unknown, parser: (v: unknown) => string, min: number, max: number) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return fail();
  const items = v.map(parser);
  if (new Set(items).size !== items.length) return fail();
  return Object.freeze(items);
};
export interface PlatformBrandTemplateScope {
  readonly kind: "Platform";
  readonly actorReference: string;
  readonly purposeCode: "PLATFORM_BRAND_TEMPLATE";
}
export function parsePlatformBrandTemplateScope(value: unknown): PlatformBrandTemplateScope {
  const r = record(value, ["kind", "actorReference", "purposeCode"]);
  if (r.kind !== "Platform" || r.purposeCode !== "PLATFORM_BRAND_TEMPLATE") return fail();
  return Object.freeze({
    kind: "Platform",
    actorReference: ref(r.actorReference),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
  });
}
const scopeKeys = ["kind", "actorReference", "purposeCode"] as const;
const scopeOf = (r: Record<string, unknown>) =>
  parsePlatformBrandTemplateScope(Object.fromEntries(scopeKeys.map((k) => [k, r[k]])));
function templateName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    [...value].length < 1 ||
    [...value].length > 160 ||
    [...value].some((character) => {
      const point = character.charCodeAt(0);
      return point <= 0x1f || point === 0x7f;
    }) ||
    /[<>]/u.test(value)
  )
    return fail();
  return value;
}
export const platformBrandTemplateContentFields = [
  "code",
  "name",
  "defaultLocale",
  "supportedLocales",
  "overrideAllowedFieldCodes",
  "hardRequirementFieldCodes",
  "effectiveFrom",
  "effectiveUntil",
  "reasonCode",
] as const;
export function parsePlatformBrandTemplateContent(value: unknown) {
  const r = record(value, platformBrandTemplateContentFields),
    supportedLocales = list(r.supportedLocales, locale, 1, 20),
    defaultLocale = locale(r.defaultLocale),
    allowed = list(r.overrideAllowedFieldCodes, code, 0, 100),
    hard = list(r.hardRequirementFieldCodes, code, 0, 100),
    effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
  if (
    !supportedLocales.includes(defaultLocale) ||
    hard.some((k) => allowed.includes(k)) ||
    (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
  )
    return fail();
  return Object.freeze({
    code: code(r.code),
    name: templateName(r.name),
    defaultLocale,
    supportedLocales,
    overrideAllowedFieldCodes: allowed,
    hardRequirementFieldCodes: hard,
    effectiveFrom,
    effectiveUntil,
    reasonCode: code(r.reasonCode),
  });
}
export type PlatformBrandTemplateContent = ReturnType<typeof parsePlatformBrandTemplateContent>;
export interface PlatformBrandTemplateHead {
  readonly revision: number;
  readonly templateVersionReference: string;
  readonly sourceDigest: string;
}
function head(v: unknown): PlatformBrandTemplateHead | null {
  if (v === null) return null;
  const r = record(v, ["revision", "templateVersionReference", "sourceDigest"]);
  return Object.freeze({
    revision: integer(r.revision, 1, 2147483646),
    templateVersionReference: ref(r.templateVersionReference),
    sourceDigest: digest(r.sourceDigest),
  });
}
export function parsePlatformBrandTemplateSave(value: unknown) {
  const r = record(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "templateReference",
      "expectedHead",
      "content",
    ]),
    scope = scopeOf(r),
    expectedHead = head(r.expectedHead),
    templateReference = r.templateReference === null ? null : ref(r.templateReference);
  if (
    r.profile !== "PlatformBrandTemplateSaveV1" ||
    (templateReference === null) !== (expectedHead === null)
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateSaveV1" as const,
    ...scope,
    operationReference: ref(r.operationReference),
    templateReference,
    expectedHead,
    content: parsePlatformBrandTemplateContent(r.content),
  });
}
export type PlatformBrandTemplateSave = ReturnType<typeof parsePlatformBrandTemplateSave>;
export function parsePlatformBrandTemplateResolve(value: unknown) {
  const r = record(value, ["profile", ...scopeKeys, "operationReference", "intentDigest"]);
  if (r.profile !== "PlatformBrandTemplateResolveV1") return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateResolveV1" as const,
    ...scopeOf(r),
    operationReference: ref(r.operationReference),
    intentDigest: digest(r.intentDigest),
  });
}
export type PlatformBrandTemplateResolve = ReturnType<typeof parsePlatformBrandTemplateResolve>;
export interface PlatformBrandTemplateCodec {
  canonicalize(value: unknown): string;
  hashIntent(canonical: string): string;
}
const hash = (codec: PlatformBrandTemplateCodec, value: unknown) =>
  digest(codec.hashIntent(codec.canonicalize(value)));
export function platformBrandTemplateIntentDigest(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
) {
  return hash(codec, parsePlatformBrandTemplateSave(value));
}
export function parsePlatformBrandTemplateRevision(value: unknown) {
  const r = record(value, [
      "profile",
      "templateReference",
      "templateVersionReference",
      "revision",
      "recordKind",
      "content",
      "supersedesVersionReference",
      "authoredByReference",
      "operationReference",
      "auditReference",
      "createdAt",
      "recordedAt",
      "contentDigest",
      "sourceDigest",
      "dataClassification",
    ]),
    revision = integer(r.revision),
    createdAt = instant(r.createdAt),
    recordedAt = instant(r.recordedAt),
    supersedesVersionReference =
      r.supersedesVersionReference === null ? null : ref(r.supersedesVersionReference);
  if (
    r.profile !== "PlatformBrandTemplateRevisionV1" ||
    r.recordKind !== "AuthoredContent" ||
    r.dataClassification !== "ConfigurationMetadata" ||
    createdAt > recordedAt ||
    (revision === 1) !== (supersedesVersionReference === null) ||
    (revision === 1 && createdAt !== recordedAt)
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateRevisionV1" as const,
    templateReference: ref(r.templateReference),
    templateVersionReference: ref(r.templateVersionReference),
    revision,
    recordKind: "AuthoredContent" as const,
    content: parsePlatformBrandTemplateContent(r.content),
    supersedesVersionReference,
    authoredByReference: ref(r.authoredByReference),
    operationReference: ref(r.operationReference),
    auditReference: ref(r.auditReference),
    createdAt,
    recordedAt,
    contentDigest: digest(r.contentDigest),
    sourceDigest: digest(r.sourceDigest),
    dataClassification: "ConfigurationMetadata" as const,
  });
}
export type PlatformBrandTemplateRevision = ReturnType<typeof parsePlatformBrandTemplateRevision>;
export function platformBrandTemplateSemanticContent(value: unknown) {
  const r = parsePlatformBrandTemplateRevision(value);
  return Object.freeze({
    profile: "PlatformBrandTemplateContentV1" as const,
    templateReference: r.templateReference,
    templateVersionReference: r.templateVersionReference,
    revision: r.revision,
    content: {
      ...r.content,
      supportedLocales: [...r.content.supportedLocales].sort(),
      overrideAllowedFieldCodes: [...r.content.overrideAllowedFieldCodes].sort(),
      hardRequirementFieldCodes: [...r.content.hardRequirementFieldCodes].sort(),
    },
    supersedesVersionReference: r.supersedesVersionReference,
    authoredByReference: r.authoredByReference,
    createdAt: r.createdAt,
    dataClassification: r.dataClassification,
  });
}
export function assertPlatformBrandTemplateRevisionDigests(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
) {
  const r = parsePlatformBrandTemplateRevision(value),
    { sourceDigest, ...source } = r;
  if (
    r.contentDigest !== hash(codec, platformBrandTemplateSemanticContent(r)) ||
    sourceDigest !== hash(codec, source)
  )
    return fail();
  return r;
}
export function createPlatformBrandTemplateRevision(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
) {
  const r = record(value, [
      "profile",
      "templateReference",
      "templateVersionReference",
      "revision",
      "recordKind",
      "content",
      "supersedesVersionReference",
      "authoredByReference",
      "operationReference",
      "auditReference",
      "createdAt",
      "recordedAt",
      "dataClassification",
    ]),
    stub = "sha256:" + "0".repeat(64),
    initial = parsePlatformBrandTemplateRevision({ ...r, contentDigest: stub, sourceDigest: stub }),
    contentDigest = hash(codec, platformBrandTemplateSemanticContent(initial)),
    { sourceDigest, ...source } = { ...initial, contentDigest };
  void sourceDigest;
  return assertPlatformBrandTemplateRevisionDigests(
    { ...source, sourceDigest: hash(codec, source) },
    codec,
  );
}
export function parsePlatformBrandTemplateReceipt(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
) {
  const r = record(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "intentDigest",
      "originalCommand",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ]),
    scope = scopeOf(r),
    operationReference = ref(r.operationReference),
    intentDigest = digest(r.intentDigest),
    originalCommand =
      r.originalCommand === null ? null : parsePlatformBrandTemplateSave(r.originalCommand),
    snapshot =
      r.snapshot === null ? null : assertPlatformBrandTemplateRevisionDigests(r.snapshot, codec),
    auditReference = ref(r.auditReference),
    occurredAt = instant(r.occurredAt);
  if (
    r.profile !== "PlatformBrandTemplateOperationV1" ||
    r.dataClassification !== "ConfigurationMetadata" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
    (r.outcome === "Committed") !== (originalCommand !== null && snapshot !== null) ||
    (r.outcome === "Abandoned" && (originalCommand !== null || snapshot !== null))
  )
    return fail();
  if (originalCommand && snapshot) {
    if (
      originalCommand.actorReference !== scope.actorReference ||
      originalCommand.operationReference !== operationReference ||
      platformBrandTemplateIntentDigest(originalCommand, codec) !== intentDigest ||
      snapshot.authoredByReference !== scope.actorReference ||
      snapshot.operationReference !== operationReference ||
      snapshot.auditReference !== auditReference ||
      snapshot.recordedAt !== occurredAt ||
      snapshot.revision !== (originalCommand.expectedHead?.revision ?? 0) + 1 ||
      codec.canonicalize(originalCommand.content) !== codec.canonicalize(snapshot.content) ||
      (originalCommand.templateReference !== null &&
        originalCommand.templateReference !== snapshot.templateReference) ||
      snapshot.supersedesVersionReference !==
        (originalCommand.expectedHead?.templateVersionReference ?? null) ||
      (originalCommand.expectedHead &&
        originalCommand.expectedHead.templateVersionReference === snapshot.templateVersionReference)
    )
      return fail();
  }
  return Object.freeze({
    profile: "PlatformBrandTemplateOperationV1" as const,
    ...scope,
    operationReference,
    intentDigest,
    originalCommand,
    outcome: r.outcome,
    snapshot,
    auditReference,
    occurredAt,
    dataClassification: "ConfigurationMetadata" as const,
  });
}
export type PlatformBrandTemplateReceipt = ReturnType<typeof parsePlatformBrandTemplateReceipt>;
function readTime(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (
    r.publication !== "NotEvaluated" ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  return { observedAt, validUntil, publication: "NotEvaluated" as const };
}
export function parsePlatformBrandTemplateCurrent(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
) {
  const r = record(value, [
      "profile",
      ...scopeKeys,
      "templateReference",
      "current",
      "observedAt",
      "validUntil",
      "publication",
    ]),
    scope = scopeOf(r),
    time = readTime(r),
    templateReference = ref(r.templateReference),
    current =
      r.current === null ? null : assertPlatformBrandTemplateRevisionDigests(r.current, codec);
  if (
    r.profile !== "PlatformBrandTemplateCurrentV1" ||
    (current &&
      (current.templateReference !== templateReference || current.recordedAt > time.observedAt))
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateCurrentV1" as const,
    ...scope,
    templateReference,
    current,
    ...time,
  });
}
export function parsePlatformBrandTemplateExact(value: unknown, codec: PlatformBrandTemplateCodec) {
  const r = record(value, [
      "profile",
      ...scopeKeys,
      "templateVersionReference",
      "snapshot",
      "observedAt",
      "validUntil",
      "publication",
    ]),
    scope = scopeOf(r),
    time = readTime(r),
    templateVersionReference = ref(r.templateVersionReference),
    snapshot =
      r.snapshot === null ? null : assertPlatformBrandTemplateRevisionDigests(r.snapshot, codec);
  if (
    r.profile !== "PlatformBrandTemplateExactV1" ||
    (snapshot &&
      (snapshot.templateVersionReference !== templateVersionReference ||
        snapshot.recordedAt > time.observedAt))
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateExactV1" as const,
    ...scope,
    templateVersionReference,
    snapshot,
    ...time,
  });
}
export function parsePlatformBrandTemplateHistory(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
) {
  const r = record(value, [
      "profile",
      ...scopeKeys,
      "templateReference",
      "beforeRevision",
      "entries",
      "nextBeforeRevision",
      "observedAt",
      "validUntil",
      "publication",
    ]),
    scope = scopeOf(r),
    time = readTime(r),
    templateReference = ref(r.templateReference),
    beforeRevision = r.beforeRevision === null ? null : integer(r.beforeRevision);
  if (
    r.profile !== "PlatformBrandTemplateHistoryV1" ||
    !Array.isArray(r.entries) ||
    r.entries.length > 2
  )
    return fail();
  const entries = r.entries.map((v) => assertPlatformBrandTemplateRevisionDigests(v, codec)),
    nextBeforeRevision = r.nextBeforeRevision === null ? null : integer(r.nextBeforeRevision);
  if (
    entries.some(
      (e, i) =>
        e.templateReference !== templateReference ||
        e.recordedAt > time.observedAt ||
        (beforeRevision !== null && e.revision >= beforeRevision) ||
        (i > 0 && e.revision >= (entries[i - 1]?.revision ?? 0)),
    ) ||
    (nextBeforeRevision !== null &&
      (entries.length !== 2 || nextBeforeRevision !== entries[1]?.revision))
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateHistoryV1" as const,
    ...scope,
    templateReference,
    beforeRevision,
    entries: Object.freeze(entries),
    nextBeforeRevision,
    ...time,
  });
}

function listCursor(value: unknown) {
  if (value === null) return null;
  const r = record(value, ["code", "templateReference"]);
  return Object.freeze({ code: code(r.code), templateReference: ref(r.templateReference) });
}
export function parsePlatformBrandTemplateListRequest(value: unknown) {
  const r = record(value, ["after", "limit"]);
  return Object.freeze({ after: listCursor(r.after), limit: integer(r.limit, 1, 20) });
}
export type PlatformBrandTemplateListRequest = ReturnType<
  typeof parsePlatformBrandTemplateListRequest
>;
export function parsePlatformBrandTemplateSummary(value: unknown) {
  const r = record(value, [
    "templateReference",
    "templateVersionReference",
    "revision",
    "code",
    "name",
    "contentDigest",
    "sourceDigest",
    "authoredByReference",
    "recordedAt",
  ]);
  return Object.freeze({
    templateReference: ref(r.templateReference),
    templateVersionReference: ref(r.templateVersionReference),
    revision: integer(r.revision),
    code: code(r.code),
    name: templateName(r.name),
    contentDigest: digest(r.contentDigest),
    sourceDigest: digest(r.sourceDigest),
    authoredByReference: ref(r.authoredByReference),
    recordedAt: instant(r.recordedAt),
  });
}
export type PlatformBrandTemplateSummary = ReturnType<typeof parsePlatformBrandTemplateSummary>;
export function parsePlatformBrandTemplateList(value: unknown) {
  const r = record(value, [
      "profile",
      ...scopeKeys,
      "after",
      "limit",
      "items",
      "hasMore",
      "nextCursor",
      "observedAt",
      "validUntil",
      "publication",
    ]),
    scope = scopeOf(r),
    request = parsePlatformBrandTemplateListRequest({ after: r.after, limit: r.limit }),
    time = readTime(r),
    nextCursor = listCursor(r.nextCursor);
  if (
    r.profile !== "PlatformBrandTemplateListV1" ||
    !Array.isArray(r.items) ||
    r.items.length > request.limit ||
    typeof r.hasMore !== "boolean"
  )
    return fail();
  const items = r.items.map(parsePlatformBrandTemplateSummary),
    families = new Set<string>(),
    versions = new Set<string>(),
    codes = new Set<string>();
  let previous = request.after;
  for (const item of items) {
    if (
      item.recordedAt > time.observedAt ||
      families.has(item.templateReference) ||
      versions.has(item.templateVersionReference) ||
      codes.has(item.code) ||
      (previous &&
        (item.code < previous.code ||
          (item.code === previous.code && item.templateReference <= previous.templateReference)))
    )
      return fail();
    families.add(item.templateReference);
    versions.add(item.templateVersionReference);
    codes.add(item.code);
    previous = { code: item.code, templateReference: item.templateReference };
  }
  if (
    r.hasMore
      ? items.length !== request.limit ||
        nextCursor === null ||
        previous === null ||
        nextCursor.code !== previous.code ||
        nextCursor.templateReference !== previous.templateReference
      : nextCursor !== null
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateListV1" as const,
    ...scope,
    ...request,
    items: Object.freeze(items),
    hasMore: r.hasMore,
    nextCursor,
    ...time,
  });
}
export type PlatformBrandTemplateList = ReturnType<typeof parsePlatformBrandTemplateList>;
