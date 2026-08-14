import type {
  RequisitionCommand,
  RequisitionCommandRecord,
  RequisitionProjection,
  RequisitionQuery,
} from "../contracts/requisition.js";
import {
  allocateRequisitionLine,
  assertRequisitionLineCapacity,
  assertRequisitionLineRemainder,
  cancelRequisitionRemainder,
  createRequisition,
  RequisitionError,
  reviseRequisitionDraft,
  transitionRequisition,
  type PurchaseRequisition,
  type RequisitionLine,
  type RequisitionReference,
} from "../domain/aggregates/requisition.js";
import { offeringReference, positiveDecimal } from "../domain/aggregates/offering.js";
import type { RequisitionAccess, RequisitionPorts } from "./ports/requisition-ports.js";

export class RequisitionServiceError extends Error {
  constructor(
    readonly code:
      | "REQUISITION_INVALID"
      | "REQUISITION_PERMISSION_DENIED"
      | "REQUISITION_NOT_FOUND"
      | "REQUISITION_CONFLICT"
      | "REQUISITION_STATE_CONFLICT"
      | "REQUISITION_SEGREGATION_REQUIRED"
      | "REQUISITION_OVER_ALLOCATED"
      | "REQUISITION_IDEMPOTENCY_CONFLICT"
      | "REQUISITION_DEPENDENCY_UNAVAILABLE"
      | "REQUISITION_APPROVAL_REQUIRED",
  ) {
    super(code);
  }
}
const fail = (code: RequisitionServiceError["code"]): never => {
  throw new RequisitionServiceError(code);
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,256}$/u;
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("REQUISITION_INVALID");
  return value as Record<string, unknown>;
}
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("REQUISITION_INVALID");
  }
};
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const code = (value: unknown, pattern = codePattern) =>
  typeof value === "string" && pattern.test(value) ? value : fail("REQUISITION_INVALID");
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fail("REQUISITION_INVALID");
const integer = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : fail("REQUISITION_INVALID");
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail("REQUISITION_INVALID"));
const at = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("REQUISITION_INVALID");
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 160 &&
  !/[<>{}\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : fail("REQUISITION_INVALID");
function parseLines(
  value: unknown,
): readonly Omit<RequisitionLine, "allocations" | "cancellations">[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200)
    return fail("REQUISITION_INVALID");
  return Object.freeze(
    value.map((entry) => {
      const raw = exact(entry, [
        "lineReference",
        "inventoryItemReference",
        "requestedQuantity",
        "requestedUnit",
        "requiredByUtc",
        "needSourceReferences",
      ]);
      if (!Array.isArray(raw.needSourceReferences) || raw.needSourceReferences.length > 100)
        return fail("REQUISITION_INVALID");
      return Object.freeze({
        lineReference: ref(raw.lineReference),
        inventoryItemReference: ref(raw.inventoryItemReference),
        requestedQuantity: positiveDecimal(raw.requestedQuantity),
        requestedUnit: code(raw.requestedUnit),
        requiredByUtc: at(raw.requiredByUtc),
        needSourceReferences: Object.freeze(raw.needSourceReferences.map(ref)),
      });
    }),
  );
}
const commandFields = [
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
function parseCommand(value: unknown): RequisitionCommand {
  const raw = exact(value, commandFields);
  const action = oneOf(raw.action, [
    "CreateDraft",
    "ReviseDraft",
    "Submit",
    "StartReview",
    "Approve",
    "Reject",
    "Cancel",
    "AllocateToPurchaseOrderDraft",
    "CancelRemainder",
  ]);
  if (raw.purpose !== "RequisitionManagement") return fail("REQUISITION_INVALID");
  const permission =
    action === "Approve" || action === "CancelRemainder"
      ? "procurement.requisition.approve"
      : action === "AllocateToPurchaseOrderDraft"
        ? "procurement.requisition.allocate"
        : action === "StartReview" || action === "Reject"
          ? "procurement.requisition.review"
          : "procurement.requisition.manage";
  if (raw.permission !== permission) return fail("REQUISITION_INVALID");
  let payload: Record<string, unknown>;
  if (action === "CreateDraft")
    payload = exact(raw.payload, [
      "requestingScopeKind",
      "requestingScopeReference",
      "requesterReference",
      "urgency",
      "lines",
    ]);
  else if (action === "ReviseDraft")
    payload = exact(raw.payload, ["requisitionReference", "expectedVersion", "urgency", "lines"]);
  else if (action === "AllocateToPurchaseOrderDraft")
    payload = exact(raw.payload, [
      "requisitionReference",
      "expectedVersion",
      "lineReference",
      "quantity",
    ]);
  else if (action === "CancelRemainder")
    payload = exact(raw.payload, [
      "requisitionReference",
      "expectedVersion",
      "lineReference",
      "quantity",
      "reasonCode",
      "approvalReference",
    ]);
  else
    payload = exact(raw.payload, [
      "requisitionReference",
      "expectedVersion",
      "reasonCode",
      "approvalReference",
    ]);
  const parsed =
    action === "CreateDraft"
      ? {
          requestingScopeKind: oneOf(payload.requestingScopeKind, ["Store", "OperatingEntity"]),
          requestingScopeReference: ref(payload.requestingScopeReference),
          requesterReference: ref(payload.requesterReference),
          urgency: oneOf(payload.urgency, ["Routine", "Urgent", "Emergency"]),
          lines: parseLines(payload.lines),
        }
      : {
          requisitionReference: ref(payload.requisitionReference),
          expectedVersion: integer(payload.expectedVersion, 1),
          ...(action === "ReviseDraft"
            ? {
                urgency: oneOf(payload.urgency, ["Routine", "Urgent", "Emergency"]),
                lines: parseLines(payload.lines),
              }
            : {}),
          ...(action === "AllocateToPurchaseOrderDraft" || action === "CancelRemainder"
            ? {
                lineReference: ref(payload.lineReference),
                quantity: positiveDecimal(payload.quantity),
              }
            : {}),
          ...(action === "CancelRemainder"
            ? {
                reasonCode: code(payload.reasonCode),
                approvalReference: ref(payload.approvalReference),
              }
            : {}),
          ...(!["ReviseDraft", "AllocateToPurchaseOrderDraft", "CancelRemainder"].includes(action)
            ? {
                reasonCode: payload.reasonCode === null ? null : code(payload.reasonCode),
                approvalReference: nullableRef(payload.approvalReference),
              }
            : {}),
        };
  if (
    (["Submit", "StartReview"].includes(action) &&
      (payload.reasonCode !== null || payload.approvalReference !== null)) ||
    (action === "Approve" && (payload.reasonCode !== null || payload.approvalReference === null)) ||
    (["Reject", "Cancel"].includes(action) &&
      (payload.reasonCode === null || payload.approvalReference !== null))
  )
    return fail("REQUISITION_INVALID");
  if (action === "CreateDraft") {
    const sources = (parsed.lines as ReturnType<typeof parseLines>).flatMap(
      (entry) => entry.needSourceReferences,
    );
    if (new Set(sources).size !== sources.length) return fail("REQUISITION_INVALID");
  }
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "RequisitionManagement",
    permission,
    operationReference: ref(raw.operationReference),
    occurredAt: at(raw.occurredAt),
    action,
    payload: Object.freeze(parsed),
  });
}
function parseQuery(value: unknown): RequisitionQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "selectedRequisitionReference",
    "search",
    "workflow",
    "requestingScopeReference",
    "requesterReference",
    "urgency",
    "unallocatedOnly",
    "requiredFromUtc",
    "requiredUntilUtc",
    "cursor",
  ]);
  if (raw.purpose !== "RequisitionRead" || raw.permission !== "procurement.requisition.read")
    return fail("REQUISITION_INVALID");
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "RequisitionRead",
    permission: "procurement.requisition.read",
    selectedRequisitionReference: nullableRef(raw.selectedRequisitionReference),
    search: raw.search === null ? null : code(raw.search, /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u),
    workflow: oneOf(raw.workflow, [
      "All",
      "Draft",
      "Submitted",
      "InReview",
      "Approved",
      "Rejected",
      "Cancelled",
    ]),
    requestingScopeReference: nullableRef(raw.requestingScopeReference),
    requesterReference: nullableRef(raw.requesterReference),
    urgency: oneOf(raw.urgency, ["All", "Routine", "Urgent", "Emergency"]),
    unallocatedOnly: bool(raw.unallocatedOnly),
    requiredFromUtc: raw.requiredFromUtc === null ? null : at(raw.requiredFromUtc),
    requiredUntilUtc: raw.requiredUntilUtc === null ? null : at(raw.requiredUntilUtc),
    cursor: raw.cursor === null ? null : code(raw.cursor, cursorPattern),
  });
}
function validateProjection(
  value: RequisitionProjection,
  input: RequisitionQuery,
  access: RequisitionAccess,
) {
  if (
    value.projectionName !== "procurement_requisition_v1" ||
    !Number.isSafeInteger(value.projectionVersion) ||
    value.projectionVersion < 1 ||
    at(value.asOfUtc) !== value.asOfUtc ||
    value.tenantReference !== input.tenantReference ||
    value.brandReference !== input.brandReference ||
    value.items.length > 100 ||
    Object.entries(value.permissions).some(
      ([key, granted]) => granted !== access[key as keyof RequisitionAccess],
    )
  )
    return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
  for (const item of value.items) {
    ref(item.requisitionReference);
    integer(item.requisitionVersion, 1);
    ref(item.requestingScopeReference);
    text(item.requestingScopeLabel);
    ref(item.requesterReference);
    at(item.requiredByUtc);
    integer(item.lineCount, 1);
    if (!access.mayViewAmount && (item.amountEstimate !== null || item.currency !== null))
      return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
    if (item.amountEstimate !== null) positiveDecimal(item.amountEstimate);
    if (item.currency !== null) code(item.currency, /^[A-Z]{3}$/u);
    if (!access.mayViewApprovalIdentity && item.approverReference !== null)
      return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
    if (item.approverReference !== null) ref(item.approverReference);
  }
  if (value.detail) {
    if (
      value.detail.requisitionReference !== input.selectedRequisitionReference ||
      !Number.isSafeInteger(value.detail.requisitionVersion)
    )
      return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
    if (
      !access.mayViewApprovalIdentity &&
      (value.detail.approverReference !== null || value.detail.approvalReference !== null)
    )
      return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
    value.detail.needSourceReferences.forEach(ref);
    value.detail.lines.forEach((line) => {
      ref(line.lineReference);
      ref(line.inventoryItemReference);
      text(line.itemName);
      positiveDecimal(line.requestedQuantity);
      code(line.requestedUnit);
      at(line.requiredByUtc);
      line.candidateSupplierSummaries.forEach(text);
      if (!access.mayViewAllocationReferences && line.allocationReferences !== null)
        return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
      line.allocationReferences?.forEach(ref);
    });
  }
}
export async function queryRequisitions(value: unknown, ports: RequisitionPorts) {
  const input = parseQuery(value);
  let access: RequisitionAccess;
  try {
    access = await ports.authorization.authorize({ ...input, action: "Query" });
  } catch {
    return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
  }
  if (!access.authorized) return fail("REQUISITION_PERMISSION_DENIED");
  try {
    const result = await ports.projection.query(input);
    validateProjection(result, input, access);
    return result;
  } catch (error) {
    if (error instanceof RequisitionServiceError) throw error;
    return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
  }
}
const intent = (value: RequisitionCommand) => JSON.stringify(value);
const permissionKey = (action: RequisitionCommand["action"]): keyof RequisitionAccess =>
  action === "Approve" || action === "CancelRemainder"
    ? "mayApprove"
    : action === "AllocateToPurchaseOrderDraft"
      ? "mayAllocate"
      : action === "StartReview" || action === "Reject"
        ? "mayReview"
        : "mayManage";
function validateApproval(
  result: Awaited<ReturnType<RequisitionPorts["approval"]["validate"]>>,
  input: RequisitionCommand,
  before: PurchaseRequisition,
  lineReference: RequisitionReference | null,
  quantity: string | null,
) {
  if (
    result.tenantReference !== input.tenantReference ||
    result.brandReference !== input.brandReference ||
    result.requisitionReference !== before.requisitionReference ||
    result.requisitionVersion !== before.aggregateVersion ||
    result.lineReference !== lineReference ||
    result.quantity !== quantity ||
    result.approvalReference !== input.payload.approvalReference ||
    !result.approved ||
    at(result.approvedAt) > input.occurredAt
  )
    return fail("REQUISITION_APPROVAL_REQUIRED");
}
export async function executeRequisition(value: unknown, ports: RequisitionPorts) {
  const input = parseCommand(value);
  let access: RequisitionAccess;
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
    return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
  }
  if (!access.authorized || !access[permissionKey(input.action)])
    return fail("REQUISITION_PERMISSION_DENIED");
  try {
    const hash = ports.references.hashIntent(intent(input));
    const replay = await ports.repository.resolveOperation(input.operationReference);
    if (replay) {
      if (
        !ports.references.equals(replay.intentHash, hash) ||
        intent(replay.command) !== intent(input) ||
        replay.operationReference !== input.operationReference ||
        replay.action !== input.action ||
        replay.requisition.tenantReference !== input.tenantReference ||
        replay.requisition.brandReference !== input.brandReference
      )
        return fail("REQUISITION_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
    }
    let before: PurchaseRequisition | null = null;
    let after: PurchaseRequisition;
    if (input.action === "CreateDraft") {
      const p = input.payload as Parameters<typeof createRequisition>[0];
      const sources = p.lines.flatMap((line) => line.needSourceReferences);
      if (
        !(await ports.repository.needSourcesAvailable({
          tenantReference: input.tenantReference,
          brandReference: input.brandReference,
          needSourceReferences: sources,
        }))
      )
        return fail("REQUISITION_CONFLICT");
      after = createRequisition({
        requisitionReference: ports.references.generate("Requisition"),
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        requestingScopeKind: p.requestingScopeKind,
        requestingScopeReference: p.requestingScopeReference,
        requesterReference: p.requesterReference,
        urgency: p.urgency,
        lines: p.lines,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
    } else {
      const p = input.payload as {
        requisitionReference: RequisitionReference;
        expectedVersion: number;
        lineReference?: RequisitionReference;
        quantity?: string;
        approvalReference?: RequisitionReference;
        reasonCode?: string | null;
        urgency?: PurchaseRequisition["urgency"];
        lines?: Parameters<typeof reviseRequisitionDraft>[1]["lines"];
      };
      before = await ports.repository.load({
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        requisitionReference: p.requisitionReference,
      });
      if (
        !before ||
        before.tenantReference !== input.tenantReference ||
        before.brandReference !== input.brandReference ||
        before.requisitionReference !== p.requisitionReference
      )
        return fail("REQUISITION_NOT_FOUND");
      if (before.aggregateVersion !== p.expectedVersion) return fail("REQUISITION_CONFLICT");
      const expected: Partial<
        Record<RequisitionCommand["action"], PurchaseRequisition["workflow"][]>
      > = {
        ReviseDraft: ["Draft"],
        Submit: ["Draft"],
        StartReview: ["Submitted"],
        Approve: ["InReview"],
        Reject: ["InReview"],
        Cancel: ["Draft", "Submitted", "InReview"],
        AllocateToPurchaseOrderDraft: ["Approved"],
        CancelRemainder: ["Approved"],
      };
      if (!expected[input.action]?.includes(before.workflow) || before.closureStatus === "Closed")
        return fail("REQUISITION_STATE_CONFLICT");
      if (
        input.action === "Approve" &&
        (input.actorReference === before.requesterReference ||
          input.actorReference === before.submittedBy)
      )
        return fail("REQUISITION_SEGREGATION_REQUIRED");
      if (input.action === "Approve")
        validateApproval(
          await ports.approval.validate({
            command: input,
            requisition: before,
            lineReference: null,
            quantity: null,
          }),
          input,
          before,
          null,
          null,
        );
      if (input.action === "CancelRemainder") {
        const lineReference = p.lineReference ?? fail("REQUISITION_INVALID");
        const quantity = p.quantity ?? fail("REQUISITION_INVALID");
        assertRequisitionLineRemainder(before, {
          expectedVersion: p.expectedVersion,
          lineReference,
          quantity,
        });
        validateApproval(
          await ports.approval.validate({
            command: input,
            requisition: before,
            lineReference,
            quantity,
          }),
          input,
          before,
          lineReference,
          quantity,
        );
      }
      if (input.action === "AllocateToPurchaseOrderDraft") {
        const requestedLineReference = p.lineReference ?? fail("REQUISITION_INVALID");
        const quantity = p.quantity ?? fail("REQUISITION_INVALID");
        const line = before.lines.find((entry) => entry.lineReference === requestedLineReference);
        if (!line) return fail("REQUISITION_INVALID");
        assertRequisitionLineCapacity(before, {
          expectedVersion: p.expectedVersion,
          lineReference: line.lineReference,
          quantity,
        });
        const allocation = await ports.purchaseOrderDraft.allocate({
          command: input,
          requisition: before,
        });
        if (
          allocation.tenantReference !== input.tenantReference ||
          allocation.brandReference !== input.brandReference ||
          allocation.requestingScopeKind !== before.requestingScopeKind ||
          allocation.requestingScopeReference !== before.requestingScopeReference ||
          allocation.requisitionReference !== before.requisitionReference ||
          allocation.requisitionVersion !== before.aggregateVersion ||
          allocation.lineReference !== line.lineReference ||
          allocation.inventoryItemReference !== line.inventoryItemReference ||
          allocation.requestedUnit !== line.requestedUnit ||
          allocation.quantity !== quantity ||
          !allocation.offeringApproved ||
          !allocation.priceApproved ||
          allocation.poWorkflow !== "Draft" ||
          allocation.poApproved ||
          allocation.poIssued
        )
          return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
        after = allocateRequisitionLine(before, {
          expectedVersion: p.expectedVersion,
          lineReference: line.lineReference,
          allocation: {
            allocationReference: ports.references.generate("Allocation"),
            purchaseOrderDraftReference: allocation.purchaseOrderDraftReference,
            purchaseOrderDraftLineReference: allocation.purchaseOrderDraftLineReference,
            offeringReference: allocation.offeringReference,
            offeringVersionReference: allocation.offeringVersionReference,
            priceRecordReference: allocation.priceRecordReference,
            priceVersionReference: allocation.priceVersionReference,
            quantity,
            allocatedBy: input.actorReference,
            allocatedAt: input.occurredAt,
          },
        });
      } else if (input.action === "CancelRemainder") {
        const lineReference = p.lineReference ?? fail("REQUISITION_INVALID");
        const quantity = p.quantity ?? fail("REQUISITION_INVALID");
        const reasonCode = p.reasonCode ?? fail("REQUISITION_INVALID");
        const approvalReference = p.approvalReference ?? fail("REQUISITION_INVALID");
        after = cancelRequisitionRemainder(before, {
          expectedVersion: p.expectedVersion,
          lineReference,
          cancellation: {
            cancellationReference: ports.references.generate("Cancellation"),
            quantity,
            reasonCode,
            approvalReference,
            cancelledBy: input.actorReference,
            cancelledAt: input.occurredAt,
          },
        });
      } else if (input.action === "ReviseDraft") {
        const urgency = p.urgency ?? fail("REQUISITION_INVALID");
        const lines = p.lines ?? fail("REQUISITION_INVALID");
        after = reviseRequisitionDraft(before, {
          expectedVersion: p.expectedVersion,
          urgency,
          lines,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      } else
        after = transitionRequisition(before, {
          expectedVersion: p.expectedVersion,
          action: input.action,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
          approvalReference: p.approvalReference ?? null,
          reasonCode: p.reasonCode ?? null,
        });
    }
    const audit = await ports.audit.create({ command: input, before, after });
    const record: RequisitionCommandRecord = Object.freeze({
      operationReference: input.operationReference,
      intentHash: hash,
      action: input.action,
      command: input,
      requisition: after,
      audit,
      outcome: "Applied",
    });
    return await ports.repository.commit(record);
  } catch (error) {
    if (error instanceof RequisitionServiceError) throw error;
    if (error instanceof RequisitionError) return fail(error.code);
    return fail("REQUISITION_DEPENDENCY_UNAVAILABLE");
  }
}
