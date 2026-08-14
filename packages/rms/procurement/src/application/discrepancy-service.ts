import type {
  DiscrepancyCommand,
  DiscrepancyIngestionCommand,
  DiscrepancyProjection,
  DiscrepancyQuery,
  DiscrepancyRecord,
} from "../contracts/discrepancy.js";
import {
  acknowledgeDiscrepancy,
  assignDiscrepancy,
  closeDiscrepancy,
  DiscrepancyError,
  openSupplierDiscrepancy,
  recordSupplierContact,
  resolveDiscrepancy,
  type DiscrepancyResolution,
  type SupplierDiscrepancy,
} from "../domain/aggregates/discrepancy.js";
import { offeringReference, type OfferingReference } from "../domain/aggregates/offering.js";
import type { DiscrepancyPorts } from "./ports/discrepancy-ports.js";
const fail = (code: DiscrepancyError["code"]): never => {
  throw new DiscrepancyError(code);
};
const exact = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("DISCREPANCY_INVALID");
  return value as Record<string, unknown>;
};
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("DISCREPANCY_INVALID");
  }
};
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("DISCREPANCY_INVALID");
const version = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 1
    ? (value as number)
    : fail("DISCREPANCY_INVALID");
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(value)
    ? value
    : fail("DISCREPANCY_INVALID");
const decimal = (value: unknown) =>
  typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)
    ? value
    : fail("DISCREPANCY_INVALID");
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u.test(value)
    ? value
    : fail("DISCREPANCY_INVALID");
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fail("DISCREPANCY_INVALID");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
function command(value: unknown): DiscrepancyCommand {
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
  if (raw.purpose !== "DiscrepancyManagement" || raw.permission !== "procurement.manage")
    return fail("DISCREPANCY_INVALID");
  const action = oneOf(raw.action, [
    "Acknowledge",
    "Assign",
    "RecordSupplierContact",
    "AcceptWithinPolicy",
    "RequestCorrection",
    "RequestReplacement",
    "WaiveRemainder",
    "Close",
  ]);
  const fields =
    action === "Acknowledge"
      ? ["discrepancyReference", "expectedVersion", "decisionReference"]
      : action === "Assign"
        ? ["discrepancyReference", "expectedVersion", "decisionReference", "ownerReference"]
        : action === "RecordSupplierContact"
          ? [
              "discrepancyReference",
              "expectedVersion",
              "decisionReference",
              "outcome",
              "reasonCode",
            ]
          : action === "WaiveRemainder"
            ? [
                "discrepancyReference",
                "expectedVersion",
                "decisionReference",
                "reasonCode",
                "approvalReference",
              ]
            : action === "Close"
              ? ["discrepancyReference", "expectedVersion", "decisionReference", "closureReference"]
              : ["discrepancyReference", "expectedVersion", "decisionReference", "reasonCode"];
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "DiscrepancyManagement",
    permission: "procurement.manage",
    operationReference: ref(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: Object.freeze(exact(raw.payload, fields)),
  });
}
function validateSource(value: unknown, input: DiscrepancyCommand, before: SupplierDiscrepancy) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "supplierReference",
    "purchaseOrderReference",
    "purchaseOrderLineReference",
    "goodsReceiptReference",
    "receiptLineReference",
    "sourceEventReference",
    "type",
    "varianceQuantity",
    "unit",
    "toleranceQuantity",
    "withinTolerance",
    "pending",
  ]);
  if (
    raw.tenantReference !== input.tenantReference ||
    raw.brandReference !== input.brandReference ||
    raw.stockSiteReference !== input.stockSiteReference ||
    raw.supplierReference !== before.supplierReference ||
    raw.purchaseOrderReference !== before.purchaseOrderReference ||
    raw.purchaseOrderLineReference !== before.purchaseOrderLineReference ||
    raw.goodsReceiptReference !== before.goodsReceiptReference ||
    raw.receiptLineReference !== before.receiptLineReference ||
    raw.sourceEventReference !== before.sourceEventReference ||
    raw.type !== before.type ||
    raw.varianceQuantity !== before.varianceQuantity ||
    raw.unit !== before.unit ||
    raw.toleranceQuantity !== before.toleranceQuantity ||
    raw.withinTolerance !== before.withinTolerance ||
    typeof raw.pending !== "boolean"
  )
    return fail("DISCREPANCY_INVALID");
  return raw;
}
export async function executeDiscrepancy(
  value: unknown,
  ports: DiscrepancyPorts,
): Promise<DiscrepancyRecord> {
  const input = command(value);
  const access = await ports.authorization.authorize(input);
  if (!access?.authorized) return fail("DISCREPANCY_INVALID");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(input)));
  const replay = await ports.repository.resolveOperation(input.operationReference);
  if (replay) {
    if (
      !ports.references.equals(replay.intentHash, intentHash) ||
      replay.command.actorReference !== input.actorReference ||
      replay.command.tenantReference !== input.tenantReference ||
      replay.command.brandReference !== input.brandReference ||
      replay.command.stockSiteReference !== input.stockSiteReference
    )
      return fail("DISCREPANCY_INVALID");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" });
  }
  const payload = input.payload;
  const before = await ports.repository.load({
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    stockSiteReference: input.stockSiteReference,
    discrepancyReference: ref(payload.discrepancyReference),
  });
  if (
    !before ||
    before.tenantReference !== input.tenantReference ||
    before.brandReference !== input.brandReference ||
    before.stockSiteReference !== input.stockSiteReference
  )
    return fail("DISCREPANCY_INVALID");
  const expectedVersion = version(payload.expectedVersion);
  const decisionReference = ref(payload.decisionReference);
  if (before.aggregateVersion !== expectedVersion) return fail("DISCREPANCY_STATE_CONFLICT");
  let after: SupplierDiscrepancy;
  let collaborationReference: OfferingReference | null = null;
  if (input.action === "Acknowledge")
    after = acknowledgeDiscrepancy(before, {
      expectedVersion,
      decisionReference,
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
    });
  else if (input.action === "Assign")
    after = assignDiscrepancy(before, {
      expectedVersion,
      decisionReference,
      ownerReference: ref(payload.ownerReference),
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
    });
  else if (input.action === "RecordSupplierContact")
    after = recordSupplierContact(before, {
      expectedVersion,
      decisionReference,
      outcome: oneOf(payload.outcome, [
        "Acknowledged",
        "Disputed",
        "CorrectionPromised",
        "ReplacementPromised",
        "NoResponse",
      ] as const),
      reasonCode: code(payload.reasonCode),
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
    });
  else {
    if (input.action === "Close") {
      if (!["Resolved", "ResolutionPending"].includes(before.status))
        return fail("DISCREPANCY_CLOSE_BLOCKED");
    } else if (["ResolutionPending", "Resolved", "Closed"].includes(before.status)) {
      return fail("DISCREPANCY_STATE_CONFLICT");
    }
    const source = validateSource(await ports.source.inspect(input), input, before);
    if (input.action === "Close") {
      if (source.pending) return fail("DISCREPANCY_CLOSE_BLOCKED");
      after = closeDiscrepancy(before, {
        expectedVersion,
        decisionReference,
        closureReference: ref(payload.closureReference),
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
    } else {
      const resolution: DiscrepancyResolution =
        input.action === "AcceptWithinPolicy"
          ? "AcceptedWithinPolicy"
          : input.action === "RequestCorrection"
            ? "CorrectionRequested"
            : input.action === "RequestReplacement"
              ? "ReplacementRequested"
              : "RemainderWaived";
      if (
        resolution === "AcceptedWithinPolicy" &&
        (before.type !== "Over" || !before.withinTolerance)
      )
        return fail("DISCREPANCY_POLICY_BLOCKED");
      if (resolution === "RemainderWaived" && before.type !== "Short")
        return fail("DISCREPANCY_POLICY_BLOCKED");
      if (resolution === "RemainderWaived") {
        if (!access.mayWaiveRemainder) return fail("DISCREPANCY_APPROVAL_REQUIRED");
        const approval = exact(
          await ports.approvals.validate(ref(payload.approvalReference), input),
          [
            "approvalReference",
            "tenantReference",
            "brandReference",
            "stockSiteReference",
            "discrepancyReference",
            "decision",
            "approvedBy",
            "approvedAt",
          ],
        );
        if (
          approval.approvalReference !== payload.approvalReference ||
          approval.tenantReference !== input.tenantReference ||
          approval.brandReference !== input.brandReference ||
          approval.stockSiteReference !== input.stockSiteReference ||
          approval.discrepancyReference !== before.discrepancyReference ||
          approval.decision !== "Approved" ||
          approval.approvedBy === input.actorReference
        )
          return fail("DISCREPANCY_APPROVAL_REQUIRED");
        ref(approval.approvedBy);
        if (instant(approval.approvedAt) > input.occurredAt)
          return fail("DISCREPANCY_APPROVAL_REQUIRED");
      }
      const result = exact(
        await ports.collaboration.request({ command: input, discrepancy: before }),
        [
          "tenantReference",
          "brandReference",
          "stockSiteReference",
          "discrepancyReference",
          "action",
          "outcomeReference",
          "status",
        ],
      );
      if (
        result.tenantReference !== input.tenantReference ||
        result.brandReference !== input.brandReference ||
        result.stockSiteReference !== input.stockSiteReference ||
        result.discrepancyReference !== before.discrepancyReference ||
        result.action !== input.action ||
        !["Accepted", "Requested", "Applied"].includes(String(result.status))
      )
        return fail("DISCREPANCY_INVALID");
      collaborationReference = ref(result.outcomeReference);
      after = resolveDiscrepancy(before, {
        expectedVersion,
        decisionReference,
        resolution,
        outcomeReference: collaborationReference,
        reasonCode: code(payload.reasonCode),
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
    }
  }
  const audit = await ports.audit.create({ command: input, before, after });
  return ports.repository.commit(
    Object.freeze({
      operationReference: input.operationReference,
      intentHash,
      command: input,
      discrepancy: after,
      collaborationReference,
      audit,
      outcome: "Applied",
    }),
  );
}
export async function ingestGoodsReceiptDiscrepancy(
  value: unknown,
  ports: DiscrepancyPorts,
): Promise<DiscrepancyRecord> {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "payload",
  ]);
  if (
    raw.purpose !== "DiscrepancyIngestion" ||
    raw.permission !== "procurement.discrepancy.consume"
  )
    return fail("DISCREPANCY_INVALID");
  const payload = exact(raw.payload, [
    "discrepancyReference",
    "supplierReference",
    "purchaseOrderReference",
    "purchaseOrderLineReference",
    "goodsReceiptReference",
    "receiptLineReference",
    "sourceEventReference",
    "type",
    "orderedQuantity",
    "priorAcceptedQuantity",
    "acceptedQuantity",
    "rejectedQuantity",
    "damagedQuantity",
    "varianceQuantity",
    "unit",
    "toleranceQuantity",
    "withinTolerance",
  ]);
  const input: DiscrepancyIngestionCommand = Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "DiscrepancyIngestion",
    permission: "procurement.discrepancy.consume",
    operationReference: ref(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    payload: Object.freeze(payload),
  });
  const access = await ports.authorization.authorize(input);
  if (!access?.authorized) return fail("DISCREPANCY_INVALID");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(input)));
  const operation = await ports.repository.resolveOperation(input.operationReference);
  if (operation) {
    if (
      !ports.references.equals(operation.intentHash, intentHash) ||
      operation.command.actorReference !== input.actorReference ||
      operation.command.tenantReference !== input.tenantReference ||
      operation.command.brandReference !== input.brandReference ||
      operation.command.stockSiteReference !== input.stockSiteReference
    )
      return fail("DISCREPANCY_INVALID");
    return Object.freeze({ ...operation, outcome: "AlreadyApplied" });
  }
  const type = oneOf(payload.type, ["Short", "Over", "Rejected", "Damaged", "Quality"]);
  const sourceEventReference = ref(payload.sourceEventReference);
  const receiptLineReference = ref(payload.receiptLineReference);
  const existing = await ports.repository.resolveSource({
    sourceEventReference,
    receiptLineReference,
    type,
  });
  if (existing) return Object.freeze({ ...existing, outcome: "AlreadyApplied" });
  const source = exact(await ports.source.inspect(input), [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "supplierReference",
    "purchaseOrderReference",
    "purchaseOrderLineReference",
    "goodsReceiptReference",
    "receiptLineReference",
    "sourceEventReference",
    "type",
    "orderedQuantity",
    "priorAcceptedQuantity",
    "acceptedQuantity",
    "rejectedQuantity",
    "damagedQuantity",
    "varianceQuantity",
    "unit",
    "toleranceQuantity",
    "withinTolerance",
  ]);
  const sourcePayload = Object.fromEntries(
    Object.entries(payload).filter(([field]) => field !== "discrepancyReference"),
  );
  for (const [field, expected] of Object.entries({
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    stockSiteReference: input.stockSiteReference,
    ...sourcePayload,
  }))
    if (source[field] !== expected) return fail("DISCREPANCY_INVALID");
  if (typeof payload.withinTolerance !== "boolean") return fail("DISCREPANCY_INVALID");
  const discrepancy = openSupplierDiscrepancy({
    discrepancyReference: ref(payload.discrepancyReference),
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    stockSiteReference: input.stockSiteReference,
    supplierReference: ref(payload.supplierReference),
    purchaseOrderReference: ref(payload.purchaseOrderReference),
    purchaseOrderLineReference: ref(payload.purchaseOrderLineReference),
    goodsReceiptReference: ref(payload.goodsReceiptReference),
    receiptLineReference,
    sourceEventReference,
    type,
    orderedQuantity: decimal(payload.orderedQuantity) as never,
    priorAcceptedQuantity: decimal(payload.priorAcceptedQuantity) as never,
    acceptedQuantity: decimal(payload.acceptedQuantity) as never,
    rejectedQuantity: decimal(payload.rejectedQuantity) as never,
    damagedQuantity: decimal(payload.damagedQuantity) as never,
    varianceQuantity: decimal(payload.varianceQuantity) as never,
    unit: text(payload.unit),
    toleranceQuantity: decimal(payload.toleranceQuantity) as never,
    withinTolerance: payload.withinTolerance,
    createdAt: input.occurredAt,
  });
  const audit = await ports.audit.create({ command: input, before: null, after: discrepancy });
  return ports.repository.commit(
    Object.freeze({
      operationReference: input.operationReference,
      intentHash,
      command: input,
      discrepancy,
      collaborationReference: null,
      audit,
      outcome: "Applied",
    }),
  );
}

export async function queryDiscrepancies(
  value: unknown,
  ports: DiscrepancyPorts,
): Promise<DiscrepancyProjection> {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockSiteReference",
    "actorReference",
    "purpose",
    "permission",
    "search",
    "type",
    "status",
    "ownerReference",
    "overdue",
  ]);
  if (
    raw.purpose !== "DiscrepancyRead" ||
    raw.permission !== "procurement.manage" ||
    (raw.search !== null && (typeof raw.search !== "string" || raw.search.length > 100)) ||
    (raw.overdue !== null && typeof raw.overdue !== "boolean")
  )
    return fail("DISCREPANCY_INVALID");
  const input: DiscrepancyQuery = Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    stockSiteReference: ref(raw.stockSiteReference),
    actorReference: ref(raw.actorReference),
    purpose: "DiscrepancyRead",
    permission: "procurement.manage",
    search: raw.search as string | null,
    type: oneOf(raw.type, ["All", "Short", "Over", "Rejected", "Damaged", "Quality"]),
    status: oneOf(raw.status, [
      "All",
      "Open",
      "Acknowledged",
      "InReview",
      "ResolutionPending",
      "Resolved",
      "Closed",
    ]),
    ownerReference: raw.ownerReference === null ? null : ref(raw.ownerReference),
    overdue: raw.overdue as boolean | null,
  });
  const access = await ports.authorization.authorize(input);
  if (!access?.authorized) return fail("DISCREPANCY_INVALID");
  const projection = await ports.projection.query(input);
  if (
    projection.projectionName !== "procurement_discrepancy_v1" ||
    projection.projectionVersion !== 1 ||
    projection.tenantReference !== input.tenantReference ||
    projection.brandReference !== input.brandReference ||
    projection.stockSiteReference !== input.stockSiteReference ||
    !["Current", "Stale", "Rebuilding"].includes(projection.freshness) ||
    projection.mayViewSupplierContact !== !!access.mayViewSupplierContact ||
    projection.mayViewEvidence !== !!access.mayViewEvidence ||
    projection.mayViewCost !== !!access.mayViewCost ||
    projection.mayViewHistory !== !!access.mayViewHistory ||
    !Array.isArray(projection.rows) ||
    projection.rows.length > 200
  )
    return fail("DISCREPANCY_INVALID");
  instant(projection.asOfUtc);
  for (const row of projection.rows) {
    ref(row.discrepancyReference);
    ref(row.purchaseOrderReference);
    ref(row.goodsReceiptReference);
    ref(row.supplierReference);
    version(row.version);
    oneOf(row.type, ["Short", "Over", "Rejected", "Damaged", "Quality"]);
    oneOf(row.status, [
      "Open",
      "Acknowledged",
      "InReview",
      "ResolutionPending",
      "Resolved",
      "Closed",
    ]);
    text(row.supplierSummary);
    text(row.itemSummary);
    text(row.unit);
    decimal(row.varianceQuantity);
    decimal(row.toleranceQuantity);
    if (typeof row.withinTolerance !== "boolean" || typeof row.overdue !== "boolean")
      return fail("DISCREPANCY_INVALID");
    if ((row.ownerReference === null) !== (row.ownerSummary === null))
      return fail("DISCREPANCY_INVALID");
    if (row.ownerReference) ref(row.ownerReference);
    if (row.ownerSummary) text(row.ownerSummary);
    if (
      row.evidenceCount !== null &&
      (!Number.isSafeInteger(row.evidenceCount) || row.evidenceCount < 0)
    )
      return fail("DISCREPANCY_INVALID");
    if (row.unitCost !== null) decimal(row.unitCost);
    if (row.history)
      for (const event of row.history) {
        text(event.action);
        instant(event.occurredAt);
      }
    if (
      (!projection.mayViewSupplierContact && row.supplierContactOutcome !== null) ||
      (!projection.mayViewEvidence && row.evidenceCount !== null) ||
      (!projection.mayViewCost && row.unitCost !== null) ||
      (!projection.mayViewHistory && row.history !== null)
    )
      return fail("DISCREPANCY_INVALID");
  }
  return projection;
}
