import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
} from "./kitchen-ticket.js";

export const kitchenWorkLifecyclePermission = "kitchen.operate" as const;
export const kitchenWorkLifecycleProjectionName = "kitchen_work_queue_v1" as const;
export const kitchenWorkLifecycleAuditRetentionPolicyCode = "KITCHEN_BUSINESS_RECORD" as const;
export const kitchenWorkLifecycleAuditRetentionPolicyVersion = 1 as const;
const postgresqlBigintMaximum = 9_223_372_036_854_775_807n;

export const kitchenWorkLifecycleErrorCodes = [
  "KITCHEN_WORK_INPUT_INVALID",
  "KITCHEN_WORK_PERMISSION_DENIED",
  "KITCHEN_WORK_NOT_FOUND",
  "KITCHEN_WORK_VERSION_CONFLICT",
  "KITCHEN_WORK_PRECONDITION_FAILED",
  "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
] as const;

export type KitchenWorkLifecycleErrorCode = (typeof kitchenWorkLifecycleErrorCodes)[number];

export class KitchenWorkLifecycleError extends Error {
  constructor(readonly code: KitchenWorkLifecycleErrorCode) {
    super("kitchen work is unavailable");
    this.name = "KitchenWorkLifecycleError";
  }
}

export type KitchenWorkLifecycleAction =
  | "AcceptKitchenWorkItem"
  | "StartKitchenWorkItem"
  | "CompleteKitchenWorkItem"
  | "MarkKitchenOrderItemReady";

export type KitchenWorkLifecyclePurpose = "KitchenWorkExecution" | "KitchenExpoCoordination";
export type KitchenWorkLifecycleOutcome =
  | "Accepted"
  | "Started"
  | "ProgressRecorded"
  | "Completed"
  | "CompletedAndOrderItemReady"
  | "OrderItemReady";
export type KitchenLifecycleWorkItemStatus =
  "Queued" | "Held" | "In Progress" | "Completed" | "Cancelled";

interface WorkItemCommandBase {
  readonly idempotencyKey: string;
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly expectedTicketVersion: string;
  readonly expectedWorkItemVersion: string;
  readonly correlationReference: KitchenReference;
}

export interface AcceptKitchenWorkItemCommand extends WorkItemCommandBase {
  readonly action: "AcceptKitchenWorkItem";
}

export interface StartKitchenWorkItemCommand extends WorkItemCommandBase {
  readonly action: "StartKitchenWorkItem";
}

export interface CompleteKitchenWorkItemCommand extends WorkItemCommandBase {
  readonly action: "CompleteKitchenWorkItem";
  readonly quantityDelta: number;
}

export interface KitchenReadyWorkItemVersion {
  readonly workItemReference: KitchenReference;
  readonly expectedWorkItemVersion: string;
}

export interface MarkKitchenOrderItemReadyCommand {
  readonly action: "MarkKitchenOrderItemReady";
  readonly idempotencyKey: string;
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly expectedTicketVersion: string;
  readonly workItems: readonly [KitchenReadyWorkItemVersion];
  readonly correlationReference: KitchenReference;
}

export type KitchenWorkLifecycleCommand =
  | AcceptKitchenWorkItemCommand
  | StartKitchenWorkItemCommand
  | CompleteKitchenWorkItemCommand
  | MarkKitchenOrderItemReadyCommand;

export interface KitchenWorkLifecycleResult {
  readonly operationReference: KitchenReference;
  readonly action: KitchenWorkLifecycleAction;
  readonly outcome: KitchenWorkLifecycleOutcome;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly ticketVersion: string;
  readonly workItemVersion: string;
  readonly workItemStatus: KitchenLifecycleWorkItemStatus;
  readonly completedQuantity: number;
  readonly requiredQuantity: number;
  readonly occurredAt: KitchenInstant;
  readonly readyResultReference: KitchenReference | null;
  readonly readyQuantity: number | null;
  readonly projectionName: "kitchen_work_queue_v1";
  readonly projectionPending: true;
  readonly projectionTriggers:
    | readonly ["KitchenLifecycleEvent"]
    | readonly ["KitchenLifecycleEvent", "KitchenReadyEvent"]
    | readonly ["KitchenReadyEvent"];
}

export interface KitchenLifecyclePredecessorOperation {
  readonly operationReference: KitchenReference;
  readonly actionCode: "KITCHEN_WORK_ITEM_ACCEPTED" | "KITCHEN_WORK_ITEM_STARTED";
  readonly purpose: "KitchenWorkExecution";
  readonly actorReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly resultTicketVersion: bigint;
  readonly resultWorkItemVersion: bigint;
  readonly occurredAt: KitchenInstant;
}

export interface KitchenLifecycleSourceWorkItem {
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly sourceItemOrdinal: number;
  readonly splitOrdinal: 1;
  readonly workItemVersion: bigint;
  readonly workItemStatus: KitchenLifecycleWorkItemStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly createdAt: KitchenInstant;
  readonly updatedAt: KitchenInstant;
}

export interface KitchenOrderItemReadyResultProof {
  readonly readyResultReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly causalOperationReference: KitchenReference;
  readonly workItemsDigest: KitchenDigest;
  readonly readyQuantity: number;
  readonly requiredQuantity: number;
  readonly readyAt: KitchenInstant;
}

export interface KitchenCapturedExpoDecision {
  readonly sourceOperationReference: KitchenReference;
  readonly sourceActionCode: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED";
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly sourceExpectedTicketVersion: bigint;
  readonly sourceCommittedTicketVersion: bigint;
  readonly sourceExpectedWorkItemVersion: bigint;
  readonly sourceCommittedWorkItemVersion: bigint;
  readonly sourceBeforeStatus: "In Progress";
  readonly sourceAfterStatus: "Completed";
  readonly sourceCompletedQuantity: number;
  readonly sourceRequiredQuantity: number;
  readonly sourceOutcome: "Completed" | "CompletedAndOrderItemReady";
  readonly sourceOccurredAt: KitchenInstant;
  readonly capturedExpoBindingDigest: KitchenDigest;
  readonly decisionReference: KitchenReference;
  readonly decisionVersion: number;
  readonly decisionDigest: KitchenDigest;
  readonly producerContractVersion: 1;
  readonly decisionBrandReference: KitchenReference;
  readonly decisionStoreReference: KitchenReference;
  readonly decisionPurpose: "KitchenReadiness";
  readonly mode: "Enabled" | "Disabled";
  readonly evaluatedAt: KitchenInstant;
  readonly validUntil: KitchenInstant;
}

export interface KitchenWorkLifecycleSource {
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly ticketStatus: "Open";
  readonly ticketVersion: bigint;
  readonly ticketUpdatedAt: KitchenInstant;
  readonly target: KitchenLifecycleSourceWorkItem;
  readonly siblings: readonly [KitchenLifecycleSourceWorkItem];
  readonly acceptedOperation: KitchenLifecyclePredecessorOperation | null;
  readonly startedOperation: KitchenLifecyclePredecessorOperation | null;
  readonly readyResult: KitchenOrderItemReadyResultProof | null;
  readonly capturedExpo: KitchenCapturedExpoDecision | null;
}

export interface KitchenWorkLifecycleAuthority {
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly observedAt: KitchenInstant;
}

export interface KitchenWorkLifecycleCorrelation {
  readonly correlationReference: KitchenReference;
}

export interface KitchenStartAdmissionDecision {
  readonly decisionReference: KitchenReference;
  readonly decisionVersion: number;
  readonly decisionDigest: KitchenDigest;
  readonly producerContractVersion: 1;
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly acceptedOperationReference: KitchenReference;
  readonly ticketVersion: bigint;
  readonly workItemVersion: bigint;
  readonly action: "StartKitchenWorkItem";
  readonly purpose: "KitchenWorkExecution";
  readonly outcome: "Allowed" | "Blocked";
  readonly evaluatedAt: KitchenInstant;
  readonly validUntil: KitchenInstant;
}

export interface KitchenExpoPolicyDecision {
  readonly decisionReference: KitchenReference;
  readonly decisionVersion: number;
  readonly decisionDigest: KitchenDigest;
  readonly producerContractVersion: 1;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly purpose: "KitchenReadiness";
  readonly mode: "Enabled" | "Disabled";
  readonly evaluatedAt: KitchenInstant;
  readonly validUntil: KitchenInstant;
}

function invalid(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_INPUT_INVALID");
}

function corrupt(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
}

function exact(
  value: unknown,
  fields: readonly string[],
  onInvalid: () => never,
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return onInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return onInvalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return onInvalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    return onInvalid();
  }
}

function exactArray(value: unknown, length: number, onInvalid: () => never): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
      return onInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      value.length !== length ||
      keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        const descriptor = descriptors[key];
        return (
          index >= length ||
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      }) ||
      Array.from({ length }, (_, index) => String(index)).some((key) => !(key in descriptors))
    )
      return onInvalid();
    return Object.freeze(
      Array.from(
        { length },
        (_, index) => (descriptors[String(index)] as PropertyDescriptor).value,
      ),
    );
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    return onInvalid();
  }
}

function reference(value: unknown, onInvalid: () => never): KitchenReference {
  try {
    return parseKitchenTicketReference(value);
  } catch {
    return onInvalid();
  }
}

function instant(value: unknown, onInvalid: () => never): KitchenInstant {
  try {
    return parseKitchenTicketInstant(value);
  } catch {
    return onInvalid();
  }
}

function digestValue(value: unknown, onInvalid: () => never): KitchenDigest {
  try {
    return parseKitchenTicketDigest(value);
  } catch {
    return onInvalid();
  }
}

function positiveBigint(value: unknown, onInvalid: () => never): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > postgresqlBigintMaximum)
    return onInvalid();
  return value;
}

function positiveVersionText(value: unknown, onInvalid: () => never): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return onInvalid();
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > postgresqlBigintMaximum) return onInvalid();
  } catch {
    return onInvalid();
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, onInvalid: () => never) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return onInvalid();
  return value as number;
}

function idempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 200 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9:_-]{14,198}[A-Za-z0-9])$/.test(value)
  )
    return invalid();
  return value;
}

function workItemStatus(value: unknown, onInvalid: () => never): KitchenLifecycleWorkItemStatus {
  if (
    typeof value !== "string" ||
    !["Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(value)
  )
    return onInvalid();
  return value as KitchenLifecycleWorkItemStatus;
}

function statusQuantityValid(
  status: KitchenLifecycleWorkItemStatus,
  completed: number,
  required: number,
): boolean {
  if (status === "Queued") return completed === 0;
  if (status === "In Progress") return completed >= 0 && completed < required;
  if (status === "Completed") return completed === required;
  return completed >= 0 && completed <= required;
}

function parseReadyVector(value: unknown): readonly [KitchenReadyWorkItemVersion] {
  const item = exactArray(value, 1, invalid)[0];
  const raw = exact(item, ["workItemReference", "expectedWorkItemVersion"], invalid);
  return Object.freeze([
    Object.freeze({
      workItemReference: reference(raw.workItemReference, invalid),
      expectedWorkItemVersion: positiveVersionText(raw.expectedWorkItemVersion, invalid),
    }),
  ]);
}

export function parseKitchenWorkLifecycleCommand(value: unknown): KitchenWorkLifecycleCommand {
  let action: unknown;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, "action");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    )
      return invalid();
    action = descriptor.value;
  } catch {
    return invalid();
  }
  const common = [
    "action",
    "idempotencyKey",
    "actorReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "expectedTicketVersion",
    "expectedWorkItemVersion",
    "correlationReference",
  ] as const;
  if (action === "MarkKitchenOrderItemReady") {
    const raw = exact(
      value,
      [
        "action",
        "idempotencyKey",
        "actorReference",
        "brandReference",
        "storeReference",
        "ticketReference",
        "orderItemReference",
        "expectedTicketVersion",
        "workItems",
        "correlationReference",
      ],
      invalid,
    );
    return Object.freeze({
      action,
      idempotencyKey: idempotencyKey(raw.idempotencyKey),
      actorReference: reference(raw.actorReference, invalid),
      brandReference: reference(raw.brandReference, invalid),
      storeReference: reference(raw.storeReference, invalid),
      ticketReference: reference(raw.ticketReference, invalid),
      orderItemReference: reference(raw.orderItemReference, invalid),
      expectedTicketVersion: positiveVersionText(raw.expectedTicketVersion, invalid),
      workItems: parseReadyVector(raw.workItems),
      correlationReference: reference(raw.correlationReference, invalid),
    });
  }
  if (
    action !== "AcceptKitchenWorkItem" &&
    action !== "StartKitchenWorkItem" &&
    action !== "CompleteKitchenWorkItem"
  )
    return invalid();
  const raw = exact(
    value,
    action === "CompleteKitchenWorkItem" ? [...common, "quantityDelta"] : common,
    invalid,
  );
  const base = {
    action,
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
    actorReference: reference(raw.actorReference, invalid),
    brandReference: reference(raw.brandReference, invalid),
    storeReference: reference(raw.storeReference, invalid),
    ticketReference: reference(raw.ticketReference, invalid),
    workItemReference: reference(raw.workItemReference, invalid),
    orderItemReference: reference(raw.orderItemReference, invalid),
    expectedTicketVersion: positiveVersionText(raw.expectedTicketVersion, invalid),
    expectedWorkItemVersion: positiveVersionText(raw.expectedWorkItemVersion, invalid),
    correlationReference: reference(raw.correlationReference, invalid),
  };
  return Object.freeze(
    action === "CompleteKitchenWorkItem"
      ? { ...base, quantityDelta: boundedInteger(raw.quantityDelta, 1, 999, invalid) }
      : base,
  ) as KitchenWorkLifecycleCommand;
}

function parseSourceWorkItem(value: unknown): KitchenLifecycleSourceWorkItem {
  const raw = exact(
    value,
    [
      "workItemReference",
      "orderItemReference",
      "sourceItemOrdinal",
      "splitOrdinal",
      "workItemVersion",
      "workItemStatus",
      "requiredQuantity",
      "completedQuantity",
      "createdAt",
      "updatedAt",
    ],
    corrupt,
  );
  const status = workItemStatus(raw.workItemStatus, corrupt);
  const requiredQuantity = boundedInteger(raw.requiredQuantity, 1, 999, corrupt);
  const completedQuantity = boundedInteger(raw.completedQuantity, 0, requiredQuantity, corrupt);
  const createdAt = instant(raw.createdAt, corrupt);
  const updatedAt = instant(raw.updatedAt, corrupt);
  if (!statusQuantityValid(status, completedQuantity, requiredQuantity)) return corrupt();
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return corrupt();
  return Object.freeze({
    workItemReference: reference(raw.workItemReference, corrupt),
    orderItemReference: reference(raw.orderItemReference, corrupt),
    sourceItemOrdinal: boundedInteger(raw.sourceItemOrdinal, 1, 100, corrupt),
    splitOrdinal: raw.splitOrdinal === 1 ? 1 : corrupt(),
    workItemVersion: positiveBigint(raw.workItemVersion, corrupt),
    workItemStatus: status,
    requiredQuantity,
    completedQuantity,
    createdAt,
    updatedAt,
  });
}

function sameSourceItem(
  left: KitchenLifecycleSourceWorkItem,
  right: KitchenLifecycleSourceWorkItem,
) {
  return (
    left.workItemReference === right.workItemReference &&
    left.orderItemReference === right.orderItemReference &&
    left.sourceItemOrdinal === right.sourceItemOrdinal &&
    left.splitOrdinal === right.splitOrdinal &&
    left.workItemVersion === right.workItemVersion &&
    left.workItemStatus === right.workItemStatus &&
    left.requiredQuantity === right.requiredQuantity &&
    left.completedQuantity === right.completedQuantity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function parsePredecessor(value: unknown): KitchenLifecyclePredecessorOperation {
  const raw = exact(
    value,
    [
      "operationReference",
      "actionCode",
      "purpose",
      "actorReference",
      "ticketReference",
      "workItemReference",
      "orderItemReference",
      "resultTicketVersion",
      "resultWorkItemVersion",
      "occurredAt",
    ],
    corrupt,
  );
  if (
    typeof raw.actionCode !== "string" ||
    !["KITCHEN_WORK_ITEM_ACCEPTED", "KITCHEN_WORK_ITEM_STARTED"].includes(raw.actionCode) ||
    raw.purpose !== "KitchenWorkExecution"
  )
    return corrupt();
  return Object.freeze({
    operationReference: reference(raw.operationReference, corrupt),
    actionCode: raw.actionCode as KitchenLifecyclePredecessorOperation["actionCode"],
    purpose: "KitchenWorkExecution",
    actorReference: reference(raw.actorReference, corrupt),
    ticketReference: reference(raw.ticketReference, corrupt),
    workItemReference: reference(raw.workItemReference, corrupt),
    orderItemReference: reference(raw.orderItemReference, corrupt),
    resultTicketVersion: positiveBigint(raw.resultTicketVersion, corrupt),
    resultWorkItemVersion: positiveBigint(raw.resultWorkItemVersion, corrupt),
    occurredAt: instant(raw.occurredAt, corrupt),
  });
}

function parseReadyResultProof(value: unknown): KitchenOrderItemReadyResultProof {
  const raw = exact(
    value,
    [
      "readyResultReference",
      "ticketReference",
      "orderItemReference",
      "causalOperationReference",
      "workItemsDigest",
      "readyQuantity",
      "requiredQuantity",
      "readyAt",
    ],
    corrupt,
  );
  const requiredQuantity = boundedInteger(raw.requiredQuantity, 1, 999, corrupt);
  const readyQuantity = boundedInteger(raw.readyQuantity, 1, requiredQuantity, corrupt);
  if (readyQuantity !== requiredQuantity) return corrupt();
  return Object.freeze({
    readyResultReference: reference(raw.readyResultReference, corrupt),
    ticketReference: reference(raw.ticketReference, corrupt),
    orderItemReference: reference(raw.orderItemReference, corrupt),
    causalOperationReference: reference(raw.causalOperationReference, corrupt),
    workItemsDigest: digestValue(raw.workItemsDigest, corrupt),
    readyQuantity,
    requiredQuantity,
    readyAt: instant(raw.readyAt, corrupt),
  });
}

export function parseKitchenCapturedExpoDecision(value: unknown): KitchenCapturedExpoDecision {
  const raw = exact(
    value,
    [
      "sourceOperationReference",
      "sourceActionCode",
      "ticketReference",
      "workItemReference",
      "orderItemReference",
      "sourceExpectedTicketVersion",
      "sourceCommittedTicketVersion",
      "sourceExpectedWorkItemVersion",
      "sourceCommittedWorkItemVersion",
      "sourceBeforeStatus",
      "sourceAfterStatus",
      "sourceCompletedQuantity",
      "sourceRequiredQuantity",
      "sourceOutcome",
      "sourceOccurredAt",
      "capturedExpoBindingDigest",
      "decisionReference",
      "decisionVersion",
      "decisionDigest",
      "producerContractVersion",
      "decisionBrandReference",
      "decisionStoreReference",
      "decisionPurpose",
      "mode",
      "evaluatedAt",
      "validUntil",
    ],
    corrupt,
  );
  if (
    raw.sourceActionCode !== "KITCHEN_WORK_ITEM_COMPLETION_RECORDED" ||
    raw.sourceBeforeStatus !== "In Progress" ||
    raw.sourceAfterStatus !== "Completed" ||
    typeof raw.sourceOutcome !== "string" ||
    !["Completed", "CompletedAndOrderItemReady"].includes(raw.sourceOutcome) ||
    raw.producerContractVersion !== 1 ||
    raw.decisionPurpose !== "KitchenReadiness" ||
    typeof raw.mode !== "string" ||
    !["Enabled", "Disabled"].includes(raw.mode)
  )
    return corrupt();
  const required = boundedInteger(raw.sourceRequiredQuantity, 1, 999, corrupt);
  const completed = boundedInteger(raw.sourceCompletedQuantity, 1, required, corrupt);
  if (completed !== required) return corrupt();
  const expectedTicket = positiveBigint(raw.sourceExpectedTicketVersion, corrupt);
  const committedTicket = positiveBigint(raw.sourceCommittedTicketVersion, corrupt);
  const expectedWorkItem = positiveBigint(raw.sourceExpectedWorkItemVersion, corrupt);
  const committedWorkItem = positiveBigint(raw.sourceCommittedWorkItemVersion, corrupt);
  if (committedTicket !== expectedTicket + 1n || committedWorkItem !== expectedWorkItem + 1n)
    return corrupt();
  const sourceOutcome = raw.sourceOutcome as KitchenCapturedExpoDecision["sourceOutcome"];
  const mode = raw.mode as KitchenCapturedExpoDecision["mode"];
  if (
    (mode === "Enabled" && sourceOutcome !== "Completed") ||
    (mode === "Disabled" && sourceOutcome !== "CompletedAndOrderItemReady")
  )
    return corrupt();
  return Object.freeze({
    sourceOperationReference: reference(raw.sourceOperationReference, corrupt),
    sourceActionCode: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
    ticketReference: reference(raw.ticketReference, corrupt),
    workItemReference: reference(raw.workItemReference, corrupt),
    orderItemReference: reference(raw.orderItemReference, corrupt),
    sourceExpectedTicketVersion: expectedTicket,
    sourceCommittedTicketVersion: committedTicket,
    sourceExpectedWorkItemVersion: expectedWorkItem,
    sourceCommittedWorkItemVersion: committedWorkItem,
    sourceBeforeStatus: "In Progress",
    sourceAfterStatus: "Completed",
    sourceCompletedQuantity: completed,
    sourceRequiredQuantity: required,
    sourceOutcome,
    sourceOccurredAt: instant(raw.sourceOccurredAt, corrupt),
    capturedExpoBindingDigest: digestValue(raw.capturedExpoBindingDigest, corrupt),
    decisionReference: reference(raw.decisionReference, corrupt),
    decisionVersion: boundedInteger(raw.decisionVersion, 1, Number.MAX_SAFE_INTEGER, corrupt),
    decisionDigest: digestValue(raw.decisionDigest, corrupt),
    producerContractVersion: 1,
    decisionBrandReference: reference(raw.decisionBrandReference, corrupt),
    decisionStoreReference: reference(raw.decisionStoreReference, corrupt),
    decisionPurpose: "KitchenReadiness",
    mode,
    evaluatedAt: instant(raw.evaluatedAt, corrupt),
    validUntil: instant(raw.validUntil, corrupt),
  });
}

export function parseKitchenWorkLifecycleSource(value: unknown): KitchenWorkLifecycleSource {
  const raw = exact(
    value,
    [
      "brandReference",
      "storeReference",
      "ticketReference",
      "ticketStatus",
      "ticketVersion",
      "ticketUpdatedAt",
      "target",
      "siblings",
      "acceptedOperation",
      "startedOperation",
      "readyResult",
      "capturedExpo",
    ],
    corrupt,
  );
  if (raw.ticketStatus !== "Open") return corrupt();
  const target = parseSourceWorkItem(raw.target);
  const sibling = parseSourceWorkItem(exactArray(raw.siblings, 1, corrupt)[0]);
  if (!sameSourceItem(target, sibling)) return corrupt();
  const acceptedOperation =
    raw.acceptedOperation === null ? null : parsePredecessor(raw.acceptedOperation);
  const startedOperation =
    raw.startedOperation === null ? null : parsePredecessor(raw.startedOperation);
  if (
    (acceptedOperation !== null && acceptedOperation.actionCode !== "KITCHEN_WORK_ITEM_ACCEPTED") ||
    (startedOperation !== null && startedOperation.actionCode !== "KITCHEN_WORK_ITEM_STARTED")
  )
    return corrupt();
  if (
    acceptedOperation !== null &&
    startedOperation !== null &&
    acceptedOperation.operationReference === startedOperation.operationReference
  )
    return corrupt();
  if (
    (acceptedOperation !== null && acceptedOperation.resultWorkItemVersion !== 2n) ||
    (startedOperation !== null && startedOperation.resultWorkItemVersion !== 3n)
  )
    return corrupt();
  const readyResult = raw.readyResult === null ? null : parseReadyResultProof(raw.readyResult);
  const capturedExpo =
    raw.capturedExpo === null ? null : parseKitchenCapturedExpoDecision(raw.capturedExpo);
  const ticketReference = reference(raw.ticketReference, corrupt);
  const brandReference = reference(raw.brandReference, corrupt);
  const storeReference = reference(raw.storeReference, corrupt);
  const ticketVersion = positiveBigint(raw.ticketVersion, corrupt);
  const ticketUpdatedAt = instant(raw.ticketUpdatedAt, corrupt);
  if (
    ticketVersion < target.workItemVersion ||
    Date.parse(ticketUpdatedAt) < Date.parse(target.updatedAt)
  )
    return corrupt();
  for (const operation of [acceptedOperation, startedOperation]) {
    if (
      operation !== null &&
      (operation.ticketReference !== ticketReference ||
        operation.workItemReference !== target.workItemReference ||
        operation.orderItemReference !== target.orderItemReference)
    )
      return corrupt();
  }
  if (
    readyResult !== null &&
    (readyResult.ticketReference !== ticketReference ||
      readyResult.orderItemReference !== target.orderItemReference)
  )
    return corrupt();
  return Object.freeze({
    brandReference,
    storeReference,
    ticketReference,
    ticketStatus: "Open",
    ticketVersion,
    ticketUpdatedAt,
    target,
    siblings: Object.freeze([sibling] as const),
    acceptedOperation,
    startedOperation,
    readyResult,
    capturedExpo,
  });
}

export function parseKitchenWorkLifecycleAuthority(value: unknown): KitchenWorkLifecycleAuthority {
  const raw = exact(
    value,
    ["actorReference", "brandReference", "storeReference", "observedAt"],
    corrupt,
  );
  return Object.freeze({
    actorReference: reference(raw.actorReference, corrupt),
    brandReference: reference(raw.brandReference, corrupt),
    storeReference: reference(raw.storeReference, corrupt),
    observedAt: instant(raw.observedAt, corrupt),
  });
}

export function parseKitchenWorkLifecycleCorrelation(
  value: unknown,
): KitchenWorkLifecycleCorrelation {
  const raw = exact(value, ["correlationReference"], corrupt);
  return Object.freeze({ correlationReference: reference(raw.correlationReference, corrupt) });
}

export function parseKitchenStartAdmissionDecision(value: unknown): KitchenStartAdmissionDecision {
  const raw = exact(
    value,
    [
      "decisionReference",
      "decisionVersion",
      "decisionDigest",
      "producerContractVersion",
      "actorReference",
      "brandReference",
      "storeReference",
      "ticketReference",
      "workItemReference",
      "acceptedOperationReference",
      "ticketVersion",
      "workItemVersion",
      "action",
      "purpose",
      "outcome",
      "evaluatedAt",
      "validUntil",
    ],
    corrupt,
  );
  if (
    raw.producerContractVersion !== 1 ||
    raw.action !== "StartKitchenWorkItem" ||
    raw.purpose !== "KitchenWorkExecution" ||
    typeof raw.outcome !== "string" ||
    !["Allowed", "Blocked"].includes(raw.outcome)
  )
    return corrupt();
  return Object.freeze({
    decisionReference: reference(raw.decisionReference, corrupt),
    decisionVersion: boundedInteger(raw.decisionVersion, 1, Number.MAX_SAFE_INTEGER, corrupt),
    decisionDigest: digestValue(raw.decisionDigest, corrupt),
    producerContractVersion: 1,
    actorReference: reference(raw.actorReference, corrupt),
    brandReference: reference(raw.brandReference, corrupt),
    storeReference: reference(raw.storeReference, corrupt),
    ticketReference: reference(raw.ticketReference, corrupt),
    workItemReference: reference(raw.workItemReference, corrupt),
    acceptedOperationReference: reference(raw.acceptedOperationReference, corrupt),
    ticketVersion: positiveBigint(raw.ticketVersion, corrupt),
    workItemVersion: positiveBigint(raw.workItemVersion, corrupt),
    action: "StartKitchenWorkItem",
    purpose: "KitchenWorkExecution",
    outcome: raw.outcome as "Allowed" | "Blocked",
    evaluatedAt: instant(raw.evaluatedAt, corrupt),
    validUntil: instant(raw.validUntil, corrupt),
  });
}

export function parseKitchenExpoPolicyDecision(value: unknown): KitchenExpoPolicyDecision {
  const raw = exact(
    value,
    [
      "decisionReference",
      "decisionVersion",
      "decisionDigest",
      "producerContractVersion",
      "brandReference",
      "storeReference",
      "purpose",
      "mode",
      "evaluatedAt",
      "validUntil",
    ],
    corrupt,
  );
  if (
    raw.producerContractVersion !== 1 ||
    raw.purpose !== "KitchenReadiness" ||
    typeof raw.mode !== "string" ||
    !["Enabled", "Disabled"].includes(raw.mode)
  )
    return corrupt();
  return Object.freeze({
    decisionReference: reference(raw.decisionReference, corrupt),
    decisionVersion: boundedInteger(raw.decisionVersion, 1, Number.MAX_SAFE_INTEGER, corrupt),
    decisionDigest: digestValue(raw.decisionDigest, corrupt),
    producerContractVersion: 1,
    brandReference: reference(raw.brandReference, corrupt),
    storeReference: reference(raw.storeReference, corrupt),
    purpose: "KitchenReadiness",
    mode: raw.mode as "Enabled" | "Disabled",
    evaluatedAt: instant(raw.evaluatedAt, corrupt),
    validUntil: instant(raw.validUntil, corrupt),
  });
}

function resultTriggers(
  outcome: KitchenWorkLifecycleOutcome,
): KitchenWorkLifecycleResult["projectionTriggers"] {
  if (outcome === "CompletedAndOrderItemReady")
    return Object.freeze(["KitchenLifecycleEvent", "KitchenReadyEvent"] as const);
  if (outcome === "OrderItemReady") return Object.freeze(["KitchenReadyEvent"] as const);
  return Object.freeze(["KitchenLifecycleEvent"] as const);
}

export function parseKitchenWorkLifecycleResult(value: unknown): KitchenWorkLifecycleResult {
  const raw = exact(
    value,
    [
      "operationReference",
      "action",
      "outcome",
      "ticketReference",
      "workItemReference",
      "orderItemReference",
      "ticketVersion",
      "workItemVersion",
      "workItemStatus",
      "completedQuantity",
      "requiredQuantity",
      "occurredAt",
      "readyResultReference",
      "readyQuantity",
      "projectionName",
      "projectionPending",
      "projectionTriggers",
    ],
    corrupt,
  );
  if (
    ![
      "AcceptKitchenWorkItem",
      "StartKitchenWorkItem",
      "CompleteKitchenWorkItem",
      "MarkKitchenOrderItemReady",
    ].includes(typeof raw.action === "string" ? raw.action : "") ||
    ![
      "Accepted",
      "Started",
      "ProgressRecorded",
      "Completed",
      "CompletedAndOrderItemReady",
      "OrderItemReady",
    ].includes(typeof raw.outcome === "string" ? raw.outcome : "") ||
    raw.projectionName !== kitchenWorkLifecycleProjectionName ||
    raw.projectionPending !== true
  )
    return corrupt();
  const action = raw.action as KitchenWorkLifecycleAction;
  const outcome = raw.outcome as KitchenWorkLifecycleOutcome;
  const allowedOutcome =
    (action === "AcceptKitchenWorkItem" && outcome === "Accepted") ||
    (action === "StartKitchenWorkItem" && outcome === "Started") ||
    (action === "CompleteKitchenWorkItem" &&
      ["ProgressRecorded", "Completed", "CompletedAndOrderItemReady"].includes(outcome)) ||
    (action === "MarkKitchenOrderItemReady" && outcome === "OrderItemReady");
  if (!allowedOutcome) return corrupt();
  const status = workItemStatus(raw.workItemStatus, corrupt);
  const requiredQuantity = boundedInteger(raw.requiredQuantity, 1, 999, corrupt);
  const completedQuantity = boundedInteger(raw.completedQuantity, 0, requiredQuantity, corrupt);
  if (!statusQuantityValid(status, completedQuantity, requiredQuantity)) return corrupt();
  if (
    (outcome === "Accepted" && (status !== "Queued" || completedQuantity !== 0)) ||
    (outcome === "Started" && (status !== "In Progress" || completedQuantity !== 0)) ||
    (outcome === "ProgressRecorded" && (status !== "In Progress" || completedQuantity <= 0)) ||
    ((outcome === "Completed" ||
      outcome === "CompletedAndOrderItemReady" ||
      outcome === "OrderItemReady") &&
      (status !== "Completed" || completedQuantity !== requiredQuantity))
  )
    return corrupt();
  const ready = outcome === "CompletedAndOrderItemReady" || outcome === "OrderItemReady";
  if (
    (ready && (raw.readyResultReference === null || raw.readyQuantity !== requiredQuantity)) ||
    (!ready && (raw.readyResultReference !== null || raw.readyQuantity !== null))
  )
    return corrupt();
  const suppliedTriggers = exactArray(
    raw.projectionTriggers,
    resultTriggers(outcome).length,
    corrupt,
  );
  const expectedTriggers = resultTriggers(outcome);
  if (suppliedTriggers.some((entry, index) => entry !== expectedTriggers[index])) return corrupt();
  return Object.freeze({
    operationReference: reference(raw.operationReference, corrupt),
    action,
    outcome,
    ticketReference: reference(raw.ticketReference, corrupt),
    workItemReference: reference(raw.workItemReference, corrupt),
    orderItemReference: reference(raw.orderItemReference, corrupt),
    ticketVersion: positiveVersionText(raw.ticketVersion, corrupt),
    workItemVersion: positiveVersionText(raw.workItemVersion, corrupt),
    workItemStatus: status,
    completedQuantity,
    requiredQuantity,
    occurredAt: instant(raw.occurredAt, corrupt),
    readyResultReference:
      raw.readyResultReference === null ? null : reference(raw.readyResultReference, corrupt),
    readyQuantity: raw.readyQuantity === null ? null : (raw.readyQuantity as number),
    projectionName: kitchenWorkLifecycleProjectionName,
    projectionPending: true,
    projectionTriggers: expectedTriggers,
  });
}

export function canonicalizeKitchenWorkLifecycle(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return corrupt();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    try {
      if (Object.getPrototypeOf(value) !== Array.prototype) return corrupt();
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
      const keys = Reflect.ownKeys(descriptors);
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        (lengthDescriptor.value as number) < 0
      )
        return corrupt();
      const length = lengthDescriptor.value as number;
      if (
        keys.some((key) => {
          if (key === "length") return false;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
          const descriptor = descriptors[key];
          return (
            Number(key) >= length ||
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            !descriptor.enumerable
          );
        }) ||
        Array.from({ length }, (_, index) => String(index)).some((key) => !(key in descriptors))
      )
        return corrupt();
      return `[${Array.from({ length }, (_, index) =>
        canonicalizeKitchenWorkLifecycle((descriptors[String(index)] as PropertyDescriptor).value),
      ).join(",")}]`;
    } catch (error) {
      if (error instanceof KitchenWorkLifecycleError) throw error;
      return corrupt();
    }
  }
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return corrupt();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      })
    )
      return corrupt();
    return `{${keys
      .filter((key): key is string => typeof key === "string")
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeKitchenWorkLifecycle(
            (descriptors[key] as PropertyDescriptor).value,
          )}`,
      )
      .join(",")}}`;
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    return corrupt();
  }
}

export function createKitchenWorkLifecycleIntentBinding(commandValue: unknown): string {
  const command = parseKitchenWorkLifecycleCommand(commandValue);
  const purpose: KitchenWorkLifecyclePurpose =
    command.action === "MarkKitchenOrderItemReady"
      ? "KitchenExpoCoordination"
      : "KitchenWorkExecution";
  const base = {
    actorReference: command.actorReference,
    brandReference: command.brandReference,
    storeReference: command.storeReference,
    action: command.action,
    purpose,
    ticketReference: command.ticketReference,
    orderItemReference: command.orderItemReference,
    expectedTicketVersion: command.expectedTicketVersion,
  };
  if (command.action === "MarkKitchenOrderItemReady")
    return canonicalizeKitchenWorkLifecycle({ ...base, workItems: command.workItems });
  return canonicalizeKitchenWorkLifecycle({
    ...base,
    workItemReference: command.workItemReference,
    expectedWorkItemVersion: command.expectedWorkItemVersion,
    quantityDelta: command.action === "CompleteKitchenWorkItem" ? command.quantityDelta : null,
  });
}

export function createKitchenReadyWorkItemsBinding(value: unknown): string {
  const raw = exactArray(value, 1, corrupt);
  const item = exact(raw[0], ["workItemReference", "workItemVersion"], corrupt);
  return canonicalizeKitchenWorkLifecycle([
    {
      workItemReference: reference(item.workItemReference, corrupt),
      workItemVersion: positiveBigint(item.workItemVersion, corrupt),
    },
  ]);
}

export function createKitchenCapturedExpoBinding(value: unknown): string {
  const parsed = parseKitchenCapturedExpoDecision(value);
  const { capturedExpoBindingDigest, ...binding } = parsed;
  if (capturedExpoBindingDigest.length === 0) return corrupt();
  return canonicalizeKitchenWorkLifecycle(binding);
}

export function kitchenVersionText(value: bigint): string {
  return positiveBigint(value, corrupt).toString();
}
