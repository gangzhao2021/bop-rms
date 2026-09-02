import type {
  SupplierCommand,
  SupplierCommandRecord,
  SupplierProjection,
  SupplierQuery,
} from "../contracts/supplier.js";
import {
  addQualificationVersion,
  createSupplier,
  parseSupplierInstant,
  parseSupplierReference,
  reviewQualification,
  reviseSupplierIdentity,
  SupplierError,
  transitionSupplier,
  type SupplierAggregate,
  type SupplierAddress,
  type SupplierContact,
  type SupplierReference,
} from "../domain/aggregates/supplier.js";
import type { SupplierPorts } from "./ports/supplier-ports.js";

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const supplierCodePattern = /^[A-Z0-9][A-Z0-9_-]{1,31}$/u;
const safeText = /^[^\p{Cc}\p{Cf}<>{}$]{1,160}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,200}$/u;
const emailMasked = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,190}$/u;
const phoneMasked = /^\+[0-9* -]{7,20}$/u;
const fail = (code: SupplierError["code"]): never => {
  throw new SupplierError(code);
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("SUPPLIER_INVALID");
  return value as Record<string, unknown>;
}
function ref(value: unknown) {
  try {
    return parseSupplierReference(value);
  } catch {
    return fail("SUPPLIER_INVALID");
  }
}
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
function at(value: unknown) {
  try {
    return parseSupplierInstant(value);
  } catch {
    return fail("SUPPLIER_INVALID");
  }
}
function code(value: unknown, pattern = codePattern) {
  if (typeof value !== "string" || !pattern.test(value)) return fail("SUPPLIER_INVALID");
  return value;
}
function text(value: unknown) {
  if (typeof value !== "string" || value.trim() !== value || !safeText.test(value))
    return fail("SUPPLIER_INVALID");
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("SUPPLIER_INVALID");
  return value as T;
}
function integer(value: unknown, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) return fail("SUPPLIER_INVALID");
  return value as number;
}
function nullableInteger(value: unknown) {
  return value === null ? null : integer(value);
}
function bool(value: unknown) {
  if (typeof value !== "boolean") return fail("SUPPLIER_INVALID");
  return value;
}
function contacts(value: unknown): readonly SupplierContact[] {
  if (!Array.isArray(value) || value.length > 50) return fail("SUPPLIER_INVALID");
  return Object.freeze(
    value.map((entry) => {
      const raw = exact(entry, ["contactReference", "roleCode", "displayName", "email", "phone"]);
      return Object.freeze({
        contactReference: ref(raw.contactReference),
        roleCode: code(raw.roleCode),
        displayName: text(raw.displayName),
        email: raw.email === null ? null : text(raw.email),
        phone: raw.phone === null ? null : text(raw.phone),
      });
    }),
  );
}
function addresses(value: unknown): readonly SupplierAddress[] {
  if (!Array.isArray(value) || value.length > 50) return fail("SUPPLIER_INVALID");
  return Object.freeze(
    value.map((entry) => {
      const raw = exact(entry, [
        "addressReference",
        "addressType",
        "addressSummary",
        "countryCode",
        "regionCode",
      ]);
      return Object.freeze({
        addressReference: ref(raw.addressReference),
        addressType: oneOf(raw.addressType, ["Registered", "Ordering", "Remittance", "Shipping"]),
        addressSummary: text(raw.addressSummary),
        countryCode: code(raw.countryCode, /^[A-Z]{2}$/u),
        regionCode: code(raw.regionCode, /^[A-Z0-9][A-Z0-9-]{0,15}$/u),
      });
    }),
  );
}
function query(value: unknown): SupplierQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "selectedSupplierReference",
    "search",
    "approvedContactReference",
    "status",
    "supplierType",
    "qualification",
    "performanceFlag",
    "hasOpenPurchaseOrder",
    "cursor",
  ]);
  if (
    raw.purpose !== "SupplierRead" ||
    raw.permission !== "procurement.supplier.read" ||
    (raw.search !== null &&
      (typeof raw.search !== "string" ||
        raw.search.trim() !== raw.search ||
        raw.search.length > 100 ||
        (raw.search.length > 0 && !safeText.test(raw.search)))) ||
    (raw.cursor !== null && (typeof raw.cursor !== "string" || !cursorPattern.test(raw.cursor))) ||
    (raw.hasOpenPurchaseOrder !== null && typeof raw.hasOpenPurchaseOrder !== "boolean")
  )
    return fail("SUPPLIER_INVALID");
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "SupplierRead",
    permission: "procurement.supplier.read",
    selectedSupplierReference: nullableRef(raw.selectedSupplierReference),
    search: raw.search as string | null,
    approvedContactReference: nullableRef(raw.approvedContactReference),
    status: oneOf(raw.status, ["All", "Draft", "Active", "Suspended", "Inactive", "Archived"]),
    supplierType: raw.supplierType === null ? null : code(raw.supplierType),
    qualification: oneOf(raw.qualification, ["All", "Current", "Expiring", "Expired", "Missing"]),
    performanceFlag: oneOf(raw.performanceFlag, ["All", "Flagged", "Clear"]),
    hasOpenPurchaseOrder: raw.hasOpenPurchaseOrder as boolean | null,
    cursor: raw.cursor as string | null,
  });
}

function validateProjection(
  value: SupplierProjection,
  input: SupplierQuery,
  access: {
    mayViewContactFields?: boolean;
    mayViewQualificationEvidence?: boolean;
    mayViewPurchaseOrderReferences?: boolean;
    mayViewPerformance?: boolean;
    mayManageSupplier?: boolean;
  },
) {
  if (
    value.projectionName !== "procurement_supplier_v1" ||
    value.projectionVersion !== 1 ||
    value.tenantReference !== input.tenantReference ||
    value.brandReference !== input.brandReference ||
    !["Current", "Stale", "Rebuilding"].includes(value.freshness) ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.rows) ||
    value.rows.length > 200 ||
    (value.nextCursor !== null && !cursorPattern.test(value.nextCursor)) ||
    (input.selectedSupplierReference === null) !== (value.detail === null)
  )
    return fail("SUPPLIER_INVALID");
  at(value.asOfUtc);
  const seen = new Set<string>();
  for (const row of value.rows) {
    const supplierReference = ref(row.supplierReference);
    if (seen.has(supplierReference)) return fail("SUPPLIER_INVALID");
    seen.add(supplierReference);
    integer(row.supplierVersion, 1);
    code(row.supplierCode, supplierCodePattern);
    text(row.legalName);
    text(row.displayName);
    code(row.supplierType);
    oneOf(row.status, ["Draft", "Active", "Suspended", "Inactive", "Archived"]);
    oneOf(row.qualificationStatus, ["Current", "Expiring", "Expired", "Missing"]);
    if (row.nextQualificationExpiry !== null) at(row.nextQualificationExpiry);
    nullableInteger(row.offeringCount);
    nullableInteger(row.openPurchaseOrderCount);
    if (
      (!access.mayViewPerformance &&
        (row.performanceSummary !== null || row.performanceFlag !== null)) ||
      (row.performanceSummary === null) !== (row.performanceFlag === null) ||
      (row.performanceSummary !== null && !safeText.test(row.performanceSummary))
    )
      return fail("SUPPLIER_INVALID");
  }
  if (!value.detail) return;
  const detail = value.detail;
  if (
    detail.supplierReference !== input.selectedSupplierReference ||
    !seen.has(detail.supplierReference) ||
    detail.contacts.length > 50 ||
    detail.addresses.length > 50 ||
    detail.qualifications.length > 100 ||
    integer(detail.historyCount) < 0
  )
    return fail("SUPPLIER_INVALID");
  nullableRef(detail.taxRegistrationReference);
  nullableRef(detail.auditReference);
  if (
    (!access.mayViewContactFields && detail.taxRegistrationReference !== null) ||
    (!access.mayManageSupplier && detail.auditReference !== null)
  )
    return fail("SUPPLIER_INVALID");
  for (const contact of detail.contacts) {
    ref(contact.contactReference);
    code(contact.roleCode);
    if (
      !access.mayViewContactFields &&
      (contact.displayName !== null || contact.email !== null || contact.phone !== null)
    )
      return fail("SUPPLIER_INVALID");
    if (contact.displayName !== null) text(contact.displayName);
    if (contact.email !== null && !emailMasked.test(contact.email)) return fail("SUPPLIER_INVALID");
    if (contact.phone !== null && !phoneMasked.test(contact.phone)) return fail("SUPPLIER_INVALID");
  }
  for (const address of detail.addresses) {
    ref(address.addressReference);
    oneOf(address.addressType, ["Registered", "Ordering", "Remittance", "Shipping"]);
    code(address.countryCode, /^[A-Z]{2}$/u);
    code(address.regionCode, /^[A-Z0-9][A-Z0-9-]{0,15}$/u);
    if (!access.mayViewContactFields && address.addressSummary !== null)
      return fail("SUPPLIER_INVALID");
    if (address.addressSummary !== null) text(address.addressSummary);
  }
  for (const qualification of detail.qualifications) {
    ref(qualification.qualificationReference);
    ref(qualification.qualificationVersionReference);
    code(qualification.qualificationType);
    code(qualification.jurisdiction);
    at(qualification.effectivePeriod.effectiveFrom);
    if (qualification.effectivePeriod.effectiveUntil !== null)
      at(qualification.effectivePeriod.effectiveUntil);
    oneOf(qualification.status, ["Pending", "Rejected", "Scheduled", "Effective", "Expired"]);
    ref(qualification.scopeReference);
    if (
      !access.mayViewQualificationEvidence &&
      (qualification.certificateNumber !== null ||
        qualification.issuer !== null ||
        qualification.documentReference !== null)
    )
      return fail("SUPPLIER_INVALID");
    if (qualification.certificateNumber !== null) text(qualification.certificateNumber);
    if (qualification.issuer !== null) text(qualification.issuer);
    nullableRef(qualification.documentReference);
  }
  if (!access.mayViewPurchaseOrderReferences && detail.openPurchaseOrderReferences !== null)
    return fail("SUPPLIER_INVALID");
  detail.offeringReferences?.forEach(ref);
  detail.openPurchaseOrderReferences?.forEach(ref);
  if (!access.mayViewPerformance && detail.performanceReference !== null)
    return fail("SUPPLIER_INVALID");
  nullableRef(detail.performanceReference);
}

export async function querySuppliers(value: unknown, ports: SupplierPorts) {
  const input = query(value);
  let access;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action: input.selectedSupplierReference === null ? "List" : "Detail",
    });
  } catch {
    return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  }
  if (!access?.authorized) return fail("SUPPLIER_PERMISSION_DENIED");
  if (input.approvedContactReference !== null && !access.mayViewContactFields)
    return fail("SUPPLIER_PERMISSION_DENIED");
  if (input.performanceFlag !== "All" && !access.mayViewPerformance)
    return fail("SUPPLIER_PERMISSION_DENIED");
  try {
    const projection = await ports.projection.query(input);
    validateProjection(projection, input, access);
    return projection;
  } catch (error) {
    if (error instanceof SupplierError) throw error;
    return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  }
}

const baseFields = [
  "tenantReference",
  "brandReference",
  "actorReference",
  "purpose",
  "permission",
  "operationReference",
  "occurredAt",
  "action",
  "payload",
] as const;
function command(value: unknown): SupplierCommand {
  const raw = exact(value, baseFields);
  const action = oneOf(raw.action, [
    "Create",
    "Update",
    "Activate",
    "Suspend",
    "Deactivate",
    "Archive",
    "RestoreToInactive",
    "AddQualificationVersion",
    "ReviewQualification",
  ]);
  const expectedPermission =
    action === "ReviewQualification"
      ? "procurement.qualification.review"
      : "procurement.supplier.manage";
  if (raw.purpose !== "SupplierManagement" || raw.permission !== expectedPermission)
    return fail("SUPPLIER_INVALID");
  let payload: Record<string, unknown>;
  if (action === "Create")
    payload = exact(raw.payload, [
      "supplierCode",
      "legalName",
      "displayName",
      "supplierType",
      "taxRegistrationReference",
      "contacts",
      "addresses",
    ]);
  else if (action === "Update")
    payload = exact(raw.payload, [
      "supplierReference",
      "expectedVersion",
      "legalName",
      "displayName",
      "supplierType",
      "taxRegistrationReference",
      "contacts",
      "addresses",
      "reasonCode",
    ]);
  else if (["Activate", "Suspend", "Deactivate", "Archive", "RestoreToInactive"].includes(action))
    payload = exact(raw.payload, [
      "supplierReference",
      "expectedVersion",
      "reasonCode",
      "approvalReference",
    ]);
  else if (action === "AddQualificationVersion")
    payload = exact(raw.payload, [
      "supplierReference",
      "expectedVersion",
      "qualificationReference",
      "qualificationVersionReference",
      "qualificationType",
      "jurisdiction",
      "certificateNumber",
      "issuer",
      "effectiveFrom",
      "effectiveUntil",
      "documentReference",
      "scopeKind",
      "scopeReference",
      "reasonCode",
    ]);
  else
    payload = exact(raw.payload, [
      "supplierReference",
      "expectedVersion",
      "qualificationReference",
      "qualificationVersionReference",
      "decision",
      "reasonCode",
    ]);
  const parsed: Record<string, unknown> =
    action === "Create"
      ? {
          supplierCode: code(payload.supplierCode, supplierCodePattern),
          legalName: text(payload.legalName),
          displayName: text(payload.displayName),
          supplierType: code(payload.supplierType),
          taxRegistrationReference: nullableRef(payload.taxRegistrationReference),
          contacts: contacts(payload.contacts),
          addresses: addresses(payload.addresses),
        }
      : {
          supplierReference: ref(payload.supplierReference),
          expectedVersion: integer(payload.expectedVersion, 1),
          reasonCode: code(payload.reasonCode),
          ...(action === "Update"
            ? {
                legalName: text(payload.legalName),
                displayName: text(payload.displayName),
                supplierType: code(payload.supplierType),
                taxRegistrationReference: nullableRef(payload.taxRegistrationReference),
                contacts: contacts(payload.contacts),
                addresses: addresses(payload.addresses),
              }
            : {}),
          ...(["Activate", "Suspend", "Deactivate", "Archive", "RestoreToInactive"].includes(action)
            ? { approvalReference: nullableRef(payload.approvalReference) }
            : {}),
          ...(action === "AddQualificationVersion"
            ? {
                qualificationReference: ref(payload.qualificationReference),
                qualificationVersionReference: ref(payload.qualificationVersionReference),
                qualificationType: code(payload.qualificationType),
                jurisdiction: code(payload.jurisdiction),
                certificateNumber: text(payload.certificateNumber),
                issuer: text(payload.issuer),
                effectivePeriod: Object.freeze({
                  effectiveFrom: at(payload.effectiveFrom),
                  effectiveUntil:
                    payload.effectiveUntil === null ? null : at(payload.effectiveUntil),
                }),
                documentReference: ref(payload.documentReference),
                scopeKind: oneOf(payload.scopeKind, ["Supplier", "Offering", "ItemCategory"]),
                scopeReference: ref(payload.scopeReference),
              }
            : {}),
          ...(action === "ReviewQualification"
            ? {
                qualificationReference: ref(payload.qualificationReference),
                qualificationVersionReference: ref(payload.qualificationVersionReference),
                decision: oneOf(payload.decision, ["Approved", "Rejected"]),
              }
            : {}),
        };
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "SupplierManagement",
    permission: expectedPermission,
    operationReference: ref(raw.operationReference),
    occurredAt: at(raw.occurredAt),
    action,
    payload: Object.freeze(parsed),
  });
}

interface ExistingPayload {
  supplierReference: SupplierReference;
  expectedVersion: number;
  reasonCode: string;
  [key: string]: unknown;
}
function sameOwnership(
  value: SupplierAggregate,
  command: SupplierCommand,
  supplierReference: SupplierReference,
) {
  return (
    value.supplierReference === supplierReference &&
    value.tenantReference === command.tenantReference &&
    value.brandReference === command.brandReference
  );
}
function validateImpact(value: unknown, command: SupplierCommand, before: SupplierAggregate) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "supplierReference",
    "supplierVersion",
    "offeringCount",
    "openPurchaseOrderCount",
    "historicalPurchaseOrdersMutated",
  ]);
  if (
    raw.tenantReference !== command.tenantReference ||
    raw.brandReference !== command.brandReference ||
    raw.supplierReference !== before.supplierReference ||
    integer(raw.supplierVersion, 1) !== before.aggregateVersion ||
    bool(raw.historicalPurchaseOrdersMutated) ||
    integer(raw.offeringCount) < 0 ||
    integer(raw.openPurchaseOrderCount) < 0
  )
    return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({
    offeringCount: raw.offeringCount as number,
    openPurchaseOrderCount: raw.openPurchaseOrderCount as number,
    historicalPurchaseOrdersMutated: false as const,
  });
}
function validateEligibility(value: unknown, command: SupplierCommand, before: SupplierAggregate) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "supplierReference",
    "supplierVersion",
    "eligible",
    "blockingQualificationReferences",
    "approvalReference",
    "approvedAt",
  ]);
  if (
    raw.tenantReference !== command.tenantReference ||
    raw.brandReference !== command.brandReference ||
    raw.supplierReference !== before.supplierReference ||
    integer(raw.supplierVersion, 1) !== before.aggregateVersion ||
    typeof raw.eligible !== "boolean" ||
    !Array.isArray(raw.blockingQualificationReferences) ||
    raw.blockingQualificationReferences.length > 100 ||
    nullableRef(raw.approvalReference) !== (command.payload as ExistingPayload).approvalReference
  )
    return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  const approvedAt = at(raw.approvedAt);
  if (approvedAt > command.occurredAt) return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  raw.blockingQualificationReferences.forEach(ref);
  if (!raw.eligible || raw.blockingQualificationReferences.length > 0)
    return fail("SUPPLIER_QUALIFICATION_BLOCKED");
}
const intent = (value: SupplierCommand) => JSON.stringify(value);
export async function executeSupplier(value: unknown, ports: SupplierPorts) {
  const input = command(value);
  let access;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action: input.action,
    });
  } catch {
    return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  }
  if (
    !access?.authorized ||
    (input.action === "ReviewQualification"
      ? !access.mayReviewQualification
      : !access.mayManageSupplier)
  )
    return fail("SUPPLIER_PERMISSION_DENIED");
  try {
    const hash = ports.references.hashIntent(intent(input));
    const replay = await ports.repository.resolveOperation(input.operationReference);
    if (replay) {
      if (
        !ports.references.equals(replay.intentHash, hash) ||
        intent(replay.command) !== intent(input) ||
        replay.operationReference !== input.operationReference ||
        replay.action !== input.action ||
        replay.supplier.tenantReference !== input.tenantReference ||
        replay.supplier.brandReference !== input.brandReference ||
        !["Applied", "AlreadyApplied"].includes(replay.outcome)
      )
        return fail("SUPPLIER_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
    }
    let before: SupplierAggregate | null = null;
    let after: SupplierAggregate;
    let impact: SupplierCommandRecord["impact"] = null;
    if (input.action === "Create") {
      const payload = input.payload as {
        supplierCode: string;
        legalName: string;
        displayName: string;
        supplierType: string;
        taxRegistrationReference: SupplierReference | null;
        contacts: readonly SupplierContact[];
        addresses: readonly SupplierAddress[];
      };
      if (
        !(await ports.repository.isCodeAvailable({
          brandReference: input.brandReference,
          supplierCode: payload.supplierCode,
          excludingSupplierReference: null,
        }))
      )
        return fail("SUPPLIER_CONFLICT");
      after = createSupplier({
        supplierReference: ports.references.generate("Supplier"),
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        ...payload,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
    } else {
      const payload = input.payload as ExistingPayload;
      before = await ports.repository.load({
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        supplierReference: payload.supplierReference,
      });
      if (!before || !sameOwnership(before, input, payload.supplierReference))
        return fail("SUPPLIER_NOT_FOUND");
      if (before.aggregateVersion !== payload.expectedVersion) return fail("SUPPLIER_CONFLICT");
      const allowedStatus: Partial<
        Record<SupplierCommand["action"], readonly SupplierAggregate["status"][]>
      > = {
        Activate: ["Draft", "Suspended", "Inactive"],
        Suspend: ["Active"],
        Deactivate: ["Active", "Suspended"],
        Archive: ["Inactive"],
        RestoreToInactive: ["Archived"],
      };
      const allowed = allowedStatus[input.action];
      if (allowed && !allowed.includes(before.status)) return fail("SUPPLIER_STATE_CONFLICT");
      if (["Suspend", "Deactivate", "Archive", "RestoreToInactive"].includes(input.action))
        impact = validateImpact(
          await ports.impact.inspect({ command: input, supplier: before }),
          input,
          before,
        );
      if (input.action === "Activate")
        validateEligibility(
          await ports.qualificationPolicy.evaluateActivation({ command: input, supplier: before }),
          input,
          before,
        );
      if (input.action === "Update") {
        const p = payload as ExistingPayload & {
          legalName: string;
          displayName: string;
          supplierType: string;
          taxRegistrationReference: SupplierReference | null;
          contacts: readonly SupplierContact[];
          addresses: readonly SupplierAddress[];
        };
        after = reviseSupplierIdentity(before, {
          ...p,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      } else if (
        ["Activate", "Suspend", "Deactivate", "Archive", "RestoreToInactive"].includes(input.action)
      )
        after = transitionSupplier(before, {
          expectedVersion: payload.expectedVersion,
          action: input.action as
            "Activate" | "Suspend" | "Deactivate" | "Archive" | "RestoreToInactive",
          reasonCode: payload.reasonCode,
          approvalReference: payload.approvalReference,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      else if (input.action === "AddQualificationVersion") {
        const p = payload as ExistingPayload & {
          qualificationReference: SupplierReference;
          qualificationVersionReference: SupplierReference;
          qualificationType: string;
          jurisdiction: string;
          certificateNumber: string;
          issuer: string;
          effectivePeriod: { effectiveFrom: string; effectiveUntil: string | null };
          documentReference: SupplierReference;
          scopeKind: "Supplier" | "Offering" | "ItemCategory";
          scopeReference: SupplierReference;
        };
        after = addQualificationVersion(before, {
          expectedVersion: p.expectedVersion,
          qualificationReference: p.qualificationReference,
          qualificationVersionReference: p.qualificationVersionReference,
          qualificationType: p.qualificationType,
          jurisdiction: p.jurisdiction,
          certificateNumber: p.certificateNumber,
          issuer: p.issuer,
          effectivePeriod: p.effectivePeriod,
          documentReference: p.documentReference,
          scopeKind: p.scopeKind,
          scopeReference: p.scopeReference,
          reasonCode: p.reasonCode,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      } else {
        const p = payload as ExistingPayload & {
          qualificationReference: SupplierReference;
          qualificationVersionReference: SupplierReference;
          decision: "Approved" | "Rejected";
        };
        after = reviewQualification(before, {
          expectedVersion: p.expectedVersion,
          qualificationReference: p.qualificationReference,
          qualificationVersionReference: p.qualificationVersionReference,
          decision: p.decision,
          reasonCode: p.reasonCode,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      }
    }
    const audit = await ports.audit.create({ command: input, before, after });
    const record: SupplierCommandRecord = Object.freeze({
      operationReference: input.operationReference,
      intentHash: hash,
      action: input.action,
      command: input,
      supplier: after,
      audit,
      impact,
      outcome: "Applied",
    });
    const committed = await ports.repository.commit(record);
    if (
      committed.operationReference !== input.operationReference ||
      committed.intentHash !== hash ||
      committed.action !== input.action ||
      !sameOwnership(committed.supplier, input, after.supplierReference) ||
      committed.supplier.aggregateVersion !== after.aggregateVersion ||
      committed.supplier.status !== after.status ||
      committed.impact !== impact
    )
      return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
    return committed;
  } catch (error) {
    if (error instanceof SupplierError) throw error;
    return fail("SUPPLIER_DEPENDENCY_UNAVAILABLE");
  }
}
