import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type OrganizationVersion,
  type StoreReference,
} from "@bop/tenant";

export const operatingEntityErrorCodes = [
  "OPERATING_ENTITY_INPUT_INVALID",
  "OPERATING_ENTITY_REFERENCE_INVALID",
  "ASSIGNMENT_REFERENCE_INVALID",
  "EVIDENCE_REFERENCE_INVALID",
  "OPERATING_ENTITY_SHAPE_INVALID",
  "OPERATING_ENTITY_EVIDENCE_REQUIRED",
  "OPERATING_ENTITY_VERSION_CONFLICT",
  "OPERATING_ENTITY_TRANSITION_INVALID",
  "ASSIGNMENT_SHAPE_INVALID",
  "ASSIGNMENT_NOT_FOUND",
  "ASSIGNMENT_AMBIGUOUS",
] as const;
export type OperatingEntityErrorCode = (typeof operatingEntityErrorCodes)[number];

const safeMessages: Readonly<Record<OperatingEntityErrorCode, string>> = {
  OPERATING_ENTITY_INPUT_INVALID: "operating entity input is invalid",
  OPERATING_ENTITY_REFERENCE_INVALID: "operating entity reference is invalid",
  ASSIGNMENT_REFERENCE_INVALID: "assignment reference is invalid",
  EVIDENCE_REFERENCE_INVALID: "evidence reference is invalid",
  OPERATING_ENTITY_SHAPE_INVALID: "operating entity shape is invalid",
  OPERATING_ENTITY_EVIDENCE_REQUIRED: "operating entity evidence is required",
  OPERATING_ENTITY_VERSION_CONFLICT: "operating entity version conflict",
  OPERATING_ENTITY_TRANSITION_INVALID: "operating entity transition is invalid",
  ASSIGNMENT_SHAPE_INVALID: "assignment shape is invalid",
  ASSIGNMENT_NOT_FOUND: "assignment was not found",
  ASSIGNMENT_AMBIGUOUS: "assignment is ambiguous",
};

export class OperatingEntityContractError extends Error {
  readonly code: OperatingEntityErrorCode;

  constructor(code: OperatingEntityErrorCode) {
    super(safeMessages[code]);
    this.name = "OperatingEntityContractError";
    this.code = code;
  }
}

export type OperatingEntityReference = string & {
  readonly __operatingEntityReference: unique symbol;
};
export type AssignmentReference = string & { readonly __assignmentReference: unique symbol };
export type EvidenceReference = string & { readonly __evidenceReference: unique symbol };

export const operatingEntityLifecycles = [
  "Draft",
  "PendingExternalEvidence",
  "Active",
  "Suspended",
  "Archived",
] as const;
export type OperatingEntityLifecycle = (typeof operatingEntityLifecycles)[number];
export const assignmentLifecycles = ["Active", "Suspended", "Archived"] as const;
export type AssignmentLifecycle = (typeof assignmentLifecycles)[number];
export const businessFunctions = [
  "SalesReceiptIssuer",
  "TaxRegistrant",
  "PaymentSettlementOwner",
  "ProcurementBuyer",
  "LicenseHolder",
  "Employer",
] as const;
export type BusinessFunction = (typeof businessFunctions)[number];

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function parseUuidV7(value: unknown, code: OperatingEntityErrorCode): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new OperatingEntityContractError(code);
  return value;
}

export function parseOperatingEntityReference(value: unknown): OperatingEntityReference {
  return parseUuidV7(value, "OPERATING_ENTITY_REFERENCE_INVALID") as OperatingEntityReference;
}
export function parseAssignmentReference(value: unknown): AssignmentReference {
  return parseUuidV7(value, "ASSIGNMENT_REFERENCE_INVALID") as AssignmentReference;
}
export function parseEvidenceReference(value: unknown): EvidenceReference {
  return parseUuidV7(value, "EVIDENCE_REFERENCE_INVALID") as EvidenceReference;
}

function readClosedRecord(
  value: unknown,
  keys: readonly string[],
  code: OperatingEntityErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new OperatingEntityContractError(code);
    const ownKeys = Reflect.ownKeys(value);
    const allowed = new Set(keys);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      throw new OperatingEntityContractError(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new OperatingEntityContractError(code);
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof OperatingEntityContractError) throw error;
    throw new OperatingEntityContractError(code);
  }
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  )
    throw new OperatingEntityContractError("OPERATING_ENTITY_INPUT_INVALID");
  return value;
}
function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}
function nullableEvidence(value: unknown): EvidenceReference | null {
  return value === null ? null : parseEvidenceReference(value);
}
function entityLifecycle(value: unknown): OperatingEntityLifecycle {
  if (
    typeof value !== "string" ||
    !operatingEntityLifecycles.includes(value as OperatingEntityLifecycle)
  )
    throw new OperatingEntityContractError("OPERATING_ENTITY_INPUT_INVALID");
  return value as OperatingEntityLifecycle;
}
function assignmentLifecycle(value: unknown): AssignmentLifecycle {
  if (typeof value !== "string" || !assignmentLifecycles.includes(value as AssignmentLifecycle))
    throw new OperatingEntityContractError("ASSIGNMENT_SHAPE_INVALID");
  return value as AssignmentLifecycle;
}
function businessFunction(value: unknown): BusinessFunction {
  if (typeof value !== "string" || !businessFunctions.includes(value as BusinessFunction))
    throw new OperatingEntityContractError("ASSIGNMENT_SHAPE_INVALID");
  return value as BusinessFunction;
}

export interface OperatingEntity {
  readonly operatingEntityReference: OperatingEntityReference;
  readonly kind: "LegalEntity";
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly jurisdictionCode: "CA-ON";
  readonly registrationReference: EvidenceReference | null;
  readonly taxRegistrationReference: EvidenceReference | null;
  readonly billingIdentityReference: EvidenceReference | null;
  readonly settlementReference: EvidenceReference | null;
  readonly evidenceReference: EvidenceReference | null;
  readonly lifecycle: OperatingEntityLifecycle;
  readonly version: OrganizationVersion;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}

export function createOperatingEntity(value: unknown): OperatingEntity {
  const r = readClosedRecord(
    value,
    [
      "operatingEntityReference",
      "kind",
      "legalName",
      "tradeName",
      "jurisdictionCode",
      "registrationReference",
      "taxRegistrationReference",
      "billingIdentityReference",
      "settlementReference",
      "evidenceReference",
      "lifecycle",
      "version",
      "createdAt",
      "updatedAt",
    ],
    "OPERATING_ENTITY_SHAPE_INVALID",
  );
  if (r.kind !== "LegalEntity" || r.jurisdictionCode !== "CA-ON")
    throw new OperatingEntityContractError("OPERATING_ENTITY_SHAPE_INVALID");
  const lifecycle = entityLifecycle(r.lifecycle);
  const evidenceReference = nullableEvidence(r.evidenceReference);
  if (lifecycle === "Active" && evidenceReference === null)
    throw new OperatingEntityContractError("OPERATING_ENTITY_EVIDENCE_REQUIRED");
  const createdAt = parseCanonicalInstant(r.createdAt);
  const updatedAt = parseCanonicalInstant(r.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new OperatingEntityContractError("OPERATING_ENTITY_SHAPE_INVALID");
  return Object.freeze({
    operatingEntityReference: parseOperatingEntityReference(r.operatingEntityReference),
    kind: "LegalEntity",
    legalName: text(r.legalName, 200),
    tradeName: nullableText(r.tradeName, 200),
    jurisdictionCode: "CA-ON",
    registrationReference: nullableEvidence(r.registrationReference),
    taxRegistrationReference: nullableEvidence(r.taxRegistrationReference),
    billingIdentityReference: nullableEvidence(r.billingIdentityReference),
    settlementReference: nullableEvidence(r.settlementReference),
    evidenceReference,
    lifecycle,
    version: parseOrganizationVersion(r.version),
    createdAt,
    updatedAt,
  });
}

const entityTransitions: Readonly<
  Record<OperatingEntityLifecycle, readonly OperatingEntityLifecycle[]>
> = {
  Draft: ["PendingExternalEvidence", "Archived"],
  PendingExternalEvidence: ["Active", "Archived"],
  Active: ["Suspended", "Archived"],
  Suspended: ["Active", "Archived"],
  Archived: [],
};

export function transitionOperatingEntity(
  aggregate: OperatingEntity,
  expectedVersion: OrganizationVersion,
  next: OperatingEntityLifecycle,
  updatedAtInput: unknown,
): OperatingEntity {
  if (aggregate.version !== expectedVersion)
    throw new OperatingEntityContractError("OPERATING_ENTITY_VERSION_CONFLICT");
  if (!entityTransitions[aggregate.lifecycle].includes(next))
    throw new OperatingEntityContractError("OPERATING_ENTITY_TRANSITION_INVALID");
  if (next === "Active" && aggregate.evidenceReference === null)
    throw new OperatingEntityContractError("OPERATING_ENTITY_EVIDENCE_REQUIRED");
  const updatedAt = parseCanonicalInstant(updatedAtInput);
  if (Date.parse(updatedAt) < Date.parse(aggregate.updatedAt))
    throw new OperatingEntityContractError("OPERATING_ENTITY_TRANSITION_INVALID");
  return Object.freeze({
    ...aggregate,
    lifecycle: next,
    version: (aggregate.version + 1) as OrganizationVersion,
    updatedAt,
  });
}

interface AssignmentBase {
  readonly assignmentReference: AssignmentReference;
  readonly brandReference: BrandReference;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly businessFunction: BusinessFunction;
  readonly lifecycle: AssignmentLifecycle;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly version: OrganizationVersion;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}
export type BrandOperatingEntityAssignment = AssignmentBase;
export interface StoreOperatingEntityAssignment extends AssignmentBase {
  readonly storeReference: StoreReference;
}

function createAssignmentBase(r: Readonly<Record<string, unknown>>): AssignmentBase {
  const effectiveFrom = parseCanonicalInstant(r.effectiveFrom);
  const effectiveUntil = r.effectiveUntil === null ? null : parseCanonicalInstant(r.effectiveUntil);
  const createdAt = parseCanonicalInstant(r.createdAt);
  const updatedAt = parseCanonicalInstant(r.updatedAt);
  if (
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  )
    throw new OperatingEntityContractError("ASSIGNMENT_SHAPE_INVALID");
  return Object.freeze({
    assignmentReference: parseAssignmentReference(r.assignmentReference),
    brandReference: parseBrandReference(r.brandReference),
    operatingEntityReference: parseOperatingEntityReference(r.operatingEntityReference),
    businessFunction: businessFunction(r.businessFunction),
    lifecycle: assignmentLifecycle(r.lifecycle),
    effectiveFrom,
    effectiveUntil,
    version: parseOrganizationVersion(r.version),
    createdAt,
    updatedAt,
  });
}

const assignmentBaseKeys = [
  "assignmentReference",
  "brandReference",
  "operatingEntityReference",
  "businessFunction",
  "lifecycle",
  "effectiveFrom",
  "effectiveUntil",
  "version",
  "createdAt",
  "updatedAt",
] as const;

export function createBrandOperatingEntityAssignment(
  value: unknown,
): BrandOperatingEntityAssignment {
  const r = readClosedRecord(value, assignmentBaseKeys, "ASSIGNMENT_SHAPE_INVALID");
  return createAssignmentBase(r);
}

export function createStoreOperatingEntityAssignment(
  value: unknown,
): StoreOperatingEntityAssignment {
  const r = readClosedRecord(
    value,
    [...assignmentBaseKeys, "storeReference"],
    "ASSIGNMENT_SHAPE_INVALID",
  );
  return Object.freeze({
    ...createAssignmentBase(r),
    storeReference: parseStoreReference(r.storeReference),
  });
}

export function resolveStoreOperatingEntity(
  assignments: readonly StoreOperatingEntityAssignment[],
  brandReferenceInput: unknown,
  storeReferenceInput: unknown,
  businessFunctionInput: unknown,
  effectiveAtInput: unknown,
): StoreOperatingEntityAssignment {
  const brandReference = parseBrandReference(brandReferenceInput);
  const storeReference = parseStoreReference(storeReferenceInput);
  const requiredFunction = businessFunction(businessFunctionInput);
  const effectiveAt = parseCanonicalInstant(effectiveAtInput);
  const at = Date.parse(effectiveAt);
  const matches = assignments.filter(
    (assignment) =>
      assignment.brandReference === brandReference &&
      assignment.storeReference === storeReference &&
      assignment.businessFunction === requiredFunction &&
      assignment.lifecycle === "Active" &&
      Date.parse(assignment.effectiveFrom) <= at &&
      (assignment.effectiveUntil === null || at < Date.parse(assignment.effectiveUntil)),
  );
  const match = matches[0];
  if (!match) throw new OperatingEntityContractError("ASSIGNMENT_NOT_FOUND");
  if (matches.length > 1) throw new OperatingEntityContractError("ASSIGNMENT_AMBIGUOUS");
  return match;
}
