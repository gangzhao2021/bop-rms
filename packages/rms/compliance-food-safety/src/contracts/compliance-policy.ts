import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceCode,
  type ComplianceReference,
  type ComplianceScope,
} from "./compliance-dashboard.js";

export const compliancePolicyStatuses = [
  "Draft",
  "InReview",
  "Approved",
  "Published",
  "Retired",
] as const;
export type CompliancePolicyStatus = (typeof compliancePolicyStatuses)[number];
export type CompliancePolicyLayer = "Platform" | "Brand" | "Store";
export type CompliancePolicyKind = "CompliancePolicy" | "RegulatoryRequirement";
export type ComplianceRequirementStrength = "Advisory" | "Mandatory" | "HardRequirement";

export interface ComplianceEvidenceRequirement {
  readonly requirementCode: ComplianceCode;
  readonly classificationCode: ComplianceCode;
  readonly mandatory: boolean;
}
export interface ComplianceEvidenceMapping {
  readonly mappingReference: ComplianceReference;
  readonly requirementCode: ComplianceCode;
  readonly evidenceTypeCode: ComplianceCode;
  readonly ownerDomainCode: ComplianceCode;
}
export interface ComplianceControlMapping {
  readonly mappingReference: ComplianceReference;
  readonly controlCode: ComplianceCode;
  readonly ownerDomainCode: ComplianceCode;
  readonly requiredOutcomeCode: ComplianceCode;
  readonly status: "Proposed" | "Validated";
}
export interface CompliancePolicyVersion {
  readonly policyReference: ComplianceReference;
  readonly versionReference: ComplianceReference;
  readonly revision: number;
  readonly policyVersion: number;
  readonly scope: ComplianceScope;
  readonly layer: CompliancePolicyLayer;
  readonly parentVersionReference: ComplianceReference | null;
  readonly kind: CompliancePolicyKind;
  readonly nameCode: ComplianceCode;
  readonly jurisdictionCode: ComplianceCode;
  readonly authorityReference: ComplianceReference | null;
  readonly requirementTypeCode: ComplianceCode;
  readonly strength: ComplianceRequirementStrength;
  readonly overrideAllowed: boolean;
  readonly applicableScopeCodes: readonly ComplianceCode[];
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly evidenceRequirements: readonly ComplianceEvidenceRequirement[];
  readonly monitoringFrequencyHours: string;
  readonly threshold: null | {
    readonly operator: "LessThan" | "LessThanOrEqual" | "GreaterThan" | "GreaterThanOrEqual";
    readonly decimalValue: string;
    readonly unitCode: ComplianceCode;
  };
  readonly retentionDays: string;
  readonly escalationRuleCode: ComplianceCode;
  readonly notificationRequirement: "Required" | "Conditional" | "NotRequired";
  readonly legalReviewStatus: "NotRequired" | "Required" | "Passed" | "Failed";
  readonly evidenceMappings: readonly ComplianceEvidenceMapping[];
  readonly controlMappings: readonly ComplianceControlMapping[];
  readonly status: CompliancePolicyStatus;
  readonly authoredByReference: ComplianceReference;
  readonly reviewedByReference: ComplianceReference | null;
  readonly counselReviewerReference: ComplianceReference | null;
  readonly secondApproverReference: ComplianceReference | null;
  readonly reviewedAt: string | null;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
  readonly recordedAt: string;
}

export class CompliancePolicyContractError extends Error {
  constructor(readonly code: "POLICY_INPUT_INVALID" | "POLICY_SCOPE_INVALID") {
    super("Compliance policy input is invalid");
    this.name = "CompliancePolicyContractError";
  }
}
const fail = (
  code: "POLICY_INPUT_INVALID" | "POLICY_SCOPE_INVALID" = "POLICY_INPUT_INVALID",
): never => {
  throw new CompliancePolicyContractError(code);
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
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
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const positive = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const bool = (value: unknown): boolean => (typeof value === "boolean" ? value : fail());
const unsigned = (value: unknown, allowZero = false): string => {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,8})$/u : /^[1-9][0-9]{0,8}$/u;
  return typeof value === "string" && pattern.test(value) ? value : fail();
};
const decimal = (value: unknown): string => {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,9})?$/u.test(value))
    return fail();
  return value;
};
const nullableReference = (value: unknown): ComplianceReference | null =>
  value === null ? null : parseComplianceReference(value);
const nullableInstant = (value: unknown): string | null =>
  value === null ? null : parseComplianceInstant(value);
function codes(value: unknown): readonly ComplianceCode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return fail();
  const parsed = Object.freeze(value.map(parseComplianceCode));
  return new Set(parsed).size === parsed.length ? parsed : fail();
}
function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return fail();
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value)
      return fail();
  } catch {
    return fail();
  }
  return value;
}
function evidenceRequirement(value: unknown): ComplianceEvidenceRequirement {
  const raw = exact(value, ["requirementCode", "classificationCode", "mandatory"]);
  return Object.freeze({
    requirementCode: parseComplianceCode(raw.requirementCode),
    classificationCode: parseComplianceCode(raw.classificationCode),
    mandatory: bool(raw.mandatory),
  });
}
function evidenceMapping(value: unknown): ComplianceEvidenceMapping {
  const raw = exact(value, [
    "mappingReference",
    "requirementCode",
    "evidenceTypeCode",
    "ownerDomainCode",
  ]);
  return Object.freeze({
    mappingReference: parseComplianceReference(raw.mappingReference),
    requirementCode: parseComplianceCode(raw.requirementCode),
    evidenceTypeCode: parseComplianceCode(raw.evidenceTypeCode),
    ownerDomainCode: parseComplianceCode(raw.ownerDomainCode),
  });
}
function controlMapping(value: unknown): ComplianceControlMapping {
  const raw = exact(value, [
    "mappingReference",
    "controlCode",
    "ownerDomainCode",
    "requiredOutcomeCode",
    "status",
  ]);
  return Object.freeze({
    mappingReference: parseComplianceReference(raw.mappingReference),
    controlCode: parseComplianceCode(raw.controlCode),
    ownerDomainCode: parseComplianceCode(raw.ownerDomainCode),
    requiredOutcomeCode: parseComplianceCode(raw.requiredOutcomeCode),
    status: oneOf(raw.status, ["Proposed", "Validated"] as const),
  });
}
function unique<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  return new Set(items.map(key)).size === items.length ? items : fail();
}

export function createCompliancePolicyVersion(value: unknown): CompliancePolicyVersion {
  const raw = exact(value, [
    "policyReference",
    "versionReference",
    "revision",
    "policyVersion",
    "scope",
    "layer",
    "parentVersionReference",
    "kind",
    "nameCode",
    "jurisdictionCode",
    "authorityReference",
    "requirementTypeCode",
    "strength",
    "overrideAllowed",
    "applicableScopeCodes",
    "timeZone",
    "effectiveFrom",
    "effectiveTo",
    "evidenceRequirements",
    "monitoringFrequencyHours",
    "threshold",
    "retentionDays",
    "escalationRuleCode",
    "notificationRequirement",
    "legalReviewStatus",
    "evidenceMappings",
    "controlMappings",
    "status",
    "authoredByReference",
    "reviewedByReference",
    "counselReviewerReference",
    "secondApproverReference",
    "reviewedAt",
    "publishedAt",
    "retiredAt",
    "recordedAt",
  ]);
  const scope = parseComplianceScope(raw.scope);
  const layer = oneOf(raw.layer, ["Platform", "Brand", "Store"] as const);
  const parentVersionReference = nullableReference(raw.parentVersionReference);
  if (
    (layer === "Platform" && (scope.storeReference !== null || parentVersionReference !== null)) ||
    (layer === "Brand" && (scope.storeReference !== null || parentVersionReference === null)) ||
    (layer === "Store" && (scope.storeReference === null || parentVersionReference === null))
  )
    return fail("POLICY_SCOPE_INVALID");
  const kind = oneOf(raw.kind, ["CompliancePolicy", "RegulatoryRequirement"] as const);
  const authorityReference = nullableReference(raw.authorityReference);
  if (kind === "RegulatoryRequirement" && authorityReference === null) return fail();
  const strength = oneOf(raw.strength, ["Advisory", "Mandatory", "HardRequirement"] as const);
  const overrideAllowed = bool(raw.overrideAllowed);
  if (strength === "HardRequirement" && overrideAllowed) return fail();
  const effectiveFrom = parseComplianceInstant(raw.effectiveFrom);
  const effectiveTo = nullableInstant(raw.effectiveTo);
  if (effectiveTo !== null && Date.parse(effectiveFrom) >= Date.parse(effectiveTo)) return fail();
  if (!Array.isArray(raw.evidenceRequirements) || raw.evidenceRequirements.length > 50)
    return fail();
  const evidenceRequirements = unique(
    Object.freeze(raw.evidenceRequirements.map(evidenceRequirement)),
    (item) => item.requirementCode,
  );
  if (!Array.isArray(raw.evidenceMappings) || raw.evidenceMappings.length > 100) return fail();
  const evidenceMappings = unique(
    Object.freeze(raw.evidenceMappings.map(evidenceMapping)),
    (item) => item.mappingReference,
  );
  if (
    evidenceMappings.some(
      (mapping) =>
        !evidenceRequirements.some(
          (requirement) => requirement.requirementCode === mapping.requirementCode,
        ),
    )
  )
    return fail();
  if (!Array.isArray(raw.controlMappings) || raw.controlMappings.length > 100) return fail();
  const controlMappings = unique(
    Object.freeze(raw.controlMappings.map(controlMapping)),
    (item) => item.mappingReference,
  );
  const thresholdRaw = raw.threshold;
  const threshold =
    thresholdRaw === null
      ? null
      : (() => {
          const item = exact(thresholdRaw, ["operator", "decimalValue", "unitCode"]);
          return Object.freeze({
            operator: oneOf(item.operator, [
              "LessThan",
              "LessThanOrEqual",
              "GreaterThan",
              "GreaterThanOrEqual",
            ] as const),
            decimalValue: decimal(item.decimalValue),
            unitCode: parseComplianceCode(item.unitCode),
          });
        })();
  const status = oneOf(raw.status, compliancePolicyStatuses);
  const legalReviewStatus = oneOf(raw.legalReviewStatus, [
    "NotRequired",
    "Required",
    "Passed",
    "Failed",
  ] as const);
  const authoredByReference = parseComplianceReference(raw.authoredByReference);
  const reviewedByReference = nullableReference(raw.reviewedByReference);
  const counselReviewerReference = nullableReference(raw.counselReviewerReference);
  const secondApproverReference = nullableReference(raw.secondApproverReference);
  const reviewedAt = nullableInstant(raw.reviewedAt);
  const publishedAt = nullableInstant(raw.publishedAt);
  const retiredAt = nullableInstant(raw.retiredAt);
  const reviewed = status === "Approved" || status === "Published" || status === "Retired";
  if (
    reviewed !== (reviewedByReference !== null && reviewedAt !== null) ||
    (reviewedByReference !== null && reviewedByReference === authoredByReference) ||
    (legalReviewStatus === "Passed") !== (counselReviewerReference !== null) ||
    (counselReviewerReference !== null && counselReviewerReference === authoredByReference) ||
    (strength === "HardRequirement" && reviewed && secondApproverReference === null) ||
    (secondApproverReference !== null &&
      [authoredByReference, reviewedByReference].includes(secondApproverReference)) ||
    (status === "Published" || status === "Retired") !== (publishedAt !== null) ||
    (status === "Retired") !== (retiredAt !== null) ||
    (retiredAt !== null && publishedAt !== null && Date.parse(retiredAt) <= Date.parse(publishedAt))
  )
    return fail();
  return Object.freeze({
    policyReference: parseComplianceReference(raw.policyReference),
    versionReference: parseComplianceReference(raw.versionReference),
    revision: positive(raw.revision),
    policyVersion: positive(raw.policyVersion),
    scope,
    layer,
    parentVersionReference,
    kind,
    nameCode: parseComplianceCode(raw.nameCode),
    jurisdictionCode: parseComplianceCode(raw.jurisdictionCode),
    authorityReference,
    requirementTypeCode: parseComplianceCode(raw.requirementTypeCode),
    strength,
    overrideAllowed,
    applicableScopeCodes: codes(raw.applicableScopeCodes),
    timeZone: timeZone(raw.timeZone),
    effectiveFrom,
    effectiveTo,
    evidenceRequirements,
    monitoringFrequencyHours: unsigned(raw.monitoringFrequencyHours),
    threshold,
    retentionDays: unsigned(raw.retentionDays, true),
    escalationRuleCode: parseComplianceCode(raw.escalationRuleCode),
    notificationRequirement: oneOf(raw.notificationRequirement, [
      "Required",
      "Conditional",
      "NotRequired",
    ] as const),
    legalReviewStatus,
    evidenceMappings,
    controlMappings,
    status,
    authoredByReference,
    reviewedByReference,
    counselReviewerReference,
    secondApproverReference,
    reviewedAt,
    publishedAt,
    retiredAt,
    recordedAt: parseComplianceInstant(raw.recordedAt),
  });
}
