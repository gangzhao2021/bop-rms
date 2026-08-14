import type {
  OfferingCommand,
  OfferingCommandRecord,
  OfferingProjection,
  OfferingQuery,
} from "../contracts/offering.js";
import {
  appendOfferingVersion,
  appendPriceVersion,
  createOffering,
  OfferingError,
  offeringReference,
  positiveDecimal,
  transitionOffering,
  type PriceScope,
  type PriceSource,
  type SupplierItemOffering,
} from "../domain/aggregates/offering.js";
import type { OfferingPorts } from "./ports/offering-ports.js";

export class OfferingServiceError extends Error {
  constructor(
    readonly code:
      | "OFFERING_INVALID"
      | "OFFERING_PERMISSION_DENIED"
      | "OFFERING_NOT_FOUND"
      | "OFFERING_CONFLICT"
      | "OFFERING_STATE_CONFLICT"
      | "OFFERING_PUBLICATION_BLOCKED"
      | "OFFERING_IDEMPOTENCY_CONFLICT"
      | "OFFERING_DEPENDENCY_UNAVAILABLE",
  ) {
    super(code);
  }
}
const fail = (code: OfferingServiceError["code"]): never => {
  throw new OfferingServiceError(code);
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,256}$/u;
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail("OFFERING_INVALID");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in raw))
  )
    return fail("OFFERING_INVALID");
  return raw;
}
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("OFFERING_INVALID");
  }
};
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const code = (value: unknown, pattern = codePattern) =>
  typeof value === "string" && pattern.test(value) ? value : fail("OFFERING_INVALID");
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fail("OFFERING_INVALID");
const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max
    ? value
    : fail("OFFERING_INVALID");
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : fail("OFFERING_INVALID");
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail("OFFERING_INVALID"));
const at = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("OFFERING_INVALID");
function configPayload(raw: Record<string, unknown>) {
  if (!Array.isArray(raw.orderingRestrictions) || raw.orderingRestrictions.length > 20)
    return fail("OFFERING_INVALID");
  return Object.freeze({
    supplierItemCode: code(raw.supplierItemCode),
    supplierItemName: text(raw.supplierItemName),
    purchaseUnit: code(raw.purchaseUnit),
    packQuantity: positiveDecimal(raw.packQuantity),
    baseUnit: code(raw.baseUnit),
    baseQuantity: positiveDecimal(raw.baseQuantity),
    minimumOrderQuantity: positiveDecimal(raw.minimumOrderQuantity),
    orderMultiple: positiveDecimal(raw.orderMultiple),
    leadTimeDays: integer(raw.leadTimeDays, 0, 365),
    orderingRestrictions: Object.freeze(raw.orderingRestrictions.map((entry) => code(entry))),
  });
}
function query(value: unknown): OfferingQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "selectedOfferingReference",
    "search",
    "supplierReference",
    "inventoryItemReference",
    "status",
    "currency",
    "storeCoverageReference",
    "expiringPrice",
    "qualificationIssue",
    "cursor",
  ]);
  if (raw.purpose !== "OfferingRead" || raw.permission !== "procurement.offering.read")
    return fail("OFFERING_INVALID");
  const search =
    raw.search === null ? null : code(raw.search, /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u);
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "OfferingRead",
    permission: "procurement.offering.read",
    selectedOfferingReference: nullableRef(raw.selectedOfferingReference),
    search,
    supplierReference: nullableRef(raw.supplierReference),
    inventoryItemReference: nullableRef(raw.inventoryItemReference),
    status: oneOf(raw.status, [
      "All",
      "Draft",
      "Submitted",
      "Approved",
      "Published",
      "Suspended",
      "Archived",
    ]),
    currency: raw.currency === null ? null : code(raw.currency, /^[A-Z]{3}$/u),
    storeCoverageReference: nullableRef(raw.storeCoverageReference),
    expiringPrice: raw.expiringPrice === null ? null : bool(raw.expiringPrice),
    qualificationIssue: raw.qualificationIssue === null ? null : bool(raw.qualificationIssue),
    cursor: raw.cursor === null ? null : code(raw.cursor, cursorPattern),
  });
}
function validateProjection(
  value: OfferingProjection,
  input: OfferingQuery,
  access: Awaited<ReturnType<OfferingPorts["authorization"]["authorize"]>>,
) {
  if (
    value.projectionName !== "procurement_offering_v1" ||
    !Number.isSafeInteger(value.projectionVersion) ||
    value.projectionVersion < 1 ||
    at(value.asOfUtc) !== value.asOfUtc ||
    value.tenantReference !== input.tenantReference ||
    value.brandReference !== input.brandReference ||
    value.items.length > 100 ||
    value.permissions.mayManage !== access.mayManage ||
    value.permissions.mayApprove !== access.mayApprove ||
    value.permissions.mayPublish !== access.mayPublish ||
    value.permissions.mayViewCost !== access.mayViewCost ||
    value.permissions.mayViewQualification !== access.mayViewQualification ||
    value.permissions.mayViewHistory !== access.mayViewHistory
  )
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
  for (const item of value.items) {
    ref(item.offeringReference);
    ref(item.supplierReference);
    ref(item.inventoryItemReference);
    ref(item.sourceReference);
    code(item.supplierItemCode);
    code(item.purchaseUnit);
    integer(item.leadTimeDays, 0, 365);
    positiveDecimal(item.minimumOrderQuantity);
    positiveDecimal(item.orderMultiple);
    if (!access.mayViewCost && (item.currentUnitCost !== null || item.currency !== null))
      return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
    if (item.currentUnitCost !== null) positiveDecimal(item.currentUnitCost);
    if (item.currency !== null) code(item.currency, /^[A-Z]{3}$/u);
  }
  if (value.detail) {
    if (
      !input.selectedOfferingReference ||
      value.detail.offeringReference !== input.selectedOfferingReference ||
      !Number.isSafeInteger(value.detail.offeringVersion) ||
      value.detail.offeringVersion < 1 ||
      value.detail.sourceReference !== input.selectedOfferingReference
    )
      return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
    if (!access.mayViewQualification && value.detail.qualificationReferences !== null)
      return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
    if (!access.mayViewHistory && value.detail.historyReferences !== null)
      return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
    for (const record of value.detail.priceRecords)
      for (const version of record.versions) {
        if (
          !access.mayViewCost &&
          (version.currency !== null || version.unitCost !== null || version.quantityTiers !== null)
        )
          return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
        if (version.unitCost !== null) positiveDecimal(version.unitCost);
        if (version.currency !== null) code(version.currency, /^[A-Z]{3}$/u);
        version.quantityTiers?.forEach((tier) => {
          positiveDecimal(tier.minimumQuantity);
          positiveDecimal(tier.unitCost);
        });
      }
  }
}
export async function queryOfferings(value: unknown, ports: OfferingPorts) {
  const input = query(value);
  let access;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action: "Query",
    });
  } catch {
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
  }
  if (!access?.authorized) return fail("OFFERING_PERMISSION_DENIED");
  try {
    const result = await ports.projection.query(input);
    validateProjection(result, input, access);
    return result;
  } catch (error) {
    if (error instanceof OfferingServiceError) throw error;
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
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
function command(value: unknown): OfferingCommand {
  const raw = exact(value, baseFields);
  const action = oneOf(raw.action, [
    "Create",
    "ReviseConfig",
    "AddPriceVersion",
    "Submit",
    "Approve",
    "Publish",
    "Suspend",
    "RestoreDraft",
    "Archive",
  ]);
  if (raw.purpose !== "OfferingManagement") return fail("OFFERING_INVALID");
  const permission =
    action === "Approve"
      ? "procurement.offering.approve"
      : action === "Publish"
        ? "procurement.offering.publish"
        : "procurement.offering.manage";
  if (raw.permission !== permission) return fail("OFFERING_INVALID");
  let payload: Record<string, unknown>;
  const configFields = [
    "supplierItemCode",
    "supplierItemName",
    "purchaseUnit",
    "packQuantity",
    "baseUnit",
    "baseQuantity",
    "minimumOrderQuantity",
    "orderMultiple",
    "leadTimeDays",
    "orderingRestrictions",
  ];
  if (action === "Create")
    payload = exact(raw.payload, [
      "supplierReference",
      "inventoryItemReference",
      "versionReference",
      ...configFields,
    ]);
  else if (action === "ReviseConfig")
    payload = exact(raw.payload, [
      "offeringReference",
      "expectedVersion",
      "versionReference",
      ...configFields,
      "reasonCode",
    ]);
  else if (action === "AddPriceVersion")
    payload = exact(raw.payload, [
      "offeringReference",
      "expectedVersion",
      "priceRecordReference",
      "priceVersionReference",
      "currency",
      "unitCost",
      "priceUnit",
      "quantityTiers",
      "effectiveFrom",
      "effectiveUntil",
      "source",
      "scope",
      "scopeReference",
      "approvalReference",
      "reasonCode",
    ]);
  else
    payload = exact(raw.payload, [
      "offeringReference",
      "expectedVersion",
      "approvalReference",
      "reasonCode",
    ]);
  const parsed: Record<string, unknown> =
    action === "Create"
      ? {
          supplierReference: ref(payload.supplierReference),
          inventoryItemReference: ref(payload.inventoryItemReference),
          versionReference: ref(payload.versionReference),
          ...configPayload(payload),
        }
      : {
          offeringReference: ref(payload.offeringReference),
          expectedVersion: integer(payload.expectedVersion, 1),
          reasonCode: code(payload.reasonCode),
          ...(action === "ReviseConfig"
            ? { versionReference: ref(payload.versionReference), ...configPayload(payload) }
            : {}),
          ...(action === "AddPriceVersion" ? parsePrice(payload) : {}),
          ...(!["ReviseConfig", "AddPriceVersion"].includes(action)
            ? { approvalReference: nullableRef(payload.approvalReference) }
            : {}),
        };
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "OfferingManagement",
    permission,
    operationReference: ref(raw.operationReference),
    occurredAt: at(raw.occurredAt),
    action,
    payload: Object.freeze(parsed),
  });
}
function parsePrice(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.quantityTiers) || payload.quantityTiers.length > 50)
    return fail("OFFERING_INVALID");
  const quantityTiers = payload.quantityTiers.map((entry) => {
    const raw = exact(entry, ["minimumQuantity", "unitCost"]);
    return Object.freeze({
      minimumQuantity: positiveDecimal(raw.minimumQuantity),
      unitCost: positiveDecimal(raw.unitCost),
    });
  });
  return {
    priceRecordReference: ref(payload.priceRecordReference),
    priceVersionReference: ref(payload.priceVersionReference),
    currency: code(payload.currency, /^[A-Z]{3}$/u),
    unitCost: positiveDecimal(payload.unitCost),
    priceUnit: code(payload.priceUnit),
    quantityTiers: Object.freeze(quantityTiers),
    effectivePeriod: Object.freeze({
      effectiveFrom: at(payload.effectiveFrom),
      effectiveUntil: payload.effectiveUntil === null ? null : at(payload.effectiveUntil),
    }),
    source: oneOf(payload.source, [
      "ApprovedQuote",
      "Contract",
      "StockSite",
      "Region",
      "Default",
      "Manual",
    ]) as PriceSource,
    scope: oneOf(payload.scope, [
      "Brand",
      "Region",
      "StoreGroup",
      "StockSite",
      "Document",
    ]) as PriceScope,
    scopeReference: ref(payload.scopeReference),
    approvalReference: ref(payload.approvalReference),
  };
}
function validatePublication(
  value: Awaited<ReturnType<OfferingPorts["publicationPolicy"]["validate"]>>,
  input: OfferingCommand,
  before: SupplierItemOffering,
) {
  const expectedApproval = input.payload.approvalReference;
  if (
    value.tenantReference !== input.tenantReference ||
    value.brandReference !== input.brandReference ||
    value.offeringReference !== before.offeringReference ||
    value.offeringVersion !== before.aggregateVersion ||
    value.supplierReference !== before.supplierReference ||
    value.inventoryItemReference !== before.inventoryItemReference ||
    value.baseUnit !== before.configVersions.at(-1)?.baseUnit ||
    value.approvalReference !== expectedApproval ||
    at(value.approvedAt) > input.occurredAt ||
    !Array.isArray(value.blockers) ||
    value.blockers.length > 100
  )
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
  value.blockers.forEach((entry) => code(entry));
  if (
    !value.supplierActive ||
    !value.itemPurchasable ||
    !value.conversionValid ||
    !value.qualificationEligible ||
    !value.approvedPriceAvailable ||
    value.blockers.length
  )
    return fail("OFFERING_PUBLICATION_BLOCKED");
}
function validatePriceApproval(
  value: Awaited<ReturnType<OfferingPorts["priceApproval"]["validate"]>>,
  input: OfferingCommand,
  before: SupplierItemOffering,
) {
  if (
    value.tenantReference !== input.tenantReference ||
    value.brandReference !== input.brandReference ||
    value.offeringReference !== before.offeringReference ||
    value.offeringVersion !== before.aggregateVersion ||
    value.priceRecordReference !== input.payload.priceRecordReference ||
    value.priceVersionReference !== input.payload.priceVersionReference ||
    value.approvalReference !== input.payload.approvalReference ||
    at(value.approvedAt) > input.occurredAt
  )
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
  if (!value.approved) return fail("OFFERING_PUBLICATION_BLOCKED");
}
const intent = (value: OfferingCommand) => JSON.stringify(value);
type CreatePayload = Omit<
  Parameters<typeof createOffering>[0],
  "offeringReference" | "tenantReference" | "brandReference" | "createdBy" | "createdAt"
>;
interface ExistingPayload {
  readonly offeringReference: SupplierItemOffering["offeringReference"];
  readonly expectedVersion: number;
  readonly approvalReference?: SupplierItemOffering["approvalReference"];
}
export async function executeOffering(value: unknown, ports: OfferingPorts) {
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
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
  }
  const permitted =
    input.action === "Approve"
      ? access?.mayApprove
      : input.action === "Publish"
        ? access?.mayPublish
        : access?.mayManage;
  if (!access?.authorized || !permitted) return fail("OFFERING_PERMISSION_DENIED");
  try {
    const hash = ports.references.hashIntent(intent(input));
    const replay = await ports.repository.resolveOperation(input.operationReference);
    if (replay) {
      if (
        !ports.references.equals(replay.intentHash, hash) ||
        intent(replay.command) !== intent(input) ||
        replay.operationReference !== input.operationReference ||
        replay.action !== input.action ||
        replay.offering.tenantReference !== input.tenantReference ||
        replay.offering.brandReference !== input.brandReference ||
        !["Applied", "AlreadyApplied"].includes(replay.outcome)
      )
        return fail("OFFERING_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
    }
    let before: SupplierItemOffering | null = null;
    let after: SupplierItemOffering;
    let impact: OfferingCommandRecord["impact"] = null;
    if (input.action === "Create") {
      const p = input.payload as unknown as CreatePayload;
      if (
        !(await ports.repository.identityAvailable({
          brandReference: input.brandReference,
          supplierReference: p.supplierReference,
          inventoryItemReference: p.inventoryItemReference,
          supplierItemCode: p.supplierItemCode,
          excludingOfferingReference: null,
        }))
      )
        return fail("OFFERING_CONFLICT");
      after = createOffering({
        offeringReference: ports.references.generate("Offering"),
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        ...p,
        createdBy: input.actorReference,
        createdAt: input.occurredAt,
      });
    } else {
      const p = input.payload as unknown as ExistingPayload;
      before = await ports.repository.load({
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        offeringReference: p.offeringReference,
      });
      if (
        !before ||
        before.offeringReference !== p.offeringReference ||
        before.tenantReference !== input.tenantReference ||
        before.brandReference !== input.brandReference
      )
        return fail("OFFERING_NOT_FOUND");
      if (before.aggregateVersion !== p.expectedVersion) return fail("OFFERING_CONFLICT");
      const expected: Partial<
        Record<OfferingCommand["action"], SupplierItemOffering["lifecycle"][]>
      > = {
        ReviseConfig: ["Draft", "Approved", "Published", "Suspended"],
        AddPriceVersion: ["Draft", "Approved", "Published", "Suspended"],
        Submit: ["Draft"],
        Approve: ["Submitted"],
        Publish: ["Approved"],
        Suspend: ["Published"],
        RestoreDraft: ["Suspended", "Archived"],
        Archive: ["Draft", "Suspended"],
      };
      const allowed = expected[input.action];
      if (allowed && !allowed.includes(before.lifecycle)) return fail("OFFERING_STATE_CONFLICT");
      if (["Suspend", "Archive"].includes(input.action)) {
        const result = await ports.impact.inspect({ command: input, offering: before });
        if (
          result.tenantReference !== input.tenantReference ||
          result.brandReference !== input.brandReference ||
          result.offeringReference !== before.offeringReference ||
          result.offeringVersion !== before.aggregateVersion ||
          bool(result.historicalPurchaseOrdersMutated) ||
          integer(result.openPurchaseOrderCount) < 0
        )
          return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
        impact = Object.freeze({
          openPurchaseOrderCount: result.openPurchaseOrderCount,
          historicalPurchaseOrdersMutated: false,
        });
      }
      if (input.action === "Publish")
        validatePublication(
          await ports.publicationPolicy.validate({ command: input, offering: before }),
          input,
          before,
        );
      if (input.action === "AddPriceVersion")
        validatePriceApproval(
          await ports.priceApproval.validate({ command: input, offering: before }),
          input,
          before,
        );
      try {
        if (input.action === "ReviseConfig") {
          const revision = input.payload as unknown as Omit<
            Parameters<typeof appendOfferingVersion>[1],
            "createdBy" | "createdAt"
          >;
          after = appendOfferingVersion(before, {
            ...revision,
            createdBy: input.actorReference,
            createdAt: input.occurredAt,
          });
        } else if (input.action === "AddPriceVersion") {
          const price = input.payload as unknown as Omit<
            Parameters<typeof appendPriceVersion>[1],
            "createdBy" | "createdAt"
          >;
          after = appendPriceVersion(before, {
            ...price,
            createdBy: input.actorReference,
            createdAt: input.occurredAt,
          });
        } else
          after = transitionOffering(before, {
            expectedVersion: p.expectedVersion,
            action: input.action as
              "Submit" | "Approve" | "Publish" | "Suspend" | "RestoreDraft" | "Archive",
            actorReference: input.actorReference,
            occurredAt: input.occurredAt,
            approvalReference: p.approvalReference,
          });
      } catch (error) {
        if (error instanceof OfferingError)
          return fail(
            error.code === "OFFERING_SEGREGATION_REQUIRED"
              ? "OFFERING_PERMISSION_DENIED"
              : error.code,
          );
        throw error;
      }
    }
    const audit = await ports.audit.create({ command: input, before, after });
    const record: OfferingCommandRecord = Object.freeze({
      operationReference: input.operationReference,
      intentHash: hash,
      action: input.action,
      command: input,
      offering: after,
      audit,
      impact,
      outcome: "Applied",
    });
    const committed = await ports.repository.commit(record);
    if (
      committed.operationReference !== input.operationReference ||
      committed.intentHash !== hash ||
      committed.action !== input.action ||
      committed.offering.tenantReference !== input.tenantReference ||
      committed.offering.brandReference !== input.brandReference ||
      committed.offering.offeringReference !== after.offeringReference ||
      committed.offering.aggregateVersion !== after.aggregateVersion ||
      committed.offering.lifecycle !== after.lifecycle ||
      committed.impact !== impact
    )
      return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
    return committed;
  } catch (error) {
    if (error instanceof OfferingServiceError) throw error;
    return fail("OFFERING_DEPENDENCY_UNAVAILABLE");
  }
}
