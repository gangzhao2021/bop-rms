import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as hash,
} from "./product-publication-command-client-v2.js";
export class BrandConfigurationClientError extends Error {
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
    super("Brand configuration could not be confirmed");
    this.name = "BrandConfigurationClientError";
  }
}
const fail = (code: BrandConfigurationClientError["code"] = "Invalid"): never => {
  throw new BrandConfigurationClientError(code);
};
export const brandConfigurationEditableFields = [
  "defaultLocale",
  "supportedLocales",
  "mediaThemeReference",
  "catalogSourceReference",
  "platformTemplateReference",
  "overrideAllowedFieldCodes",
  "hardRequirementFieldCodes",
  "effectiveFrom",
  "effectiveUntil",
  "reasonCode",
] as const;
const scopeKeys = ["tenantReference", "brandReference", "actorReference"] as const;
const identityKeys = [
  ...scopeKeys,
  "command",
  "operationReference",
  "expectedBrandVersion",
  "expectedHead",
  "purposeCode",
] as const;
const revisionKeys = [
  "profile",
  ...scopeKeys,
  "revision",
  "brandVersion",
  "command",
  "operationReference",
  "configuration",
  "submittedByReference",
  "publishing",
  "contentDigest",
  "sourceDigest",
  "auditReference",
  "createdAt",
  "recordedAt",
  "dataClassification",
] as const;
export interface BrandConfigurationScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
}
export type BrandConfigurationAction =
  | "SaveConfigurationDraft"
  | "SubmitConfiguration"
  | "ApproveConfiguration"
  | "PublishConfiguration";
export interface BrandConfigurationHead {
  readonly revision: number;
  readonly configurationVersionReference: string;
  readonly sourceDigest: string;
}
const bounded = (v: unknown, min = 1, max = 2147483647) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail();
const digest = (v: unknown) =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const nullableRef = (v: unknown) => (v === null ? null : ref(v));
const nullableInstant = (v: unknown) => (v === null ? null : instant(v));
const code = (v: unknown) =>
  typeof v === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(v) ? v : fail();
const locale = (v: unknown) =>
  typeof v === "string" && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u.test(v)
    ? v
    : fail();
function list<T>(v: unknown, parse: (item: unknown) => T, min: number, max: number): readonly T[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) return fail();
  const items = v.map(parse);
  if (new Set(items).size !== items.length) return fail();
  return Object.freeze(items);
}
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof BrandConfigurationClientError) throw e;
    return fail();
  }
}
function closed(v: unknown, keys: readonly string[]) {
  return safe(() => record(copyProductCommandValue(v), keys));
}
export function parseBrandConfigurationScope(value: unknown): BrandConfigurationScope {
  const r = closed(value, scopeKeys);
  const s = Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    actorReference: ref(r.actorReference),
  });
  if (s.tenantReference !== s.brandReference) return fail();
  return s;
}
const scopeOf = (r: Record<string, unknown>) =>
  parseBrandConfigurationScope(Object.fromEntries(scopeKeys.map((k) => [k, r[k]])));
function action(v: unknown): BrandConfigurationAction {
  if (
    v === "SaveConfigurationDraft" ||
    v === "SubmitConfiguration" ||
    v === "ApproveConfiguration" ||
    v === "PublishConfiguration"
  )
    return v;
  return fail();
}
function head(v: unknown): BrandConfigurationHead | null {
  if (v === null) return null;
  const r = closed(v, ["revision", "configurationVersionReference", "sourceDigest"]);
  return Object.freeze({
    revision: bounded(r.revision, 1, 2147483646),
    configurationVersionReference: ref(r.configurationVersionReference),
    sourceDigest: digest(r.sourceDigest),
  });
}
export function parseBrandConfigurationEditable(value: unknown) {
  const r = closed(value, brandConfigurationEditableFields),
    supportedLocales = list(r.supportedLocales, locale, 1, 20),
    defaultLocale = locale(r.defaultLocale),
    overrideAllowedFieldCodes = list(r.overrideAllowedFieldCodes, code, 0, 100),
    hardRequirementFieldCodes = list(r.hardRequirementFieldCodes, code, 0, 100),
    effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = nullableInstant(r.effectiveUntil);
  if (
    !supportedLocales.includes(defaultLocale) ||
    hardRequirementFieldCodes.some((k) => overrideAllowedFieldCodes.includes(k)) ||
    (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
  )
    return fail();
  return Object.freeze({
    defaultLocale,
    supportedLocales,
    mediaThemeReference: nullableRef(r.mediaThemeReference),
    catalogSourceReference: ref(r.catalogSourceReference),
    platformTemplateReference: ref(r.platformTemplateReference),
    overrideAllowedFieldCodes,
    hardRequirementFieldCodes,
    effectiveFrom,
    effectiveUntil,
    reasonCode: code(r.reasonCode),
  });
}
export type BrandConfigurationEditable = ReturnType<typeof parseBrandConfigurationEditable>;
const candidateKeys = [
  "templateReference",
  "templateVersionReference",
  "revision",
  "contentDigest",
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
export function parseBrandTemplateCandidate(value: unknown) {
  const r = closed(value, candidateKeys),
    supportedLocales = list(r.supportedLocales, locale, 1, 20),
    defaultLocale = locale(r.defaultLocale),
    allowed = list(r.overrideAllowedFieldCodes, code, 0, 100),
    hard = list(r.hardRequirementFieldCodes, code, 0, 100),
    effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = nullableInstant(r.effectiveUntil);
  if (
    typeof r.name !== "string" ||
    r.name !== r.name.trim() ||
    [...r.name].length < 1 ||
    [...r.name].length > 160 ||
    [...r.name].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127) ||
    /[<>]/u.test(r.name) ||
    !supportedLocales.includes(defaultLocale) ||
    hard.some((c) => allowed.includes(c)) ||
    (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
  )
    return fail();
  return Object.freeze({
    templateReference: ref(r.templateReference),
    templateVersionReference: ref(r.templateVersionReference),
    revision: bounded(r.revision),
    contentDigest: digest(r.contentDigest),
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
export type BrandTemplateCandidate = ReturnType<typeof parseBrandTemplateCandidate>;
export function parseBrandTemplateCandidates(
  value: unknown,
  scope: BrandConfigurationScope,
  after: string | null,
) {
  const r = closed(value, [
      "profile",
      ...scopeKeys,
      "afterTemplateReference",
      "items",
      "hasMore",
      "nextAfterTemplateReference",
      "observedAt",
      "validUntil",
    ]),
    actualScope = scopeOf(r),
    observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil),
    cursor = nullableRef(r.afterTemplateReference),
    next = nullableRef(r.nextAfterTemplateReference);
  if (
    r.profile !== "MerchantBrandTemplateCandidatesV1" ||
    canonical(actualScope) !== canonical(parseBrandConfigurationScope(scope)) ||
    cursor !== after ||
    !Array.isArray(r.items) ||
    r.items.length > 20 ||
    typeof r.hasMore !== "boolean" ||
    (r.hasMore ? next === null : next !== null) ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  const items = r.items.map(parseBrandTemplateCandidate);
  if (
    new Set(items.map((item) => item.templateReference)).size !== items.length ||
    items.some(
      (item, index) =>
        (cursor !== null && item.templateReference <= cursor) ||
        (index > 0 && item.templateReference <= (items[index - 1]?.templateReference ?? "")) ||
        item.effectiveFrom > observedAt ||
        (item.effectiveUntil !== null &&
          (item.effectiveUntil <= observedAt || item.effectiveUntil < validUntil)),
    ) ||
    (next !== null &&
      ((cursor !== null && next <= cursor) || items.some((item) => item.templateReference > next)))
  )
    return fail();
  return Object.freeze({
    profile: "MerchantBrandTemplateCandidatesV1" as const,
    ...actualScope,
    afterTemplateReference: cursor,
    items: Object.freeze(items),
    hasMore: r.hasMore,
    nextAfterTemplateReference: next,
    observedAt,
    validUntil,
  });
}
export type BrandTemplateCandidates = ReturnType<typeof parseBrandTemplateCandidates>;
export function parseRecordedBrandConfiguration(value: unknown) {
  const keys = [
      ...brandConfigurationEditableFields,
      "configurationVersionReference",
      "brandReference",
      "configurationVersion",
      "lifecycle",
      "supersedesVersionReference",
      "authoredByReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "publicationReference",
      "createdAt",
      "updatedAt",
      "dataClassification",
    ],
    r = closed(value, keys),
    editable = parseBrandConfigurationEditable(
      Object.fromEntries(brandConfigurationEditableFields.map((k) => [k, r[k]])),
    ),
    configurationVersion = bounded(r.configurationVersion),
    supersedesVersionReference = nullableRef(r.supersedesVersionReference),
    authoredByReference = ref(r.authoredByReference),
    approvedByReference = nullableRef(r.approvedByReference),
    approvalEvidenceReference = nullableRef(r.approvalEvidenceReference),
    publicationReference = nullableRef(r.publicationReference),
    createdAt = instant(r.createdAt),
    updatedAt = instant(r.updatedAt);
  const lifecycle = r.lifecycle;
  if (
    lifecycle !== "Draft" &&
    lifecycle !== "PendingApproval" &&
    lifecycle !== "Approved" &&
    lifecycle !== "Published" &&
    lifecycle !== "Superseded" &&
    lifecycle !== "Archived"
  )
    return fail();
  if (
    r.dataClassification !== "ConfigurationMetadata" ||
    updatedAt < createdAt ||
    (configurationVersion === 1) !== (supersedesVersionReference === null) ||
    (approvedByReference === null) !== (approvalEvidenceReference === null) ||
    approvedByReference === authoredByReference ||
    (["Draft", "PendingApproval"].includes(lifecycle) &&
      (approvedByReference !== null || publicationReference !== null)) ||
    (lifecycle === "Approved" && (approvedByReference === null || publicationReference !== null)) ||
    (["Published", "Superseded", "Archived"].includes(lifecycle) &&
      (approvedByReference === null || publicationReference === null))
  )
    return fail();
  return Object.freeze({
    ...editable,
    configurationVersionReference: ref(r.configurationVersionReference),
    brandReference: ref(r.brandReference),
    configurationVersion,
    lifecycle,
    supersedesVersionReference,
    authoredByReference,
    approvedByReference,
    approvalEvidenceReference,
    publicationReference,
    createdAt,
    updatedAt,
    dataClassification: "ConfigurationMetadata" as const,
  });
}
export type RecordedBrandConfiguration = ReturnType<typeof parseRecordedBrandConfiguration>;
function binding(value: unknown) {
  if (value === null) return null;
  const r = closed(value, [
    "familyReference",
    "lifecycleReference",
    "lifecycleVersion",
    "mutationOperationReference",
    "validationEvidenceReference",
    "approvalEvidenceReference",
    "publicationReference",
  ]);
  return Object.freeze({
    familyReference: ref(r.familyReference),
    lifecycleReference: ref(r.lifecycleReference),
    lifecycleVersion: bounded(r.lifecycleVersion, 2),
    mutationOperationReference: ref(r.mutationOperationReference),
    validationEvidenceReference: ref(r.validationEvidenceReference),
    approvalEvidenceReference: nullableRef(r.approvalEvidenceReference),
    publicationReference: nullableRef(r.publicationReference),
  });
}
function identity(r: Record<string, unknown>) {
  const s = scopeOf(r),
    c = action(r.command),
    expectedHead = head(r.expectedHead);
  if (
    r.purposeCode !== "BRAND_CONFIGURATION" ||
    (expectedHead === null && c !== "SaveConfigurationDraft")
  )
    return fail();
  return Object.freeze({
    ...s,
    command: c,
    operationReference: ref(r.operationReference),
    expectedBrandVersion: bounded(r.expectedBrandVersion),
    expectedHead,
    purposeCode: "BRAND_CONFIGURATION" as const,
  });
}
export function parseBrandConfigurationCommand(value: unknown) {
  const r = closed(value, ["profile", ...identityKeys, "configuration", "reviewValidUntil"]),
    i = identity(r);
  if (r.profile !== "TenantBrandConfigurationCommandV1") return fail();
  const configuration =
      i.command === "SaveConfigurationDraft"
        ? parseBrandConfigurationEditable(r.configuration)
        : null,
    reviewValidUntil = i.command === "SubmitConfiguration" ? instant(r.reviewValidUntil) : null;
  if (
    (configuration === null && r.configuration !== null) ||
    (reviewValidUntil === null && r.reviewValidUntil !== null)
  )
    return fail();
  return Object.freeze({
    profile: "TenantBrandConfigurationCommandV1" as const,
    ...i,
    configuration,
    reviewValidUntil,
  });
}
export type BrandConfigurationCommand = ReturnType<typeof parseBrandConfigurationCommand>;
export function parseBrandConfigurationOriginal(value: unknown) {
  const r = closed(value, ["profile", ...identityKeys, "intentDigest"]);
  if (r.profile !== "TenantBrandConfigurationResolveV1") return fail();
  return Object.freeze({
    profile: "TenantBrandConfigurationResolveV1" as const,
    ...identity(r),
    intentDigest: digest(r.intentDigest),
  });
}
export type BrandConfigurationOriginal = ReturnType<typeof parseBrandConfigurationOriginal>;
export async function validateBrandConfigurationRevision(value: unknown) {
  const r = closed(value, revisionKeys),
    s = scopeOf(r),
    configuration = parseRecordedBrandConfiguration(r.configuration),
    command = action(r.command),
    publishing = binding(r.publishing),
    submittedByReference = nullableRef(r.submittedByReference),
    revision = bounded(r.revision),
    createdAt = instant(r.createdAt),
    recordedAt = instant(r.recordedAt),
    state = {
      SaveConfigurationDraft: "Draft",
      SubmitConfiguration: "PendingApproval",
      ApproveConfiguration: "Approved",
      PublishConfiguration: "Published",
    }[command];
  if (
    r.profile !== "TenantBrandConfigurationRevisionV1" ||
    r.dataClassification !== "ConfigurationMetadata" ||
    configuration.brandReference !== s.brandReference ||
    configuration.lifecycle !== state ||
    configuration.updatedAt !== recordedAt ||
    createdAt > recordedAt ||
    (revision === 1 && createdAt !== recordedAt) ||
    (command === "SaveConfigurationDraft" &&
      (publishing !== null ||
        submittedByReference !== null ||
        configuration.authoredByReference !== s.actorReference)) ||
    (command !== "SaveConfigurationDraft" &&
      (publishing === null || submittedByReference === null)) ||
    (command === "SubmitConfiguration" && submittedByReference !== s.actorReference) ||
    (command === "ApproveConfiguration" &&
      (s.actorReference === submittedByReference ||
        s.actorReference === configuration.authoredByReference ||
        configuration.approvedByReference !== s.actorReference)) ||
    (publishing !== null &&
      (publishing.familyReference !== s.brandReference ||
        publishing.approvalEvidenceReference !== configuration.approvalEvidenceReference ||
        publishing.publicationReference !== configuration.publicationReference ||
        (command === "ApproveConfiguration" && publishing.lifecycleVersion < 3) ||
        (command === "PublishConfiguration" && publishing.lifecycleVersion < 4)))
  )
    return fail();
  const parsed = Object.freeze({
    profile: "TenantBrandConfigurationRevisionV1" as const,
    ...s,
    revision,
    brandVersion: bounded(r.brandVersion),
    command,
    operationReference: ref(r.operationReference),
    configuration,
    submittedByReference,
    publishing,
    contentDigest: digest(r.contentDigest),
    sourceDigest: digest(r.sourceDigest),
    auditReference: ref(r.auditReference),
    createdAt,
    recordedAt,
    dataClassification: "ConfigurationMetadata" as const,
  });
  const content = {
    profile: "TenantBrandConfigurationContentV1",
    ...Object.fromEntries(
      [
        "configurationVersionReference",
        "brandReference",
        "configurationVersion",
        ...brandConfigurationEditableFields,
        "supersedesVersionReference",
        "authoredByReference",
        "createdAt",
        "dataClassification",
      ].map((k) => [k, Object.getOwnPropertyDescriptor(configuration, k)?.value]),
    ),
    supportedLocales: [...configuration.supportedLocales].sort(),
    overrideAllowedFieldCodes: [...configuration.overrideAllowedFieldCodes].sort(),
    hardRequirementFieldCodes: [...configuration.hardRequirementFieldCodes].sort(),
  };
  const { sourceDigest, ...preimage } = parsed;
  if (parsed.contentDigest !== (await hash(content)) || sourceDigest !== (await hash(preimage)))
    return fail();
  return parsed;
}
export type BrandConfigurationRevision = Awaited<
  ReturnType<typeof validateBrandConfigurationRevision>
>;
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
export async function validateBrandConfigurationReceipt(
  value: unknown,
  expected: BrandConfigurationOriginal,
) {
  const r = closed(value, [
      "profile",
      ...identityKeys,
      "intentDigest",
      "originalCommand",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ]),
    i = identity(r),
    originalCommand =
      r.originalCommand === null ? null : parseBrandConfigurationCommand(r.originalCommand),
    snapshot = r.snapshot === null ? null : await validateBrandConfigurationRevision(r.snapshot),
    occurredAt = instant(r.occurredAt);
  if (
    r.profile !== "TenantBrandConfigurationOperationV1" ||
    r.dataClassification !== "ConfigurationMetadata" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
    (r.outcome === "Committed") !== (originalCommand !== null && snapshot !== null) ||
    (r.outcome === "Abandoned" && (originalCommand !== null || snapshot !== null))
  )
    return fail();
  const cursor = parseBrandConfigurationOriginal({
    profile: "TenantBrandConfigurationResolveV1",
    ...i,
    intentDigest: digest(r.intentDigest),
  });
  if (!same(cursor, parseBrandConfigurationOriginal(expected))) return fail("Conflict");
  if (originalCommand && snapshot) {
    if (
      identityKeys.some(
        (k) =>
          !same(
            Object.getOwnPropertyDescriptor(originalCommand, k)?.value,
            Object.getOwnPropertyDescriptor(i, k)?.value,
          ),
      ) ||
      snapshot.tenantReference !== i.tenantReference ||
      snapshot.brandReference !== i.brandReference ||
      snapshot.actorReference !== i.actorReference ||
      snapshot.command !== i.command ||
      snapshot.operationReference !== i.operationReference ||
      snapshot.brandVersion !== i.expectedBrandVersion ||
      snapshot.revision !== (i.expectedHead?.revision ?? 0) + 1 ||
      snapshot.auditReference !== r.auditReference ||
      snapshot.recordedAt !== occurredAt ||
      (await hash(originalCommand)) !== cursor.intentDigest ||
      (i.command === "SaveConfigurationDraft" &&
        !same(
          originalCommand.configuration,
          Object.fromEntries(
            brandConfigurationEditableFields.map((k) => [k, snapshot.configuration[k]]),
          ),
        )) ||
      (i.command === "SubmitConfiguration" &&
        (originalCommand.reviewValidUntil === null ||
          snapshot.recordedAt >= originalCommand.reviewValidUntil ||
          (snapshot.configuration.effectiveUntil !== null &&
            originalCommand.reviewValidUntil > snapshot.configuration.effectiveUntil))) ||
      (i.expectedHead &&
        i.command !== "SaveConfigurationDraft" &&
        snapshot.configuration.configurationVersionReference !==
          i.expectedHead.configurationVersionReference) ||
      (i.command === "SaveConfigurationDraft" &&
        i.expectedHead &&
        (snapshot.configuration.configurationVersionReference ===
          i.expectedHead.configurationVersionReference ||
          snapshot.configuration.supersedesVersionReference !==
            i.expectedHead.configurationVersionReference))
    )
      return fail();
  }
  return Object.freeze({
    profile: "TenantBrandConfigurationOperationV1" as const,
    ...i,
    intentDigest: cursor.intentDigest,
    originalCommand,
    outcome: r.outcome,
    snapshot,
    auditReference: ref(r.auditReference),
    occurredAt,
    dataClassification: "ConfigurationMetadata" as const,
  });
}
export type BrandConfigurationReceipt = Awaited<
  ReturnType<typeof validateBrandConfigurationReceipt>
>;
function lease(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (
    r.currentPublication !== "NotEvaluated" ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  return { observedAt, validUntil, currentPublication: "NotEvaluated" as const };
}
function recordedReview(value: unknown, current: BrandConfigurationRevision | null) {
  if (value === null) {
    if (current && current.configuration.lifecycle !== "Draft") return fail();
    return null;
  }
  if (!current || current.configuration.lifecycle === "Draft" || !current.publishing) return fail();
  const r = closed(value, [
      "profile",
      "configurationVersionReference",
      "configurationSourceDigest",
      "lifecycleReference",
      "lifecycleVersion",
      "recordedState",
      "validationEvidenceReference",
      "submittedByReference",
      "submittedAt",
      "reviewValidUntil",
    ]),
    submittedAt = instant(r.submittedAt),
    reviewValidUntil = instant(r.reviewValidUntil),
    state = r.recordedState;
  if (
    r.profile !== "MerchantBrandConfigurationRecordedReviewV1" ||
    (state !== "PendingApproval" && state !== "Approved" && state !== "Published") ||
    state !== current.configuration.lifecycle ||
    r.configurationVersionReference !== current.configuration.configurationVersionReference ||
    r.configurationSourceDigest !== current.sourceDigest ||
    r.lifecycleReference !== current.publishing.lifecycleReference ||
    r.lifecycleVersion !== current.publishing.lifecycleVersion ||
    r.validationEvidenceReference !== current.publishing.validationEvidenceReference ||
    r.submittedByReference !== current.submittedByReference ||
    submittedAt < current.configuration.createdAt ||
    submittedAt > current.recordedAt ||
    reviewValidUntil <= submittedAt ||
    (current.configuration.effectiveUntil !== null &&
      reviewValidUntil > current.configuration.effectiveUntil)
  )
    return fail();
  return Object.freeze({
    profile: "MerchantBrandConfigurationRecordedReviewV1" as const,
    configurationVersionReference: ref(r.configurationVersionReference),
    configurationSourceDigest: digest(r.configurationSourceDigest),
    lifecycleReference: ref(r.lifecycleReference),
    lifecycleVersion: bounded(r.lifecycleVersion, 2),
    recordedState: state,
    validationEvidenceReference: ref(r.validationEvidenceReference),
    submittedByReference: ref(r.submittedByReference),
    submittedAt,
    reviewValidUntil,
  });
}
export async function parseBrandConfigurationCurrent(
  value: unknown,
  selected: BrandConfigurationScope,
) {
  const r = closed(value, [
      "profile",
      ...scopeKeys,
      "current",
      "observedAt",
      "validUntil",
      "currentPublication",
      "recordedReview",
    ]),
    scope = scopeOf(r),
    time = lease(r),
    current = r.current === null ? null : await validateBrandConfigurationRevision(r.current);
  if (
    r.profile !== "TenantBrandConfigurationCurrentV1" ||
    !same(scope, parseBrandConfigurationScope(selected)) ||
    (current &&
      (current.tenantReference !== scope.tenantReference ||
        current.brandReference !== scope.brandReference ||
        current.recordedAt > time.observedAt))
  )
    return fail("ScopeChanged");
  return Object.freeze({
    profile: "TenantBrandConfigurationCurrentV1" as const,
    ...scope,
    current,
    recordedReview: recordedReview(r.recordedReview, current),
    ...time,
  });
}
export type BrandConfigurationCurrent = Awaited<ReturnType<typeof parseBrandConfigurationCurrent>>;
export async function parseBrandConfigurationHistory(
  value: unknown,
  selected: BrandConfigurationScope,
  beforeRevision: number | null,
) {
  const r = closed(value, [
      "profile",
      ...scopeKeys,
      "beforeRevision",
      "entries",
      "nextBeforeRevision",
      "observedAt",
      "validUntil",
      "currentPublication",
    ]),
    scope = scopeOf(r),
    time = lease(r);
  if (beforeRevision !== null) bounded(beforeRevision);
  if (
    r.profile !== "TenantBrandConfigurationHistoryV1" ||
    !same(scope, parseBrandConfigurationScope(selected)) ||
    r.beforeRevision !== beforeRevision ||
    !Array.isArray(r.entries) ||
    r.entries.length > 2
  )
    return fail();
  const entries = await Promise.all(r.entries.map(validateBrandConfigurationRevision)),
    nextBeforeRevision = r.nextBeforeRevision === null ? null : bounded(r.nextBeforeRevision);
  if (
    entries.some(
      (e, index) =>
        e.tenantReference !== scope.tenantReference ||
        e.brandReference !== scope.brandReference ||
        e.recordedAt > time.observedAt ||
        (beforeRevision !== null && e.revision >= beforeRevision) ||
        (index > 0 && e.revision >= (entries[index - 1]?.revision ?? 0)),
    ) ||
    (nextBeforeRevision !== null &&
      (entries.length !== 2 || nextBeforeRevision !== entries[1]?.revision))
  )
    return fail();
  return Object.freeze({
    profile: "TenantBrandConfigurationHistoryV1" as const,
    ...scope,
    beforeRevision,
    entries: Object.freeze(entries),
    nextBeforeRevision,
    ...time,
  });
}
export type BrandConfigurationHistory = Awaited<ReturnType<typeof parseBrandConfigurationHistory>>;
export interface PreparedBrandConfigurationCommand {
  readonly command: BrandConfigurationCommand;
  readonly original: BrandConfigurationOriginal;
}
interface Controls {
  readonly csrf: string;
  readonly signal?: AbortSignal;
}
export function createMerchantBrandConfigurationClient(fetcher: typeof fetch = fetch) {
  let generation = 0;
  async function request(
    mode: "current" | "history" | "execute" | "resolve" | "templates",
    scopeValue: BrandConfigurationScope,
    body: unknown,
    controls: Controls,
    mutating: boolean,
  ) {
    const scope = parseBrandConfigurationScope(scopeValue),
      c = record(controls, ["csrf"], ["signal"]),
      csrf = c.csrf,
      signal = c.signal,
      epoch = ++generation;
    if (
      typeof csrf !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      return fail();
    const started = Date.now(),
      controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const check = () => {
      if (
        epoch !== generation ||
        !same(scope, parseBrandConfigurationScope(scopeValue)) ||
        controls.csrf !== csrf ||
        controls.signal !== signal
      )
        return fail("ScopeChanged");
      if (signal?.aborted || controller.signal.aborted)
        return fail(mutating ? "OutcomeUnknown" : "Unavailable");
    };
    const timer = setTimeout(abort, 15000);
    let sent = false;
    try {
      check();
      const path = `/merchant/organization/brands/configuration/${mode}`,
        encoded = canonical(body);
      if (new TextEncoder().encode(encoded).byteLength > 32768) return fail();
      sent = true;
      const response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: encoded,
        signal: controller.signal,
      });
      check();
      if (
        response.redirected ||
        (response.url && new URL(response.url).href !== new URL(path, location.origin).href)
      )
        return fail(mutating ? "OutcomeUnknown" : "Unavailable");
      if (response.status === 403) return fail("Denied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 400) return fail();
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
        !response.body
      )
        return fail(mutating ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        size = 0;
      try {
        while (true) {
          check();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > (mode === "templates" ? 524288 : 393216)) return fail();
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      check();
      const raw: unknown = JSON.parse(text);
      check();
      return { raw, check, started };
    } catch (e) {
      if (e instanceof BrandConfigurationClientError) throw e;
      return fail(mutating && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  function checkLease(
    value: BrandConfigurationCurrent | BrandConfigurationHistory | BrandTemplateCandidates,
    started: number,
  ) {
    if (
      Date.now() < started ||
      Date.now() < Date.parse(value.observedAt) ||
      Date.now() >= Date.parse(value.validUntil)
    )
      return fail("Stale");
  }
  function originalFor(command: BrandConfigurationCommand, intentDigest: string) {
    const { configuration, reviewValidUntil, profile, ...pins } = command;
    void configuration;
    void reviewValidUntil;
    void profile;
    return parseBrandConfigurationOriginal({
      profile: "TenantBrandConfigurationResolveV1",
      ...pins,
      intentDigest,
    });
  }
  return Object.freeze({
    async templates(
      scope: BrandConfigurationScope,
      afterTemplateReference: string | null,
      controls: Controls,
    ) {
      if (afterTemplateReference !== null) ref(afterTemplateReference);
      const reply = await request(
          "templates",
          scope,
          { brandReference: scope.brandReference, afterTemplateReference },
          controls,
          false,
        ),
        output = parseBrandTemplateCandidates(reply.raw, scope, afterTemplateReference);
      reply.check();
      checkLease(output, reply.started);
      return output;
    },
    async current(scope: BrandConfigurationScope, controls: Controls) {
      const reply = await request(
          "current",
          scope,
          { brandReference: scope.brandReference },
          controls,
          false,
        ),
        output = await parseBrandConfigurationCurrent(reply.raw, scope);
      reply.check();
      checkLease(output, reply.started);
      return output;
    },
    async history(
      scope: BrandConfigurationScope,
      beforeRevision: number | null,
      controls: Controls,
    ) {
      if (beforeRevision !== null) bounded(beforeRevision);
      const reply = await request(
          "history",
          scope,
          { brandReference: scope.brandReference, beforeRevision },
          controls,
          false,
        ),
        output = await parseBrandConfigurationHistory(reply.raw, scope, beforeRevision);
      reply.check();
      checkLease(output, reply.started);
      return output;
    },
    async prepare(value: unknown) {
      const command = parseBrandConfigurationCommand(value),
        intentDigest = await hash(command);
      return Object.freeze({ command, original: originalFor(command, intentDigest) });
    },
    async execute(value: PreparedBrandConfigurationCommand, controls: Controls) {
      const command = parseBrandConfigurationCommand(value.command),
        original = parseBrandConfigurationOriginal(value.original);
      if (!same(originalFor(command, await hash(command)), original)) return fail();
      const body = Object.fromEntries(
        [
          "command",
          "operationReference",
          "expectedBrandVersion",
          "expectedHead",
          "configuration",
          "reviewValidUntil",
        ].map((k) => [k, Object.getOwnPropertyDescriptor(command, k)?.value]),
      );
      const reply = await request(
          "execute",
          scopeOf(original),
          { brandReference: original.brandReference, command: body },
          controls,
          true,
        ),
        output = await validateBrandConfigurationReceipt(reply.raw, original);
      reply.check();
      return output;
    },
    async resolve(value: BrandConfigurationOriginal, controls: Controls) {
      const original = parseBrandConfigurationOriginal(value),
        body = Object.fromEntries(
          [
            "command",
            "operationReference",
            "expectedBrandVersion",
            "expectedHead",
            "intentDigest",
          ].map((k) => [k, Object.getOwnPropertyDescriptor(original, k)?.value]),
        );
      const reply = await request(
          "resolve",
          scopeOf(original),
          { brandReference: original.brandReference, command: body },
          controls,
          true,
        ),
        output = await validateBrandConfigurationReceipt(reply.raw, original);
      reply.check();
      return output;
    },
  });
}
