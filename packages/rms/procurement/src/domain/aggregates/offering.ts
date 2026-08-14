import { deriveEffectiveStatus, type EffectivePeriodValue } from "@bop/effective-period";

export type OfferingReference = string & { readonly __offeringReference: unique symbol };
export type OfferingLifecycle =
  "Draft" | "Submitted" | "Approved" | "Published" | "Suspended" | "Archived";
export type PriceSource =
  "ApprovedQuote" | "Contract" | "StockSite" | "Region" | "Default" | "Manual";
export type PriceScope = "Brand" | "Region" | "StoreGroup" | "StockSite" | "Document";

export interface OfferingConfigVersion {
  readonly versionReference: OfferingReference;
  readonly version: number;
  readonly supplierItemCode: string;
  readonly supplierItemName: string;
  readonly purchaseUnit: string;
  readonly packQuantity: string;
  readonly baseUnit: string;
  readonly baseQuantity: string;
  readonly minimumOrderQuantity: string;
  readonly orderMultiple: string;
  readonly leadTimeDays: number;
  readonly orderingRestrictions: readonly string[];
  readonly createdBy: OfferingReference;
  readonly createdAt: string;
}
export interface SupplierPriceVersion {
  readonly priceVersionReference: OfferingReference;
  readonly version: number;
  readonly currency: string;
  readonly unitCost: string;
  readonly priceUnit: string;
  readonly quantityTiers: readonly {
    readonly minimumQuantity: string;
    readonly unitCost: string;
  }[];
  readonly effectivePeriod: {
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
  };
  readonly source: PriceSource;
  readonly scope: PriceScope;
  readonly scopeReference: OfferingReference;
  readonly approvalReference: OfferingReference;
  readonly createdBy: OfferingReference;
  readonly createdAt: string;
}
export interface SupplierPriceRecord {
  readonly priceRecordReference: OfferingReference;
  readonly versions: readonly SupplierPriceVersion[];
}
export interface SupplierItemOffering {
  readonly offeringReference: OfferingReference;
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly supplierReference: OfferingReference;
  readonly inventoryItemReference: OfferingReference;
  readonly lifecycle: OfferingLifecycle;
  readonly aggregateVersion: number;
  readonly configVersions: readonly OfferingConfigVersion[];
  readonly priceRecords: readonly SupplierPriceRecord[];
  readonly submittedBy: OfferingReference | null;
  readonly approvalReference: OfferingReference | null;
  readonly updatedBy: OfferingReference;
  readonly updatedAt: string;
}
export class OfferingError extends Error {
  constructor(
    readonly code: "OFFERING_INVALID" | "OFFERING_STATE_CONFLICT" | "OFFERING_SEGREGATION_REQUIRED",
  ) {
    super(code);
  }
}
const fail = (code: OfferingError["code"]): never => {
  throw new OfferingError(code);
};
const refPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
export const offeringReference = (value: unknown): OfferingReference =>
  typeof value === "string" && refPattern.test(value)
    ? (value as OfferingReference)
    : fail("OFFERING_INVALID");
const code = (value: unknown, pattern = codePattern) =>
  typeof value === "string" && pattern.test(value) ? value : fail("OFFERING_INVALID");
const text = (value: unknown) => {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 200)
    return fail("OFFERING_INVALID");
  return value;
};
export const positiveDecimal = (value: unknown) => {
  if (typeof value !== "string" || !decimalPattern.test(value) || /^0(?:\.0+)?$/u.test(value))
    return fail("OFFERING_INVALID");
  return value;
};
const utc = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return fail("OFFERING_INVALID");
  return value;
};
const base = (value: SupplierItemOffering, actor: unknown, occurredAt: unknown) =>
  Object.freeze({
    ...value,
    aggregateVersion: value.aggregateVersion + 1,
    updatedBy: offeringReference(actor),
    updatedAt: utc(occurredAt),
  });
function config(
  input: Omit<OfferingConfigVersion, "version"> & { version: number },
): OfferingConfigVersion {
  if (
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    !Number.isInteger(input.leadTimeDays) ||
    input.leadTimeDays < 0 ||
    input.leadTimeDays > 365
  )
    return fail("OFFERING_INVALID");
  if (!Array.isArray(input.orderingRestrictions) || input.orderingRestrictions.length > 20)
    return fail("OFFERING_INVALID");
  return Object.freeze({
    versionReference: offeringReference(input.versionReference),
    version: input.version,
    supplierItemCode: code(input.supplierItemCode),
    supplierItemName: text(input.supplierItemName),
    purchaseUnit: code(input.purchaseUnit),
    packQuantity: positiveDecimal(input.packQuantity),
    baseUnit: code(input.baseUnit),
    baseQuantity: positiveDecimal(input.baseQuantity),
    minimumOrderQuantity: positiveDecimal(input.minimumOrderQuantity),
    orderMultiple: positiveDecimal(input.orderMultiple),
    leadTimeDays: input.leadTimeDays,
    orderingRestrictions: Object.freeze(input.orderingRestrictions.map((x) => code(x))),
    createdBy: offeringReference(input.createdBy),
    createdAt: utc(input.createdAt),
  });
}
export function createOffering(
  input: Omit<
    SupplierItemOffering,
    | "lifecycle"
    | "aggregateVersion"
    | "configVersions"
    | "priceRecords"
    | "submittedBy"
    | "approvalReference"
    | "updatedBy"
    | "updatedAt"
  > &
    Omit<OfferingConfigVersion, "version">,
): SupplierItemOffering {
  const initial = config({ ...input, version: 1 });
  return Object.freeze({
    offeringReference: offeringReference(input.offeringReference),
    tenantReference: offeringReference(input.tenantReference),
    brandReference: offeringReference(input.brandReference),
    supplierReference: offeringReference(input.supplierReference),
    inventoryItemReference: offeringReference(input.inventoryItemReference),
    lifecycle: "Draft",
    aggregateVersion: 1,
    configVersions: Object.freeze([initial]),
    priceRecords: Object.freeze([]),
    submittedBy: null,
    approvalReference: null,
    updatedBy: initial.createdBy,
    updatedAt: initial.createdAt,
  });
}
export function appendOfferingVersion(
  value: SupplierItemOffering,
  input: Omit<OfferingConfigVersion, "version"> & { expectedVersion: number },
): SupplierItemOffering {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    !["Draft", "Approved", "Published", "Suspended"].includes(value.lifecycle)
  )
    return fail("OFFERING_STATE_CONFLICT");
  const next = config({ ...input, version: (value.configVersions.at(-1)?.version ?? 0) + 1 });
  const revised = base(value, next.createdBy, next.createdAt);
  return Object.freeze({
    ...revised,
    lifecycle: "Draft",
    configVersions: Object.freeze([...value.configVersions, next]),
    submittedBy: null,
    approvalReference: null,
  });
}
export function transitionOffering(
  value: SupplierItemOffering,
  input: {
    expectedVersion: number;
    action: "Submit" | "Approve" | "Publish" | "Suspend" | "RestoreDraft" | "Archive";
    actorReference: unknown;
    occurredAt: unknown;
    approvalReference: unknown | null;
  },
): SupplierItemOffering {
  if (value.aggregateVersion !== input.expectedVersion) return fail("OFFERING_STATE_CONFLICT");
  const allowed: Record<typeof input.action, OfferingLifecycle[]> = {
    Submit: ["Draft"],
    Approve: ["Submitted"],
    Publish: ["Approved"],
    Suspend: ["Published"],
    RestoreDraft: ["Suspended", "Archived"],
    Archive: ["Draft", "Suspended"],
  };
  if (!allowed[input.action].includes(value.lifecycle)) return fail("OFFERING_STATE_CONFLICT");
  const actor = offeringReference(input.actorReference);
  if (input.action === "Approve" && value.submittedBy === actor)
    return fail("OFFERING_SEGREGATION_REQUIRED");
  const approval =
    input.approvalReference === null ? null : offeringReference(input.approvalReference);
  if (["Approve", "Publish"].includes(input.action) && approval === null)
    return fail("OFFERING_INVALID");
  if (input.action === "Publish" && value.approvalReference !== approval)
    return fail("OFFERING_INVALID");
  const lifecycle: OfferingLifecycle = {
    Submit: "Submitted",
    Approve: "Approved",
    Publish: "Published",
    Suspend: "Suspended",
    RestoreDraft: "Draft",
    Archive: "Archived",
  }[input.action] as OfferingLifecycle;
  const changed = base(value, actor, input.occurredAt);
  return Object.freeze({
    ...changed,
    lifecycle,
    submittedBy: input.action === "Submit" ? actor : value.submittedBy,
    approvalReference:
      input.action === "Approve"
        ? approval
        : input.action === "RestoreDraft"
          ? null
          : value.approvalReference,
  });
}
function priceVersion(
  input: Omit<SupplierPriceVersion, "version"> & { version: number },
): SupplierPriceVersion {
  if (
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    !Array.isArray(input.quantityTiers) ||
    input.quantityTiers.length > 50 ||
    !["ApprovedQuote", "Contract", "StockSite", "Region", "Default", "Manual"].includes(
      input.source,
    ) ||
    !["Brand", "Region", "StoreGroup", "StockSite", "Document"].includes(input.scope)
  )
    return fail("OFFERING_INVALID");
  const period: EffectivePeriodValue = Object.freeze({
    effectiveFrom: utc(input.effectivePeriod.effectiveFrom),
    effectiveUntil:
      input.effectivePeriod.effectiveUntil === null
        ? null
        : utc(input.effectivePeriod.effectiveUntil),
  });
  if (period.effectiveUntil !== null && period.effectiveUntil <= period.effectiveFrom)
    return fail("OFFERING_INVALID");
  let previous: string | null = null;
  const tiers = input.quantityTiers.map((tier) => {
    const minimumQuantity = positiveDecimal(tier.minimumQuantity);
    if (previous !== null && compareDecimal(minimumQuantity, previous) <= 0)
      return fail("OFFERING_INVALID");
    previous = minimumQuantity;
    return Object.freeze({ minimumQuantity, unitCost: positiveDecimal(tier.unitCost) });
  });
  return Object.freeze({
    priceVersionReference: offeringReference(input.priceVersionReference),
    version: input.version,
    currency: code(input.currency, /^[A-Z]{3}$/u),
    unitCost: positiveDecimal(input.unitCost),
    priceUnit: code(input.priceUnit),
    quantityTiers: Object.freeze(tiers),
    effectivePeriod: period,
    source: input.source,
    scope: input.scope,
    scopeReference: offeringReference(input.scopeReference),
    approvalReference: offeringReference(input.approvalReference),
    createdBy: offeringReference(input.createdBy),
    createdAt: utc(input.createdAt),
  });
}
export function appendPriceVersion(
  value: SupplierItemOffering,
  input: Omit<SupplierPriceVersion, "version"> & {
    priceRecordReference: unknown;
    expectedVersion: number;
  },
): SupplierItemOffering {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    !["Draft", "Approved", "Published", "Suspended"].includes(value.lifecycle)
  )
    return fail("OFFERING_STATE_CONFLICT");
  const recordReference = offeringReference(input.priceRecordReference);
  const existing = value.priceRecords.find(
    (record) => record.priceRecordReference === recordReference,
  );
  const next = priceVersion({ ...input, version: (existing?.versions.at(-1)?.version ?? 0) + 1 });
  const records = existing
    ? value.priceRecords.map((record) =>
        record.priceRecordReference === recordReference
          ? Object.freeze({ ...record, versions: Object.freeze([...record.versions, next]) })
          : record,
      )
    : [
        ...value.priceRecords,
        Object.freeze({ priceRecordReference: recordReference, versions: Object.freeze([next]) }),
      ];
  const changed = base(value, next.createdBy, next.createdAt);
  return Object.freeze({ ...changed, priceRecords: Object.freeze(records) });
}
function decimalParts(value: string): [bigint, bigint] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
}
export function compareDecimal(left: string, right: string): number {
  const [ln, ld] = decimalParts(positiveDecimal(left));
  const [rn, rd] = decimalParts(positiveDecimal(right));
  const difference = ln * rd - rn * ld;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
const priority: Record<PriceSource, number> = {
  ApprovedQuote: 1,
  Contract: 2,
  StockSite: 3,
  Region: 4,
  Default: 5,
  Manual: 6,
};
export function resolvePrice(input: {
  offering: SupplierItemOffering;
  atUtc: string;
  currency: string;
  quantity: string;
  allowedScopes: readonly OfferingReference[];
}): {
  priceRecordReference: OfferingReference;
  priceVersionReference: OfferingReference;
  unitCost: string;
  basis: PriceSource;
} {
  const at = utc(input.atUtc);
  const currency = code(input.currency, /^[A-Z]{3}$/u);
  const quantity = positiveDecimal(input.quantity);
  const scopes = new Set(input.allowedScopes.map(offeringReference));
  const candidates = input.offering.priceRecords.flatMap((record) =>
    record.versions
      .filter((version) => {
        return (
          version.currency === currency &&
          scopes.has(version.scopeReference) &&
          deriveEffectiveStatus(version.effectivePeriod, at) === "Effective"
        );
      })
      .map((version) => ({ record, version })),
  );
  if (candidates.length === 0) return fail("OFFERING_INVALID");
  const best = Math.min(...candidates.map(({ version }) => priority[version.source]));
  const matches = candidates.filter(({ version }) => priority[version.source] === best);
  if (matches.length !== 1) return fail("OFFERING_INVALID");
  const selected = matches[0];
  if (!selected) return fail("OFFERING_INVALID");
  const tier = [...selected.version.quantityTiers]
    .reverse()
    .find((entry) => compareDecimal(quantity, entry.minimumQuantity) >= 0);
  return Object.freeze({
    priceRecordReference: selected.record.priceRecordReference,
    priceVersionReference: selected.version.priceVersionReference,
    unitCost: tier?.unitCost ?? selected.version.unitCost,
    basis: selected.version.source,
  });
}
