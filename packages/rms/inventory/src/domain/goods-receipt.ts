import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryDecimal,
  type InventoryInstant,
  type InventoryReference,
} from "./inventory-item.js";

export type GoodsReceiptStatus = "Draft" | "Posted" | "Voided";
export type OverReceiptPolicy = "Block" | "ManagerOverride" | "AllowWithinTolerance";
export interface GoodsReceiptLine {
  readonly receiptLineReference: InventoryReference;
  readonly purchaseOrderLineReference: InventoryReference;
  readonly inventoryItemReference: InventoryReference;
  readonly offeringReference: InventoryReference;
  readonly offeringVersionReference: InventoryReference;
  readonly priceVersionReference: InventoryReference;
  readonly lotReference: InventoryReference | null;
  readonly lotCode: string | null;
  readonly expiryDate: string | null;
  readonly locationReference: InventoryReference;
  readonly deliveredQuantity: InventoryDecimal;
  readonly acceptedQuantity: InventoryDecimal;
  readonly rejectedQuantity: InventoryDecimal;
  readonly damagedQuantity: InventoryDecimal;
  readonly purchaseUnit: string;
  readonly baseUnit: string;
  readonly conversionMultiplier: InventoryDecimal;
  readonly orderedQuantity: InventoryDecimal;
  readonly priorAcceptedQuantity: InventoryDecimal;
  readonly overReceiptPolicy: OverReceiptPolicy;
  readonly toleranceQuantity: InventoryDecimal;
  readonly managerOverrideApprovalReference: InventoryReference | null;
  readonly overrideReasonCode: string | null;
  readonly qualityDisposition: "Accepted" | "Quarantined" | "Rejected";
  readonly temperatureReading: string | null;
  readonly temperatureUnit: "C" | "F" | null;
  readonly evidenceReferences: readonly InventoryReference[];
  readonly discrepancyRequired: boolean;
}
export interface GoodsReceiptCorrection {
  readonly correctionReference: InventoryReference;
  readonly correctionType: "Adjustment" | "Void";
  readonly eventReference: InventoryReference;
  readonly reasonCode: string;
  readonly lines: readonly GoodsReceiptCorrectionLine[];
  readonly compensatingMovementReferences: readonly InventoryReference[];
  readonly correctedBy: InventoryReference;
  readonly correctedAt: InventoryInstant;
}
export interface GoodsReceiptCorrectionLine {
  readonly receiptLineReference: InventoryReference;
  readonly purchaseOrderLineReference: InventoryReference;
  readonly acceptedQuantityDelta: string;
  readonly rejectedQuantityDelta: string;
  readonly damagedQuantityDelta: string;
  readonly unit: string;
}
export interface GoodsReceipt {
  readonly goodsReceiptReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly supplierReference: InventoryReference;
  readonly purchaseOrderReference: InventoryReference;
  readonly purchaseOrderVersion: number;
  readonly purchaseOrderRevisionNumber: number;
  readonly issuedSnapshotReference: InventoryReference;
  readonly receivedAt: InventoryInstant;
  readonly status: GoodsReceiptStatus;
  readonly aggregateVersion: number;
  readonly lines: readonly GoodsReceiptLine[];
  readonly postedEventReference: InventoryReference | null;
  readonly stockMovementReferences: readonly InventoryReference[];
  readonly corrections: readonly GoodsReceiptCorrection[];
  readonly decisions: readonly {
    readonly action: string;
    readonly reasonCode: string | null;
    readonly actorReference: InventoryReference;
    readonly occurredAt: InventoryInstant;
  }[];
  readonly updatedBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
}
export class GoodsReceiptError extends Error {
  constructor(
    readonly code:
      | "GOODS_RECEIPT_INVALID"
      | "GOODS_RECEIPT_STATE_CONFLICT"
      | "GOODS_RECEIPT_TOLERANCE_BLOCKED"
      | "GOODS_RECEIPT_OVERRIDE_REQUIRED"
      | "GOODS_RECEIPT_MOVEMENT_MISMATCH",
  ) {
    super(code);
  }
}
const fail = (code: GoodsReceiptError["code"]): never => {
  throw new GoodsReceiptError(code);
};
const ref = (value: unknown) => {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("GOODS_RECEIPT_INVALID");
    throw error;
  }
};
const instant = (value: unknown) => {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("GOODS_RECEIPT_INVALID");
    throw error;
  }
};
const decimal = (value: unknown) => {
  try {
    return parseInventoryDecimal(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("GOODS_RECEIPT_INVALID");
    throw error;
  }
};
const code = (value: unknown, pattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u) =>
  typeof value === "string" && pattern.test(value) ? value : fail("GOODS_RECEIPT_INVALID");
interface Fixed {
  readonly numerator: bigint;
  readonly scale: number;
}
function fixed(value: InventoryDecimal): Fixed {
  const [whole, fraction = ""] = value.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
const pow = (scale: number) => 10n ** BigInt(scale);
function sum(values: readonly InventoryDecimal[]) {
  const parts = values.map(fixed);
  const scale = Math.max(0, ...parts.map((entry) => entry.scale));
  return {
    numerator: parts.reduce(
      (total, entry) => total + entry.numerator * pow(scale - entry.scale),
      0n,
    ),
    scale,
  };
}
function compare(left: Fixed, right: Fixed) {
  const scale = Math.max(left.scale, right.scale);
  const result =
    left.numerator * pow(scale - left.scale) - right.numerator * pow(scale - right.scale);
  return result < 0n ? -1 : result > 0n ? 1 : 0;
}
function add(left: InventoryDecimal, right: InventoryDecimal) {
  return sum([left, right]);
}
const date = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
    ? value
    : fail("GOODS_RECEIPT_INVALID");
const signedDecimal = (value: unknown) =>
  typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)
    ? value
    : fail("GOODS_RECEIPT_INVALID");
function receiptLine(input: GoodsReceiptLine): GoodsReceiptLine {
  if (
    !["Block", "ManagerOverride", "AllowWithinTolerance"].includes(input.overReceiptPolicy) ||
    !["Accepted", "Quarantined", "Rejected"].includes(input.qualityDisposition)
  )
    return fail("GOODS_RECEIPT_INVALID");
  const delivered = decimal(input.deliveredQuantity);
  const accepted = decimal(input.acceptedQuantity);
  const rejected = decimal(input.rejectedQuantity);
  const damaged = decimal(input.damagedQuantity);
  if (
    compare(sum([accepted, rejected, damaged]), fixed(delivered)) !== 0 ||
    fixed(delivered).numerator === 0n
  )
    return fail("GOODS_RECEIPT_INVALID");
  const ordered = decimal(input.orderedQuantity);
  const prior = decimal(input.priorAcceptedQuantity);
  const tolerance = decimal(input.toleranceQuantity);
  const multiplier = decimal(input.conversionMultiplier);
  if (fixed(ordered).numerator === 0n || fixed(multiplier).numerator === 0n)
    return fail("GOODS_RECEIPT_INVALID");
  const acceptedCumulative = add(prior, accepted);
  const orderedFixed = fixed(ordered);
  const allowed = sum([ordered, tolerance]);
  const isOver = compare(acceptedCumulative, orderedFixed) > 0;
  if (isOver && input.overReceiptPolicy === "Block") return fail("GOODS_RECEIPT_TOLERANCE_BLOCKED");
  if (
    isOver &&
    input.overReceiptPolicy === "AllowWithinTolerance" &&
    compare(acceptedCumulative, allowed) > 0
  )
    return fail("GOODS_RECEIPT_TOLERANCE_BLOCKED");
  const approval =
    input.managerOverrideApprovalReference === null
      ? null
      : ref(input.managerOverrideApprovalReference);
  const reason = input.overrideReasonCode === null ? null : code(input.overrideReasonCode);
  if (
    isOver &&
    input.overReceiptPolicy === "ManagerOverride" &&
    (approval === null || reason === null)
  )
    return fail("GOODS_RECEIPT_OVERRIDE_REQUIRED");
  if (
    (!isOver || input.overReceiptPolicy !== "ManagerOverride") &&
    (approval !== null || reason !== null)
  )
    return fail("GOODS_RECEIPT_INVALID");
  if (!Array.isArray(input.evidenceReferences) || input.evidenceReferences.length > 20)
    return fail("GOODS_RECEIPT_INVALID");
  const evidence = Object.freeze(input.evidenceReferences.map(ref));
  if (new Set(evidence).size !== evidence.length) return fail("GOODS_RECEIPT_INVALID");
  const lotReference = input.lotReference === null ? null : ref(input.lotReference);
  const lotCode =
    input.lotCode === null ? null : code(input.lotCode, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  const expiryDate = input.expiryDate === null ? null : date(input.expiryDate);
  if (
    (lotReference === null) !== (lotCode === null) ||
    (expiryDate !== null && lotReference === null)
  )
    return fail("GOODS_RECEIPT_INVALID");
  const temperatureReading =
    input.temperatureReading === null ? null : signedDecimal(input.temperatureReading);
  if (
    (temperatureReading === null) !== (input.temperatureUnit === null) ||
    (input.temperatureUnit !== null && !["C", "F"].includes(input.temperatureUnit))
  )
    return fail("GOODS_RECEIPT_INVALID");
  const discrepancyRequired =
    isOver ||
    fixed(rejected).numerator > 0n ||
    fixed(damaged).numerator > 0n ||
    compare(acceptedCumulative, orderedFixed) < 0 ||
    input.qualityDisposition !== "Accepted";
  return Object.freeze({
    receiptLineReference: ref(input.receiptLineReference),
    purchaseOrderLineReference: ref(input.purchaseOrderLineReference),
    inventoryItemReference: ref(input.inventoryItemReference),
    offeringReference: ref(input.offeringReference),
    offeringVersionReference: ref(input.offeringVersionReference),
    priceVersionReference: ref(input.priceVersionReference),
    lotReference,
    lotCode,
    expiryDate,
    locationReference: ref(input.locationReference),
    deliveredQuantity: delivered,
    acceptedQuantity: accepted,
    rejectedQuantity: rejected,
    damagedQuantity: damaged,
    purchaseUnit: code(input.purchaseUnit),
    baseUnit: code(input.baseUnit),
    conversionMultiplier: multiplier,
    orderedQuantity: ordered,
    priorAcceptedQuantity: prior,
    overReceiptPolicy: input.overReceiptPolicy,
    toleranceQuantity: tolerance,
    managerOverrideApprovalReference: approval,
    overrideReasonCode: reason,
    qualityDisposition: input.qualityDisposition,
    temperatureReading,
    temperatureUnit: input.temperatureUnit,
    evidenceReferences: evidence,
    discrepancyRequired,
  });
}
export function createValidatedGoodsReceipt(
  input: Omit<
    GoodsReceipt,
    | "status"
    | "aggregateVersion"
    | "postedEventReference"
    | "stockMovementReferences"
    | "corrections"
    | "decisions"
    | "updatedBy"
    | "updatedAt"
    | "lines"
  > & { lines: readonly GoodsReceiptLine[]; actorReference: unknown; occurredAt: unknown },
): GoodsReceipt {
  if (
    !Number.isSafeInteger(input.purchaseOrderVersion) ||
    input.purchaseOrderVersion < 1 ||
    !Number.isSafeInteger(input.purchaseOrderRevisionNumber) ||
    input.purchaseOrderRevisionNumber < 1 ||
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > 500
  )
    return fail("GOODS_RECEIPT_INVALID");
  const lines = Object.freeze(input.lines.map(receiptLine));
  if (
    new Set(lines.map((entry) => entry.receiptLineReference)).size !== lines.length ||
    new Set(lines.map((entry) => entry.purchaseOrderLineReference)).size !== lines.length
  )
    return fail("GOODS_RECEIPT_INVALID");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const receivedAt = instant(input.receivedAt);
  if (receivedAt > occurredAt) return fail("GOODS_RECEIPT_INVALID");
  return Object.freeze({
    goodsReceiptReference: ref(input.goodsReceiptReference),
    tenantReference: ref(input.tenantReference),
    brandReference: ref(input.brandReference),
    stockSiteReference: ref(input.stockSiteReference),
    supplierReference: ref(input.supplierReference),
    purchaseOrderReference: ref(input.purchaseOrderReference),
    purchaseOrderVersion: input.purchaseOrderVersion,
    purchaseOrderRevisionNumber: input.purchaseOrderRevisionNumber,
    issuedSnapshotReference: ref(input.issuedSnapshotReference),
    receivedAt,
    status: "Draft",
    aggregateVersion: 1,
    lines,
    postedEventReference: null,
    stockMovementReferences: Object.freeze([]),
    corrections: Object.freeze([]),
    decisions: Object.freeze([
      { action: "Validated", reasonCode: null, actorReference: actor, occurredAt },
    ]),
    updatedBy: actor,
    updatedAt: occurredAt,
  });
}
export function markGoodsReceiptPosted(
  value: GoodsReceipt,
  input: {
    expectedVersion: number;
    postedEventReference: unknown;
    stockMovementReferences: readonly unknown[];
    actorReference: unknown;
    occurredAt: unknown;
  },
): GoodsReceipt {
  if (value.aggregateVersion !== input.expectedVersion || value.status !== "Draft")
    return fail("GOODS_RECEIPT_STATE_CONFLICT");
  const acceptedLines = value.lines.filter((entry) => fixed(entry.acceptedQuantity).numerator > 0n);
  if (
    !Array.isArray(input.stockMovementReferences) ||
    input.stockMovementReferences.length !== acceptedLines.length
  )
    return fail("GOODS_RECEIPT_MOVEMENT_MISMATCH");
  const movements = Object.freeze(input.stockMovementReferences.map(ref));
  if (new Set(movements).size !== movements.length) return fail("GOODS_RECEIPT_MOVEMENT_MISMATCH");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  return Object.freeze({
    ...value,
    status: "Posted",
    aggregateVersion: value.aggregateVersion + 1,
    postedEventReference: ref(input.postedEventReference),
    stockMovementReferences: movements,
    decisions: Object.freeze([
      ...value.decisions,
      Object.freeze({ action: "Posted", reasonCode: null, actorReference: actor, occurredAt }),
    ]),
    updatedBy: actor,
    updatedAt: occurredAt,
  });
}
export function appendGoodsReceiptCorrection(
  value: GoodsReceipt,
  input: {
    expectedVersion: number;
    correctionReference: unknown;
    correctionType: "Adjustment" | "Void";
    eventReference: unknown;
    reasonCode: unknown;
    lines: readonly GoodsReceiptCorrectionLine[];
    compensatingMovementReferences: readonly unknown[];
    actorReference: unknown;
    occurredAt: unknown;
  },
): GoodsReceipt {
  if (value.aggregateVersion !== input.expectedVersion || value.status !== "Posted")
    return fail("GOODS_RECEIPT_STATE_CONFLICT");
  if (
    !Array.isArray(input.compensatingMovementReferences) ||
    input.compensatingMovementReferences.length < 1 ||
    input.compensatingMovementReferences.length > 500
  )
    return fail("GOODS_RECEIPT_INVALID");
  if (
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > value.lines.length
  )
    return fail("GOODS_RECEIPT_INVALID");
  const correctionLines = Object.freeze(
    input.lines.map((entry) => {
      const receiptLineReference = ref(entry.receiptLineReference);
      const source = value.lines.find((line) => line.receiptLineReference === receiptLineReference);
      if (
        !source ||
        source.purchaseOrderLineReference !== entry.purchaseOrderLineReference ||
        source.purchaseUnit !== entry.unit
      )
        return fail("GOODS_RECEIPT_INVALID");
      const acceptedQuantityDelta = signedDecimal(entry.acceptedQuantityDelta);
      const rejectedQuantityDelta = signedDecimal(entry.rejectedQuantityDelta);
      const damagedQuantityDelta = signedDecimal(entry.damagedQuantityDelta);
      if (
        [acceptedQuantityDelta, rejectedQuantityDelta, damagedQuantityDelta].every((entry) =>
          /^-?0(?:\.0+)?$/u.test(entry),
        )
      )
        return fail("GOODS_RECEIPT_INVALID");
      return Object.freeze({
        receiptLineReference,
        purchaseOrderLineReference: ref(entry.purchaseOrderLineReference),
        acceptedQuantityDelta,
        rejectedQuantityDelta,
        damagedQuantityDelta,
        unit: code(entry.unit),
      });
    }),
  );
  if (
    new Set(correctionLines.map((entry) => entry.receiptLineReference)).size !==
    correctionLines.length
  )
    return fail("GOODS_RECEIPT_INVALID");
  const movements = Object.freeze(input.compensatingMovementReferences.map(ref));
  if (new Set(movements).size !== movements.length) return fail("GOODS_RECEIPT_INVALID");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const correction = Object.freeze({
    correctionReference: ref(input.correctionReference),
    correctionType: input.correctionType,
    eventReference: ref(input.eventReference),
    reasonCode: code(input.reasonCode),
    lines: correctionLines,
    compensatingMovementReferences: movements,
    correctedBy: actor,
    correctedAt: occurredAt,
  });
  if (
    value.corrections.some(
      (entry) =>
        entry.correctionReference === correction.correctionReference ||
        entry.eventReference === correction.eventReference,
    )
  )
    return fail("GOODS_RECEIPT_INVALID");
  return Object.freeze({
    ...value,
    status: input.correctionType === "Void" ? "Voided" : "Posted",
    aggregateVersion: value.aggregateVersion + 1,
    corrections: Object.freeze([...value.corrections, correction]),
    decisions: Object.freeze([
      ...value.decisions,
      Object.freeze({
        action: input.correctionType,
        reasonCode: correction.reasonCode,
        actorReference: actor,
        occurredAt,
      }),
    ]),
    updatedBy: actor,
    updatedAt: occurredAt,
  });
}
