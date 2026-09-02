export type CompliancePolicyPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class CompliancePolicyPageError extends Error {
  constructor(readonly code: CompliancePolicyPageErrorCode) {
    super("Compliance Policy page unavailable");
    this.name = "CompliancePolicyPageError";
  }
}
export interface CompliancePolicyClient {
  load(): Promise<unknown>;
}
type PolicyStatus = "Draft" | "InReview" | "Approved" | "Published" | "Retired";
export interface CompliancePolicyView {
  readonly screenId: "CMP-POLICY-LIST" | "CMP-POLICY-EDITOR";
  readonly queryName: "compliance_policy_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayCreateRevision: boolean;
    readonly mayMapControl: boolean;
    readonly mayRequestReview: boolean;
    readonly mayApprove: boolean;
    readonly mayPublish: boolean;
    readonly mayRetire: boolean;
  };
  readonly filters: {
    readonly nameCode: string | null;
    readonly requirementTypeCode: string | null;
    readonly jurisdictionCode: string | null;
    readonly layer: "Platform" | "Brand" | "Store" | null;
    readonly status: PolicyStatus | null;
    readonly effectiveDisposition: "Upcoming" | "Effective" | "Expiring" | "Retired" | null;
  };
  readonly policies: readonly {
    readonly policyReference: string;
    readonly versionReference: string;
    readonly revision: number;
    readonly policyVersion: number;
    readonly storeReference: string | null;
    readonly layer: "Platform" | "Brand" | "Store";
    readonly parentVersionReference: string | null;
    readonly kind: "CompliancePolicy" | "RegulatoryRequirement";
    readonly nameCode: string;
    readonly jurisdictionCode: string;
    readonly authorityReference: string | null;
    readonly requirementTypeCode: string;
    readonly strength: "Advisory" | "Mandatory" | "HardRequirement";
    readonly overrideAllowed: boolean;
    readonly applicableScopeCodes: readonly string[];
    readonly timeZone: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly monitoringFrequencyHours: string;
    readonly threshold: null | {
      readonly operator: "LessThan" | "LessThanOrEqual" | "GreaterThan" | "GreaterThanOrEqual";
      readonly decimalValue: string;
      readonly unitCode: string;
    };
    readonly retentionDays: string;
    readonly escalationRuleCode: string;
    readonly notificationRequirement: "Required" | "Conditional" | "NotRequired";
    readonly legalReviewStatus: "NotRequired" | "Required" | "Passed" | "Failed";
    readonly status: PolicyStatus;
    readonly evidenceRequirements: readonly {
      readonly requirementCode: string;
      readonly classificationCode: string;
      readonly mandatory: boolean;
      readonly mappingReference: string | null;
      readonly ownerDomainCode: string | null;
    }[];
    readonly controlMappings: readonly {
      readonly mappingReference: string;
      readonly controlCode: string;
      readonly ownerDomainCode: string;
      readonly requiredOutcomeCode: string;
      readonly status: "Proposed" | "Validated";
    }[];
    readonly authoredByReference: string;
    readonly reviewedByReference: string | null;
    readonly counselReviewerReference: string | null;
    readonly secondApproverReference: string | null;
    readonly reviewedAt: string | null;
    readonly publishedAt: string | null;
    readonly retiredAt: string | null;
  }[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const unsigned = /^(?:0|[1-9][0-9]{0,8})$/u;
const decimalPattern = /^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,9})?$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new CompliancePolicyPageError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
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
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const nullableReference = (value: unknown) => (value === null ? null : reference(value));
const code = (value: unknown) =>
  typeof value === "string" && codePattern.test(value) ? value : fail();
const nullableCode = (value: unknown) => (value === null ? null : code(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const count = (value: unknown) =>
  typeof value === "string" && unsigned.test(value) ? value : fail();
function codes(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return fail();
  const parsed = Object.freeze(value.map(code));
  return new Set(parsed).size === parsed.length ? parsed : fail();
}
function zone(value: unknown) {
  if (typeof value !== "string" || value.length > 64) return fail();
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value)
      return fail();
  } catch {
    return fail();
  }
  return value;
}
function evidence(value: unknown) {
  const raw = object(value, [
    "requirementCode",
    "classificationCode",
    "mandatory",
    "mappingReference",
    "ownerDomainCode",
  ]);
  const mappingReference = nullableReference(raw.mappingReference);
  const ownerDomainCode = nullableCode(raw.ownerDomainCode);
  if ((mappingReference === null) !== (ownerDomainCode === null)) return fail();
  return Object.freeze({
    requirementCode: code(raw.requirementCode),
    classificationCode: code(raw.classificationCode),
    mandatory: bool(raw.mandatory),
    mappingReference,
    ownerDomainCode,
  });
}
function control(value: unknown) {
  const raw = object(value, [
    "mappingReference",
    "controlCode",
    "ownerDomainCode",
    "requiredOutcomeCode",
    "status",
  ]);
  return Object.freeze({
    mappingReference: reference(raw.mappingReference),
    controlCode: code(raw.controlCode),
    ownerDomainCode: code(raw.ownerDomainCode),
    requiredOutcomeCode: code(raw.requiredOutcomeCode),
    status: oneOf(raw.status, ["Proposed", "Validated"] as const),
  });
}
function policy(value: unknown): CompliancePolicyView["policies"][number] {
  const raw = object(value, [
    "policyReference",
    "versionReference",
    "revision",
    "policyVersion",
    "storeReference",
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
    "monitoringFrequencyHours",
    "threshold",
    "retentionDays",
    "escalationRuleCode",
    "notificationRequirement",
    "legalReviewStatus",
    "status",
    "evidenceRequirements",
    "controlMappings",
    "authoredByReference",
    "reviewedByReference",
    "counselReviewerReference",
    "secondApproverReference",
    "reviewedAt",
    "publishedAt",
    "retiredAt",
  ]);
  const storeReference = nullableReference(raw.storeReference);
  const layer = oneOf(raw.layer, ["Platform", "Brand", "Store"] as const);
  const parentVersionReference = nullableReference(raw.parentVersionReference);
  if (
    (layer === "Platform" && (storeReference !== null || parentVersionReference !== null)) ||
    (layer === "Brand" && (storeReference !== null || parentVersionReference === null)) ||
    (layer === "Store" && (storeReference === null || parentVersionReference === null))
  )
    return fail();
  const effectiveFrom = instant(raw.effectiveFrom);
  const effectiveTo = nullableInstant(raw.effectiveTo);
  if (effectiveTo !== null && Date.parse(effectiveFrom) >= Date.parse(effectiveTo)) return fail();
  const strength = oneOf(raw.strength, ["Advisory", "Mandatory", "HardRequirement"] as const);
  const overrideAllowed = bool(raw.overrideAllowed);
  if (strength === "HardRequirement" && overrideAllowed) return fail();
  if (!Array.isArray(raw.evidenceRequirements) || raw.evidenceRequirements.length > 50)
    return fail();
  const evidenceRequirements = Object.freeze(raw.evidenceRequirements.map(evidence));
  if (
    new Set(evidenceRequirements.map((item) => item.requirementCode)).size !==
    evidenceRequirements.length
  )
    return fail();
  if (!Array.isArray(raw.controlMappings) || raw.controlMappings.length > 100) return fail();
  const controlMappings = Object.freeze(raw.controlMappings.map(control));
  if (new Set(controlMappings.map((item) => item.mappingReference)).size !== controlMappings.length)
    return fail();
  const threshold =
    raw.threshold === null
      ? null
      : (() => {
          const item = object(raw.threshold, ["operator", "decimalValue", "unitCode"]);
          return Object.freeze({
            operator: oneOf(item.operator, [
              "LessThan",
              "LessThanOrEqual",
              "GreaterThan",
              "GreaterThanOrEqual",
            ] as const),
            decimalValue:
              typeof item.decimalValue === "string" && decimalPattern.test(item.decimalValue)
                ? item.decimalValue
                : fail(),
            unitCode: code(item.unitCode),
          });
        })();
  const kind = oneOf(raw.kind, ["CompliancePolicy", "RegulatoryRequirement"] as const);
  const authorityReference = nullableReference(raw.authorityReference);
  if (kind === "RegulatoryRequirement" && authorityReference === null) return fail();
  const status = oneOf(raw.status, [
    "Draft",
    "InReview",
    "Approved",
    "Published",
    "Retired",
  ] as const);
  const reviewedByReference = nullableReference(raw.reviewedByReference);
  const counselReviewerReference = nullableReference(raw.counselReviewerReference);
  const secondApproverReference = nullableReference(raw.secondApproverReference);
  const reviewedAt = nullableInstant(raw.reviewedAt);
  const publishedAt = nullableInstant(raw.publishedAt);
  const retiredAt = nullableInstant(raw.retiredAt);
  const authoredByReference = reference(raw.authoredByReference);
  const legalReviewStatus = oneOf(raw.legalReviewStatus, [
    "NotRequired",
    "Required",
    "Passed",
    "Failed",
  ] as const);
  const reviewed = ["Approved", "Published", "Retired"].includes(status);
  if (
    reviewed !== (reviewedByReference !== null && reviewedAt !== null) ||
    reviewedByReference === authoredByReference ||
    (legalReviewStatus === "Passed") !== (counselReviewerReference !== null) ||
    counselReviewerReference === authoredByReference ||
    (strength === "HardRequirement" && reviewed && secondApproverReference === null) ||
    (secondApproverReference !== null &&
      [authoredByReference, reviewedByReference].includes(secondApproverReference)) ||
    (status === "Published" || status === "Retired") !== (publishedAt !== null) ||
    (status === "Retired") !== (retiredAt !== null) ||
    ((status === "Published" || status === "Retired") &&
      (evidenceRequirements.some((item) => item.mandatory && item.mappingReference === null) ||
        controlMappings.length === 0 ||
        controlMappings.some((item) => item.status !== "Validated")))
  )
    return fail();
  return Object.freeze({
    policyReference: reference(raw.policyReference),
    versionReference: reference(raw.versionReference),
    revision: positive(raw.revision),
    policyVersion: positive(raw.policyVersion),
    storeReference,
    layer,
    parentVersionReference,
    kind,
    nameCode: code(raw.nameCode),
    jurisdictionCode: code(raw.jurisdictionCode),
    authorityReference,
    requirementTypeCode: code(raw.requirementTypeCode),
    strength,
    overrideAllowed,
    applicableScopeCodes: codes(raw.applicableScopeCodes),
    timeZone: zone(raw.timeZone),
    effectiveFrom,
    effectiveTo,
    monitoringFrequencyHours: count(raw.monitoringFrequencyHours),
    threshold,
    retentionDays: count(raw.retentionDays),
    escalationRuleCode: code(raw.escalationRuleCode),
    notificationRequirement: oneOf(raw.notificationRequirement, [
      "Required",
      "Conditional",
      "NotRequired",
    ] as const),
    legalReviewStatus,
    status,
    evidenceRequirements,
    controlMappings,
    authoredByReference,
    reviewedByReference,
    counselReviewerReference,
    secondApproverReference,
    reviewedAt,
    publishedAt,
    retiredAt,
  });
}
export function parseCompliancePolicyView(value: unknown): CompliancePolicyView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "filters",
    "policies",
  ]);
  const screenId = oneOf(raw.screenId, ["CMP-POLICY-LIST", "CMP-POLICY-EDITOR"] as const);
  if (raw.queryName !== "compliance_policy_v1" || raw.queryVersion !== 1) return fail();
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) return fail();
  const permissions = object(raw.permissions, [
    "mayCreateRevision",
    "mayMapControl",
    "mayRequestReview",
    "mayApprove",
    "mayPublish",
    "mayRetire",
  ]);
  const filters = object(raw.filters, [
    "nameCode",
    "requirementTypeCode",
    "jurisdictionCode",
    "layer",
    "status",
    "effectiveDisposition",
  ]);
  if (!Array.isArray(raw.policies) || raw.policies.length > 500) return fail();
  const policies = Object.freeze(raw.policies.map(policy));
  if (new Set(policies.map((item) => item.versionReference)).size !== policies.length)
    return fail();
  if (screenId === "CMP-POLICY-EDITOR" && policies.length !== 1) return fail();
  return Object.freeze({
    screenId,
    queryName: "compliance_policy_v1",
    queryVersion: 1,
    generatedAt,
    sourceAsOf,
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayCreateRevision: bool(permissions.mayCreateRevision),
      mayMapControl: bool(permissions.mayMapControl),
      mayRequestReview: bool(permissions.mayRequestReview),
      mayApprove: bool(permissions.mayApprove),
      mayPublish: bool(permissions.mayPublish),
      mayRetire: bool(permissions.mayRetire),
    }),
    filters: Object.freeze({
      nameCode: nullableCode(filters.nameCode),
      requirementTypeCode: nullableCode(filters.requirementTypeCode),
      jurisdictionCode: nullableCode(filters.jurisdictionCode),
      layer:
        filters.layer === null
          ? null
          : oneOf(filters.layer, ["Platform", "Brand", "Store"] as const),
      status:
        filters.status === null
          ? null
          : oneOf(filters.status, [
              "Draft",
              "InReview",
              "Approved",
              "Published",
              "Retired",
            ] as const),
      effectiveDisposition:
        filters.effectiveDisposition === null
          ? null
          : oneOf(filters.effectiveDisposition, [
              "Upcoming",
              "Effective",
              "Expiring",
              "Retired",
            ] as const),
    }),
    policies,
  });
}
export const unavailableCompliancePolicyClient: CompliancePolicyClient = Object.freeze({
  async load() {
    throw new CompliancePolicyPageError("Unavailable");
  },
});
