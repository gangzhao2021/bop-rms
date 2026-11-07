import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as hash,
} from "./product-publication-command-client-v2.js";
export class PlatformTemplateClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged"
      | "Stale",
  ) {
    super("Platform template request could not be confirmed");
    this.name = "PlatformTemplateClientError";
  }
}
const fail = (code: PlatformTemplateClientError["code"] = "Invalid"): never => {
  throw new PlatformTemplateClientError(code);
};
/** Detached bounded wire values only, never a browser authority or transition evaluator. */
function copy(value: unknown): unknown {
  let nodes = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 30000 || depth > 15) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : fail();
    if (typeof v === "string") {
      if (v.length > 16384) return fail();
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const d = v.charCodeAt(++i);
          if (!(d >= 0xdc00 && d <= 0xdfff)) return fail();
        } else if (c >= 0xdc00 && c <= 0xdfff) return fail();
      }
      return v;
    }
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 128 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return fail();
          return visit(d.value, depth + 1);
        }),
      );
    }
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return fail();
    const r: Record<string, unknown> = {};
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k !== "string" || k === "__proto__") return fail();
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d?.enumerable || !("value" in d)) return fail();
      r[k] = visit(d.value, depth + 1);
    }
    return Object.freeze(r);
  }
  return visit(value, 0);
}
export const detachPlatformTemplateValue = copy;
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = copy(v);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Reflect.ownKeys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return fail();
  return r as Record<string, unknown>;
}
function ref(v: unknown): string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
    ? v
    : fail();
}
function digest(v: unknown): string {
  return typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
}
function instant(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    return fail();
  return v;
}
function integer(v: unknown, max = 2147483647): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : fail();
}
function code(v: unknown): string {
  return typeof v === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(v) ? v : fail();
}
function credential(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/u.test(v) ? v : fail();
}
const nullableRef = (v: unknown) => (v === null ? null : ref(v)),
  nullableTime = (v: unknown) => (v === null ? null : instant(v));
function list<T>(v: unknown, parse: (v: unknown) => T, max = 100, min = 0): readonly T[] {
  const a = copy(v);
  if (!Array.isArray(a) || a.length < min || a.length > max) return fail();
  return Object.freeze(a.map(parse));
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export interface PlatformTemplateScope {
  readonly kind: "Platform";
  readonly actorReference: string;
  readonly purposeCode: "PLATFORM_BRAND_TEMPLATE";
}
export function parsePlatformTemplateScope(v: unknown): PlatformTemplateScope {
  const r = exact(v, ["kind", "actorReference", "purposeCode"]);
  if (r.kind !== "Platform" || r.purposeCode !== "PLATFORM_BRAND_TEMPLATE") return fail();
  return Object.freeze({
    kind: "Platform",
    actorReference: ref(r.actorReference),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
  });
}
const scopeFields = ["kind", "actorReference", "purposeCode"] as const;
const scopeOf = (r: Record<string, unknown>) =>
  parsePlatformTemplateScope(Object.fromEntries(scopeFields.map((k) => [k, r[k]])));
function bindScope(r: PlatformTemplateScope, s: PlatformTemplateScope) {
  const left = parsePlatformTemplateScope({
    kind: r.kind,
    actorReference: r.actorReference,
    purposeCode: r.purposeCode,
  });
  const right = parsePlatformTemplateScope({
    kind: s.kind,
    actorReference: s.actorReference,
    purposeCode: s.purposeCode,
  });
  if (!same(left, right)) return fail("ScopeChanged");
}
function hasControl(value: string, maximum: number): boolean {
  return [...value].some((character) => {
    const point = character.charCodeAt(0);
    return point <= maximum || point === 127;
  });
}
export interface PlatformTemplateBootstrap {
  readonly authenticated: true;
  readonly session: {
    readonly sessionReference: string;
    readonly actorReference: string;
    readonly expiresAt: string;
  };
  readonly recentMfaRequired: boolean;
  readonly csrf: string;
}
export function parsePlatformTemplateBootstrap(v: unknown, now: string): PlatformTemplateBootstrap {
  const r = exact(v, ["authenticated", "session", "recentMfaRequired", "csrf"]),
    s = exact(r.session, ["sessionReference", "actorReference", "expiresAt"]);
  if (r.authenticated !== true || typeof r.recentMfaRequired !== "boolean") return fail();
  const expiresAt = instant(s.expiresAt);
  if (expiresAt <= instant(now)) return fail("Denied");
  return Object.freeze({
    authenticated: true,
    session: Object.freeze({
      sessionReference: ref(s.sessionReference),
      actorReference: ref(s.actorReference),
      expiresAt,
    }),
    recentMfaRequired: r.recentMfaRequired,
    csrf: credential(r.csrf),
  });
}
const contentFields = [
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
export function parsePlatformTemplateContent(v: unknown) {
  const r = exact(v, contentFields);
  const locale = (v: unknown) =>
    typeof v === "string" && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u.test(v)
      ? v
      : fail();
  const supportedLocales = list(r.supportedLocales, locale, 20, 1),
    defaultLocale = locale(r.defaultLocale),
    allowed = list(r.overrideAllowedFieldCodes, code),
    hard = list(r.hardRequirementFieldCodes, code),
    effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = nullableTime(r.effectiveUntil);
  if (
    typeof r.name !== "string" ||
    r.name !== r.name.trim() ||
    [...r.name].length < 1 ||
    [...r.name].length > 160 ||
    hasControl(r.name, 31) ||
    /[<>]/u.test(r.name) ||
    !supportedLocales.includes(defaultLocale) ||
    hard.some((k) => allowed.includes(k)) ||
    new Set(supportedLocales).size !== supportedLocales.length ||
    new Set(allowed).size !== allowed.length ||
    new Set(hard).size !== hard.length ||
    (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
  )
    return fail();
  return Object.freeze({
    code: code(r.code),
    name: r.name,
    defaultLocale,
    supportedLocales,
    overrideAllowedFieldCodes: allowed,
    hardRequirementFieldCodes: hard,
    effectiveFrom,
    effectiveUntil,
    reasonCode: code(r.reasonCode),
  });
}
export type PlatformTemplateContent = ReturnType<typeof parsePlatformTemplateContent>;
export interface PlatformTemplateHead {
  readonly revision: number;
  readonly templateVersionReference: string;
  readonly sourceDigest: string;
}
function head(v: unknown): PlatformTemplateHead | null {
  if (v === null) return null;
  const r = exact(v, ["revision", "templateVersionReference", "sourceDigest"]);
  return Object.freeze({
    revision: integer(r.revision, 2147483646),
    templateVersionReference: ref(r.templateVersionReference),
    sourceDigest: digest(r.sourceDigest),
  });
}
export interface PlatformTemplateSaveRequest {
  readonly action: "Save";
  readonly operationReference: string;
  readonly templateReference: string | null;
  readonly expectedHead: PlatformTemplateHead | null;
  readonly content: PlatformTemplateContent;
}
function saveRequest(v: unknown): PlatformTemplateSaveRequest {
  const r = exact(v, [
      "action",
      "operationReference",
      "templateReference",
      "expectedHead",
      "content",
    ]),
    t = nullableRef(r.templateReference),
    h = head(r.expectedHead);
  if (r.action !== "Save" || (t === null) !== (h === null)) return fail();
  return Object.freeze({
    action: "Save",
    operationReference: ref(r.operationReference),
    templateReference: t,
    expectedHead: h,
    content: parsePlatformTemplateContent(r.content),
  });
}
function savedOriginal(v: unknown) {
  const r = exact(v, [
    "profile",
    ...scopeFields,
    "operationReference",
    "templateReference",
    "expectedHead",
    "content",
  ]);
  if (r.profile !== "PlatformBrandTemplateSaveV1") return fail();
  const s = scopeOf(r),
    q = saveRequest({
      action: "Save",
      operationReference: r.operationReference,
      templateReference: r.templateReference,
      expectedHead: r.expectedHead,
      content: r.content,
    });
  return Object.freeze({
    profile: "PlatformBrandTemplateSaveV1" as const,
    ...s,
    operationReference: q.operationReference,
    templateReference: q.templateReference,
    expectedHead: q.expectedHead,
    content: q.content,
  });
}
export async function parsePlatformTemplateSnapshot(v: unknown) {
  const r = exact(v, [
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
  ]);
  const s = Object.freeze({
    profile: "PlatformBrandTemplateRevisionV1" as const,
    templateReference: ref(r.templateReference),
    templateVersionReference: ref(r.templateVersionReference),
    revision: integer(r.revision),
    recordKind: "AuthoredContent" as const,
    content: parsePlatformTemplateContent(r.content),
    supersedesVersionReference: nullableRef(r.supersedesVersionReference),
    authoredByReference: ref(r.authoredByReference),
    operationReference: ref(r.operationReference),
    auditReference: ref(r.auditReference),
    createdAt: instant(r.createdAt),
    recordedAt: instant(r.recordedAt),
    contentDigest: digest(r.contentDigest),
    sourceDigest: digest(r.sourceDigest),
    dataClassification: "ConfigurationMetadata" as const,
  });
  if (
    r.profile !== s.profile ||
    r.recordKind !== s.recordKind ||
    r.dataClassification !== s.dataClassification ||
    s.createdAt > s.recordedAt ||
    (s.revision === 1) !== (s.supersedesVersionReference === null) ||
    (s.revision === 1 && s.createdAt !== s.recordedAt)
  )
    return fail();
  const { sourceDigest, ...body } = s;
  const semantic = {
    profile: "PlatformBrandTemplateContentV1",
    templateReference: s.templateReference,
    templateVersionReference: s.templateVersionReference,
    revision: s.revision,
    content: {
      ...s.content,
      supportedLocales: [...s.content.supportedLocales].sort(),
      overrideAllowedFieldCodes: [...s.content.overrideAllowedFieldCodes].sort(),
      hardRequirementFieldCodes: [...s.content.hardRequirementFieldCodes].sort(),
    },
    supersedesVersionReference: s.supersedesVersionReference,
    authoredByReference: s.authoredByReference,
    createdAt: s.createdAt,
    dataClassification: s.dataClassification,
  };
  if ((await hash(body)) !== sourceDigest || (await hash(semantic)) !== s.contentDigest)
    return fail();
  return s;
}
export type PlatformTemplateSnapshot = Awaited<ReturnType<typeof parsePlatformTemplateSnapshot>>;
function lease(r: Record<string, unknown>, now: string) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil),
    at = instant(now);
  if (
    observedAt > at ||
    at >= validUntil ||
    validUntil <= observedAt ||
    Date.parse(validUntil) > Date.parse(observedAt) + 5000
  )
    return fail("Stale");
  return { observedAt, validUntil };
}
export const platformTemplatePermissionActions = [
  "platform.brand-template.manage",
  "platform.brand-template.submit",
  "platform.brand-template.approve",
  "platform.brand-template.publish",
  "platform.brand-template.archive",
] as const;
export type PlatformTemplatePermissionAction = (typeof platformTemplatePermissionActions)[number];
export interface PlatformTemplateActions {
  readonly profile: "PlatformTemplateActionsV1";
  readonly scope: PlatformTemplateScope;
  readonly allowedActions: readonly PlatformTemplatePermissionAction[];
  readonly observedAt: string;
  readonly validUntil: string;
}
export function parsePlatformTemplateActions(
  v: unknown,
  s: PlatformTemplateScope,
  now: string,
): PlatformTemplateActions {
  const r = exact(v, ["profile", "scope", "allowedActions", "observedAt", "validUntil"]),
    scope = parsePlatformTemplateScope(r.scope),
    a = list(
      r.allowedActions,
      (v) => {
        if (
          typeof v !== "string" ||
          !platformTemplatePermissionActions.includes(v as PlatformTemplatePermissionAction)
        )
          return fail();
        return v as PlatformTemplatePermissionAction;
      },
      5,
    );
  bindScope(scope, s);
  if (
    r.profile !== "PlatformTemplateActionsV1" ||
    new Set(a).size !== a.length ||
    a.some(
      (v, i) =>
        i > 0 &&
        platformTemplatePermissionActions.indexOf(v) <=
          platformTemplatePermissionActions.indexOf(a[i - 1] ?? v),
    )
  )
    return fail();
  return Object.freeze({
    profile: "PlatformTemplateActionsV1",
    scope,
    allowedActions: a,
    ...lease(r, now),
  });
}
export interface PlatformTemplateSummary {
  readonly templateReference: string;
  readonly templateVersionReference: string;
  readonly revision: number;
  readonly code: string;
  readonly name: string;
  readonly contentDigest: string;
  readonly sourceDigest: string;
  readonly authoredByReference: string;
  readonly recordedAt: string;
}
function summary(v: unknown): PlatformTemplateSummary {
  const r = exact(v, [
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
  if (
    typeof r.name !== "string" ||
    !r.name.length ||
    [...r.name].length > 160 ||
    r.name !== r.name.trim() ||
    hasControl(r.name, 31) ||
    /[<>]/u.test(r.name)
  )
    return fail();
  return Object.freeze({
    templateReference: ref(r.templateReference),
    templateVersionReference: ref(r.templateVersionReference),
    revision: integer(r.revision),
    code: code(r.code),
    name: r.name,
    contentDigest: digest(r.contentDigest),
    sourceDigest: digest(r.sourceDigest),
    authoredByReference: ref(r.authoredByReference),
    recordedAt: instant(r.recordedAt),
  });
}
export interface PlatformTemplateCursor {
  readonly code: string;
  readonly templateReference: string;
}
function cursor(v: unknown): PlatformTemplateCursor | null {
  if (v === null) return null;
  const r = exact(v, ["code", "templateReference"]);
  return Object.freeze({ code: code(r.code), templateReference: ref(r.templateReference) });
}
export interface PlatformTemplateList extends PlatformTemplateScope {
  readonly profile: "PlatformBrandTemplateListV1";
  readonly after: PlatformTemplateCursor | null;
  readonly limit: number;
  readonly items: readonly PlatformTemplateSummary[];
  readonly hasMore: boolean;
  readonly nextCursor: PlatformTemplateCursor | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publication: "NotEvaluated";
}
export function parsePlatformTemplateList(
  v: unknown,
  s: PlatformTemplateScope,
  now: string,
): PlatformTemplateList {
  const r = exact(v, [
      "profile",
      ...scopeFields,
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
    after = cursor(r.after),
    limit = integer(r.limit, 20),
    items = list(r.items, summary, limit),
    nextCursor = cursor(r.nextCursor),
    time = lease(r, now);
  bindScope(scope, s);
  const less = (a: PlatformTemplateCursor, b: PlatformTemplateCursor) =>
    a.code < b.code || (a.code === b.code && a.templateReference < b.templateReference);
  if (
    r.profile !== "PlatformBrandTemplateListV1" ||
    r.publication !== "NotEvaluated" ||
    typeof r.hasMore !== "boolean" ||
    r.hasMore !== (nextCursor !== null) ||
    (r.hasMore && items.length !== limit) ||
    items.some(
      (item, i) =>
        item.recordedAt > time.observedAt ||
        (after !== null && !less(after, item)) ||
        (i > 0 && !less(items[i - 1] ?? item, item)),
    ) ||
    (nextCursor !== null &&
      (!items.length ||
        !same(nextCursor, {
          code: items.at(-1)?.code,
          templateReference: items.at(-1)?.templateReference,
        })))
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateListV1",
    ...scope,
    after,
    limit,
    items,
    hasMore: r.hasMore,
    nextCursor,
    ...time,
    publication: "NotEvaluated",
  });
}
export interface PlatformTemplateCurrent extends PlatformTemplateScope {
  readonly profile: "PlatformBrandTemplateCurrentV1";
  readonly templateReference: string;
  readonly current: PlatformTemplateSnapshot | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publication: "NotEvaluated";
}
export interface PlatformTemplateExact extends PlatformTemplateScope {
  readonly profile: "PlatformBrandTemplateExactV1";
  readonly templateVersionReference: string;
  readonly snapshot: PlatformTemplateSnapshot | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publication: "NotEvaluated";
}
export interface PlatformTemplateHistory extends PlatformTemplateScope {
  readonly profile: "PlatformBrandTemplateHistoryV1";
  readonly templateReference: string;
  readonly beforeRevision: number | null;
  readonly entries: readonly PlatformTemplateSnapshot[];
  readonly nextBeforeRevision: number | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publication: "NotEvaluated";
}
async function templateRead(
  v: unknown,
  s: PlatformTemplateScope,
  request: PlatformTemplateQuery,
  now: string,
): Promise<PlatformTemplateCurrent | PlatformTemplateExact | PlatformTemplateHistory> {
  const type = request.action,
    fields =
      type === "Current"
        ? ["templateReference", "current"]
        : type === "Exact"
          ? ["templateVersionReference", "snapshot"]
          : ["templateReference", "beforeRevision", "entries", "nextBeforeRevision"];
  const r = exact(v, [
      "profile",
      ...scopeFields,
      ...fields,
      "observedAt",
      "validUntil",
      "publication",
    ]),
    scope = scopeOf(r),
    time = lease(r, now);
  bindScope(scope, s);
  if (r.publication !== "NotEvaluated") return fail();
  if (type === "Current") {
    if (
      r.profile !== "PlatformBrandTemplateCurrentV1" ||
      r.templateReference !== request.templateReference
    )
      return fail();
    const current = r.current === null ? null : await parsePlatformTemplateSnapshot(r.current);
    if (
      current &&
      (current.templateReference !== r.templateReference || current.recordedAt > time.observedAt)
    )
      return fail();
    return Object.freeze({
      profile: "PlatformBrandTemplateCurrentV1",
      ...scope,
      templateReference: ref(r.templateReference),
      current,
      ...time,
      publication: "NotEvaluated",
    });
  }
  if (type === "Exact") {
    if (
      r.profile !== "PlatformBrandTemplateExactV1" ||
      r.templateVersionReference !== request.templateVersionReference
    )
      return fail();
    const snapshot = r.snapshot === null ? null : await parsePlatformTemplateSnapshot(r.snapshot);
    if (
      snapshot &&
      (snapshot.templateVersionReference !== r.templateVersionReference ||
        snapshot.recordedAt > time.observedAt)
    )
      return fail();
    return Object.freeze({
      profile: "PlatformBrandTemplateExactV1",
      ...scope,
      templateVersionReference: ref(r.templateVersionReference),
      snapshot,
      ...time,
      publication: "NotEvaluated",
    });
  }
  if (
    type !== "History" ||
    r.profile !== "PlatformBrandTemplateHistoryV1" ||
    r.templateReference !== request.templateReference ||
    r.beforeRevision !== request.beforeRevision
  )
    return fail();
  const entries = await Promise.all(
      list(r.entries, (v) => v, 2).map(parsePlatformTemplateSnapshot),
    ),
    nextBeforeRevision = r.nextBeforeRevision === null ? null : integer(r.nextBeforeRevision);
  if (
    entries.some(
      (e, i) =>
        e.templateReference !== r.templateReference ||
        e.recordedAt > time.observedAt ||
        (request.beforeRevision !== null && e.revision >= request.beforeRevision) ||
        (i > 0 && e.revision >= (entries[i - 1]?.revision ?? 0)),
    ) ||
    (nextBeforeRevision !== null &&
      (entries.length !== 2 || nextBeforeRevision !== entries[1]?.revision))
  )
    return fail();
  return Object.freeze({
    profile: "PlatformBrandTemplateHistoryV1",
    ...scope,
    templateReference: ref(r.templateReference),
    beforeRevision: request.beforeRevision,
    entries: Object.freeze(entries),
    nextBeforeRevision,
    ...time,
    publication: "NotEvaluated",
  });
}
export const platformTemplatePublicationOperations = [
  "CreateDraft",
  "SubmitReview",
  "Approve",
  "Publish",
  "Archive",
] as const;
export type PlatformTemplatePublicationOperation =
  (typeof platformTemplatePublicationOperations)[number];
export interface PlatformTemplatePublicationRequest {
  readonly profile: "PlatformPublishingRequestV1";
  readonly operation: PlatformTemplatePublicationOperation;
  readonly operationReference: string;
  readonly templateReference: string;
  readonly templateVersionReference: string;
  readonly contentDigest: string;
  readonly templateSourceDigest: string;
  readonly expectedLifecycle: {
    readonly lifecycleReference: string;
    readonly version: number;
    readonly sourceDigest: string;
  } | null;
  readonly reviewValidUntil: string | null;
  readonly reasonCode: string;
}
export function parsePlatformTemplatePublicationRequest(
  v: unknown,
): PlatformTemplatePublicationRequest {
  const r = exact(v, [
    "profile",
    "operation",
    "operationReference",
    "templateReference",
    "templateVersionReference",
    "contentDigest",
    "templateSourceDigest",
    "expectedLifecycle",
    "reviewValidUntil",
    "reasonCode",
  ]);
  if (
    r.profile !== "PlatformPublishingRequestV1" ||
    typeof r.operation !== "string" ||
    !platformTemplatePublicationOperations.includes(
      r.operation as PlatformTemplatePublicationOperation,
    )
  )
    return fail();
  const h =
      r.expectedLifecycle === null
        ? null
        : exact(r.expectedLifecycle, ["lifecycleReference", "version", "sourceDigest"]),
    until = nullableTime(r.reviewValidUntil);
  if (
    (r.operation === "SubmitReview") !== (until !== null) ||
    (r.operation !== "CreateDraft" && h === null)
  )
    return fail();
  return Object.freeze({
    profile: "PlatformPublishingRequestV1",
    operation: r.operation as PlatformTemplatePublicationOperation,
    operationReference: ref(r.operationReference),
    templateReference: ref(r.templateReference),
    templateVersionReference: ref(r.templateVersionReference),
    contentDigest: digest(r.contentDigest),
    templateSourceDigest: digest(r.templateSourceDigest),
    expectedLifecycle:
      h === null
        ? null
        : Object.freeze({
            lifecycleReference: ref(h.lifecycleReference),
            version: integer(h.version),
            sourceDigest: digest(h.sourceDigest),
          }),
    reviewValidUntil: until,
    reasonCode: code(r.reasonCode),
  });
}
interface GlobalScope {
  readonly kind: "Platform";
  readonly brandReference: null;
  readonly storeReference: null;
}
function globalScope(v: unknown): GlobalScope {
  const r = exact(v, ["kind", "brandReference", "storeReference"]);
  if (r.kind !== "Platform" || r.brandReference !== null || r.storeReference !== null)
    return fail();
  return Object.freeze({ kind: "Platform", brandReference: null, storeReference: null });
}
export interface PlatformTemplateLifecycle {
  readonly lifecycleId: string;
  readonly familyReference: string;
  readonly configurationType: "PLATFORM_BRAND_TEMPLATE";
  readonly purposeCode: "PLATFORM_BRAND_TEMPLATE";
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly scope: GlobalScope;
  readonly version: number;
  readonly state: "Draft" | "InReview" | "Approved" | "Published" | "Archived";
  readonly validationEvidenceReference: string | null;
  readonly approvalEvidenceReference: string | null;
  readonly createdAt: string;
  readonly changedAt: string;
  readonly authoredActorReference: string;
  readonly submittedActorReference: string | null;
  readonly reviewValidUntil: string | null;
}
function lifecycle(v: unknown): PlatformTemplateLifecycle {
  const r = exact(v, [
    "lifecycleId",
    "familyReference",
    "configurationType",
    "purposeCode",
    "snapshotReference",
    "snapshotDigest",
    "scope",
    "version",
    "state",
    "validationEvidenceReference",
    "approvalEvidenceReference",
    "createdAt",
    "changedAt",
    "authoredActorReference",
    "submittedActorReference",
    "reviewValidUntil",
  ]);
  if (
    r.configurationType !== "PLATFORM_BRAND_TEMPLATE" ||
    r.purposeCode !== "PLATFORM_BRAND_TEMPLATE" ||
    !["Draft", "InReview", "Approved", "Published", "Archived"].includes(String(r.state))
  )
    return fail();
  const result = Object.freeze({
    lifecycleId: ref(r.lifecycleId),
    familyReference: ref(r.familyReference),
    configurationType: "PLATFORM_BRAND_TEMPLATE" as const,
    purposeCode: "PLATFORM_BRAND_TEMPLATE" as const,
    snapshotReference: ref(r.snapshotReference),
    snapshotDigest: digest(r.snapshotDigest),
    scope: globalScope(r.scope),
    version: integer(r.version),
    state: r.state as PlatformTemplateLifecycle["state"],
    validationEvidenceReference: nullableRef(r.validationEvidenceReference),
    approvalEvidenceReference: nullableRef(r.approvalEvidenceReference),
    createdAt: instant(r.createdAt),
    changedAt: instant(r.changedAt),
    authoredActorReference: ref(r.authoredActorReference),
    submittedActorReference: nullableRef(r.submittedActorReference),
    reviewValidUntil: nullableTime(r.reviewValidUntil),
  });
  if (result.createdAt > result.changedAt) return fail();
  if (result.state === "Draft") {
    if (
      result.validationEvidenceReference !== null ||
      result.approvalEvidenceReference !== null ||
      result.submittedActorReference !== null ||
      result.reviewValidUntil !== null
    )
      return fail();
  } else {
    if (
      result.validationEvidenceReference === null ||
      result.submittedActorReference === null ||
      result.reviewValidUntil === null ||
      result.reviewValidUntil <= result.createdAt ||
      (result.state === "InReview") !== (result.approvalEvidenceReference === null) ||
      (result.state !== "Archived" && result.changedAt >= result.reviewValidUntil)
    )
      return fail();
  }
  return result;
}
export interface PlatformTemplateValidation {
  readonly evidenceReference: string;
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly scope: GlobalScope;
  readonly result: "Pass";
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly checkCodes: readonly string[];
}
function validation(v: unknown): PlatformTemplateValidation | null {
  if (v === null) return null;
  const r = exact(v, [
      "evidenceReference",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "result",
      "checkedAt",
      "validUntil",
      "checkCodes",
    ]),
    checkedAt = instant(r.checkedAt),
    validUntil = instant(r.validUntil),
    checkCodes = list(r.checkCodes, code, 128, 1);
  if (
    r.result !== "Pass" ||
    checkedAt >= validUntil ||
    new Set(checkCodes).size !== checkCodes.length
  )
    return fail();
  return Object.freeze({
    evidenceReference: ref(r.evidenceReference),
    snapshotReference: ref(r.snapshotReference),
    snapshotDigest: digest(r.snapshotDigest),
    scope: globalScope(r.scope),
    result: "Pass",
    checkedAt,
    validUntil,
    checkCodes,
  });
}
export interface PlatformTemplateApproval {
  readonly evidenceReference: string;
  readonly reviewLifecycleId: string;
  readonly reviewVersion: number;
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly scope: GlobalScope;
  readonly decision: "Accepted";
  readonly approvedActorReference: string;
  readonly approvedAt: string;
  readonly validUntil: string;
  readonly authoredActorReference: string;
  readonly submittedActorReference: string;
}
function approval(v: unknown): PlatformTemplateApproval | null {
  if (v === null) return null;
  const r = exact(v, [
      "evidenceReference",
      "reviewLifecycleId",
      "reviewVersion",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "decision",
      "approvedActorReference",
      "approvedAt",
      "validUntil",
      "authoredActorReference",
      "submittedActorReference",
    ]),
    approvedAt = instant(r.approvedAt),
    validUntil = instant(r.validUntil),
    approvedActorReference = ref(r.approvedActorReference),
    authoredActorReference = ref(r.authoredActorReference),
    submittedActorReference = ref(r.submittedActorReference);
  if (
    r.decision !== "Accepted" ||
    approvedAt >= validUntil ||
    approvedActorReference === authoredActorReference ||
    approvedActorReference === submittedActorReference
  )
    return fail();
  return Object.freeze({
    evidenceReference: ref(r.evidenceReference),
    reviewLifecycleId: ref(r.reviewLifecycleId),
    reviewVersion: integer(r.reviewVersion),
    snapshotReference: ref(r.snapshotReference),
    snapshotDigest: digest(r.snapshotDigest),
    scope: globalScope(r.scope),
    decision: "Accepted",
    approvedActorReference,
    approvedAt,
    validUntil,
    authoredActorReference,
    submittedActorReference,
  });
}
export interface PlatformTemplateRelease {
  readonly releaseId: string;
  readonly familyReference: string;
  readonly configurationType: "PLATFORM_BRAND_TEMPLATE";
  readonly purposeCode: "PLATFORM_BRAND_TEMPLATE";
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly scope: GlobalScope;
  readonly sequence: number;
  readonly sourceLifecycleId: string;
  readonly kind: "Publish" | "Rollback";
  readonly previousReleaseId: string | null;
  readonly createdAt: string;
}
function release(v: unknown): PlatformTemplateRelease | null {
  if (v === null) return null;
  const r = exact(v, [
      "releaseId",
      "familyReference",
      "configurationType",
      "purposeCode",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "sequence",
      "sourceLifecycleId",
      "kind",
      "previousReleaseId",
      "createdAt",
    ]),
    sequence = integer(r.sequence),
    previousReleaseId = nullableRef(r.previousReleaseId),
    releaseId = ref(r.releaseId);
  if (
    r.configurationType !== "PLATFORM_BRAND_TEMPLATE" ||
    r.purposeCode !== "PLATFORM_BRAND_TEMPLATE" ||
    (r.kind !== "Publish" && r.kind !== "Rollback") ||
    (sequence === 1) !== (previousReleaseId === null) ||
    releaseId === previousReleaseId
  )
    return fail();
  return Object.freeze({
    releaseId,
    familyReference: ref(r.familyReference),
    configurationType: "PLATFORM_BRAND_TEMPLATE",
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    snapshotReference: ref(r.snapshotReference),
    snapshotDigest: digest(r.snapshotDigest),
    scope: globalScope(r.scope),
    sequence,
    sourceLifecycleId: ref(r.sourceLifecycleId),
    kind: r.kind,
    previousReleaseId,
    createdAt: instant(r.createdAt),
  });
}
export interface PlatformTemplatePublishingCommand {
  readonly profile: "PlatformPublishingCommandV1";
  readonly operation: PlatformTemplatePublicationOperation;
  readonly operationReference: string;
  readonly currentActorReference: string;
  readonly expectedVersion: number;
  readonly current: PlatformTemplateLifecycle | null;
  readonly next: PlatformTemplateLifecycle;
  readonly validationEvidence: PlatformTemplateValidation | null;
  readonly approvalEvidence: PlatformTemplateApproval | null;
  readonly release: PlatformTemplateRelease | null;
  readonly previousRelease: PlatformTemplateRelease | null;
  readonly rollbackTarget: null;
  readonly occurredAt: string;
}
function publishingCommand(v: unknown): PlatformTemplatePublishingCommand {
  const r = exact(v, [
    "profile",
    "operation",
    "operationReference",
    "currentActorReference",
    "expectedVersion",
    "current",
    "next",
    "validationEvidence",
    "approvalEvidence",
    "release",
    "previousRelease",
    "rollbackTarget",
    "occurredAt",
  ]);
  if (
    r.profile !== "PlatformPublishingCommandV1" ||
    typeof r.operation !== "string" ||
    !platformTemplatePublicationOperations.includes(
      r.operation as PlatformTemplatePublicationOperation,
    ) ||
    r.rollbackTarget !== null
  )
    return fail();
  return Object.freeze({
    profile: "PlatformPublishingCommandV1",
    operation: r.operation as PlatformTemplatePublicationOperation,
    operationReference: ref(r.operationReference),
    currentActorReference: ref(r.currentActorReference),
    expectedVersion: integer(r.expectedVersion),
    current: r.current === null ? null : lifecycle(r.current),
    next: lifecycle(r.next),
    validationEvidence: validation(r.validationEvidence),
    approvalEvidence: approval(r.approvalEvidence),
    release: release(r.release),
    previousRelease: release(r.previousRelease),
    rollbackTarget: null,
    occurredAt: instant(r.occurredAt),
  });
}
function publishingOriginal(v: unknown) {
  const r = exact(v, ["profile", "scope", "request"]);
  if (r.profile !== "PlatformPublishingOriginalV1") return fail();
  return Object.freeze({
    profile: "PlatformPublishingOriginalV1" as const,
    scope: parsePlatformTemplateScope(r.scope),
    request: parsePlatformTemplatePublicationRequest(r.request),
  });
}
export async function parsePlatformTemplatePublishingSource(v: unknown) {
  const r = exact(v, [
      "profile",
      "sequence",
      "templateSourceDigest",
      "originalCommand",
      "intentDigest",
      "command",
      "auditReference",
      "sourceDigest",
    ]),
    original = publishingOriginal(r.originalCommand),
    q = original.request,
    c = publishingCommand(r.command);
  const source = Object.freeze({
    profile: "PlatformPublishingSourceV1" as const,
    sequence: integer(r.sequence),
    templateSourceDigest: digest(r.templateSourceDigest),
    originalCommand: original,
    intentDigest: digest(r.intentDigest),
    command: c,
    auditReference: ref(r.auditReference),
    sourceDigest: digest(r.sourceDigest),
  });
  const { sourceDigest, ...body } = source;
  if (
    r.profile !== source.profile ||
    (await hash(original)) !== source.intentDigest ||
    (await hash(body)) !== sourceDigest ||
    source.templateSourceDigest !== q.templateSourceDigest ||
    c.operation !== q.operation ||
    c.operationReference !== q.operationReference ||
    c.currentActorReference !== original.scope.actorReference ||
    c.next.familyReference !== q.templateReference ||
    c.next.snapshotReference !== q.templateVersionReference ||
    c.next.snapshotDigest !== q.contentDigest ||
    c.occurredAt !== c.next.changedAt ||
    (q.operation === "SubmitReview" && c.next.reviewValidUntil !== q.reviewValidUntil) ||
    (c.current !== null &&
      (!q.expectedLifecycle ||
        q.expectedLifecycle.lifecycleReference !== c.current.lifecycleId ||
        q.expectedLifecycle.version !== c.current.version)) ||
    (c.current === null &&
      (q.operation !== "CreateDraft" ||
        (q.expectedLifecycle !== null &&
          q.expectedLifecycle.lifecycleReference === c.next.lifecycleId))) ||
    (q.expectedLifecycle === null && source.sequence !== 1)
  )
    return fail();
  const ve = c.validationEvidence,
    ae = c.approvalEvidence,
    rel = c.release;
  if (
    ve &&
    (ve.snapshotReference !== q.templateVersionReference ||
      ve.snapshotDigest !== q.contentDigest ||
      c.next.validationEvidenceReference !== ve.evidenceReference ||
      ve.checkedAt > c.occurredAt ||
      ve.validUntil !== c.next.reviewValidUntil)
  )
    return fail();
  if (
    ae &&
    (ae.snapshotReference !== q.templateVersionReference ||
      ae.snapshotDigest !== q.contentDigest ||
      ae.reviewLifecycleId !== c.next.lifecycleId ||
      ae.authoredActorReference !== c.next.authoredActorReference ||
      ae.submittedActorReference !== c.next.submittedActorReference ||
      c.next.approvalEvidenceReference !== ae.evidenceReference ||
      ae.approvedAt > c.occurredAt ||
      ae.validUntil !== c.next.reviewValidUntil)
  )
    return fail();
  if (
    rel &&
    (rel.familyReference !== q.templateReference ||
      rel.snapshotReference !== q.templateVersionReference ||
      rel.snapshotDigest !== q.contentDigest ||
      rel.sourceLifecycleId !== c.next.lifecycleId ||
      rel.createdAt !== c.occurredAt ||
      rel.previousReleaseId !== (c.previousRelease?.releaseId ?? null))
  )
    return fail();
  return source;
}
export type PlatformTemplatePublishingSource = Awaited<
  ReturnType<typeof parsePlatformTemplatePublishingSource>
>;
export interface PlatformTemplatePublicationCurrent {
  readonly profile: "PlatformPublishingCurrentV1";
  readonly scope: PlatformTemplateScope;
  readonly templateReference: string;
  readonly lifecycleReference: string | null;
  readonly current: PlatformTemplatePublishingSource | null;
  readonly currentRelease: PlatformTemplatePublishingSource | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface PlatformTemplatePublicationExact {
  readonly profile: "PlatformPublishingExactV1";
  readonly scope: PlatformTemplateScope;
  readonly templateReference: string;
  readonly sequence: number;
  readonly source: PlatformTemplatePublishingSource | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface PlatformTemplatePublicationHistory {
  readonly profile: "PlatformPublishingHistoryV1";
  readonly scope: PlatformTemplateScope;
  readonly templateReference: string;
  readonly beforeSequence: number | null;
  readonly items: readonly PlatformTemplatePublishingSource[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence: number | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
async function publicationRead(
  v: unknown,
  s: PlatformTemplateScope,
  q: PlatformTemplateQuery,
  now: string,
): Promise<
  | PlatformTemplatePublicationCurrent
  | PlatformTemplatePublicationExact
  | PlatformTemplatePublicationHistory
> {
  const fields =
    q.action === "PublicationCurrent"
      ? ["lifecycleReference", "current", "currentRelease"]
      : q.action === "PublicationExact"
        ? ["sequence", "source"]
        : ["beforeSequence", "items", "hasMore", "nextBeforeSequence"];
  const r = exact(v, [
      "profile",
      "scope",
      "templateReference",
      ...fields,
      "observedAt",
      "validUntil",
    ]),
    scope = parsePlatformTemplateScope(r.scope),
    time = lease(r, now);
  bindScope(scope, s);
  if (!("templateReference" in q) || r.templateReference !== q.templateReference) return fail();
  const family = ref(r.templateReference);
  const parse = async (v: unknown) => {
    const p = await parsePlatformTemplatePublishingSource(v);
    if (p.command.next.familyReference !== family || p.command.occurredAt > time.observedAt)
      return fail();
    return p;
  };
  if (q.action === "PublicationCurrent") {
    if (
      r.profile !== "PlatformPublishingCurrentV1" ||
      r.lifecycleReference !== q.lifecycleReference
    )
      return fail();
    const current = r.current === null ? null : await parse(r.current),
      currentRelease = r.currentRelease === null ? null : await parse(r.currentRelease);
    if (
      current &&
      q.lifecycleReference !== null &&
      current.command.next.lifecycleId !== q.lifecycleReference
    )
      return fail();
    if (
      current &&
      currentRelease &&
      current.sequence === currentRelease.sequence &&
      !same(current, currentRelease)
    )
      return fail();
    if (
      currentRelease &&
      (currentRelease.command.operation !== "Publish" ||
        currentRelease.command.next.state !== "Published" ||
        currentRelease.command.release === null ||
        (current &&
          current.command.next.lifecycleId === currentRelease.command.next.lifecycleId &&
          (current.command.next.version < currentRelease.command.next.version ||
            current.command.next.state === "Archived")))
    )
      return fail();
    return Object.freeze({
      profile: "PlatformPublishingCurrentV1",
      scope,
      templateReference: family,
      lifecycleReference: q.lifecycleReference,
      current,
      currentRelease,
      ...time,
    });
  }
  if (q.action === "PublicationExact") {
    if (r.profile !== "PlatformPublishingExactV1" || r.sequence !== q.sequence) return fail();
    const source = r.source === null ? null : await parse(r.source);
    if (source && source.sequence !== q.sequence) return fail();
    return Object.freeze({
      profile: "PlatformPublishingExactV1",
      scope,
      templateReference: family,
      sequence: q.sequence,
      source,
      ...time,
    });
  }
  if (
    q.action !== "PublicationHistory" ||
    r.profile !== "PlatformPublishingHistoryV1" ||
    r.beforeSequence !== q.beforeSequence ||
    typeof r.hasMore !== "boolean"
  )
    return fail();
  const items = await Promise.all(list(r.items, (v) => v, 20).map(parse)),
    next = r.nextBeforeSequence === null ? null : integer(r.nextBeforeSequence);
  let previous = q.beforeSequence;
  const op = new Set<string>(),
    audits = new Set<string>(),
    versions = new Set<string>();
  for (const p of items) {
    const key = p.originalCommand.scope.actorReference + ":" + p.command.operationReference,
      version = p.command.next.lifecycleId + ":" + p.command.next.version;
    if (
      (previous !== null && p.sequence >= previous) ||
      op.has(key) ||
      audits.has(p.auditReference) ||
      versions.has(version)
    )
      return fail();
    op.add(key);
    audits.add(p.auditReference);
    versions.add(version);
    previous = p.sequence;
  }
  if (r.hasMore ? items.length !== 20 || next !== previous : next !== null) return fail();
  return Object.freeze({
    profile: "PlatformPublishingHistoryV1",
    scope,
    templateReference: family,
    beforeSequence: q.beforeSequence,
    items: Object.freeze(items),
    hasMore: r.hasMore,
    nextBeforeSequence: next,
    ...time,
  });
}
export type PlatformTemplateQuery =
  | { readonly action: "Actions" }
  | {
      readonly action: "List";
      readonly after: PlatformTemplateCursor | null;
      readonly limit: number;
    }
  | { readonly action: "Current"; readonly templateReference: string }
  | { readonly action: "Exact"; readonly templateVersionReference: string }
  | {
      readonly action: "History";
      readonly templateReference: string;
      readonly beforeRevision: number | null;
    }
  | {
      readonly action: "PublicationCurrent";
      readonly templateReference: string;
      readonly lifecycleReference: string | null;
    }
  | {
      readonly action: "PublicationExact";
      readonly templateReference: string;
      readonly sequence: number;
    }
  | {
      readonly action: "PublicationHistory";
      readonly templateReference: string;
      readonly beforeSequence: number | null;
    };
export function parsePlatformTemplateQuery(v: unknown): PlatformTemplateQuery {
  const raw = copy(v);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const a = (raw as Record<string, unknown>).action;
  switch (a) {
    case "Actions":
      exact(v, ["action"]);
      return Object.freeze({ action: a });
    case "List": {
      const r = exact(v, ["action", "after", "limit"]);
      return Object.freeze({ action: a, after: cursor(r.after), limit: integer(r.limit, 20) });
    }
    case "Current": {
      const r = exact(v, ["action", "templateReference"]);
      return Object.freeze({ action: a, templateReference: ref(r.templateReference) });
    }
    case "Exact": {
      const r = exact(v, ["action", "templateVersionReference"]);
      return Object.freeze({
        action: a,
        templateVersionReference: ref(r.templateVersionReference),
      });
    }
    case "History": {
      const r = exact(v, ["action", "templateReference", "beforeRevision"]);
      return Object.freeze({
        action: a,
        templateReference: ref(r.templateReference),
        beforeRevision: r.beforeRevision === null ? null : integer(r.beforeRevision),
      });
    }
    case "PublicationCurrent": {
      const r = exact(v, ["action", "templateReference", "lifecycleReference"]);
      return Object.freeze({
        action: a,
        templateReference: ref(r.templateReference),
        lifecycleReference: nullableRef(r.lifecycleReference),
      });
    }
    case "PublicationExact": {
      const r = exact(v, ["action", "templateReference", "sequence"]);
      return Object.freeze({
        action: a,
        templateReference: ref(r.templateReference),
        sequence: integer(r.sequence),
      });
    }
    case "PublicationHistory": {
      const r = exact(v, ["action", "templateReference", "beforeSequence"]);
      return Object.freeze({
        action: a,
        templateReference: ref(r.templateReference),
        beforeSequence: r.beforeSequence === null ? null : integer(r.beforeSequence),
      });
    }
    default:
      return fail();
  }
}
export type PlatformTemplateQueryResult =
  | PlatformTemplateActions
  | PlatformTemplateList
  | PlatformTemplateCurrent
  | PlatformTemplateExact
  | PlatformTemplateHistory
  | PlatformTemplatePublicationCurrent
  | PlatformTemplatePublicationExact
  | PlatformTemplatePublicationHistory;
export async function parsePlatformTemplateQueryResult(
  v: unknown,
  s: PlatformTemplateScope,
  q: PlatformTemplateQuery,
  now: string,
): Promise<PlatformTemplateQueryResult> {
  switch (q.action) {
    case "Actions":
      return parsePlatformTemplateActions(v, s, now);
    case "List": {
      const p = parsePlatformTemplateList(v, s, now);
      if (!same(p.after, q.after) || p.limit !== q.limit) return fail();
      return p;
    }
    case "Current":
    case "Exact":
    case "History":
      return templateRead(v, s, q, now);
    default:
      return publicationRead(v, s, q, now);
  }
}
export interface PlatformTemplatePendingOriginal extends PlatformTemplateScope {
  readonly profile: "PlatformTemplatePendingOriginalV1";
  readonly owner: "Save" | "Publication";
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly templateReference: string | null;
}
export function parsePlatformTemplatePendingOriginal(v: unknown): PlatformTemplatePendingOriginal {
  const r = exact(v, [
    "profile",
    ...scopeFields,
    "owner",
    "operationReference",
    "intentDigest",
    "templateReference",
  ]);
  if (
    r.profile !== "PlatformTemplatePendingOriginalV1" ||
    (r.owner !== "Save" && r.owner !== "Publication") ||
    (r.owner === "Publication" && r.templateReference === null)
  )
    return fail();
  return Object.freeze({
    profile: "PlatformTemplatePendingOriginalV1",
    ...scopeOf(r),
    owner: r.owner,
    operationReference: ref(r.operationReference),
    intentDigest: digest(r.intentDigest),
    templateReference: nullableRef(r.templateReference),
  });
}
export type PlatformTemplateSaveOriginal = ReturnType<typeof savedOriginal>;
export interface PlatformTemplateSaveReceipt extends PlatformTemplateScope {
  readonly profile: "PlatformBrandTemplateOperationV1";
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly originalCommand: PlatformTemplateSaveOriginal | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: PlatformTemplateSnapshot | null;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
export interface PlatformTemplatePublicationReceipt extends PlatformTemplateScope {
  readonly profile: "PlatformPublishingReceiptV1";
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly originalCommand: ReturnType<typeof publishingOriginal> | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly source: PlatformTemplatePublishingSource | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export type PlatformTemplateReceipt =
  PlatformTemplateSaveReceipt | PlatformTemplatePublicationReceipt;
export async function parsePlatformTemplateReceipt(
  v: unknown,
  pending: PlatformTemplatePendingOriginal,
): Promise<PlatformTemplateReceipt> {
  const p = parsePlatformTemplatePendingOriginal(pending),
    save = p.owner === "Save",
    r = exact(v, [
      "profile",
      ...scopeFields,
      "operationReference",
      "intentDigest",
      "originalCommand",
      "outcome",
      save ? "snapshot" : "source",
      "auditReference",
      "occurredAt",
      ...(save ? ["dataClassification"] : []),
    ]),
    scope = scopeOf(r);
  bindScope(scope, p);
  if (
    r.profile !== (save ? "PlatformBrandTemplateOperationV1" : "PlatformPublishingReceiptV1") ||
    r.operationReference !== p.operationReference ||
    r.intentDigest !== p.intentDigest ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
    (save && r.dataClassification !== "ConfigurationMetadata")
  )
    return fail();
  const auditReference = ref(r.auditReference),
    occurredAt = instant(r.occurredAt);
  if (r.outcome === "Abandoned") {
    if (r.originalCommand !== null || r[save ? "snapshot" : "source"] !== null) return fail();
    return save
      ? Object.freeze({
          profile: "PlatformBrandTemplateOperationV1",
          ...scope,
          operationReference: p.operationReference,
          intentDigest: p.intentDigest,
          originalCommand: null,
          outcome: "Abandoned",
          snapshot: null,
          auditReference,
          occurredAt,
          dataClassification: "ConfigurationMetadata",
        })
      : Object.freeze({
          profile: "PlatformPublishingReceiptV1",
          ...scope,
          operationReference: p.operationReference,
          intentDigest: p.intentDigest,
          originalCommand: null,
          outcome: "Abandoned",
          source: null,
          auditReference,
          occurredAt,
        });
  }
  if (save) {
    const original = savedOriginal(r.originalCommand),
      snapshot = await parsePlatformTemplateSnapshot(r.snapshot);
    if (
      !same(scope, scopeOf(original)) ||
      original.operationReference !== p.operationReference ||
      original.templateReference !== p.templateReference ||
      (await hash(original)) !== p.intentDigest ||
      snapshot.authoredByReference !== scope.actorReference ||
      snapshot.operationReference !== p.operationReference ||
      snapshot.auditReference !== auditReference ||
      snapshot.recordedAt !== occurredAt ||
      snapshot.revision !== (original.expectedHead?.revision ?? 0) + 1 ||
      !same(snapshot.content, original.content) ||
      (original.templateReference !== null &&
        snapshot.templateReference !== original.templateReference) ||
      snapshot.supersedesVersionReference !==
        (original.expectedHead?.templateVersionReference ?? null) ||
      original.expectedHead?.templateVersionReference === snapshot.templateVersionReference
    )
      return fail();
    return Object.freeze({
      profile: "PlatformBrandTemplateOperationV1",
      ...scope,
      operationReference: p.operationReference,
      intentDigest: p.intentDigest,
      originalCommand: original,
      outcome: "Committed",
      snapshot,
      auditReference,
      occurredAt,
      dataClassification: "ConfigurationMetadata",
    });
  }
  const original = publishingOriginal(r.originalCommand),
    source = await parsePlatformTemplatePublishingSource(r.source);
  if (
    !same(scope, original.scope) ||
    original.request.operationReference !== p.operationReference ||
    original.request.templateReference !== p.templateReference ||
    (await hash(original)) !== p.intentDigest ||
    !same(source.originalCommand, original) ||
    source.intentDigest !== p.intentDigest ||
    source.auditReference !== auditReference ||
    source.command.occurredAt !== occurredAt
  )
    return fail();
  return Object.freeze({
    profile: "PlatformPublishingReceiptV1",
    ...scope,
    operationReference: p.operationReference,
    intentDigest: p.intentDigest,
    originalCommand: original,
    outcome: "Committed",
    source,
    auditReference,
    occurredAt,
  });
}
export interface PreparedPlatformTemplate {
  readonly request:
    | PlatformTemplateSaveRequest
    | { readonly action: "Publication"; readonly request: PlatformTemplatePublicationRequest };
  readonly original: PlatformTemplatePendingOriginal;
}
export interface PlatformTemplateRequestOptions {
  readonly csrf: string;
  readonly signal?: AbortSignal;
}
export interface PlatformTemplateClient {
  invalidate(): void;
  bootstrap(options?: { readonly signal?: AbortSignal }): Promise<PlatformTemplateBootstrap>;
  stepUp(
    csrf: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly status: "step_up_required"; readonly authorizationUrl: string }>;
  logout(
    csrf: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly status: "browser_logout_required"; readonly logoutUrl: string }>;
  query(
    scope: PlatformTemplateScope,
    request: PlatformTemplateQuery,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateQueryResult>;
  actions(
    scope: PlatformTemplateScope,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateActions>;
  list(
    scope: PlatformTemplateScope,
    after: PlatformTemplateCursor | null,
    limit: number,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateList>;
  current(
    scope: PlatformTemplateScope,
    templateReference: string,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateCurrent>;
  exact(
    scope: PlatformTemplateScope,
    templateVersionReference: string,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateExact>;
  history(
    scope: PlatformTemplateScope,
    templateReference: string,
    beforeRevision: number | null,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateHistory>;
  publicationCurrent(
    scope: PlatformTemplateScope,
    templateReference: string,
    lifecycleReference: string | null,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplatePublicationCurrent>;
  publicationExact(
    scope: PlatformTemplateScope,
    templateReference: string,
    sequence: number,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplatePublicationExact>;
  publicationHistory(
    scope: PlatformTemplateScope,
    templateReference: string,
    beforeSequence: number | null,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplatePublicationHistory>;
  prepareSave(
    scope: PlatformTemplateScope,
    value: Omit<PlatformTemplateSaveRequest, "action">,
  ): Promise<PreparedPlatformTemplate>;
  preparePublication(
    scope: PlatformTemplateScope,
    value: PlatformTemplatePublicationRequest,
  ): Promise<PreparedPlatformTemplate>;
  execute(
    scope: PlatformTemplateScope,
    prepared: PreparedPlatformTemplate,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateReceipt>;
  resolve(
    scope: PlatformTemplateScope,
    original: PlatformTemplatePendingOriginal,
    options: PlatformTemplateRequestOptions,
  ): Promise<PlatformTemplateReceipt>;
}
function https(v: unknown): string {
  if (typeof v !== "string" || v.length > 8192 || hasControl(v, 32)) return fail();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return fail();
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash) return fail();
  return v;
}
export function createPlatformTemplateClient(
  options: { readonly fetcher?: typeof fetch; readonly now?: () => string } = {},
): PlatformTemplateClient {
  const fetcher = options.fetcher ?? globalThis.fetch,
    clock = options.now ?? (() => new Date(Date.now()).toISOString());
  let epoch = 0;
  const controllers = new Set<AbortController>();
  function check(captured: number, signal?: AbortSignal) {
    if (
      captured !== epoch ||
      signal?.aborted ||
      (options.fetcher !== undefined && options.fetcher !== fetcher) ||
      (options.now !== undefined && options.now !== clock)
    )
      return fail("ScopeChanged");
  }
  function invalidate() {
    epoch++;
    for (const c of controllers) c.abort();
    controllers.clear();
  }
  async function request(
    path: string,
    body: unknown | null,
    controls: { readonly csrf?: string; readonly signal?: AbortSignal },
    write = false,
  ): Promise<unknown> {
    const captured = epoch,
      signal = controls.signal,
      csrf = controls.csrf === undefined ? undefined : credential(controls.csrf),
      controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let sent = false;
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new PlatformTemplateClientError(write ? "OutcomeUnknown" : "Unavailable")),
        { once: true },
      );
    });
    const timer = setTimeout(abort, 10000);
    try {
      check(captured, signal);
      sent = true;
      const response = await Promise.race([
        fetcher(path, {
          method: body === null ? "GET" : "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: {
            Accept: "application/json",
            ...(body === null ? {} : { "Content-Type": "application/json" }),
            ...(csrf === undefined ? {} : { "X-Bop-Csrf": csrf }),
          },
          ...(body === null ? {} : { body: canonical(body) }),
          signal: controller.signal,
        }),
        aborted,
      ]);
      check(captured, signal);
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      const errorCode =
        response.status === 403
          ? "Denied"
          : response.status === 409
            ? "Conflict"
            : response.status === 400
              ? "Invalid"
              : write
                ? "OutcomeUnknown"
                : "Unavailable";
      if (
        !response.ok &&
        (response.status === 403 || response.status === 409 || response.status === 400)
      )
        return fail(errorCode);
      if (
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        !/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(response.headers.get("cache-control") ?? "")
      )
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(write ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          check(captured, signal);
          const part = await Promise.race([reader.read(), aborted]);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > (response.ok ? 131072 : 8192))
            return fail(write ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      check(captured, signal);
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if ((controls.csrf !== csrf && csrf !== undefined) || controls.signal !== signal)
        return fail("ScopeChanged");
      if (!response.ok) return fail(errorCode);
      return JSON.parse(text);
    } catch (error) {
      if (captured !== epoch || signal?.aborted) return fail("ScopeChanged");
      if (error instanceof PlatformTemplateClientError) throw error;
      return fail(sent && write ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
  async function query(
    scope: PlatformTemplateScope,
    value: PlatformTemplateQuery,
    controls: PlatformTemplateRequestOptions,
  ) {
    const captured = epoch,
      s = parsePlatformTemplateScope(scope),
      q = parsePlatformTemplateQuery(value),
      csrf = credential(controls.csrf),
      signal = controls.signal;
    const packet = await parsePlatformTemplateQueryResult(
      await request("/platform/templates/query", q, controls),
      s,
      q,
      clock(),
    );
    check(captured, signal);
    if (controls.csrf !== csrf || controls.signal !== signal) return fail("ScopeChanged");
    lease({ observedAt: packet.observedAt, validUntil: packet.validUntil }, clock());
    check(captured, signal);
    return packet;
  }
  async function prepare(
    scope: PlatformTemplateScope,
    value: unknown,
    owner: "Save" | "Publication",
  ): Promise<PreparedPlatformTemplate> {
    const captured = epoch,
      s = parsePlatformTemplateScope(scope),
      q = owner === "Save" ? saveRequest(value) : parsePlatformTemplatePublicationRequest(value),
      originalCommand =
        owner === "Save"
          ? savedOriginal({
              profile: "PlatformBrandTemplateSaveV1",
              ...s,
              operationReference: q.operationReference,
              templateReference: q.templateReference,
              expectedHead: (q as PlatformTemplateSaveRequest).expectedHead,
              content: (q as PlatformTemplateSaveRequest).content,
            })
          : publishingOriginal({ profile: "PlatformPublishingOriginalV1", scope: s, request: q });
    const intentDigest = await hash(originalCommand);
    check(captured);
    const original = parsePlatformTemplatePendingOriginal({
      profile: "PlatformTemplatePendingOriginalV1",
      ...s,
      owner,
      operationReference: q.operationReference,
      intentDigest,
      templateReference: q.templateReference,
    });
    return Object.freeze({
      request:
        owner === "Save"
          ? (q as PlatformTemplateSaveRequest)
          : Object.freeze({
              action: "Publication",
              request: q as PlatformTemplatePublicationRequest,
            }),
      original,
    });
  }
  const client: PlatformTemplateClient = {
    invalidate,
    async bootstrap(controls = {}) {
      const captured = epoch,
        value = parsePlatformTemplateBootstrap(
          await request("/platform/auth/session", null, controls),
          clock(),
        );
      check(captured, controls.signal);
      return value;
    },
    async stepUp(csrf, controls = {}) {
      const captured = epoch,
        r = exact(await request("/platform/auth/step-up", {}, { ...controls, csrf }, true), [
          "status",
          "authorizationUrl",
        ]);
      if (r.status !== "step_up_required") return fail();
      const result = Object.freeze({
        status: "step_up_required" as const,
        authorizationUrl: https(r.authorizationUrl),
      });
      check(captured, controls.signal);
      return result;
    },
    async logout(csrf, controls = {}) {
      const captured = epoch,
        r = exact(await request("/platform/auth/logout", {}, { ...controls, csrf }, true), [
          "status",
          "logoutUrl",
        ]);
      if (r.status !== "browser_logout_required") return fail();
      const result = Object.freeze({
        status: "browser_logout_required" as const,
        logoutUrl: https(r.logoutUrl),
      });
      check(captured, controls.signal);
      return result;
    },
    query,
    async actions(s, o) {
      const p = await query(s, { action: "Actions" }, o);
      if (p.profile !== "PlatformTemplateActionsV1") return fail();
      return p;
    },
    async list(s, after, limit, o) {
      const p = await query(s, { action: "List", after, limit }, o);
      if (p.profile !== "PlatformBrandTemplateListV1") return fail();
      return p;
    },
    async current(s, templateReference, o) {
      const p = await query(s, { action: "Current", templateReference }, o);
      if (p.profile !== "PlatformBrandTemplateCurrentV1") return fail();
      return p;
    },
    async exact(s, templateVersionReference, o) {
      const p = await query(s, { action: "Exact", templateVersionReference }, o);
      if (p.profile !== "PlatformBrandTemplateExactV1") return fail();
      return p;
    },
    async history(s, templateReference, beforeRevision, o) {
      const p = await query(s, { action: "History", templateReference, beforeRevision }, o);
      if (p.profile !== "PlatformBrandTemplateHistoryV1") return fail();
      return p;
    },
    async publicationCurrent(s, templateReference, lifecycleReference, o) {
      const p = await query(
        s,
        { action: "PublicationCurrent", templateReference, lifecycleReference },
        o,
      );
      if (p.profile !== "PlatformPublishingCurrentV1") return fail();
      return p;
    },
    async publicationExact(s, templateReference, sequence, o) {
      const p = await query(s, { action: "PublicationExact", templateReference, sequence }, o);
      if (p.profile !== "PlatformPublishingExactV1") return fail();
      return p;
    },
    async publicationHistory(s, templateReference, beforeSequence, o) {
      const p = await query(
        s,
        { action: "PublicationHistory", templateReference, beforeSequence },
        o,
      );
      if (p.profile !== "PlatformPublishingHistoryV1") return fail();
      return p;
    },
    prepareSave: (s, value) =>
      prepare(
        s,
        {
          ...exact(value, ["operationReference", "templateReference", "expectedHead", "content"]),
          action: "Save",
        },
        "Save",
      ),
    preparePublication: (s, value) => prepare(s, value, "Publication"),
    async execute(scope, prepared, controls) {
      const captured = epoch,
        csrf = credential(controls.csrf),
        signal = controls.signal,
        s = parsePlatformTemplateScope(scope),
        r = exact(prepared, ["request", "original"]),
        original = parsePlatformTemplatePendingOriginal(r.original);
      bindScope(original, s);
      const raw = original.owner === "Save" ? r.request : exact(r.request, ["action", "request"]);
      if (
        original.owner === "Publication" &&
        (raw as Record<string, unknown>).action !== "Publication"
      )
        return fail();
      const checked = await prepare(
        s,
        original.owner === "Save" ? raw : (raw as Record<string, unknown>).request,
        original.owner,
      );
      if (!same(checked.original, original)) return fail("Conflict");
      if (controls.csrf !== csrf || controls.signal !== signal) return fail("ScopeChanged");
      check(captured, signal);
      const packet = await parsePlatformTemplateReceipt(
        await request("/platform/templates/command", checked.request, controls, true),
        original,
      );
      check(captured, signal);
      if (controls.csrf !== csrf || controls.signal !== signal) return fail("ScopeChanged");
      return packet;
    },
    async resolve(scope, value, controls) {
      const captured = epoch,
        csrf = credential(controls.csrf),
        signal = controls.signal,
        s = parsePlatformTemplateScope(scope),
        original = parsePlatformTemplatePendingOriginal(value);
      bindScope(original, s);
      const packet = await parsePlatformTemplateReceipt(
        await request(
          "/platform/templates/command",
          {
            action: original.owner === "Save" ? "ResolveSave" : "ResolvePublication",
            operationReference: original.operationReference,
            intentDigest: original.intentDigest,
          },
          controls,
          true,
        ),
        original,
      );
      check(captured, signal);
      if (controls.csrf !== csrf || controls.signal !== signal) return fail("ScopeChanged");
      return packet;
    },
  };
  return Object.freeze(client);
}
