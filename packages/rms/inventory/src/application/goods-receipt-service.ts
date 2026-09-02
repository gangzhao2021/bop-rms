import type {
  GoodsReceiptCommand,
  GoodsReceiptCommandRecord,
  GoodsReceiptProjection,
  GoodsReceiptQuery,
} from "../contracts/goods-receipt.js";
import {
  appendGoodsReceiptCorrection,
  createValidatedGoodsReceipt,
  GoodsReceiptError,
  markGoodsReceiptPosted,
  type GoodsReceiptCorrectionLine,
  type GoodsReceiptLine,
} from "../domain/goods-receipt.js";
import {
  InventoryItemError,
  parseInventoryInstant,
  parseInventoryReference,
} from "../domain/inventory-item.js";
import type { GoodsReceiptPorts } from "./ports/goods-receipt-ports.js";

const fail = (code: GoodsReceiptError["code"]): never => {
  throw new GoodsReceiptError(code);
};
const exact = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("GOODS_RECEIPT_INVALID");
  return value as Record<string, unknown>;
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
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fail("GOODS_RECEIPT_INVALID");
const version = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : fail("GOODS_RECEIPT_INVALID");
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(value)
    ? value
    : fail("GOODS_RECEIPT_INVALID");
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const nullableString = (value: unknown) =>
  value === null ? null : typeof value === "string" ? value : fail("GOODS_RECEIPT_INVALID");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
const stable = (value: unknown): string => JSON.stringify(canonical(value));

function parseCommand(value: unknown): GoodsReceiptCommand {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "action",
    "payload",
  ]);
  if (raw.purpose !== "GoodsReceiptManagement" || raw.permission !== "inventory.receive")
    return fail("GOODS_RECEIPT_INVALID");
  const action = oneOf(raw.action, ["Post", "Adjust", "Void"]);
  const fields =
    action === "Post"
      ? [
          "goodsReceiptReference",
          "purchaseOrderReference",
          "purchaseOrderVersion",
          "purchaseOrderRevisionNumber",
          "issuedSnapshotReference",
          "supplierReference",
          "receivedAt",
          "eventReference",
          "lines",
        ]
      : [
          "goodsReceiptReference",
          "expectedVersion",
          "correctionReference",
          "eventReference",
          "reasonCode",
          "lines",
        ];
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "GoodsReceiptManagement",
    permission: "inventory.receive",
    operationReference: ref(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: Object.freeze(exact(raw.payload, fields)),
  });
}

function parseLine(value: unknown): GoodsReceiptLine {
  const raw = exact(value, [
    "receiptLineReference",
    "purchaseOrderLineReference",
    "inventoryItemReference",
    "offeringReference",
    "offeringVersionReference",
    "priceVersionReference",
    "lotReference",
    "lotCode",
    "expiryDate",
    "locationReference",
    "deliveredQuantity",
    "acceptedQuantity",
    "rejectedQuantity",
    "damagedQuantity",
    "purchaseUnit",
    "baseUnit",
    "conversionMultiplier",
    "orderedQuantity",
    "priorAcceptedQuantity",
    "overReceiptPolicy",
    "toleranceQuantity",
    "managerOverrideApprovalReference",
    "overrideReasonCode",
    "qualityDisposition",
    "temperatureReading",
    "temperatureUnit",
    "evidenceReferences",
    "discrepancyRequired",
  ]);
  if (!Array.isArray(raw.evidenceReferences) || typeof raw.discrepancyRequired !== "boolean")
    return fail("GOODS_RECEIPT_INVALID");
  return {
    receiptLineReference: ref(raw.receiptLineReference),
    purchaseOrderLineReference: ref(raw.purchaseOrderLineReference),
    inventoryItemReference: ref(raw.inventoryItemReference),
    offeringReference: ref(raw.offeringReference),
    offeringVersionReference: ref(raw.offeringVersionReference),
    priceVersionReference: ref(raw.priceVersionReference),
    lotReference: nullableRef(raw.lotReference),
    lotCode: nullableString(raw.lotCode),
    expiryDate: nullableString(raw.expiryDate),
    locationReference: ref(raw.locationReference),
    deliveredQuantity: raw.deliveredQuantity as GoodsReceiptLine["deliveredQuantity"],
    acceptedQuantity: raw.acceptedQuantity as GoodsReceiptLine["acceptedQuantity"],
    rejectedQuantity: raw.rejectedQuantity as GoodsReceiptLine["rejectedQuantity"],
    damagedQuantity: raw.damagedQuantity as GoodsReceiptLine["damagedQuantity"],
    purchaseUnit: raw.purchaseUnit as string,
    baseUnit: raw.baseUnit as string,
    conversionMultiplier: raw.conversionMultiplier as GoodsReceiptLine["conversionMultiplier"],
    orderedQuantity: raw.orderedQuantity as GoodsReceiptLine["orderedQuantity"],
    priorAcceptedQuantity: raw.priorAcceptedQuantity as GoodsReceiptLine["priorAcceptedQuantity"],
    overReceiptPolicy: raw.overReceiptPolicy as GoodsReceiptLine["overReceiptPolicy"],
    toleranceQuantity: raw.toleranceQuantity as GoodsReceiptLine["toleranceQuantity"],
    managerOverrideApprovalReference: nullableRef(raw.managerOverrideApprovalReference),
    overrideReasonCode: nullableString(raw.overrideReasonCode),
    qualityDisposition: raw.qualityDisposition as GoodsReceiptLine["qualityDisposition"],
    temperatureReading: nullableString(raw.temperatureReading),
    temperatureUnit: raw.temperatureUnit as GoodsReceiptLine["temperatureUnit"],
    evidenceReferences: Object.freeze(raw.evidenceReferences.map(ref)),
    discrepancyRequired: raw.discrepancyRequired,
  };
}

function parseCorrectionLine(value: unknown): GoodsReceiptCorrectionLine {
  const raw = exact(value, [
    "receiptLineReference",
    "purchaseOrderLineReference",
    "acceptedQuantityDelta",
    "rejectedQuantityDelta",
    "damagedQuantityDelta",
    "unit",
  ]);
  return Object.freeze({
    receiptLineReference: ref(raw.receiptLineReference),
    purchaseOrderLineReference: ref(raw.purchaseOrderLineReference),
    acceptedQuantityDelta: raw.acceptedQuantityDelta as string,
    rejectedQuantityDelta: raw.rejectedQuantityDelta as string,
    damagedQuantityDelta: raw.damagedQuantityDelta as string,
    unit: raw.unit as string,
  });
}

function validateReceivingSnapshot(
  value: unknown,
  command: GoodsReceiptCommand,
): GoodsReceiptLine[] {
  const payload = command.payload;
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "supplierReference",
    "purchaseOrderReference",
    "purchaseOrderVersion",
    "purchaseOrderRevisionNumber",
    "issuedSnapshotReference",
    "workflow",
    "closure",
    "lines",
  ]);
  if (
    raw.tenantReference !== command.tenantReference ||
    raw.brandReference !== command.brandReference ||
    raw.stockSiteReference !== command.stockSiteReference ||
    raw.supplierReference !== payload.supplierReference ||
    raw.purchaseOrderReference !== payload.purchaseOrderReference ||
    raw.purchaseOrderVersion !== payload.purchaseOrderVersion ||
    raw.purchaseOrderRevisionNumber !== payload.purchaseOrderRevisionNumber ||
    raw.issuedSnapshotReference !== payload.issuedSnapshotReference ||
    !["Issued", "Acknowledged"].includes(String(raw.workflow)) ||
    raw.closure !== "Open" ||
    !Array.isArray(raw.lines) ||
    !Array.isArray(payload.lines) ||
    raw.lines.length !== payload.lines.length
  )
    return fail("GOODS_RECEIPT_INVALID");
  const lines = payload.lines.map(parseLine);
  const authoritativeFields = [
    "purchaseOrderLineReference",
    "inventoryItemReference",
    "offeringReference",
    "offeringVersionReference",
    "priceVersionReference",
    "purchaseUnit",
    "baseUnit",
    "conversionMultiplier",
    "orderedQuantity",
    "priorAcceptedQuantity",
    "overReceiptPolicy",
    "toleranceQuantity",
  ] as const;
  for (const line of lines) {
    const owner = raw.lines.find(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).purchaseOrderLineReference ===
          line.purchaseOrderLineReference,
    );
    if (!owner) return fail("GOODS_RECEIPT_INVALID");
    const source = exact(owner, [...authoritativeFields]);
    for (const field of authoritativeFields)
      if (source[field] !== line[field]) return fail("GOODS_RECEIPT_INVALID");
  }
  return lines;
}

async function replay(command: GoodsReceiptCommand, ports: GoodsReceiptPorts) {
  const record = await ports.repository.resolveOperation(command.operationReference);
  if (!record) return null;
  const intentHash = ports.references.hashIntent(stable(command));
  if (
    !ports.references.equals(record.intentHash, intentHash) ||
    record.command.tenantReference !== command.tenantReference ||
    record.command.brandReference !== command.brandReference ||
    record.command.stockSiteReference !== command.stockSiteReference ||
    record.command.actorReference !== command.actorReference
  )
    return fail("GOODS_RECEIPT_INVALID");
  return Object.freeze({ ...record, outcome: "AlreadyApplied" as const });
}

export async function executeGoodsReceipt(
  value: unknown,
  ports: GoodsReceiptPorts,
): Promise<GoodsReceiptCommandRecord> {
  const command = parseCommand(value);
  let access;
  try {
    access = await ports.authorization.authorize(command);
  } catch {
    return fail("GOODS_RECEIPT_INVALID");
  }
  if (!access?.authorized) return fail("GOODS_RECEIPT_INVALID");
  const prior = await replay(command, ports);
  if (prior) return prior;
  const intentHash = ports.references.hashIntent(stable(command));
  if (command.action === "Post") {
    const payload = command.payload;
    const lines = validateReceivingSnapshot(
      await ports.procurement.receivingSnapshot(command),
      command,
    );
    for (const line of lines) {
      if (line.managerOverrideApprovalReference) {
        const decision = exact(
          await ports.approvals.validate(line.managerOverrideApprovalReference, command),
          [
            "approvalReference",
            "tenantReference",
            "brandReference",
            "stockSiteReference",
            "purchaseOrderLineReference",
            "decision",
            "approvedBy",
            "approvedAt",
            "reasonCode",
          ],
        );
        if (
          decision.approvalReference !== line.managerOverrideApprovalReference ||
          decision.tenantReference !== command.tenantReference ||
          decision.brandReference !== command.brandReference ||
          decision.stockSiteReference !== command.stockSiteReference ||
          decision.purchaseOrderLineReference !== line.purchaseOrderLineReference ||
          decision.decision !== "Approved" ||
          decision.approvedBy === command.actorReference ||
          decision.reasonCode !== line.overrideReasonCode
        )
          return fail("GOODS_RECEIPT_OVERRIDE_REQUIRED");
        ref(decision.approvedBy);
        instant(decision.approvedAt);
      }
      const evidence = exact(await ports.evidence.validate(line.evidenceReferences, command), [
        "references",
        "tenantReference",
        "brandReference",
        "stockSiteReference",
      ]);
      if (
        evidence.tenantReference !== command.tenantReference ||
        evidence.brandReference !== command.brandReference ||
        evidence.stockSiteReference !== command.stockSiteReference ||
        !Array.isArray(evidence.references) ||
        stable(evidence.references) !== stable(line.evidenceReferences)
      )
        return fail("GOODS_RECEIPT_INVALID");
    }
    const draft = createValidatedGoodsReceipt({
      goodsReceiptReference: ref(payload.goodsReceiptReference),
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      stockSiteReference: command.stockSiteReference,
      supplierReference: ref(payload.supplierReference),
      purchaseOrderReference: ref(payload.purchaseOrderReference),
      purchaseOrderVersion: version(payload.purchaseOrderVersion, 1),
      purchaseOrderRevisionNumber: version(payload.purchaseOrderRevisionNumber, 1),
      issuedSnapshotReference: ref(payload.issuedSnapshotReference),
      receivedAt: instant(payload.receivedAt),
      lines,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    });
    const mappings = await ports.ledger.preparePost({ receipt: draft, lines, command });
    const accepted = lines.filter((line) => !/^0(?:\.0+)?$/u.test(line.acceptedQuantity));
    if (
      !Array.isArray(mappings) ||
      mappings.length !== accepted.length ||
      mappings.some(
        (mapping, index) => mapping.receiptLineReference !== accepted[index]?.receiptLineReference,
      )
    )
      return fail("GOODS_RECEIPT_MOVEMENT_MISMATCH");
    const receipt = markGoodsReceiptPosted(draft, {
      expectedVersion: 1,
      postedEventReference: ref(payload.eventReference),
      stockMovementReferences: mappings.map((entry) => entry.movementReference),
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    });
    const movementByLine = new Map(
      mappings.map((entry) => [entry.receiptLineReference, entry.movementReference]),
    );
    const event = Object.freeze({
      eventName: "GoodsReceiptPosted" as const,
      eventVersion: 1 as const,
      eventReference: ref(payload.eventReference),
      tenantReference: receipt.tenantReference,
      brandReference: receipt.brandReference,
      stockSiteReference: receipt.stockSiteReference,
      supplierReference: receipt.supplierReference,
      purchaseOrderReference: receipt.purchaseOrderReference,
      issuedSnapshotReference: receipt.issuedSnapshotReference,
      goodsReceiptReference: receipt.goodsReceiptReference,
      receivedAt: receipt.receivedAt,
      lines: Object.freeze(
        receipt.lines.map((line) =>
          Object.freeze({
            receiptLineReference: line.receiptLineReference,
            purchaseOrderLineReference: line.purchaseOrderLineReference,
            inventoryItemReference: line.inventoryItemReference,
            acceptedQuantity: line.acceptedQuantity,
            rejectedQuantity: line.rejectedQuantity,
            damagedQuantity: line.damagedQuantity,
            unit: line.purchaseUnit,
            stockMovementReference: movementByLine.get(line.receiptLineReference) ?? null,
            discrepancyRequired: line.discrepancyRequired,
          }),
        ),
      ),
    });
    const audit = await ports.audit.create({ command, before: null, after: receipt });
    return ports.repository.commit(
      Object.freeze({
        operationReference: command.operationReference,
        intentHash,
        action: command.action,
        command,
        receipt,
        event,
        audit,
        outcome: "Applied",
      }),
    );
  }
  const payload = command.payload;
  const before = await ports.repository.load({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    stockSiteReference: command.stockSiteReference,
    goodsReceiptReference: ref(payload.goodsReceiptReference),
  });
  if (
    !before ||
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference ||
    before.stockSiteReference !== command.stockSiteReference
  )
    return fail("GOODS_RECEIPT_INVALID");
  const correctionType = command.action === "Void" ? "Void" : "Adjustment";
  const correctionReference = ref(payload.correctionReference);
  const reasonCode = code(payload.reasonCode);
  const expectedVersion = version(payload.expectedVersion, 1);
  if (before.aggregateVersion !== expectedVersion || before.status !== "Posted")
    return fail("GOODS_RECEIPT_STATE_CONFLICT");
  if (!Array.isArray(payload.lines)) return fail("GOODS_RECEIPT_INVALID");
  const lines = payload.lines.map(parseCorrectionLine);
  const movements = await ports.ledger.prepareCorrection({
    receipt: before,
    command,
    correctionType,
    correctionReference,
    reasonCode,
    lines,
  });
  const receipt = appendGoodsReceiptCorrection(before, {
    expectedVersion,
    correctionReference,
    correctionType,
    eventReference: ref(payload.eventReference),
    reasonCode,
    lines,
    compensatingMovementReferences: movements,
    actorReference: command.actorReference,
    occurredAt: command.occurredAt,
  });
  const correction = receipt.corrections.at(-1);
  if (!correction) return fail("GOODS_RECEIPT_INVALID");
  const event = Object.freeze({
    eventName:
      correction.correctionType === "Void"
        ? ("GoodsReceiptVoided" as const)
        : ("GoodsReceiptAdjusted" as const),
    eventVersion: 1 as const,
    eventReference: correction.eventReference,
    tenantReference: receipt.tenantReference,
    brandReference: receipt.brandReference,
    stockSiteReference: receipt.stockSiteReference,
    purchaseOrderReference: receipt.purchaseOrderReference,
    goodsReceiptReference: receipt.goodsReceiptReference,
    correctionReference: correction.correctionReference,
    reasonCode: correction.reasonCode,
    lines: correction.lines,
    compensatingMovementReferences: correction.compensatingMovementReferences,
    occurredAt: correction.correctedAt,
  });
  const audit = await ports.audit.create({ command, before, after: receipt });
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      action: command.action,
      command,
      receipt,
      event,
      audit,
      outcome: "Applied",
    }),
  );
}

export async function queryGoodsReceipt(
  value: unknown,
  ports: GoodsReceiptPorts,
): Promise<GoodsReceiptProjection> {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "actorReference",
    "purpose",
    "permission",
    "search",
    "supplierReference",
    "purchaseOrderReference",
    "itemReference",
    "barcode",
  ]);
  if (raw.purpose !== "GoodsReceiptRead" || raw.permission !== "inventory.receive")
    return fail("GOODS_RECEIPT_INVALID");
  const query: GoodsReceiptQuery = Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "GoodsReceiptRead",
    permission: "inventory.receive",
    search: nullableString(raw.search),
    supplierReference: nullableRef(raw.supplierReference),
    purchaseOrderReference: nullableRef(raw.purchaseOrderReference),
    itemReference: nullableRef(raw.itemReference),
    barcode: nullableString(raw.barcode),
  });
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) return fail("GOODS_RECEIPT_INVALID");
  const projection = await ports.projection.query(query);
  if (
    projection.projectionName !== "inventory_goods_receipt_v1" ||
    projection.projectionVersion !== 1 ||
    projection.tenantReference !== query.tenantReference ||
    projection.brandReference !== query.brandReference ||
    projection.stockSiteReference !== query.stockSiteReference ||
    !["Current", "Stale", "Rebuilding"].includes(projection.freshness) ||
    typeof projection.partial !== "boolean" ||
    projection.mayViewCost !== !!access.mayViewCost ||
    projection.mayViewEvidence !== !!access.mayViewEvidence ||
    projection.mayViewTemperature !== !!access.mayViewTemperature
  )
    return fail("GOODS_RECEIPT_INVALID");
  instant(projection.asOfUtc);
  if (projection.draft) {
    if (
      !/^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u.test(projection.draft.supplierSummary) ||
      (!projection.mayViewEvidence &&
        projection.draft.lines.some((line) => line.evidenceReferences.length > 0)) ||
      (!projection.mayViewTemperature &&
        projection.draft.lines.some((line) => line.temperatureReading !== null))
    )
      return fail("GOODS_RECEIPT_INVALID");
    const validated = createValidatedGoodsReceipt({
      goodsReceiptReference: projection.draft.goodsReceiptReference,
      tenantReference: query.tenantReference,
      brandReference: query.brandReference,
      stockSiteReference: query.stockSiteReference,
      supplierReference: projection.draft.supplierReference,
      purchaseOrderReference: projection.draft.purchaseOrderReference,
      purchaseOrderVersion: projection.draft.purchaseOrderVersion,
      purchaseOrderRevisionNumber: projection.draft.purchaseOrderRevisionNumber,
      issuedSnapshotReference: projection.draft.issuedSnapshotReference,
      receivedAt: projection.draft.receivedAt,
      lines: projection.draft.lines,
      actorReference: query.actorReference,
      occurredAt: projection.asOfUtc,
    });
    if (
      validated.lines.some(
        (line, index) =>
          line.discrepancyRequired !== projection.draft?.lines[index]?.discrepancyRequired,
      )
    )
      return fail("GOODS_RECEIPT_INVALID");
  }
  return projection;
}
