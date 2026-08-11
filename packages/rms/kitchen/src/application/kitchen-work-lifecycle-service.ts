import { isProxy } from "node:util/types";

import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";

import {
  canonicalizeKitchenWorkLifecycle,
  createKitchenCapturedExpoBinding,
  createKitchenReadyWorkItemsBinding,
  createKitchenWorkLifecycleIntentBinding,
  kitchenVersionText,
  kitchenWorkLifecycleAuditRetentionPolicyCode,
  kitchenWorkLifecycleAuditRetentionPolicyVersion,
  kitchenWorkLifecyclePermission,
  kitchenWorkLifecycleProjectionName,
  KitchenWorkLifecycleError,
  parseKitchenCapturedExpoDecision,
  parseKitchenExpoPolicyDecision,
  parseKitchenStartAdmissionDecision,
  parseKitchenWorkLifecycleAuthority,
  parseKitchenWorkLifecycleCommand,
  parseKitchenWorkLifecycleCorrelation,
  parseKitchenWorkLifecycleResult,
  parseKitchenWorkLifecycleSource,
  type CompleteKitchenWorkItemCommand,
  type KitchenCapturedExpoDecision,
  type KitchenExpoPolicyDecision,
  type KitchenLifecycleWorkItemStatus,
  type KitchenStartAdmissionDecision,
  type KitchenWorkLifecycleAction,
  type KitchenWorkLifecycleCommand,
  type KitchenWorkLifecyclePurpose,
  type KitchenWorkLifecycleResult,
  type KitchenWorkLifecycleSource,
} from "../contracts/kitchen-work-lifecycle.js";
import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";
import {
  createKitchenReadyEventBundle,
  createKitchenReadyEventSemanticBinding,
  parseKitchenItemReadyEnvelope,
  parseKitchenOrderReadyEnvelope,
} from "./kitchen-ready-events.js";
import {
  createKitchenWorkLifecycleEventSemanticBinding,
  createKitchenWorkLifecycleEnvelope,
  parseKitchenWorkLifecycleEnvelope,
} from "./kitchen-work-lifecycle-events.js";
import type {
  KitchenOrderItemReadyResult,
  KitchenReadyPublication,
  KitchenWorkLifecycleActionCode,
  KitchenWorkLifecycleCommit,
  KitchenWorkLifecycleEffect,
  KitchenWorkLifecycleMutation,
  KitchenWorkLifecycleOperationRecord,
  KitchenWorkLifecyclePorts,
  KitchenWorkLifecycleReasonCode,
  KitchenWorkLifecycleReferencePurpose,
  KitchenWorkLifecycleResolution,
  KitchenWorkLifecycleStableReferencePurpose,
} from "./ports/kitchen-work-lifecycle-ports.js";

const dayMs = 86_400_000;
const postgresqlBigintMaximum = 9_223_372_036_854_775_807n;

function fail(code: ConstructorParameters<typeof KitchenWorkLifecycleError>[0]): never {
  throw new KitchenWorkLifecycleError(code);
}

function dependency(): never {
  return fail("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
}

function conflict(): never {
  return fail("KITCHEN_WORK_VERSION_CONFLICT");
}

function precondition(): never {
  return fail("KITCHEN_WORK_PRECONDITION_FAILED");
}

function notFound(): never {
  return fail("KITCHEN_WORK_NOT_FOUND");
}

function exact(
  value: unknown,
  fields: readonly string[],
  onInvalid: () => never = dependency,
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      isProxy(value) ||
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

function exactArray(
  value: unknown,
  minimum: number,
  maximum: number,
  onInvalid: () => never = dependency,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
      return onInvalid();
    if (value.length < minimum || value.length > maximum) return onInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const descriptor = descriptors[key];
        return (
          Number(key) >= value.length ||
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      }) ||
      Array.from({ length: value.length }, (_, index) => String(index)).some(
        (key) => !(key in descriptors),
      )
    )
      return onInvalid();
    return Object.freeze(
      Array.from(
        { length: value.length },
        (_, index) => (descriptors[String(index)] as PropertyDescriptor).value,
      ),
    );
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    return onInvalid();
  }
}

function dataField(value: unknown, field: string): unknown {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    )
      return dependency();
    return descriptor.value;
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    return dependency();
  }
}

function parseReference(value: unknown): string {
  try {
    return parseKitchenTicketReference(value);
  } catch {
    return dependency();
  }
}

function parseInstant(value: unknown): string {
  try {
    return parseKitchenTicketInstant(value);
  } catch {
    return dependency();
  }
}

function parseDigest(value: unknown): string {
  try {
    return parseKitchenTicketDigest(value);
  } catch {
    return dependency();
  }
}

function parseBigint(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > postgresqlBigintMaximum)
    return dependency();
  return value;
}

function parseNullableBigint(value: unknown): bigint | null {
  return value === null ? null : parseBigint(value);
}

function parseQuantity(value: unknown, minimum = 0, maximum = 999): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return dependency();
  return value as number;
}

function parseNullableQuantity(value: unknown, minimum = 0, maximum = 999): number | null {
  return value === null ? null : parseQuantity(value, minimum, maximum);
}

function parseStatus(value: unknown): KitchenLifecycleWorkItemStatus {
  if (
    value !== "Queued" &&
    value !== "Held" &&
    value !== "In Progress" &&
    value !== "Completed" &&
    value !== "Cancelled"
  )
    return dependency();
  return value;
}

function parseNullableStatus(value: unknown): KitchenLifecycleWorkItemStatus | null {
  return value === null ? null : parseStatus(value);
}

function parseStoredIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 200 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9:_-]{14,198}[A-Za-z0-9])$/.test(value)
  )
    return dependency();
  return value;
}

function purposeFor(action: KitchenWorkLifecycleAction): KitchenWorkLifecyclePurpose {
  return action === "MarkKitchenOrderItemReady"
    ? "KitchenExpoCoordination"
    : "KitchenWorkExecution";
}

function actionCodeFor(action: KitchenWorkLifecycleAction): KitchenWorkLifecycleActionCode {
  if (action === "AcceptKitchenWorkItem") return "KITCHEN_WORK_ITEM_ACCEPTED";
  if (action === "StartKitchenWorkItem") return "KITCHEN_WORK_ITEM_STARTED";
  if (action === "CompleteKitchenWorkItem") return "KITCHEN_WORK_ITEM_COMPLETION_RECORDED";
  return "KITCHEN_ORDER_ITEM_READY";
}

function reasonFor(action: KitchenWorkLifecycleAction): KitchenWorkLifecycleReasonCode {
  if (action === "AcceptKitchenWorkItem") return "WORK_ITEM_ACCEPTED";
  if (action === "StartKitchenWorkItem") return "WORK_ITEM_STARTED";
  if (action === "CompleteKitchenWorkItem") return "COMPLETION_QUANTITY_RECORDED";
  return "EXPO_MARKED_READY";
}

function digest(ports: KitchenWorkLifecyclePorts, binding: string): string {
  try {
    return parseKitchenTicketDigest(ports.digests.sha256(binding));
  } catch {
    return dependency();
  }
}

function nextReference(
  ports: KitchenWorkLifecyclePorts,
  purpose: KitchenWorkLifecycleReferencePurpose,
): string {
  try {
    return parseKitchenTicketReference(ports.references.next(purpose));
  } catch {
    return dependency();
  }
}

function stableReference(
  ports: KitchenWorkLifecyclePorts,
  purpose: KitchenWorkLifecycleStableReferencePurpose,
  identity: unknown,
): string {
  try {
    return parseKitchenTicketReference(
      ports.references.derive(purpose, canonicalizeKitchenWorkLifecycle(identity)),
    );
  } catch {
    return dependency();
  }
}

function ensureDistinct(generated: readonly string[], observed: readonly string[]) {
  if (
    new Set(generated).size !== generated.length ||
    generated.some((reference) => observed.includes(reference))
  )
    return dependency();
}

function parseResolution(value: KitchenWorkLifecycleResolution): KitchenWorkLifecycleResolution {
  const status = dataField(value, "status");
  const snapshot = exact(value, status === "NotFound" ? ["status"] : ["status", "effect"]);
  if (snapshot.status === "NotFound") return Object.freeze({ status: "NotFound" });
  if (snapshot.status !== "Found") return dependency();
  return Object.freeze({ status: "Found", effect: snapshot.effect });
}

function parseCommit(value: KitchenWorkLifecycleCommit): KitchenWorkLifecycleCommit {
  const status = dataField(value, "status");
  const snapshot = exact(value, status === "Conflict" ? ["status"] : ["status", "effect"]);
  if (snapshot.status === "Conflict") return Object.freeze({ status: "Conflict" });
  if (snapshot.status !== "Committed") return dependency();
  return Object.freeze({ status: "Committed", effect: snapshot.effect });
}

function sameCommandIntent(
  ports: KitchenWorkLifecyclePorts,
  command: KitchenWorkLifecycleCommand,
  storedIntentDigest: string,
): boolean {
  return digest(ports, createKitchenWorkLifecycleIntentBinding(command)) === storedIntentDigest;
}

function parseOperation(value: unknown): KitchenWorkLifecycleOperationRecord {
  const raw = exact(value, [
    "operationReference",
    "idempotencyKey",
    "intentDigest",
    "action",
    "actionCode",
    "purpose",
    "reasonCode",
    "sourceChannel",
    "actorType",
    "actorReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "expectedTicketVersion",
    "resultTicketVersion",
    "expectedWorkItemVersion",
    "resultWorkItemVersion",
    "beforeStatus",
    "afterStatus",
    "quantityDelta",
    "completedQuantity",
    "requiredQuantity",
    "acceptedOperationReference",
    "startedOperationReference",
    "admissionDecision",
    "capturedExpo",
    "parentOperationReference",
    "readyResultReference",
    "auditReference",
    "auditSemanticDigest",
    "eventReference",
    "eventSemanticDigest",
    "correlationReference",
    "causationReference",
    "occurredAt",
    "replayExpiresAt",
  ]);
  if (
    raw.action !== "AcceptKitchenWorkItem" &&
    raw.action !== "StartKitchenWorkItem" &&
    raw.action !== "CompleteKitchenWorkItem" &&
    raw.action !== "MarkKitchenOrderItemReady" &&
    raw.action !== "AutomaticKitchenOrderItemReady"
  )
    return dependency();
  if (
    raw.actionCode !== "KITCHEN_WORK_ITEM_ACCEPTED" &&
    raw.actionCode !== "KITCHEN_WORK_ITEM_STARTED" &&
    raw.actionCode !== "KITCHEN_WORK_ITEM_COMPLETION_RECORDED" &&
    raw.actionCode !== "KITCHEN_ORDER_ITEM_READY"
  )
    return dependency();
  if (raw.purpose !== "KitchenWorkExecution" && raw.purpose !== "KitchenExpoCoordination")
    return dependency();
  if (
    raw.reasonCode !== "WORK_ITEM_ACCEPTED" &&
    raw.reasonCode !== "WORK_ITEM_STARTED" &&
    raw.reasonCode !== "COMPLETION_QUANTITY_RECORDED" &&
    raw.reasonCode !== "EXPO_MARKED_READY" &&
    raw.reasonCode !== "ALL_WORK_ITEMS_COMPLETED"
  )
    return dependency();
  if (raw.sourceChannel !== "KDS_COMMAND" && raw.sourceChannel !== "KITCHEN_AUTOMATION")
    return dependency();
  if (raw.actorType !== "User" && raw.actorType !== "System") return dependency();

  const operation = Object.freeze({
    operationReference: parseReference(raw.operationReference),
    idempotencyKey:
      raw.idempotencyKey === null ? null : parseStoredIdempotencyKey(raw.idempotencyKey),
    intentDigest: raw.intentDigest === null ? null : parseDigest(raw.intentDigest),
    action: raw.action,
    actionCode: raw.actionCode,
    purpose: raw.purpose,
    reasonCode: raw.reasonCode,
    sourceChannel: raw.sourceChannel,
    actorType: raw.actorType,
    actorReference: raw.actorReference === null ? null : parseReference(raw.actorReference),
    brandReference: parseReference(raw.brandReference),
    storeReference: parseReference(raw.storeReference),
    ticketReference: parseReference(raw.ticketReference),
    workItemReference:
      raw.workItemReference === null ? null : parseReference(raw.workItemReference),
    orderItemReference: parseReference(raw.orderItemReference),
    expectedTicketVersion: parseNullableBigint(raw.expectedTicketVersion),
    resultTicketVersion: parseBigint(raw.resultTicketVersion),
    expectedWorkItemVersion: parseNullableBigint(raw.expectedWorkItemVersion),
    resultWorkItemVersion: parseNullableBigint(raw.resultWorkItemVersion),
    beforeStatus: parseNullableStatus(raw.beforeStatus),
    afterStatus: parseNullableStatus(raw.afterStatus),
    quantityDelta: parseNullableQuantity(raw.quantityDelta, 1),
    completedQuantity: parseNullableQuantity(raw.completedQuantity),
    requiredQuantity: parseNullableQuantity(raw.requiredQuantity, 1),
    acceptedOperationReference:
      raw.acceptedOperationReference === null
        ? null
        : parseReference(raw.acceptedOperationReference),
    startedOperationReference:
      raw.startedOperationReference === null ? null : parseReference(raw.startedOperationReference),
    admissionDecision:
      raw.admissionDecision === null
        ? null
        : parseKitchenStartAdmissionDecision(raw.admissionDecision),
    capturedExpo:
      raw.capturedExpo === null ? null : parseKitchenCapturedExpoDecision(raw.capturedExpo),
    parentOperationReference:
      raw.parentOperationReference === null ? null : parseReference(raw.parentOperationReference),
    readyResultReference:
      raw.readyResultReference === null ? null : parseReference(raw.readyResultReference),
    auditReference: parseReference(raw.auditReference),
    auditSemanticDigest: parseDigest(raw.auditSemanticDigest),
    eventReference: raw.eventReference === null ? null : parseReference(raw.eventReference),
    eventSemanticDigest:
      raw.eventSemanticDigest === null ? null : parseDigest(raw.eventSemanticDigest),
    correlationReference: parseReference(raw.correlationReference),
    causationReference:
      raw.causationReference === null ? null : parseReference(raw.causationReference),
    occurredAt: parseInstant(raw.occurredAt),
    replayExpiresAt: raw.replayExpiresAt === null ? null : parseInstant(raw.replayExpiresAt),
  }) satisfies KitchenWorkLifecycleOperationRecord;

  const automatic = operation.action === "AutomaticKitchenOrderItemReady";
  if ((operation.actorType === "User") !== (operation.actorReference !== null)) return dependency();
  if ((operation.eventReference === null) !== (operation.eventSemanticDigest === null))
    return dependency();
  if (automatic) {
    if (
      operation.actionCode !== "KITCHEN_ORDER_ITEM_READY" ||
      operation.purpose !== "KitchenExpoCoordination" ||
      operation.reasonCode !== "ALL_WORK_ITEMS_COMPLETED" ||
      operation.sourceChannel !== "KITCHEN_AUTOMATION" ||
      operation.actorType !== "System" ||
      operation.workItemReference !== null ||
      operation.idempotencyKey !== null ||
      operation.intentDigest !== null ||
      operation.expectedTicketVersion !== null ||
      operation.expectedWorkItemVersion !== null ||
      operation.resultWorkItemVersion !== null ||
      operation.beforeStatus !== null ||
      operation.afterStatus !== null ||
      operation.quantityDelta !== null ||
      operation.completedQuantity !== null ||
      operation.requiredQuantity !== null ||
      operation.acceptedOperationReference !== null ||
      operation.startedOperationReference !== null ||
      operation.admissionDecision !== null ||
      operation.capturedExpo !== null ||
      operation.parentOperationReference === null ||
      operation.readyResultReference === null ||
      operation.eventReference !== null ||
      operation.causationReference !== operation.parentOperationReference ||
      operation.replayExpiresAt !== null
    )
      return dependency();
    return operation;
  }

  if (
    operation.actorType !== "User" ||
    operation.sourceChannel !== "KDS_COMMAND" ||
    operation.idempotencyKey === null ||
    operation.intentDigest === null ||
    operation.expectedTicketVersion === null ||
    operation.expectedWorkItemVersion === null ||
    operation.resultWorkItemVersion === null ||
    operation.beforeStatus === null ||
    operation.afterStatus === null ||
    operation.completedQuantity === null ||
    operation.requiredQuantity === null ||
    operation.parentOperationReference !== null ||
    operation.causationReference !== null ||
    operation.replayExpiresAt === null ||
    operation.resultTicketVersion !== operation.expectedTicketVersion + 1n
  )
    return dependency();
  if (operation.replayExpiresAt !== replayExpiry(operation.occurredAt)) return dependency();

  const workAdvances = operation.resultWorkItemVersion === operation.expectedWorkItemVersion + 1n;
  if (operation.action === "AcceptKitchenWorkItem") {
    if (
      operation.actionCode !== "KITCHEN_WORK_ITEM_ACCEPTED" ||
      operation.purpose !== "KitchenWorkExecution" ||
      operation.reasonCode !== "WORK_ITEM_ACCEPTED" ||
      operation.workItemReference === null ||
      !workAdvances ||
      operation.beforeStatus !== "Queued" ||
      operation.afterStatus !== "Queued" ||
      operation.quantityDelta !== null ||
      operation.completedQuantity !== 0 ||
      operation.acceptedOperationReference !== null ||
      operation.startedOperationReference !== null ||
      operation.admissionDecision !== null ||
      operation.capturedExpo !== null ||
      operation.readyResultReference !== null ||
      operation.eventReference === null
    )
      return dependency();
  } else if (operation.action === "StartKitchenWorkItem") {
    if (
      operation.actionCode !== "KITCHEN_WORK_ITEM_STARTED" ||
      operation.purpose !== "KitchenWorkExecution" ||
      operation.reasonCode !== "WORK_ITEM_STARTED" ||
      operation.workItemReference === null ||
      !workAdvances ||
      operation.beforeStatus !== "Queued" ||
      operation.afterStatus !== "In Progress" ||
      operation.quantityDelta !== null ||
      operation.completedQuantity !== 0 ||
      operation.acceptedOperationReference === null ||
      operation.startedOperationReference !== null ||
      operation.admissionDecision === null ||
      operation.admissionDecision.outcome !== "Allowed" ||
      operation.capturedExpo !== null ||
      operation.readyResultReference !== null ||
      operation.eventReference === null
    )
      return dependency();
  } else if (operation.action === "CompleteKitchenWorkItem") {
    if (
      operation.actionCode !== "KITCHEN_WORK_ITEM_COMPLETION_RECORDED" ||
      operation.purpose !== "KitchenWorkExecution" ||
      operation.reasonCode !== "COMPLETION_QUANTITY_RECORDED" ||
      operation.workItemReference === null ||
      !workAdvances ||
      operation.beforeStatus !== "In Progress" ||
      operation.quantityDelta === null ||
      operation.completedQuantity <= 0 ||
      operation.acceptedOperationReference === null ||
      operation.startedOperationReference === null ||
      operation.admissionDecision !== null ||
      operation.eventReference === null ||
      (operation.afterStatus === "In Progress" &&
        (operation.completedQuantity >= operation.requiredQuantity ||
          operation.capturedExpo !== null ||
          operation.readyResultReference !== null)) ||
      (operation.afterStatus === "Completed" &&
        (operation.completedQuantity !== operation.requiredQuantity ||
          operation.capturedExpo === null ||
          (operation.capturedExpo.mode === "Enabled") !==
            (operation.readyResultReference === null))) ||
      (operation.afterStatus !== "In Progress" && operation.afterStatus !== "Completed")
    )
      return dependency();
  } else if (
    operation.actionCode !== "KITCHEN_ORDER_ITEM_READY" ||
    operation.purpose !== "KitchenExpoCoordination" ||
    operation.reasonCode !== "EXPO_MARKED_READY" ||
    operation.workItemReference !== null ||
    operation.resultWorkItemVersion !== operation.expectedWorkItemVersion ||
    operation.beforeStatus !== "Completed" ||
    operation.afterStatus !== "Completed" ||
    operation.quantityDelta !== null ||
    operation.completedQuantity !== operation.requiredQuantity ||
    operation.acceptedOperationReference !== null ||
    operation.startedOperationReference !== null ||
    operation.admissionDecision !== null ||
    operation.capturedExpo === null ||
    operation.capturedExpo.mode !== "Enabled" ||
    operation.readyResultReference === null ||
    operation.eventReference !== null
  )
    return dependency();
  return operation;
}

function parseMutation(value: unknown): KitchenWorkLifecycleMutation {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "expectedTicketVersion",
    "resultTicketVersion",
    "expectedWorkItemVersion",
    "resultWorkItemVersion",
    "beforeStatus",
    "afterStatus",
    "beforeCompletedQuantity",
    "afterCompletedQuantity",
    "requiredQuantity",
    "updatedAt",
  ]);
  const mutation = Object.freeze({
    brandReference: parseReference(raw.brandReference),
    storeReference: parseReference(raw.storeReference),
    ticketReference: parseReference(raw.ticketReference),
    workItemReference: parseReference(raw.workItemReference),
    orderItemReference: parseReference(raw.orderItemReference),
    expectedTicketVersion: parseBigint(raw.expectedTicketVersion),
    resultTicketVersion: parseBigint(raw.resultTicketVersion),
    expectedWorkItemVersion: parseBigint(raw.expectedWorkItemVersion),
    resultWorkItemVersion: parseBigint(raw.resultWorkItemVersion),
    beforeStatus: parseStatus(raw.beforeStatus),
    afterStatus: parseStatus(raw.afterStatus),
    beforeCompletedQuantity: parseQuantity(raw.beforeCompletedQuantity),
    afterCompletedQuantity: parseQuantity(raw.afterCompletedQuantity),
    requiredQuantity: parseQuantity(raw.requiredQuantity, 1),
    updatedAt: parseInstant(raw.updatedAt),
  });
  const quantityValid = (status: KitchenLifecycleWorkItemStatus, completed: number) =>
    status === "Queued"
      ? completed === 0
      : status === "In Progress"
        ? completed >= 0 && completed < mutation.requiredQuantity
        : status === "Completed"
          ? completed === mutation.requiredQuantity
          : completed >= 0 && completed <= mutation.requiredQuantity;
  if (
    mutation.resultTicketVersion !== mutation.expectedTicketVersion + 1n ||
    (mutation.resultWorkItemVersion !== mutation.expectedWorkItemVersion &&
      mutation.resultWorkItemVersion !== mutation.expectedWorkItemVersion + 1n) ||
    !quantityValid(mutation.beforeStatus, mutation.beforeCompletedQuantity) ||
    !quantityValid(mutation.afterStatus, mutation.afterCompletedQuantity)
  )
    return dependency();
  return mutation;
}

function parseReadyResult(value: unknown): KitchenOrderItemReadyResult {
  const raw = exact(value, [
    "readyResultReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "orderItemReference",
    "causalOperationReference",
    "actorType",
    "actorReference",
    "workItems",
    "workItemsDigest",
    "readyQuantity",
    "requiredQuantity",
    "capturedExpo",
    "readyAt",
  ]);
  const itemRaw = exact(exactArray(raw.workItems, 1, 1)[0], [
    "workItemReference",
    "workItemVersion",
  ]);
  if (typeof raw.actorType !== "string" || !["User", "System"].includes(raw.actorType))
    return dependency();
  const actorType = raw.actorType as "User" | "System";
  const actorReference = raw.actorReference === null ? null : parseReference(raw.actorReference);
  if ((actorType === "User") !== (actorReference !== null)) return dependency();
  const requiredQuantity = parseQuantity(raw.requiredQuantity, 1);
  const readyQuantity = parseQuantity(raw.readyQuantity, 1, requiredQuantity);
  if (readyQuantity !== requiredQuantity) return dependency();
  return Object.freeze({
    readyResultReference: parseReference(raw.readyResultReference),
    brandReference: parseReference(raw.brandReference),
    storeReference: parseReference(raw.storeReference),
    ticketReference: parseReference(raw.ticketReference),
    orderItemReference: parseReference(raw.orderItemReference),
    causalOperationReference: parseReference(raw.causalOperationReference),
    actorType,
    actorReference,
    workItems: Object.freeze([
      Object.freeze({
        workItemReference: parseReference(itemRaw.workItemReference),
        workItemVersion: parseBigint(itemRaw.workItemVersion),
      }),
    ] as const),
    workItemsDigest: parseDigest(raw.workItemsDigest),
    readyQuantity,
    requiredQuantity,
    capturedExpo: parseKitchenCapturedExpoDecision(raw.capturedExpo),
    readyAt: parseInstant(raw.readyAt),
  });
}

function parseReadyPublication(
  value: unknown,
  ports: KitchenWorkLifecyclePorts,
): KitchenReadyPublication {
  const raw = exact(value, [
    "publicationReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "readyResultReference",
    "ticketVersion",
    "readyQuantity",
    "requiredQuantity",
    "itemCount",
    "itemEvent",
    "itemEventSemanticDigest",
    "orderEvent",
    "orderEventSemanticDigest",
    "correlationReference",
    "causationReference",
    "occurredAt",
  ]);
  let itemEvent;
  let orderEvent;
  try {
    itemEvent = parseKitchenItemReadyEnvelope(raw.itemEvent);
    orderEvent = raw.orderEvent === null ? null : parseKitchenOrderReadyEnvelope(raw.orderEvent);
  } catch {
    return dependency();
  }
  const requiredQuantity = parseQuantity(raw.requiredQuantity, 1, 999);
  const readyQuantity = parseQuantity(raw.readyQuantity, 1, requiredQuantity);
  const itemCount = parseQuantity(raw.itemCount, 1, 100);
  const publication = Object.freeze({
    publicationReference: parseReference(raw.publicationReference),
    brandReference: parseReference(raw.brandReference),
    storeReference: parseReference(raw.storeReference),
    ticketReference: parseReference(raw.ticketReference),
    orderReference: parseReference(raw.orderReference),
    orderBatchReference: parseReference(raw.orderBatchReference),
    orderItemReference: parseReference(raw.orderItemReference),
    readyResultReference: parseReference(raw.readyResultReference),
    ticketVersion: parseBigint(raw.ticketVersion),
    readyQuantity,
    requiredQuantity,
    itemCount,
    itemEvent,
    itemEventSemanticDigest: parseDigest(raw.itemEventSemanticDigest),
    orderEvent,
    orderEventSemanticDigest:
      raw.orderEventSemanticDigest === null ? null : parseDigest(raw.orderEventSemanticDigest),
    correlationReference: parseReference(raw.correlationReference),
    causationReference: parseReference(raw.causationReference),
    occurredAt: parseInstant(raw.occurredAt),
  });
  if (
    readyQuantity !== requiredQuantity ||
    (orderEvent === null) !== (publication.orderEventSemanticDigest === null) ||
    itemEvent.tenantId !== publication.brandReference ||
    itemEvent.storeId !== publication.storeReference ||
    itemEvent.payload.kitchenTicketReference !== publication.ticketReference ||
    itemEvent.payload.orderReference !== publication.orderReference ||
    itemEvent.payload.orderBatchReference !== publication.orderBatchReference ||
    itemEvent.payload.orderItemReference !== publication.orderItemReference ||
    itemEvent.payload.readyResultReference !== publication.readyResultReference ||
    itemEvent.payload.readyQuantity !== publication.readyQuantity ||
    itemEvent.payload.requiredQuantity !== publication.requiredQuantity ||
    itemEvent.correlationId !== publication.correlationReference ||
    itemEvent.causationId !== publication.causationReference ||
    itemEvent.occurredAt !== publication.occurredAt ||
    publication.itemEventSemanticDigest !==
      digest(ports, createKitchenReadyEventSemanticBinding(itemEvent)) ||
    (orderEvent !== null &&
      (orderEvent.tenantId !== publication.brandReference ||
        orderEvent.storeId !== publication.storeReference ||
        orderEvent.aggregateId !== publication.ticketReference ||
        orderEvent.aggregateVersion !== publication.ticketVersion ||
        orderEvent.payload.orderReference !== publication.orderReference ||
        orderEvent.payload.orderBatchReference !== publication.orderBatchReference ||
        orderEvent.payload.itemCount !== publication.itemCount ||
        orderEvent.payload.readyItemCount !== publication.itemCount ||
        orderEvent.correlationId !== publication.correlationReference ||
        orderEvent.causationId !== publication.causationReference ||
        orderEvent.occurredAt !== publication.occurredAt ||
        publication.orderEventSemanticDigest !==
          digest(ports, createKitchenReadyEventSemanticBinding(orderEvent))))
  )
    return dependency();
  return publication;
}

function parseAudit(value: unknown): AppendAuditRecordInput {
  const raw = exact(value, [
    "auditId",
    "brandId",
    "storeId",
    "actor",
    "actionCode",
    "targetType",
    "targetId",
    "beforeSummary",
    "afterSummary",
    "reasonCode",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "dataClassification",
    "retentionPolicyCode",
    "retentionPolicyVersion",
  ]);
  const actorRaw =
    dataField(raw.actor, "type") === "System"
      ? exact(raw.actor, ["type"])
      : exact(raw.actor, ["type", "reference"]);
  const actor =
    actorRaw.type === "System"
      ? Object.freeze({ type: "System" as const })
      : actorRaw.type === "User"
        ? Object.freeze({ type: "User" as const, reference: parseReference(actorRaw.reference) })
        : dependency();
  const before = exact(raw.beforeSummary, [
    "status",
    "ticketVersion",
    "workItemVersion",
    "completedQuantity",
    "requiredQuantity",
  ]);
  const after = exact(raw.afterSummary, [
    "status",
    "ticketVersion",
    "workItemVersion",
    "completedQuantity",
    "requiredQuantity",
  ]);
  const candidate = Object.freeze({
    auditId: parseReference(raw.auditId),
    brandId: parseReference(raw.brandId),
    storeId: parseReference(raw.storeId),
    actor,
    actionCode: raw.actionCode as string,
    targetType: raw.targetType as string,
    targetId: parseReference(raw.targetId),
    beforeSummary: Object.freeze({
      status: before.status as string,
      ticketVersion: before.ticketVersion as string,
      workItemVersion: before.workItemVersion as string,
      completedQuantity: before.completedQuantity as number,
      requiredQuantity: before.requiredQuantity as number,
    }),
    afterSummary: Object.freeze({
      status: after.status as string,
      ticketVersion: after.ticketVersion as string,
      workItemVersion: after.workItemVersion as string,
      completedQuantity: after.completedQuantity as number,
      requiredQuantity: after.requiredQuantity as number,
    }),
    reasonCode: raw.reasonCode as string,
    correlationId: parseReference(raw.correlationId),
    occurredAt: parseInstant(raw.occurredAt),
    sourceChannel: raw.sourceChannel as string,
    dataClassification: raw.dataClassification as "Confidential",
    retentionPolicyCode: raw.retentionPolicyCode as string,
    retentionPolicyVersion: raw.retentionPolicyVersion as number,
  });
  try {
    validateAuditRecord(candidate, Date.parse(candidate.occurredAt));
  } catch {
    return dependency();
  }
  if (
    candidate.dataClassification !== "Confidential" ||
    candidate.retentionPolicyCode !== kitchenWorkLifecycleAuditRetentionPolicyCode ||
    candidate.retentionPolicyVersion !== kitchenWorkLifecycleAuditRetentionPolicyVersion
  )
    return dependency();
  return candidate;
}

export function createKitchenWorkLifecycleAuditSemanticBinding(value: unknown): string {
  return canonicalizeKitchenWorkLifecycle(parseAudit(value));
}

function effectBinding(effect: Omit<KitchenWorkLifecycleEffect, "effectDigest">): string {
  return canonicalizeKitchenWorkLifecycle(effect);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalizeKitchenWorkLifecycle(left) === canonicalizeKitchenWorkLifecycle(right);
}

function effectSemantics(
  effect: Omit<KitchenWorkLifecycleEffect, "effectDigest">,
  ports: KitchenWorkLifecyclePorts,
): boolean {
  try {
    const {
      command,
      intentDigest,
      operation,
      mutation,
      readyResult,
      automaticReadyOperation,
      automaticReadyEffectDigest,
      audits,
      event,
      readyPublication,
      result,
    } = effect;
    const parentAudit = audits[0];
    if (parentAudit === undefined) return false;
    const markReady = command.action === "MarkKitchenOrderItemReady";
    const commandWorkItemReference = markReady
      ? command.workItems[0].workItemReference
      : command.workItemReference;
    const commandWorkItemVersion = BigInt(
      markReady ? command.workItems[0].expectedWorkItemVersion : command.expectedWorkItemVersion,
    );
    const commandTicketVersion = BigInt(command.expectedTicketVersion);
    const automatic = result.outcome === "CompletedAndOrderItemReady";
    const anyReady = automatic || result.outcome === "OrderItemReady";

    if (
      operation.idempotencyKey !== command.idempotencyKey ||
      operation.intentDigest !== intentDigest ||
      operation.action !== command.action ||
      operation.actionCode !== actionCodeFor(command.action) ||
      operation.purpose !== purposeFor(command.action) ||
      operation.reasonCode !== reasonFor(command.action) ||
      operation.sourceChannel !== "KDS_COMMAND" ||
      operation.actorType !== "User" ||
      operation.actorReference !== command.actorReference ||
      operation.brandReference !== command.brandReference ||
      operation.storeReference !== command.storeReference ||
      operation.ticketReference !== command.ticketReference ||
      operation.workItemReference !== (markReady ? null : commandWorkItemReference) ||
      operation.orderItemReference !== command.orderItemReference ||
      operation.operationReference !== result.operationReference ||
      operation.expectedTicketVersion !== commandTicketVersion ||
      operation.resultTicketVersion !== mutation.resultTicketVersion ||
      operation.expectedWorkItemVersion !== commandWorkItemVersion ||
      operation.resultWorkItemVersion !== mutation.resultWorkItemVersion ||
      operation.beforeStatus !== mutation.beforeStatus ||
      operation.afterStatus !== mutation.afterStatus ||
      operation.completedQuantity !== mutation.afterCompletedQuantity ||
      operation.requiredQuantity !== mutation.requiredQuantity ||
      operation.occurredAt !== result.occurredAt ||
      operation.correlationReference !== command.correlationReference ||
      operation.causationReference !== null ||
      operation.auditReference !== parentAudit.auditId ||
      operation.auditSemanticDigest !==
        digest(ports, createKitchenWorkLifecycleAuditSemanticBinding(parentAudit)) ||
      operation.eventReference !== (event?.eventId ?? null) ||
      operation.eventSemanticDigest !==
        (event === null
          ? null
          : digest(ports, createKitchenWorkLifecycleEventSemanticBinding(event))) ||
      operation.readyResultReference !== result.readyResultReference ||
      mutation.brandReference !== command.brandReference ||
      mutation.storeReference !== command.storeReference ||
      mutation.ticketReference !== command.ticketReference ||
      mutation.orderItemReference !== command.orderItemReference ||
      mutation.workItemReference !== commandWorkItemReference ||
      mutation.expectedTicketVersion !== commandTicketVersion ||
      mutation.expectedWorkItemVersion !== commandWorkItemVersion ||
      mutation.resultTicketVersion.toString() !== result.ticketVersion ||
      mutation.resultWorkItemVersion.toString() !== result.workItemVersion ||
      mutation.afterStatus !== result.workItemStatus ||
      mutation.afterCompletedQuantity !== result.completedQuantity ||
      mutation.requiredQuantity !== result.requiredQuantity ||
      mutation.updatedAt !== result.occurredAt ||
      result.action !== command.action ||
      result.ticketReference !== command.ticketReference ||
      result.workItemReference !== commandWorkItemReference ||
      result.orderItemReference !== command.orderItemReference ||
      anyReady !== (readyResult !== null) ||
      anyReady !== (readyPublication !== null) ||
      automatic !== (automaticReadyOperation !== null) ||
      automatic !== (automaticReadyEffectDigest !== null) ||
      audits.length !== (automatic ? 2 : 1)
    )
      return false;

    if (command.action === "AcceptKitchenWorkItem") {
      if (
        result.outcome !== "Accepted" ||
        mutation.resultWorkItemVersion !== mutation.expectedWorkItemVersion + 1n ||
        mutation.beforeStatus !== "Queued" ||
        mutation.afterStatus !== "Queued" ||
        mutation.beforeCompletedQuantity !== 0 ||
        mutation.afterCompletedQuantity !== 0 ||
        operation.quantityDelta !== null ||
        operation.acceptedOperationReference !== null ||
        operation.startedOperationReference !== null ||
        operation.admissionDecision !== null ||
        operation.capturedExpo !== null ||
        readyResult !== null ||
        automaticReadyOperation !== null
      )
        return false;
    } else if (command.action === "StartKitchenWorkItem") {
      const admission = operation.admissionDecision;
      if (
        result.outcome !== "Started" ||
        mutation.resultWorkItemVersion !== mutation.expectedWorkItemVersion + 1n ||
        mutation.beforeStatus !== "Queued" ||
        mutation.afterStatus !== "In Progress" ||
        mutation.beforeCompletedQuantity !== 0 ||
        mutation.afterCompletedQuantity !== 0 ||
        operation.quantityDelta !== null ||
        operation.acceptedOperationReference === null ||
        operation.startedOperationReference !== null ||
        admission === null ||
        admission.outcome !== "Allowed" ||
        admission.actorReference !== command.actorReference ||
        admission.brandReference !== command.brandReference ||
        admission.storeReference !== command.storeReference ||
        admission.ticketReference !== command.ticketReference ||
        admission.workItemReference !== command.workItemReference ||
        admission.acceptedOperationReference !== operation.acceptedOperationReference ||
        admission.ticketVersion !== mutation.expectedTicketVersion ||
        admission.workItemVersion !== mutation.expectedWorkItemVersion ||
        Date.parse(admission.evaluatedAt) > Date.parse(operation.occurredAt) ||
        Date.parse(operation.occurredAt) >= Date.parse(admission.validUntil) ||
        operation.capturedExpo !== null ||
        readyResult !== null ||
        automaticReadyOperation !== null
      )
        return false;
    } else if (command.action === "CompleteKitchenWorkItem") {
      const captured = operation.capturedExpo;
      const final = result.outcome !== "ProgressRecorded";
      if (
        mutation.resultWorkItemVersion !== mutation.expectedWorkItemVersion + 1n ||
        mutation.beforeStatus !== "In Progress" ||
        mutation.afterCompletedQuantity !==
          mutation.beforeCompletedQuantity + command.quantityDelta ||
        operation.quantityDelta !== command.quantityDelta ||
        operation.acceptedOperationReference === null ||
        operation.startedOperationReference === null ||
        operation.acceptedOperationReference === operation.startedOperationReference ||
        operation.admissionDecision !== null ||
        (result.outcome === "ProgressRecorded" &&
          (mutation.afterStatus !== "In Progress" ||
            mutation.afterCompletedQuantity >= mutation.requiredQuantity ||
            captured !== null ||
            readyResult !== null ||
            automaticReadyOperation !== null)) ||
        (final &&
          (mutation.afterStatus !== "Completed" ||
            mutation.afterCompletedQuantity !== mutation.requiredQuantity ||
            captured === null))
      )
        return false;
      if (captured !== null) {
        if (
          captured.sourceOperationReference !== operation.operationReference ||
          captured.ticketReference !== command.ticketReference ||
          captured.workItemReference !== command.workItemReference ||
          captured.orderItemReference !== command.orderItemReference ||
          captured.sourceExpectedTicketVersion !== mutation.expectedTicketVersion ||
          captured.sourceCommittedTicketVersion !== mutation.resultTicketVersion ||
          captured.sourceExpectedWorkItemVersion !== mutation.expectedWorkItemVersion ||
          captured.sourceCommittedWorkItemVersion !== mutation.resultWorkItemVersion ||
          captured.sourceBeforeStatus !== mutation.beforeStatus ||
          captured.sourceAfterStatus !== mutation.afterStatus ||
          captured.sourceCompletedQuantity !== mutation.afterCompletedQuantity ||
          captured.sourceRequiredQuantity !== mutation.requiredQuantity ||
          captured.sourceOutcome !== result.outcome ||
          captured.sourceOccurredAt !== operation.occurredAt ||
          Date.parse(captured.evaluatedAt) > Date.parse(captured.sourceOccurredAt) ||
          Date.parse(captured.sourceOccurredAt) >= Date.parse(captured.validUntil) ||
          captured.decisionBrandReference !== command.brandReference ||
          captured.decisionStoreReference !== command.storeReference ||
          captured.sourceOperationReference === captured.decisionReference ||
          [captured.sourceOperationReference, captured.decisionReference].some((reference) =>
            [
              command.brandReference,
              command.storeReference,
              command.ticketReference,
              command.workItemReference,
              command.orderItemReference,
            ].includes(reference),
          ) ||
          (result.outcome === "Completed") !== (captured.mode === "Enabled") ||
          digest(ports, createKitchenCapturedExpoBinding(captured)) !==
            captured.capturedExpoBindingDigest
        )
          return false;
      }
    } else {
      const captured = operation.capturedExpo;
      if (
        result.outcome !== "OrderItemReady" ||
        mutation.resultWorkItemVersion !== mutation.expectedWorkItemVersion ||
        mutation.beforeStatus !== "Completed" ||
        mutation.afterStatus !== "Completed" ||
        mutation.beforeCompletedQuantity !== mutation.requiredQuantity ||
        mutation.afterCompletedQuantity !== mutation.requiredQuantity ||
        operation.quantityDelta !== null ||
        operation.acceptedOperationReference !== null ||
        operation.startedOperationReference !== null ||
        operation.admissionDecision !== null ||
        captured === null ||
        captured.mode !== "Enabled" ||
        captured.sourceOutcome !== "Completed" ||
        captured.ticketReference !== command.ticketReference ||
        captured.workItemReference !== commandWorkItemReference ||
        captured.orderItemReference !== command.orderItemReference ||
        captured.sourceCommittedTicketVersion > mutation.expectedTicketVersion ||
        captured.sourceCommittedWorkItemVersion !== mutation.expectedWorkItemVersion ||
        captured.sourceCompletedQuantity !== mutation.requiredQuantity ||
        captured.sourceRequiredQuantity !== mutation.requiredQuantity ||
        Date.parse(captured.sourceOccurredAt) > Date.parse(operation.occurredAt) ||
        Date.parse(captured.evaluatedAt) > Date.parse(captured.sourceOccurredAt) ||
        Date.parse(captured.sourceOccurredAt) >= Date.parse(captured.validUntil) ||
        captured.decisionBrandReference !== command.brandReference ||
        captured.decisionStoreReference !== command.storeReference ||
        captured.sourceOperationReference === captured.decisionReference ||
        [captured.sourceOperationReference, captured.decisionReference].some((reference) =>
          [
            command.brandReference,
            command.storeReference,
            command.ticketReference,
            commandWorkItemReference,
            command.orderItemReference,
          ].includes(reference),
        ) ||
        digest(ports, createKitchenCapturedExpoBinding(captured)) !==
          captured.capturedExpoBindingDigest ||
        event !== null ||
        readyResult === null ||
        automaticReadyOperation !== null
      )
        return false;
    }

    const expectedParentAudit = createAudit({
      auditReference: operation.auditReference,
      command,
      actionCode: operation.actionCode,
      reasonCode: operation.reasonCode,
      sourceChannel: "KDS_COMMAND",
      actorType: "User",
      actorReference: command.actorReference,
      targetType: markReady ? "KitchenOrderItem" : "KitchenWorkItem",
      targetReference: markReady ? command.orderItemReference : commandWorkItemReference,
      mutation,
      correlationReference: command.correlationReference,
      occurredAt: operation.occurredAt,
    });
    if (!sameCanonical(parentAudit, expectedParentAudit)) return false;

    if (command.action === "MarkKitchenOrderItemReady") {
      if (event !== null) return false;
    } else {
      if (event === null) return false;
      const expectedEvent = createKitchenWorkLifecycleEnvelope({
        eventReference: event.eventId,
        operationReference: operation.operationReference,
        actorReference: command.actorReference,
        correlationReference: command.correlationReference,
        brandReference: command.brandReference,
        storeReference: command.storeReference,
        result,
        quantityDelta: command.action === "CompleteKitchenWorkItem" ? command.quantityDelta : null,
      });
      if (!sameCanonical(event, expectedEvent)) return false;
    }

    if (readyResult !== null) {
      const causalOperationReference =
        automaticReadyOperation?.operationReference ?? operation.operationReference;
      const captured = operation.capturedExpo;
      if (
        captured === null ||
        readyResult.readyResultReference !== result.readyResultReference ||
        readyResult.brandReference !== command.brandReference ||
        readyResult.storeReference !== command.storeReference ||
        readyResult.ticketReference !== command.ticketReference ||
        readyResult.orderItemReference !== command.orderItemReference ||
        readyResult.causalOperationReference !== causalOperationReference ||
        readyResult.actorType !== (automatic ? "System" : "User") ||
        readyResult.actorReference !== (automatic ? null : command.actorReference) ||
        readyResult.workItems[0].workItemReference !== commandWorkItemReference ||
        readyResult.workItems[0].workItemVersion !== mutation.resultWorkItemVersion ||
        readyResult.workItemsDigest !==
          digest(ports, createKitchenReadyWorkItemsBinding(readyResult.workItems)) ||
        readyResult.readyQuantity !== mutation.requiredQuantity ||
        readyResult.requiredQuantity !== mutation.requiredQuantity ||
        !sameCanonical(readyResult.capturedExpo, captured) ||
        readyResult.readyAt !== operation.occurredAt ||
        result.readyQuantity !== mutation.requiredQuantity
      )
        return false;
    }

    if (
      readyPublication !== null &&
      (readyResult === null ||
        readyPublication.brandReference !== command.brandReference ||
        readyPublication.storeReference !== command.storeReference ||
        readyPublication.ticketReference !== command.ticketReference ||
        readyPublication.orderItemReference !== command.orderItemReference ||
        readyPublication.readyResultReference !== readyResult.readyResultReference ||
        readyPublication.ticketVersion !== mutation.resultTicketVersion ||
        readyPublication.readyQuantity !== readyResult.readyQuantity ||
        readyPublication.requiredQuantity !== readyResult.requiredQuantity ||
        readyPublication.correlationReference !== command.correlationReference ||
        readyPublication.causationReference !== readyResult.causalOperationReference ||
        readyPublication.occurredAt !== readyResult.readyAt)
    )
      return false;

    if (automaticReadyOperation !== null) {
      const childAudit = audits[1];
      if (
        childAudit === undefined ||
        readyResult === null ||
        automaticReadyOperation.resultTicketVersion !== mutation.resultTicketVersion ||
        automaticReadyOperation.brandReference !== command.brandReference ||
        automaticReadyOperation.storeReference !== command.storeReference ||
        automaticReadyOperation.ticketReference !== command.ticketReference ||
        automaticReadyOperation.orderItemReference !== command.orderItemReference ||
        automaticReadyOperation.parentOperationReference !== operation.operationReference ||
        automaticReadyOperation.readyResultReference !== readyResult.readyResultReference ||
        automaticReadyOperation.auditReference !== childAudit.auditId ||
        automaticReadyOperation.auditSemanticDigest !==
          digest(ports, createKitchenWorkLifecycleAuditSemanticBinding(childAudit)) ||
        automaticReadyOperation.eventSemanticDigest !== null ||
        automaticReadyOperation.correlationReference !== command.correlationReference ||
        automaticReadyOperation.causationReference !== operation.operationReference ||
        automaticReadyOperation.occurredAt !== operation.occurredAt
      )
        return false;
      const expectedChildAudit = createAudit({
        auditReference: automaticReadyOperation.auditReference,
        command,
        actionCode: "KITCHEN_ORDER_ITEM_READY",
        reasonCode: "ALL_WORK_ITEMS_COMPLETED",
        sourceChannel: "KITCHEN_AUTOMATION",
        actorType: "System",
        actorReference: null,
        targetType: "KitchenOrderItem",
        targetReference: command.orderItemReference,
        mutation,
        correlationReference: command.correlationReference,
        occurredAt: operation.occurredAt,
      });
      if (
        !sameCanonical(childAudit, expectedChildAudit) ||
        automaticReadyEffectDigest !==
          digest(
            ports,
            canonicalizeKitchenWorkLifecycle({
              operation: automaticReadyOperation,
              readyResult,
              audit: childAudit,
              event: null,
            }),
          )
      )
        return false;
    }

    const generatedReferences = [
      operation.operationReference,
      operation.auditReference,
      ...(operation.eventReference === null ? [] : [operation.eventReference]),
      ...(readyResult === null ? [] : [readyResult.readyResultReference]),
      ...(readyPublication === null
        ? []
        : [
            readyPublication.publicationReference,
            readyPublication.itemEvent.eventId,
            ...(readyPublication.orderEvent === null ? [] : [readyPublication.orderEvent.eventId]),
          ]),
      ...(automaticReadyOperation === null
        ? []
        : [automaticReadyOperation.operationReference, automaticReadyOperation.auditReference]),
    ];
    const observedReferences = [
      command.actorReference,
      command.brandReference,
      command.storeReference,
      command.ticketReference,
      command.orderItemReference,
      command.correlationReference,
      commandWorkItemReference,
      ...(operation.acceptedOperationReference === null
        ? []
        : [operation.acceptedOperationReference]),
      ...(operation.startedOperationReference === null
        ? []
        : [operation.startedOperationReference]),
      ...(operation.admissionDecision === null
        ? []
        : [operation.admissionDecision.decisionReference]),
      ...(operation.capturedExpo === null
        ? []
        : [
            operation.capturedExpo.decisionReference,
            ...(command.action === "MarkKitchenOrderItemReady"
              ? [operation.capturedExpo.sourceOperationReference]
              : []),
          ]),
    ];
    ensureDistinct(generatedReferences, observedReferences);
    if (
      generatedReferences.includes(command.idempotencyKey) ||
      command.idempotencyKey === command.correlationReference
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function parseEffect(value: unknown, ports: KitchenWorkLifecyclePorts): KitchenWorkLifecycleEffect {
  const raw = exact(value, [
    "command",
    "intentDigest",
    "operation",
    "mutation",
    "readyResult",
    "automaticReadyOperation",
    "automaticReadyEffectDigest",
    "audits",
    "event",
    "readyPublication",
    "result",
    "effectDigest",
  ]);
  let command: KitchenWorkLifecycleCommand;
  let result: KitchenWorkLifecycleResult;
  try {
    command = parseKitchenWorkLifecycleCommand(raw.command);
    result = parseKitchenWorkLifecycleResult(raw.result);
  } catch {
    return dependency();
  }
  const intentDigest = parseDigest(raw.intentDigest);
  if (!sameCommandIntent(ports, command, intentDigest)) return dependency();
  const operation = parseOperation(raw.operation);
  const mutation = parseMutation(raw.mutation);
  const readyResult = raw.readyResult === null ? null : parseReadyResult(raw.readyResult);
  const automaticReadyOperation =
    raw.automaticReadyOperation === null ? null : parseOperation(raw.automaticReadyOperation);
  const automaticReadyEffectDigest =
    raw.automaticReadyEffectDigest === null ? null : parseDigest(raw.automaticReadyEffectDigest);
  const audits = Object.freeze(exactArray(raw.audits, 1, 2).map(parseAudit));
  let event: ReturnType<typeof parseKitchenWorkLifecycleEnvelope> | null;
  try {
    event = raw.event === null ? null : parseKitchenWorkLifecycleEnvelope(raw.event);
  } catch {
    return dependency();
  }
  const readyPublication =
    raw.readyPublication === null ? null : parseReadyPublication(raw.readyPublication, ports);
  const effectDigest = parseDigest(raw.effectDigest);
  const withoutDigest = Object.freeze({
    command,
    intentDigest,
    operation,
    mutation,
    readyResult,
    automaticReadyOperation,
    automaticReadyEffectDigest,
    audits,
    event,
    readyPublication,
    result,
  });
  const childAudit = audits[1] ?? null;
  if (
    (automaticReadyOperation === null) !== (automaticReadyEffectDigest === null) ||
    (automaticReadyOperation !== null &&
      (readyResult === null ||
        childAudit === null ||
        digest(
          ports,
          canonicalizeKitchenWorkLifecycle({
            operation: automaticReadyOperation,
            readyResult,
            audit: childAudit,
            event: null,
          }),
        ) !== automaticReadyEffectDigest)) ||
    !effectSemantics(withoutDigest, ports) ||
    digest(ports, effectBinding(withoutDigest)) !== effectDigest
  )
    return dependency();
  return Object.freeze({ ...withoutDigest, effectDigest });
}

function validateSourceForCommand(
  ports: KitchenWorkLifecyclePorts,
  source: KitchenWorkLifecycleSource,
  command: KitchenWorkLifecycleCommand,
  observedAt: string,
): void {
  const targetWorkItemReference =
    command.action === "MarkKitchenOrderItemReady"
      ? command.workItems[0].workItemReference
      : command.workItemReference;
  if (
    source.brandReference !== command.brandReference ||
    source.storeReference !== command.storeReference ||
    source.ticketReference !== command.ticketReference ||
    source.target.workItemReference !== targetWorkItemReference ||
    source.target.orderItemReference !== command.orderItemReference
  )
    return dependency();
  if (source.capturedExpo !== null)
    validateCapturedExpoAnchor(ports, source.capturedExpo, source, observedAt);
  const readyResult = source.readyResult;
  if (readyResult !== null) {
    const expectedWorkItemsDigest = digest(
      ports,
      createKitchenReadyWorkItemsBinding([
        {
          workItemReference: source.target.workItemReference,
          workItemVersion: source.target.workItemVersion,
        },
      ]),
    );
    const readyIdentities = [
      readyResult.readyResultReference,
      readyResult.causalOperationReference,
    ];
    const observedIdentities = [
      source.brandReference,
      source.storeReference,
      source.ticketReference,
      source.target.workItemReference,
      source.target.orderItemReference,
      ...(source.capturedExpo === null
        ? []
        : [source.capturedExpo.sourceOperationReference, source.capturedExpo.decisionReference]),
    ];
    if (
      source.target.workItemStatus !== "Completed" ||
      source.target.completedQuantity !== source.target.requiredQuantity ||
      readyResult.workItemsDigest !== expectedWorkItemsDigest ||
      readyResult.readyQuantity !== source.target.requiredQuantity ||
      readyResult.requiredQuantity !== source.target.requiredQuantity ||
      Date.parse(readyResult.readyAt) < Date.parse(source.target.updatedAt) ||
      Date.parse(readyResult.readyAt) > Date.parse(source.ticketUpdatedAt) ||
      new Set(readyIdentities).size !== readyIdentities.length ||
      readyIdentities.some((reference) => observedIdentities.includes(reference))
    )
      return dependency();
  }
  if (
    source.ticketVersion.toString() !== command.expectedTicketVersion ||
    source.target.workItemVersion.toString() !==
      (command.action === "MarkKitchenOrderItemReady"
        ? command.workItems[0].expectedWorkItemVersion
        : command.expectedWorkItemVersion)
  )
    return conflict();
}

function validatePredecessors(
  source: KitchenWorkLifecycleSource,
  command: KitchenWorkLifecycleCommand,
) {
  const accepted = source.acceptedOperation;
  const started = source.startedOperation;
  const targetUpdatedAt = Date.parse(source.target.updatedAt);
  if (source.readyResult !== null && command.action !== "MarkKitchenOrderItemReady")
    return dependency();
  if (source.capturedExpo !== null && command.action !== "MarkKitchenOrderItemReady")
    return dependency();
  if (
    accepted !== null &&
    (accepted.resultTicketVersion > source.ticketVersion ||
      accepted.resultWorkItemVersion > source.target.workItemVersion ||
      Date.parse(accepted.occurredAt) > targetUpdatedAt)
  )
    return dependency();
  if (
    started !== null &&
    (accepted === null ||
      started.actorReference !== accepted.actorReference ||
      started.resultTicketVersion <= accepted.resultTicketVersion ||
      started.resultTicketVersion > source.ticketVersion ||
      started.resultWorkItemVersion <= accepted.resultWorkItemVersion ||
      started.resultWorkItemVersion > source.target.workItemVersion ||
      Date.parse(started.occurredAt) < Date.parse(accepted.occurredAt) ||
      Date.parse(started.occurredAt) > targetUpdatedAt)
  )
    return dependency();
  if (command.action === "AcceptKitchenWorkItem") {
    if (accepted !== null) return precondition();
    if (started !== null) return dependency();
    return;
  }
  if (accepted === null || accepted.actionCode !== "KITCHEN_WORK_ITEM_ACCEPTED")
    return precondition();
  if (command.action === "StartKitchenWorkItem") {
    if (accepted.actorReference !== command.actorReference) return precondition();
    if (accepted.resultWorkItemVersion !== source.target.workItemVersion) return dependency();
    if (started !== null) return precondition();
    return;
  }
  if (command.action === "CompleteKitchenWorkItem") {
    if (
      accepted.actorReference !== command.actorReference ||
      started === null ||
      started.actionCode !== "KITCHEN_WORK_ITEM_STARTED" ||
      started.actorReference !== command.actorReference
    )
      return precondition();
    return;
  }
  if (started === null || started.actionCode !== "KITCHEN_WORK_ITEM_STARTED") return precondition();
}

async function resolveAdmission(
  ports: KitchenWorkLifecyclePorts,
  command: Extract<KitchenWorkLifecycleCommand, { readonly action: "StartKitchenWorkItem" }>,
  source: KitchenWorkLifecycleSource,
  observedAt: string,
): Promise<KitchenStartAdmissionDecision> {
  const accepted = source.acceptedOperation;
  if (accepted === null) return precondition();
  let value: unknown | null;
  try {
    value = await ports.admission.resolve({
      command,
      acceptedOperationReference: accepted.operationReference,
      observedAt,
    });
  } catch {
    return dependency();
  }
  if (value === null) return dependency();
  let decision: KitchenStartAdmissionDecision;
  try {
    decision = parseKitchenStartAdmissionDecision(value);
  } catch {
    return dependency();
  }
  if (
    decision.actorReference !== command.actorReference ||
    decision.brandReference !== command.brandReference ||
    decision.storeReference !== command.storeReference ||
    decision.ticketReference !== command.ticketReference ||
    decision.workItemReference !== command.workItemReference ||
    decision.acceptedOperationReference !== accepted.operationReference ||
    decision.ticketVersion !== source.ticketVersion ||
    decision.workItemVersion !== source.target.workItemVersion
  )
    return dependency();
  if (Date.parse(accepted.occurredAt) > Date.parse(decision.evaluatedAt)) return dependency();
  if (decision.outcome === "Blocked") {
    if (
      Date.parse(decision.evaluatedAt) > Date.parse(observedAt) ||
      Date.parse(observedAt) >= Date.parse(decision.validUntil)
    )
      return dependency();
    return precondition();
  }
  return decision;
}

async function resolveExpo(
  ports: KitchenWorkLifecyclePorts,
  command: CompleteKitchenWorkItemCommand,
  observedAt: string,
): Promise<KitchenExpoPolicyDecision> {
  let value: unknown | null;
  try {
    value = await ports.expo.resolve({
      brandReference: command.brandReference,
      storeReference: command.storeReference,
      purpose: "KitchenReadiness",
      ticketReference: command.ticketReference,
      workItemReference: command.workItemReference,
      orderItemReference: command.orderItemReference,
      observedAt,
    });
  } catch {
    return dependency();
  }
  if (value === null) return dependency();
  let decision: KitchenExpoPolicyDecision;
  try {
    decision = parseKitchenExpoPolicyDecision(value);
  } catch {
    return dependency();
  }
  if (
    decision.brandReference !== command.brandReference ||
    decision.storeReference !== command.storeReference
  )
    return dependency();
  return decision;
}

function sampleTime(
  ports: KitchenWorkLifecyclePorts,
  lowerBounds: readonly string[],
  evidence: { readonly evaluatedAt: string; readonly validUntil: string } | null,
): string {
  let occurredAt: string;
  try {
    occurredAt = parseKitchenTicketInstant(ports.clock.now());
  } catch {
    return dependency();
  }
  if (lowerBounds.some((bound) => Date.parse(occurredAt) < Date.parse(bound))) return dependency();
  if (
    evidence !== null &&
    (Date.parse(evidence.evaluatedAt) > Date.parse(occurredAt) ||
      Date.parse(occurredAt) >= Date.parse(evidence.validUntil))
  )
    return dependency();
  return occurredAt;
}

function replayExpiry(occurredAt: string): string {
  const value = Date.parse(occurredAt) + 30 * dayMs;
  if (!Number.isSafeInteger(value)) return dependency();
  return parseInstant(new Date(value).toISOString());
}

function buildCapturedExpo(input: {
  readonly ports: KitchenWorkLifecyclePorts;
  readonly operationReference: string;
  readonly command: CompleteKitchenWorkItemCommand;
  readonly source: KitchenWorkLifecycleSource;
  readonly decision: KitchenExpoPolicyDecision;
  readonly occurredAt: string;
  readonly outcome: "Completed" | "CompletedAndOrderItemReady";
}): KitchenCapturedExpoDecision {
  const { command, source, decision, operationReference, occurredAt, outcome, ports } = input;
  const binding = {
    sourceOperationReference: operationReference,
    sourceActionCode: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED" as const,
    ticketReference: command.ticketReference,
    workItemReference: command.workItemReference,
    orderItemReference: command.orderItemReference,
    sourceExpectedTicketVersion: source.ticketVersion,
    sourceCommittedTicketVersion: source.ticketVersion + 1n,
    sourceExpectedWorkItemVersion: source.target.workItemVersion,
    sourceCommittedWorkItemVersion: source.target.workItemVersion + 1n,
    sourceBeforeStatus: "In Progress" as const,
    sourceAfterStatus: "Completed" as const,
    sourceCompletedQuantity: source.target.requiredQuantity,
    sourceRequiredQuantity: source.target.requiredQuantity,
    sourceOutcome: outcome,
    sourceOccurredAt: occurredAt,
    decisionReference: decision.decisionReference,
    decisionVersion: decision.decisionVersion,
    decisionDigest: decision.decisionDigest,
    producerContractVersion: 1 as const,
    decisionBrandReference: decision.brandReference,
    decisionStoreReference: decision.storeReference,
    decisionPurpose: "KitchenReadiness" as const,
    mode: decision.mode,
    evaluatedAt: decision.evaluatedAt,
    validUntil: decision.validUntil,
  };
  const capturedExpo = {
    ...binding,
    capturedExpoBindingDigest: digest(ports, canonicalizeKitchenWorkLifecycle(binding)),
  };
  return parseKitchenCapturedExpoDecision(capturedExpo);
}

function validateCapturedExpoAnchor(
  ports: KitchenWorkLifecyclePorts,
  captured: KitchenCapturedExpoDecision,
  source: KitchenWorkLifecycleSource,
  observedAt: string,
) {
  const anchorReferences = [captured.sourceOperationReference, captured.decisionReference];
  if (
    captured.ticketReference !== source.ticketReference ||
    captured.workItemReference !== source.target.workItemReference ||
    captured.orderItemReference !== source.target.orderItemReference ||
    captured.decisionBrandReference !== source.brandReference ||
    captured.decisionStoreReference !== source.storeReference ||
    captured.sourceCommittedTicketVersion > source.ticketVersion ||
    captured.sourceCommittedWorkItemVersion !== source.target.workItemVersion ||
    captured.sourceCompletedQuantity !== source.target.completedQuantity ||
    captured.sourceRequiredQuantity !== source.target.requiredQuantity ||
    captured.sourceOccurredAt !== source.target.updatedAt ||
    Date.parse(captured.sourceOccurredAt) > Date.parse(observedAt) ||
    Date.parse(captured.evaluatedAt) > Date.parse(captured.sourceOccurredAt) ||
    Date.parse(captured.sourceOccurredAt) >= Date.parse(captured.validUntil) ||
    new Set(anchorReferences).size !== anchorReferences.length ||
    anchorReferences.some((reference) =>
      [
        source.brandReference,
        source.storeReference,
        source.ticketReference,
        source.target.workItemReference,
        source.target.orderItemReference,
      ].includes(reference),
    ) ||
    digest(ports, createKitchenCapturedExpoBinding(captured)) !== captured.capturedExpoBindingDigest
  )
    return dependency();
}

function validateCapturedExpo(
  ports: KitchenWorkLifecyclePorts,
  captured: KitchenCapturedExpoDecision,
  source: KitchenWorkLifecycleSource,
  command: KitchenWorkLifecycleCommand,
  observedAt: string,
) {
  validateCapturedExpoAnchor(ports, captured, source, observedAt);
  if (
    captured.mode !== "Enabled" ||
    captured.sourceOutcome !== "Completed" ||
    captured.ticketReference !== command.ticketReference ||
    captured.workItemReference !== source.target.workItemReference ||
    captured.orderItemReference !== command.orderItemReference ||
    captured.decisionBrandReference !== command.brandReference ||
    captured.decisionStoreReference !== command.storeReference ||
    captured.sourceCommittedTicketVersion > source.ticketVersion ||
    captured.sourceCommittedWorkItemVersion !== source.target.workItemVersion ||
    captured.sourceCompletedQuantity !== source.target.completedQuantity ||
    captured.sourceRequiredQuantity !== source.target.requiredQuantity
  )
    return dependency();
}

function resultFor(input: {
  readonly operationReference: string;
  readonly command: KitchenWorkLifecycleCommand;
  readonly source: KitchenWorkLifecycleSource;
  readonly outcome: KitchenWorkLifecycleResult["outcome"];
  readonly afterStatus: KitchenLifecycleWorkItemStatus;
  readonly completedQuantity: number;
  readonly occurredAt: string;
  readonly readyResultReference: string | null;
}): KitchenWorkLifecycleResult {
  const { command, source, outcome } = input;
  const markReady = command.action === "MarkKitchenOrderItemReady";
  return parseKitchenWorkLifecycleResult({
    operationReference: input.operationReference,
    action: command.action,
    outcome,
    ticketReference: command.ticketReference,
    workItemReference: source.target.workItemReference,
    orderItemReference: command.orderItemReference,
    ticketVersion: kitchenVersionText(source.ticketVersion + 1n),
    workItemVersion: kitchenVersionText(
      markReady ? source.target.workItemVersion : source.target.workItemVersion + 1n,
    ),
    workItemStatus: input.afterStatus,
    completedQuantity: input.completedQuantity,
    requiredQuantity: source.target.requiredQuantity,
    occurredAt: input.occurredAt,
    readyResultReference: input.readyResultReference,
    readyQuantity: input.readyResultReference === null ? null : source.target.requiredQuantity,
    projectionName: kitchenWorkLifecycleProjectionName,
    projectionPending: true,
    projectionTriggers:
      outcome === "CompletedAndOrderItemReady"
        ? ["KitchenLifecycleEvent", "KitchenReadyEvent"]
        : outcome === "OrderItemReady"
          ? ["KitchenReadyEvent"]
          : ["KitchenLifecycleEvent"],
  });
}

function createMutation(
  command: KitchenWorkLifecycleCommand,
  source: KitchenWorkLifecycleSource,
  afterStatus: KitchenLifecycleWorkItemStatus,
  afterCompletedQuantity: number,
  occurredAt: string,
): KitchenWorkLifecycleMutation {
  const markReady = command.action === "MarkKitchenOrderItemReady";
  return Object.freeze({
    brandReference: command.brandReference,
    storeReference: command.storeReference,
    ticketReference: command.ticketReference,
    workItemReference: source.target.workItemReference,
    orderItemReference: command.orderItemReference,
    expectedTicketVersion: source.ticketVersion,
    resultTicketVersion: source.ticketVersion + 1n,
    expectedWorkItemVersion: source.target.workItemVersion,
    resultWorkItemVersion: markReady
      ? source.target.workItemVersion
      : source.target.workItemVersion + 1n,
    beforeStatus: source.target.workItemStatus,
    afterStatus,
    beforeCompletedQuantity: source.target.completedQuantity,
    afterCompletedQuantity,
    requiredQuantity: source.target.requiredQuantity,
    updatedAt: occurredAt,
  });
}

function createAudit(input: {
  readonly auditReference: string;
  readonly command: KitchenWorkLifecycleCommand;
  readonly actionCode: KitchenWorkLifecycleActionCode;
  readonly reasonCode: KitchenWorkLifecycleReasonCode;
  readonly sourceChannel: "KDS_COMMAND" | "KITCHEN_AUTOMATION";
  readonly actorType: "User" | "System";
  readonly actorReference: string | null;
  readonly targetType: "KitchenWorkItem" | "KitchenOrderItem";
  readonly targetReference: string;
  readonly mutation: KitchenWorkLifecycleMutation;
  readonly correlationReference: string;
  readonly occurredAt: string;
}): AppendAuditRecordInput {
  const candidate = Object.freeze({
    auditId: input.auditReference,
    brandId: input.command.brandReference,
    storeId: input.command.storeReference,
    actor:
      input.actorType === "System"
        ? Object.freeze({ type: "System" as const })
        : Object.freeze({ type: "User" as const, reference: input.actorReference as string }),
    actionCode: input.actionCode,
    targetType: input.targetType,
    targetId: input.targetReference,
    beforeSummary: Object.freeze({
      status: input.mutation.beforeStatus,
      ticketVersion: input.mutation.expectedTicketVersion.toString(),
      workItemVersion: input.mutation.expectedWorkItemVersion.toString(),
      completedQuantity: input.mutation.beforeCompletedQuantity,
      requiredQuantity: input.mutation.requiredQuantity,
    }),
    afterSummary: Object.freeze({
      status: input.mutation.afterStatus,
      ticketVersion: input.mutation.resultTicketVersion.toString(),
      workItemVersion: input.mutation.resultWorkItemVersion.toString(),
      completedQuantity: input.mutation.afterCompletedQuantity,
      requiredQuantity: input.mutation.requiredQuantity,
    }),
    reasonCode: input.reasonCode,
    correlationId: input.correlationReference,
    occurredAt: input.occurredAt,
    sourceChannel: input.sourceChannel,
    dataClassification: "Confidential" as const,
    retentionPolicyCode: kitchenWorkLifecycleAuditRetentionPolicyCode,
    retentionPolicyVersion: kitchenWorkLifecycleAuditRetentionPolicyVersion,
  });
  try {
    return validateAuditRecord(candidate, Date.parse(input.occurredAt));
  } catch {
    return dependency();
  }
}

function operationFor(input: {
  readonly operationReference: string;
  readonly command: KitchenWorkLifecycleCommand;
  readonly intentDigest: string;
  readonly source: KitchenWorkLifecycleSource;
  readonly mutation: KitchenWorkLifecycleMutation;
  readonly admission: KitchenStartAdmissionDecision | null;
  readonly capturedExpo: KitchenCapturedExpoDecision | null;
  readonly readyResultReference: string | null;
  readonly auditReference: string;
  readonly auditSemanticDigest: string;
  readonly eventReference: string | null;
  readonly eventSemanticDigest: string | null;
  readonly occurredAt: string;
}): KitchenWorkLifecycleOperationRecord {
  const { command, source, mutation } = input;
  return Object.freeze({
    operationReference: input.operationReference,
    idempotencyKey: command.idempotencyKey,
    intentDigest: input.intentDigest,
    action: command.action,
    actionCode: actionCodeFor(command.action),
    purpose: purposeFor(command.action),
    reasonCode: reasonFor(command.action),
    sourceChannel: "KDS_COMMAND",
    actorType: "User",
    actorReference: command.actorReference,
    brandReference: command.brandReference,
    storeReference: command.storeReference,
    ticketReference: command.ticketReference,
    workItemReference:
      command.action === "MarkKitchenOrderItemReady" ? null : source.target.workItemReference,
    orderItemReference: command.orderItemReference,
    expectedTicketVersion: mutation.expectedTicketVersion,
    resultTicketVersion: mutation.resultTicketVersion,
    expectedWorkItemVersion: mutation.expectedWorkItemVersion,
    resultWorkItemVersion: mutation.resultWorkItemVersion,
    beforeStatus: mutation.beforeStatus,
    afterStatus: mutation.afterStatus,
    quantityDelta: command.action === "CompleteKitchenWorkItem" ? command.quantityDelta : null,
    completedQuantity: mutation.afterCompletedQuantity,
    requiredQuantity: mutation.requiredQuantity,
    acceptedOperationReference:
      command.action === "MarkKitchenOrderItemReady"
        ? null
        : (source.acceptedOperation?.operationReference ?? null),
    startedOperationReference:
      command.action === "MarkKitchenOrderItemReady"
        ? null
        : (source.startedOperation?.operationReference ?? null),
    admissionDecision: input.admission,
    capturedExpo: input.capturedExpo,
    parentOperationReference: null,
    readyResultReference: input.readyResultReference,
    auditReference: input.auditReference,
    auditSemanticDigest: input.auditSemanticDigest,
    eventReference: input.eventReference,
    eventSemanticDigest: input.eventSemanticDigest,
    correlationReference: command.correlationReference,
    causationReference: null,
    occurredAt: input.occurredAt,
    replayExpiresAt: replayExpiry(input.occurredAt),
  });
}

async function buildEffect(
  ports: KitchenWorkLifecyclePorts,
  command: KitchenWorkLifecycleCommand,
  source: KitchenWorkLifecycleSource,
  operationReference: string,
  intentDigest: string,
  observedAt: string,
): Promise<KitchenWorkLifecycleEffect> {
  validatePredecessors(source, command);
  let admission: KitchenStartAdmissionDecision | null = null;
  let expo: KitchenExpoPolicyDecision | null = null;
  let capturedExpo: KitchenCapturedExpoDecision | null = null;
  let afterStatus = source.target.workItemStatus;
  let completedQuantity = source.target.completedQuantity;
  let outcome: KitchenWorkLifecycleResult["outcome"];

  if (command.action === "AcceptKitchenWorkItem") {
    if (source.target.workItemStatus !== "Queued" || source.target.completedQuantity !== 0)
      return precondition();
    outcome = "Accepted";
  } else if (command.action === "StartKitchenWorkItem") {
    if (source.target.workItemStatus !== "Queued" || source.target.completedQuantity !== 0)
      return precondition();
    admission = await resolveAdmission(ports, command, source, observedAt);
    outcome = "Started";
    afterStatus = "In Progress";
  } else if (command.action === "CompleteKitchenWorkItem") {
    if (source.target.workItemStatus !== "In Progress") return precondition();
    completedQuantity = source.target.completedQuantity + command.quantityDelta;
    if (completedQuantity > source.target.requiredQuantity) return precondition();
    if (completedQuantity < source.target.requiredQuantity) {
      outcome = "ProgressRecorded";
    } else {
      afterStatus = "Completed";
      expo = await resolveExpo(ports, command, observedAt);
      outcome = expo.mode === "Disabled" ? "CompletedAndOrderItemReady" : "Completed";
    }
  } else {
    if (
      source.target.workItemStatus !== "Completed" ||
      source.target.completedQuantity !== source.target.requiredQuantity ||
      source.readyResult !== null ||
      source.capturedExpo === null
    )
      return precondition();
    validateCapturedExpo(ports, source.capturedExpo, source, command, observedAt);
    capturedExpo = source.capturedExpo;
    outcome = "OrderItemReady";
  }

  const decision = admission ?? expo;
  const occurredAt = sampleTime(
    ports,
    [observedAt, source.ticketUpdatedAt, source.target.updatedAt],
    decision,
  );
  if (admission !== null) {
    const accepted = source.acceptedOperation;
    if (accepted === null || Date.parse(accepted.occurredAt) > Date.parse(admission.evaluatedAt))
      return dependency();
  }
  if (expo !== null) {
    capturedExpo = buildCapturedExpo({
      ports,
      operationReference,
      command: command as CompleteKitchenWorkItemCommand,
      source,
      decision: expo,
      occurredAt,
      outcome: outcome as "Completed" | "CompletedAndOrderItemReady",
    });
  }

  const mutation = createMutation(command, source, afterStatus, completedQuantity, occurredAt);
  const automaticReady = outcome === "CompletedAndOrderItemReady";
  const manualReady = outcome === "OrderItemReady";
  const ready = automaticReady || manualReady;
  const automaticReadyOperationReference = automaticReady
    ? stableReference(ports, "KitchenAutomaticOrderItemReadyOperation", {
        brandReference: command.brandReference,
        storeReference: command.storeReference,
        ticketReference: command.ticketReference,
        orderItemReference: command.orderItemReference,
        parentOperationReference: operationReference,
      })
    : null;
  const readyResultReference = ready
    ? stableReference(ports, "KitchenOrderItemReadyResult", {
        brandReference: command.brandReference,
        storeReference: command.storeReference,
        ticketReference: command.ticketReference,
        orderItemReference: command.orderItemReference,
        sourceOperationReference: operationReference,
      })
    : null;
  const auditReference = nextReference(ports, "KitchenWorkLifecycleAudit");
  const automaticAuditReference = automaticReady
    ? nextReference(ports, "KitchenWorkLifecycleAudit")
    : null;
  const eventReference =
    command.action === "MarkKitchenOrderItemReady"
      ? null
      : nextReference(ports, "KitchenWorkLifecycleEvent");
  const readyPublicationReference = ready ? nextReference(ports, "KitchenReadyPublication") : null;
  const itemReadyEventReference = ready ? nextReference(ports, "KitchenReadyEvent") : null;
  const allTicketItemsReady =
    ready &&
    source.ticketReadiness.every(
      (entry) =>
        entry.orderItemReference === command.orderItemReference ||
        entry.readyResultReference !== null,
    );
  const orderReadyEventReference = allTicketItemsReady
    ? nextReference(ports, "KitchenReadyEvent")
    : null;
  const generated = [
    operationReference,
    auditReference,
    ...(automaticReadyOperationReference === null ? [] : [automaticReadyOperationReference]),
    ...(readyResultReference === null ? [] : [readyResultReference]),
    ...(automaticAuditReference === null ? [] : [automaticAuditReference]),
    ...(eventReference === null ? [] : [eventReference]),
    ...(readyPublicationReference === null ? [] : [readyPublicationReference]),
    ...(itemReadyEventReference === null ? [] : [itemReadyEventReference]),
    ...(orderReadyEventReference === null ? [] : [orderReadyEventReference]),
  ];
  ensureDistinct(generated, [
    command.actorReference,
    command.brandReference,
    command.storeReference,
    command.ticketReference,
    command.orderItemReference,
    command.correlationReference,
    source.target.workItemReference,
    source.orderReference,
    source.orderBatchReference,
    ...(source.acceptedOperation === null ? [] : [source.acceptedOperation.operationReference]),
    ...(source.startedOperation === null ? [] : [source.startedOperation.operationReference]),
    ...(admission === null ? [] : [admission.decisionReference]),
    ...(capturedExpo === null
      ? []
      : [
          capturedExpo.decisionReference,
          ...(command.action === "MarkKitchenOrderItemReady"
            ? [capturedExpo.sourceOperationReference]
            : []),
        ]),
  ]);
  if (
    generated.includes(command.idempotencyKey) ||
    command.idempotencyKey === command.correlationReference
  )
    return dependency();

  const result = resultFor({
    operationReference,
    command,
    source,
    outcome,
    afterStatus,
    completedQuantity,
    occurredAt,
    readyResultReference,
  });
  const event =
    eventReference === null
      ? null
      : createKitchenWorkLifecycleEnvelope({
          eventReference,
          operationReference,
          actorReference: command.actorReference,
          correlationReference: command.correlationReference,
          brandReference: command.brandReference,
          storeReference: command.storeReference,
          result,
          quantityDelta:
            command.action === "CompleteKitchenWorkItem" ? command.quantityDelta : null,
        });
  const parentAudit = createAudit({
    auditReference,
    command,
    actionCode: actionCodeFor(command.action),
    reasonCode: reasonFor(command.action),
    sourceChannel: "KDS_COMMAND",
    actorType: "User",
    actorReference: command.actorReference,
    targetType:
      command.action === "MarkKitchenOrderItemReady" ? "KitchenOrderItem" : "KitchenWorkItem",
    targetReference:
      command.action === "MarkKitchenOrderItemReady"
        ? command.orderItemReference
        : source.target.workItemReference,
    mutation,
    correlationReference: command.correlationReference,
    occurredAt,
  });
  const parentAuditSemanticDigest = digest(
    ports,
    createKitchenWorkLifecycleAuditSemanticBinding(parentAudit),
  );
  const eventSemanticDigest =
    event === null ? null : digest(ports, createKitchenWorkLifecycleEventSemanticBinding(event));
  const readyResult =
    readyResultReference === null || capturedExpo === null
      ? null
      : Object.freeze({
          readyResultReference,
          brandReference: command.brandReference,
          storeReference: command.storeReference,
          ticketReference: command.ticketReference,
          orderItemReference: command.orderItemReference,
          causalOperationReference: automaticReadyOperationReference ?? operationReference,
          actorType: automaticReady ? ("System" as const) : ("User" as const),
          actorReference: automaticReady ? null : command.actorReference,
          workItems: Object.freeze([
            Object.freeze({
              workItemReference: source.target.workItemReference,
              workItemVersion: mutation.resultWorkItemVersion,
            }),
          ] as const),
          workItemsDigest: digest(
            ports,
            createKitchenReadyWorkItemsBinding([
              {
                workItemReference: source.target.workItemReference,
                workItemVersion: mutation.resultWorkItemVersion,
              },
            ]),
          ),
          readyQuantity: source.target.requiredQuantity,
          requiredQuantity: source.target.requiredQuantity,
          capturedExpo,
          readyAt: occurredAt,
        });
  const readyPublication =
    readyResult === null || readyPublicationReference === null || itemReadyEventReference === null
      ? null
      : (() => {
          const causationReference = automaticReadyOperationReference ?? operationReference;
          const readiness = Object.freeze(
            source.ticketReadiness.map((entry) =>
              entry.orderItemReference === command.orderItemReference
                ? Object.freeze({
                    orderItemReference: entry.orderItemReference,
                    requiredQuantity: entry.requiredQuantity,
                    readyResultReference: readyResult.readyResultReference,
                    readyQuantity: readyResult.readyQuantity,
                    readyAt: readyResult.readyAt,
                  })
                : entry,
            ),
          );
          const bundle = createKitchenReadyEventBundle({
            itemEventReference: itemReadyEventReference,
            orderEventReference: orderReadyEventReference,
            brandReference: command.brandReference,
            storeReference: command.storeReference,
            ticketReference: command.ticketReference,
            ticketVersion: mutation.resultTicketVersion,
            orderReference: source.orderReference,
            orderBatchReference: source.orderBatchReference,
            orderItemReference: command.orderItemReference,
            readyResultReference: readyResult.readyResultReference,
            readyQuantity: readyResult.readyQuantity,
            requiredQuantity: readyResult.requiredQuantity,
            readyAt: readyResult.readyAt,
            correlationReference: command.correlationReference,
            causationReference,
            readiness,
          });
          return Object.freeze({
            publicationReference: readyPublicationReference,
            brandReference: command.brandReference,
            storeReference: command.storeReference,
            ticketReference: command.ticketReference,
            orderReference: source.orderReference,
            orderBatchReference: source.orderBatchReference,
            orderItemReference: command.orderItemReference,
            readyResultReference: readyResult.readyResultReference,
            ticketVersion: mutation.resultTicketVersion,
            readyQuantity: readyResult.readyQuantity,
            requiredQuantity: readyResult.requiredQuantity,
            itemCount: readiness.length,
            itemEvent: bundle.itemEvent,
            itemEventSemanticDigest: digest(
              ports,
              createKitchenReadyEventSemanticBinding(bundle.itemEvent),
            ),
            orderEvent: bundle.orderEvent,
            orderEventSemanticDigest:
              bundle.orderEvent === null
                ? null
                : digest(ports, createKitchenReadyEventSemanticBinding(bundle.orderEvent)),
            correlationReference: command.correlationReference,
            causationReference,
            occurredAt,
          });
        })();
  const automaticAudit =
    automaticAuditReference === null
      ? null
      : createAudit({
          auditReference: automaticAuditReference,
          command,
          actionCode: "KITCHEN_ORDER_ITEM_READY",
          reasonCode: "ALL_WORK_ITEMS_COMPLETED",
          sourceChannel: "KITCHEN_AUTOMATION",
          actorType: "System",
          actorReference: null,
          targetType: "KitchenOrderItem",
          targetReference: command.orderItemReference,
          mutation,
          correlationReference: command.correlationReference,
          occurredAt,
        });
  const automaticAuditSemanticDigest =
    automaticAudit === null
      ? null
      : digest(ports, createKitchenWorkLifecycleAuditSemanticBinding(automaticAudit));
  const automaticReadyOperation =
    automaticReadyOperationReference === null ||
    automaticAuditReference === null ||
    automaticAuditSemanticDigest === null ||
    readyResultReference === null
      ? null
      : Object.freeze({
          operationReference: automaticReadyOperationReference,
          idempotencyKey: null,
          intentDigest: null,
          action: "AutomaticKitchenOrderItemReady" as const,
          actionCode: "KITCHEN_ORDER_ITEM_READY" as const,
          purpose: "KitchenExpoCoordination" as const,
          reasonCode: "ALL_WORK_ITEMS_COMPLETED" as const,
          sourceChannel: "KITCHEN_AUTOMATION" as const,
          actorType: "System" as const,
          actorReference: null,
          brandReference: command.brandReference,
          storeReference: command.storeReference,
          ticketReference: command.ticketReference,
          workItemReference: null,
          orderItemReference: command.orderItemReference,
          expectedTicketVersion: null,
          resultTicketVersion: mutation.resultTicketVersion,
          expectedWorkItemVersion: null,
          resultWorkItemVersion: null,
          beforeStatus: null,
          afterStatus: null,
          quantityDelta: null,
          completedQuantity: null,
          requiredQuantity: null,
          acceptedOperationReference: null,
          startedOperationReference: null,
          admissionDecision: null,
          capturedExpo: null,
          parentOperationReference: operationReference,
          readyResultReference,
          auditReference: automaticAuditReference,
          auditSemanticDigest: automaticAuditSemanticDigest,
          eventReference: null,
          eventSemanticDigest: null,
          correlationReference: command.correlationReference,
          causationReference: operationReference,
          occurredAt,
          replayExpiresAt: null,
        });
  const automaticReadyEffectDigest =
    automaticReadyOperation === null || readyResult === null || automaticAudit === null
      ? null
      : digest(
          ports,
          canonicalizeKitchenWorkLifecycle({
            operation: automaticReadyOperation,
            readyResult,
            audit: automaticAudit,
            event: null,
          }),
        );
  const operation = operationFor({
    operationReference,
    command,
    intentDigest,
    source,
    mutation,
    admission,
    capturedExpo,
    readyResultReference,
    auditReference,
    auditSemanticDigest: parentAuditSemanticDigest,
    eventReference,
    eventSemanticDigest,
    occurredAt,
  });
  const withoutDigest = Object.freeze({
    command,
    intentDigest,
    operation,
    mutation,
    readyResult,
    automaticReadyOperation,
    automaticReadyEffectDigest,
    audits: Object.freeze(automaticAudit === null ? [parentAudit] : [parentAudit, automaticAudit]),
    event,
    readyPublication,
    result,
  });
  const effect = Object.freeze({
    ...withoutDigest,
    effectDigest: digest(ports, effectBinding(withoutDigest)),
  });
  return parseEffect(effect, ports);
}

async function authorize(
  ports: KitchenWorkLifecyclePorts,
  command: KitchenWorkLifecycleCommand,
): Promise<{ readonly observedAt: string }> {
  let authority;
  let correlation;
  try {
    authority = parseKitchenWorkLifecycleAuthority(await ports.trustedContext.resolveAuthority());
    correlation = parseKitchenWorkLifecycleCorrelation(await ports.correlationContext.resolve());
  } catch {
    return dependency();
  }
  if (
    authority.actorReference !== command.actorReference ||
    authority.brandReference !== command.brandReference ||
    authority.storeReference !== command.storeReference
  )
    return fail("KITCHEN_WORK_PERMISSION_DENIED");
  if (correlation.correlationReference !== command.correlationReference) return dependency();
  let allowed: boolean;
  try {
    allowed = await ports.authorization.authorize({
      action: command.action,
      purpose: purposeFor(command.action),
      permission: kitchenWorkLifecyclePermission,
      actorReference: authority.actorReference,
      brandReference: authority.brandReference,
      storeReference: authority.storeReference,
      observedAt: authority.observedAt,
    });
  } catch {
    return dependency();
  }
  if (allowed === false) return fail("KITCHEN_WORK_PERMISSION_DENIED");
  if (allowed !== true) return dependency();
  return Object.freeze({ observedAt: authority.observedAt });
}

export function createKitchenWorkLifecycleService(ports: KitchenWorkLifecyclePorts) {
  return Object.freeze({
    async execute(commandValue: unknown): Promise<KitchenWorkLifecycleResult> {
      const command = parseKitchenWorkLifecycleCommand(commandValue);
      const { observedAt } = await authorize(ports, command);
      const attempt = () =>
        ports.transactions.withTransaction(async (transaction: ConsumerTransaction) => {
          try {
            await ports.tenantContext.install({
              actorReference: command.actorReference,
              brandReference: command.brandReference,
              storeReference: command.storeReference,
              purpose: purposeFor(command.action),
              transaction,
            });
            await ports.idempotency.acquireFence({
              brandReference: command.brandReference,
              storeReference: command.storeReference,
              idempotencyKey: command.idempotencyKey,
              transaction,
            });
          } catch {
            return dependency();
          }
          let resolution: KitchenWorkLifecycleResolution;
          try {
            resolution = parseResolution(
              await ports.repository.resolveByIdempotency({
                brandReference: command.brandReference,
                storeReference: command.storeReference,
                idempotencyKey: command.idempotencyKey,
                transaction,
              }),
            );
          } catch (error) {
            if (error instanceof KitchenWorkLifecycleError) throw error;
            return dependency();
          }
          if (resolution.status === "Found") {
            const stored = parseEffect(resolution.effect, ports);
            if (
              stored.operation.idempotencyKey !== command.idempotencyKey ||
              stored.operation.brandReference !== command.brandReference ||
              stored.operation.storeReference !== command.storeReference ||
              stored.command.brandReference !== command.brandReference ||
              stored.command.storeReference !== command.storeReference
            )
              return dependency();
            if (!sameCommandIntent(ports, command, stored.intentDigest)) return conflict();
            const expiry = stored.operation.replayExpiresAt;
            if (Date.parse(observedAt) < Date.parse(stored.operation.occurredAt))
              return dependency();
            if (expiry === null || Date.parse(observedAt) >= Date.parse(expiry)) return conflict();
            return stored.result;
          }
          const intentDigest = digest(ports, createKitchenWorkLifecycleIntentBinding(command));
          const operationReference = nextReference(ports, "KitchenWorkLifecycleOperation");
          ensureDistinct(
            [operationReference],
            [
              command.actorReference,
              command.brandReference,
              command.storeReference,
              command.ticketReference,
              command.orderItemReference,
              command.correlationReference,
              ...(command.action === "MarkKitchenOrderItemReady"
                ? command.workItems.map((entry) => entry.workItemReference)
                : [command.workItemReference]),
            ],
          );
          if (operationReference === command.idempotencyKey) return dependency();
          let sourceValue: unknown | null;
          try {
            sourceValue = await ports.repository.loadSourceForUpdate({ command, transaction });
          } catch {
            return dependency();
          }
          if (sourceValue === null) return notFound();
          let source: KitchenWorkLifecycleSource;
          try {
            source = parseKitchenWorkLifecycleSource(sourceValue);
          } catch {
            return dependency();
          }
          validateSourceForCommand(ports, source, command, observedAt);
          const effect = await buildEffect(
            ports,
            command,
            source,
            operationReference,
            intentDigest,
            observedAt,
          );
          let commit: KitchenWorkLifecycleCommit;
          try {
            commit = parseCommit(await ports.repository.commit({ effect, transaction }));
          } catch (error) {
            if (error instanceof KitchenWorkLifecycleError) throw error;
            throw error;
          }
          if (commit.status === "Conflict") return conflict();
          const committed = parseEffect(commit.effect, ports);
          if (committed.effectDigest !== effect.effectDigest) return dependency();
          return committed.result;
        });
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof KitchenWorkLifecycleError) throw error;
        try {
          return await attempt();
        } catch (reconciliationError) {
          if (reconciliationError instanceof KitchenWorkLifecycleError) throw reconciliationError;
          return dependency();
        }
      }
    },
  });
}
