import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type OrganizationVersion,
  type StoreReference,
} from "../domain/brand-store.js";

export class BrandAdministrationError extends Error {
  constructor(
    readonly code:
      | "BRAND_ADMIN_INPUT_INVALID"
      | "BRAND_ADMIN_STATE_INVALID"
      | "BRAND_ADMIN_OVERRIDE_DENIED"
      | "BRAND_ADMIN_RESOLUTION_AMBIGUOUS",
  ) {
    super("Brand administration input is invalid");
    this.name = "BrandAdministrationError";
  }
}
const fail = (code: BrandAdministrationError["code"] = "BRAND_ADMIN_INPUT_INVALID"): never => {
  throw new BrandAdministrationError(code);
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  return value as Record<string, unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u,
  LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u;
export type BrandAdministrationReference = string & {
  readonly __brandAdministrationReference: unique symbol;
};
export const parseBrandAdministrationReference = (v: unknown) =>
  typeof v === "string" && UUID.test(v) ? (v as BrandAdministrationReference) : fail();
const nullableRef = (v: unknown) => (v === null ? null : parseBrandAdministrationReference(v)),
  instant = (v: unknown) => parseCanonicalInstant(v),
  nullableInstant = (v: unknown) => (v === null ? null : instant(v));
const code = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : fail());
const locale = (v: unknown) => (typeof v === "string" && LOCALE.test(v) ? v : fail());
const oneOf = <T extends string>(v: unknown, x: readonly T[]) =>
  typeof v === "string" && x.includes(v as T) ? (v as T) : fail();
const uniqueCodes = (v: unknown, max = 100) => {
  if (!Array.isArray(v) || v.length > max) return fail();
  const r = v.map(code);
  return new Set(r).size === r.length ? Object.freeze(r) : fail();
};
const uniqueLocales = (v: unknown) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) return fail();
  const r = v.map(locale);
  return new Set(r).size === r.length ? Object.freeze(r) : fail();
};

export const brandConfigurationLifecycles = [
  "Draft",
  "PendingApproval",
  "Approved",
  "Published",
  "Superseded",
  "Archived",
] as const;
export interface BrandConfigurationVersion {
  readonly configurationVersionReference: BrandAdministrationReference;
  readonly brandReference: BrandReference;
  readonly configurationVersion: OrganizationVersion;
  readonly lifecycle: (typeof brandConfigurationLifecycles)[number];
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly mediaThemeReference: BrandAdministrationReference | null;
  readonly catalogSourceReference: BrandAdministrationReference;
  readonly platformTemplateReference: BrandAdministrationReference;
  readonly overrideAllowedFieldCodes: readonly string[];
  readonly hardRequirementFieldCodes: readonly string[];
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly supersedesVersionReference: BrandAdministrationReference | null;
  readonly reasonCode: string;
  readonly authoredByReference: BrandAdministrationReference;
  readonly approvedByReference: BrandAdministrationReference | null;
  readonly approvalEvidenceReference: BrandAdministrationReference | null;
  readonly publicationReference: BrandAdministrationReference | null;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
  readonly dataClassification: "ConfigurationMetadata";
}
export function createBrandConfigurationVersion(value: unknown): BrandConfigurationVersion {
  const r = exact(value, [
    "configurationVersionReference",
    "brandReference",
    "configurationVersion",
    "lifecycle",
    "defaultLocale",
    "supportedLocales",
    "mediaThemeReference",
    "catalogSourceReference",
    "platformTemplateReference",
    "overrideAllowedFieldCodes",
    "hardRequirementFieldCodes",
    "effectiveFrom",
    "effectiveUntil",
    "supersedesVersionReference",
    "reasonCode",
    "authoredByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ]);
  const lifecycle = oneOf(r.lifecycle, brandConfigurationLifecycles),
    version = parseOrganizationVersion(r.configurationVersion),
    defaultLocale = locale(r.defaultLocale),
    supportedLocales = uniqueLocales(r.supportedLocales),
    allowed = uniqueCodes(r.overrideAllowedFieldCodes),
    hard = uniqueCodes(r.hardRequirementFieldCodes),
    effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = nullableInstant(r.effectiveUntil),
    createdAt = instant(r.createdAt),
    updatedAt = instant(r.updatedAt),
    authored = parseBrandAdministrationReference(r.authoredByReference),
    approved = nullableRef(r.approvedByReference),
    approval = nullableRef(r.approvalEvidenceReference),
    publication = nullableRef(r.publicationReference),
    supersedes = nullableRef(r.supersedesVersionReference);
  if (
    !supportedLocales.includes(defaultLocale) ||
    hard.some((f) => allowed.includes(f)) ||
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (version === 1) !== (supersedes === null) ||
    (approved === null) !== (approval === null) ||
    (approved !== null && approved === authored)
  )
    return fail("BRAND_ADMIN_STATE_INVALID");
  const unapproved = lifecycle === "Draft" || lifecycle === "PendingApproval",
    published = ["Published", "Superseded", "Archived"].includes(lifecycle);
  if (
    (unapproved && (approved !== null || publication !== null)) ||
    (lifecycle === "Approved" && (approved === null || publication !== null)) ||
    (published && (approved === null || publication === null))
  )
    return fail("BRAND_ADMIN_STATE_INVALID");
  return Object.freeze({
    configurationVersionReference: parseBrandAdministrationReference(
      r.configurationVersionReference,
    ),
    brandReference: parseBrandReference(r.brandReference),
    configurationVersion: version,
    lifecycle,
    defaultLocale,
    supportedLocales,
    mediaThemeReference: nullableRef(r.mediaThemeReference),
    catalogSourceReference: parseBrandAdministrationReference(r.catalogSourceReference),
    platformTemplateReference: parseBrandAdministrationReference(r.platformTemplateReference),
    overrideAllowedFieldCodes: allowed,
    hardRequirementFieldCodes: hard,
    effectiveFrom,
    effectiveUntil,
    supersedesVersionReference: supersedes,
    reasonCode: code(r.reasonCode),
    authoredByReference: authored,
    approvedByReference: approved,
    approvalEvidenceReference: approval,
    publicationReference: publication,
    createdAt,
    updatedAt,
    dataClassification:
      r.dataClassification === "ConfigurationMetadata" ? "ConfigurationMetadata" : fail(),
  });
}

export interface BrandStoreMembershipRecord {
  readonly membershipRecordReference: BrandAdministrationReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly action: "Added" | "Removed";
  readonly effectiveAt: CanonicalInstant;
  readonly brandVersion: OrganizationVersion;
  readonly actorReference: BrandAdministrationReference;
  readonly approvalEvidenceReference: BrandAdministrationReference;
  readonly operationReference: BrandAdministrationReference;
  readonly recordedAt: CanonicalInstant;
}
export function createBrandStoreMembershipRecord(value: unknown): BrandStoreMembershipRecord {
  const r = exact(value, [
    "membershipRecordReference",
    "brandReference",
    "storeReference",
    "action",
    "effectiveAt",
    "brandVersion",
    "actorReference",
    "approvalEvidenceReference",
    "operationReference",
    "recordedAt",
  ]);
  const effectiveAt = instant(r.effectiveAt),
    recordedAt = instant(r.recordedAt);
  if (Date.parse(recordedAt) < Date.parse(effectiveAt)) return fail("BRAND_ADMIN_STATE_INVALID");
  return Object.freeze({
    membershipRecordReference: parseBrandAdministrationReference(r.membershipRecordReference),
    brandReference: parseBrandReference(r.brandReference),
    storeReference: parseStoreReference(r.storeReference),
    action: oneOf(r.action, ["Added", "Removed"] as const),
    effectiveAt,
    brandVersion: parseOrganizationVersion(r.brandVersion),
    actorReference: parseBrandAdministrationReference(r.actorReference),
    approvalEvidenceReference: parseBrandAdministrationReference(r.approvalEvidenceReference),
    operationReference: parseBrandAdministrationReference(r.operationReference),
    recordedAt,
  });
}

export interface BrandInheritanceCandidate {
  readonly candidateReference: BrandAdministrationReference;
  readonly fieldCode: string;
  readonly source: "PlatformTemplate" | "BrandBase" | "StoreOverride" | "RuntimeContext";
  readonly sourceVersionReference: BrandAdministrationReference;
  readonly baseBrandVersionReference: BrandAdministrationReference;
  readonly valueReference: BrandAdministrationReference;
  readonly priority: number;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly platformHardRequirement: boolean;
}
export function createBrandInheritanceCandidate(value: unknown): BrandInheritanceCandidate {
  const r = exact(value, [
    "candidateReference",
    "fieldCode",
    "source",
    "sourceVersionReference",
    "baseBrandVersionReference",
    "valueReference",
    "priority",
    "effectiveFrom",
    "effectiveUntil",
    "platformHardRequirement",
  ]);
  const from = instant(r.effectiveFrom),
    until = nullableInstant(r.effectiveUntil);
  if (
    typeof r.priority !== "number" ||
    !Number.isSafeInteger(r.priority) ||
    r.priority < 0 ||
    r.priority > 1000 ||
    typeof r.platformHardRequirement !== "boolean" ||
    (until !== null && Date.parse(until) <= Date.parse(from))
  )
    return fail();
  return Object.freeze({
    candidateReference: parseBrandAdministrationReference(r.candidateReference),
    fieldCode: code(r.fieldCode),
    source: oneOf(r.source, [
      "PlatformTemplate",
      "BrandBase",
      "StoreOverride",
      "RuntimeContext",
    ] as const),
    sourceVersionReference: parseBrandAdministrationReference(r.sourceVersionReference),
    baseBrandVersionReference: parseBrandAdministrationReference(r.baseBrandVersionReference),
    valueReference: parseBrandAdministrationReference(r.valueReference),
    priority: r.priority,
    effectiveFrom: from,
    effectiveUntil: until,
    platformHardRequirement: r.platformHardRequirement,
  });
}
export function resolveBrandInheritance(
  configuration: BrandConfigurationVersion,
  candidates: readonly BrandInheritanceCandidate[],
  fieldCodeInput: unknown,
  effectiveAtInput: unknown,
) {
  const fieldCode = code(fieldCodeInput),
    at = Date.parse(instant(effectiveAtInput)),
    matching = candidates.filter(
      (c) =>
        c.fieldCode === fieldCode &&
        Date.parse(c.effectiveFrom) <= at &&
        (c.effectiveUntil === null || at < Date.parse(c.effectiveUntil)),
    );
  for (const candidate of matching)
    if (
      candidate.source === "StoreOverride" &&
      (!configuration.overrideAllowedFieldCodes.includes(fieldCode) ||
        configuration.hardRequirementFieldCodes.includes(fieldCode) ||
        candidate.platformHardRequirement ||
        candidate.baseBrandVersionReference !== configuration.configurationVersionReference)
    )
      return fail("BRAND_ADMIN_OVERRIDE_DENIED");
  matching.sort((a, b) => b.priority - a.priority);
  const first = matching[0];
  if (!first) return fail("BRAND_ADMIN_STATE_INVALID");
  if (matching[1]?.priority === first.priority) return fail("BRAND_ADMIN_RESOLUTION_AMBIGUOUS");
  return Object.freeze({
    fieldCode,
    valueReference: first.valueReference,
    source: first.source,
    sourceVersionReference: first.sourceVersionReference,
    effectiveFrom: first.effectiveFrom,
    effectiveUntil: first.effectiveUntil,
  });
}
