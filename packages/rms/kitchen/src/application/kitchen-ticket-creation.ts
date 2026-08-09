import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createOrderKitchenSourceEvidenceBinding,
  createOrderKitchenSourceLineBinding,
  OrderKitchenSourceError,
  parseConfirmedOrderKitchenSourceEvidence,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type ConfirmedOrderKitchenSourceEvidence,
  type ConfirmedOrderKitchenSourceItem,
} from "@rms/ordering";

import type { ConfirmedOrderIntakeReceipt } from "../contracts/confirmed-order-intake.js";
import {
  kitchenTicketAuditRetentionPolicyCode,
  kitchenTicketAuditRetentionPolicyVersion,
  KitchenTicketCreationError,
  type KitchenPlanningSource,
  type KitchenTicket,
  type KitchenTicketCreationAction,
  type KitchenTicketCreationResult,
  type KitchenWorkPlan,
  type KitchenWorkPlanItem,
} from "../contracts/kitchen-ticket.js";
import {
  confirmedOrderReceiptsMatchExact,
  confirmedOrderReceiptsMatchSemantic,
  parseConfirmedOrderIntakeReceipt,
} from "./confirmed-order-intake.js";
import {
  createKitchenWorkCreatedEnvelope,
  parseKitchenWorkCreatedEnvelope,
} from "./kitchen-work-created-event.js";
import type {
  KitchenTicketCommitResult,
  KitchenTicketCreationEffect,
  KitchenTicketCreationPorts,
  KitchenTicketIdentityResolution,
  KitchenTicketSemanticIdentity,
  KitchenStableReferencePurpose,
} from "./ports/kitchen-ticket-ports.js";
import {
  createKitchenWorkPlanDigestBinding,
  parseKitchenCustomerNote,
  parseKitchenPlanningSource,
  parseKitchenTicket,
  parseKitchenTicketCreationAction,
  parseKitchenTicketCreationResult,
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
  parseKitchenWorkPlan,
  receiptFromKitchenTicket,
} from "../domain/kitchen-ticket.js";

function fail(code: ConstructorParameters<typeof KitchenTicketCreationError>[0]): never {
  throw new KitchenTicketCreationError(code);
}

function dependency(): never {
  return fail("KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE");
}

function conflict(): never {
  return fail("KITCHEN_TICKET_CONFLICT");
}

function inputInvalid(): never {
  return fail("KITCHEN_TICKET_INPUT_INVALID");
}

function safeObject(
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
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
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
    if (error instanceof KitchenTicketCreationError) throw error;
    return onInvalid();
  }
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return dependency();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return dependency();
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function digest(ports: KitchenTicketCreationPorts, binding: string) {
  try {
    return parseKitchenTicketDigest(ports.digests.sha256(binding));
  } catch {
    return dependency();
  }
}

function reference(
  ports: KitchenTicketCreationPorts,
  purpose: KitchenStableReferencePurpose,
  identity: unknown,
) {
  try {
    return parseKitchenTicketReference(ports.references.derive(purpose, canonical(identity)));
  } catch {
    return dependency();
  }
}

function semanticIdentity(value: KitchenTicketSemanticIdentity): KitchenTicketSemanticIdentity {
  const raw = safeObject(
    value,
    [
      "brandReference",
      "storeReference",
      "sourceEventReference",
      "confirmationReference",
      "orderBatchReference",
      "transaction",
    ],
    inputInvalid,
  );
  if (
    raw.transaction === null ||
    typeof raw.transaction !== "object" ||
    typeof (raw.transaction as { readonly query?: unknown }).query !== "function"
  )
    return inputInvalid();
  return Object.freeze({
    brandReference: parseKitchenTicketReference(raw.brandReference),
    storeReference: parseKitchenTicketReference(raw.storeReference),
    sourceEventReference: parseKitchenTicketReference(raw.sourceEventReference),
    confirmationReference: parseKitchenTicketReference(raw.confirmationReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    transaction: raw.transaction as ConsumerTransaction,
  });
}

function identityFromReceipt(
  receipt: ConfirmedOrderIntakeReceipt,
  transaction: ConsumerTransaction,
): KitchenTicketSemanticIdentity {
  return Object.freeze({
    brandReference: receipt.brandReference,
    storeReference: receipt.storeReference,
    sourceEventReference: receipt.sourceEventReference,
    confirmationReference: receipt.confirmationReference,
    orderBatchReference: receipt.orderBatchReference,
    transaction,
  });
}

function parseResolution(value: unknown): KitchenTicketIdentityResolution {
  const rawBase = safeObjectByStatus(
    value,
    ["NotFound", "Resolved", "Conflict"],
    ["NotFound", "Conflict"],
  );
  if (rawBase.status === "NotFound" || rawBase.status === "Conflict")
    return Object.freeze({ status: rawBase.status });
  return Object.freeze({ status: "Resolved" as const, effect: rawBase.effect });
}

function parseCommit(value: unknown): KitchenTicketCommitResult {
  const raw = safeObjectByStatus(value, ["Created", "AlreadyCreated", "Conflict"]);
  return Object.freeze({ status: raw.status, effect: raw.effect }) as KitchenTicketCommitResult;
}

function safeObjectByStatus(
  value: unknown,
  statuses: readonly string[],
  statusesWithoutEffect: readonly string[] = [],
): Readonly<Record<string, unknown>> & { readonly status: string; readonly effect?: unknown } {
  let status: unknown;
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const descriptor = Object.getOwnPropertyDescriptor(value, "status");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    )
      return dependency();
    status = descriptor.value;
  } catch {
    return dependency();
  }
  if (typeof status !== "string" || !statuses.includes(status)) return dependency();
  const fields = statusesWithoutEffect.includes(status) ? ["status"] : ["status", "effect"];
  const raw = safeObject(value, fields, dependency);
  if (raw.status !== status) return dependency();
  return Object.freeze({ status, ...(fields.length === 2 ? { effect: raw.effect } : {}) });
}

function mapOrderingFailure(error: unknown): never {
  if (error instanceof OrderKitchenSourceError) {
    if (error.code === "ORDER_KITCHEN_SOURCE_PERMISSION_DENIED")
      return fail("KITCHEN_TICKET_PERMISSION_DENIED");
    if (error.code === "ORDER_KITCHEN_SOURCE_CONFLICT") return conflict();
  }
  return dependency();
}

function sourceMatchesReceipt(
  source: ConfirmedOrderKitchenSourceEvidence,
  receipt: ConfirmedOrderIntakeReceipt,
): boolean {
  return (
    String(source.brandReference) === receipt.brandReference &&
    String(source.storeReference) === receipt.storeReference &&
    String(source.orderReference) === receipt.orderReference &&
    String(source.orderBatchReference) === receipt.orderBatchReference &&
    String(source.confirmationReference) === receipt.confirmationReference &&
    String(source.sourceEventReference) === receipt.sourceEventReference &&
    source.sourceAggregateVersion === receipt.sourceAggregateVersion &&
    String(source.sourceSnapshotDigest) === receipt.sourceSnapshotDigest &&
    Date.parse(source.capturedAt) <= Date.parse(receipt.confirmedAt)
  );
}

async function resolveSource(
  ports: KitchenTicketCreationPorts,
  receipt: ConfirmedOrderIntakeReceipt,
): Promise<ConfirmedOrderKitchenSourceEvidence> {
  let value: unknown;
  try {
    value = await ports.orderingSource.resolve({
      brandReference: parseOrderingReference(receipt.brandReference),
      storeReference: parseOrderingReference(receipt.storeReference),
      orderReference: parseOrderingReference(receipt.orderReference),
      orderBatchReference: parseOrderingReference(receipt.orderBatchReference),
      confirmationReference: parseOrderingReference(receipt.confirmationReference),
      sourceEventReference: parseOrderingReference(receipt.sourceEventReference),
      sourceAggregateVersion: receipt.sourceAggregateVersion,
      sourceSnapshotDigest: parseOrderingHash(receipt.sourceSnapshotDigest),
      observedAt: parseOrderingInstant(receipt.confirmedAt),
    });
  } catch (error) {
    return mapOrderingFailure(error);
  }
  let source: ConfirmedOrderKitchenSourceEvidence;
  try {
    source = parseConfirmedOrderKitchenSourceEvidence(value);
  } catch {
    return conflict();
  }
  if (!sourceMatchesReceipt(source, receipt)) return conflict();
  for (const item of source.items) {
    if (digest(ports, createOrderKitchenSourceLineBinding(item)) !== String(item.lineDigest))
      return conflict();
  }
  if (
    digest(ports, createOrderKitchenSourceEvidenceBinding(source)) !== String(source.evidenceDigest)
  )
    return conflict();
  return source;
}

function planningSourceFromEvidence(
  source: ConfirmedOrderKitchenSourceEvidence,
): KitchenPlanningSource {
  return parseKitchenPlanningSource({
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    orderReference: source.orderReference,
    orderBatchReference: source.orderBatchReference,
    confirmationReference: source.confirmationReference,
    sourceEvidenceReference: source.evidenceReference,
    sourceEvidenceVersion: source.evidenceVersion,
    sourceEvidenceDigest: source.evidenceDigest,
    items: source.items.map((item) => ({
      orderItemReference: item.orderItemReference,
      ordinal: item.ordinal,
      quantity: item.quantity,
      productReference: item.productReference,
      productVersionReference: item.productVersionReference,
      skuReference: item.skuReference,
      menuVersionReference: item.menuVersionReference,
      selectedOptions: item.selectedOptions.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
      })),
      sourceLineDigest: item.lineDigest,
    })),
  });
}

export function createKitchenExecutionSnapshotDigestBinding(
  source: ConfirmedOrderKitchenSourceItem,
  plan: KitchenWorkPlanItem,
): string {
  return canonical({
    source: {
      orderItemReference: source.orderItemReference,
      orderBatchReference: source.orderBatchReference,
      ordinal: source.ordinal,
      quantity: source.quantity,
      productReference: source.productReference,
      productVersionReference: source.productVersionReference,
      skuReference: source.skuReference,
      menuVersionReference: source.menuVersionReference,
      localizedDisplayNames: source.localizedDisplayNames,
      selectedOptions: source.selectedOptions,
      customerNote: source.customerNote,
      sourceLineDigest: source.lineDigest,
    },
    plan: {
      orderItemReference: plan.orderItemReference,
      splitOrdinal: plan.splitOrdinal,
      stationRouting: plan.stationRouting,
      preparation: plan.preparation,
    },
  });
}

function verifyPlan(
  ports: KitchenTicketCreationPorts,
  plan: KitchenWorkPlan,
  source: ConfirmedOrderKitchenSourceEvidence,
  planningSource: KitchenPlanningSource,
  receipt: ConfirmedOrderIntakeReceipt,
): ReadonlyMap<string, KitchenWorkPlanItem> {
  if (
    plan.brandReference !== receipt.brandReference ||
    plan.storeReference !== receipt.storeReference ||
    plan.orderReference !== receipt.orderReference ||
    plan.orderBatchReference !== receipt.orderBatchReference ||
    plan.confirmationReference !== receipt.confirmationReference ||
    plan.sourceEvidenceDigest !== String(source.evidenceDigest) ||
    plan.items.length !== planningSource.items.length ||
    Date.parse(plan.generatedAt) <
      Math.max(Date.parse(source.capturedAt), Date.parse(receipt.confirmedAt))
  )
    return conflict();
  const items = new Map<string, KitchenWorkPlanItem>(
    plan.items.map((entry) => [entry.orderItemReference, entry]),
  );
  for (const sourceItem of planningSource.items) {
    const planItem = items.get(String(sourceItem.orderItemReference));
    if (planItem === undefined) return conflict();
  }
  if (digest(ports, createKitchenWorkPlanDigestBinding(plan)) !== plan.planDigest)
    return conflict();
  return items;
}

async function resolvePlan(
  ports: KitchenTicketCreationPorts,
  receipt: ConfirmedOrderIntakeReceipt,
  source: ConfirmedOrderKitchenSourceEvidence,
): Promise<{
  readonly plan: KitchenWorkPlan;
  readonly items: ReadonlyMap<string, KitchenWorkPlanItem>;
}> {
  const planningSource = planningSourceFromEvidence(source);
  let value: unknown | null;
  try {
    value = await ports.plans.resolve({ receipt, source: planningSource });
  } catch {
    return dependency();
  }
  if (value === null) return dependency();
  let plan: KitchenWorkPlan;
  try {
    plan = parseKitchenWorkPlan(value);
  } catch {
    return conflict();
  }
  return Object.freeze({
    plan,
    items: verifyPlan(ports, plan, source, planningSource, receipt),
  });
}

function copyLocalizedNames(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function createTicket(input: {
  readonly ports: KitchenTicketCreationPorts;
  readonly receipt: ConfirmedOrderIntakeReceipt;
  readonly source: ConfirmedOrderKitchenSourceEvidence;
  readonly plan: KitchenWorkPlan;
  readonly planItems: ReadonlyMap<string, KitchenWorkPlanItem>;
  readonly createdAt: string;
}): KitchenTicket {
  const { ports, receipt, source, plan, planItems } = input;
  const createdAt = parseKitchenTicketInstant(input.createdAt);
  const ticketReference = reference(ports, "KitchenTicket", {
    brandReference: receipt.brandReference,
    storeReference: receipt.storeReference,
    orderBatchReference: receipt.orderBatchReference,
  });
  const workItems = source.items.map((sourceItem) => {
    const planItem = planItems.get(sourceItem.orderItemReference);
    if (planItem === undefined) return conflict();
    return {
      workItemReference: reference(ports, "KitchenWorkItem", {
        ticketReference,
        orderItemReference: sourceItem.orderItemReference,
        splitOrdinal: 1,
      }),
      ticketReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      orderItemReference: parseKitchenTicketReference(sourceItem.orderItemReference),
      orderBatchReference: receipt.orderBatchReference,
      sourceOrdinal: sourceItem.ordinal,
      splitOrdinal: 1,
      requiredQuantity: sourceItem.quantity,
      completedQuantity: 0,
      status: "Queued",
      productReference: parseKitchenTicketReference(sourceItem.productReference),
      productVersionReference: parseKitchenTicketReference(sourceItem.productVersionReference),
      skuReference: parseKitchenTicketReference(sourceItem.skuReference),
      menuVersionReference: parseKitchenTicketReference(sourceItem.menuVersionReference),
      localizedDisplayNames: copyLocalizedNames(sourceItem.localizedDisplayNames),
      selectedOptions: sourceItem.selectedOptions.map((option) => ({
        optionReference: parseKitchenTicketReference(option.optionReference),
        quantity: option.quantity,
        localizedNames: copyLocalizedNames(option.localizedNames),
      })),
      customerNote: parseKitchenCustomerNote(sourceItem.customerNote),
      sourceLineDigest: parseKitchenTicketDigest(sourceItem.lineDigest),
      stationRouting: planItem.stationRouting,
      preparation: planItem.preparation,
      executionSnapshotDigest: digest(
        ports,
        createKitchenExecutionSnapshotDigestBinding(sourceItem, planItem),
      ),
      createdAt,
    };
  });
  const references = [ticketReference, ...workItems.map((entry) => entry.workItemReference)];
  if (new Set(references).size !== references.length) return dependency();
  return parseKitchenTicket({
    ticketReference,
    brandReference: receipt.brandReference,
    storeReference: receipt.storeReference,
    orderReference: receipt.orderReference,
    orderBatchReference: receipt.orderBatchReference,
    confirmationReference: receipt.confirmationReference,
    sourceEventReference: receipt.sourceEventReference,
    sourceAggregateVersion: receipt.sourceAggregateVersion,
    sourceSnapshotDigest: receipt.sourceSnapshotDigest,
    sourceEvidenceReference: source.evidenceReference,
    sourceEvidenceVersion: source.evidenceVersion,
    sourceEvidenceDigest: source.evidenceDigest,
    sourceEvidenceCapturedAt: source.capturedAt,
    planReference: plan.planReference,
    planVersion: plan.planVersion,
    planDigest: plan.planDigest,
    planGeneratedAt: plan.generatedAt,
    consumerName: receipt.consumerName,
    consumerVersion: receipt.consumerVersion,
    confirmedAt: receipt.confirmedAt,
    correlationReference: receipt.correlationReference,
    semanticEventBindingDigest: receipt.semanticEventBindingDigest,
    aggregateVersion: 1n,
    status: "Open",
    createdAt,
    workItems,
  });
}

function createAction(
  ports: KitchenTicketCreationPorts,
  ticket: KitchenTicket,
): KitchenTicketCreationAction {
  return parseKitchenTicketCreationAction({
    actionReference: reference(ports, "KitchenCreationAction", {
      ticketReference: ticket.ticketReference,
      purpose: "CREATE_KITCHEN_TICKET",
    }),
    actionVersion: 1,
    actionCode: "KITCHEN_TICKET_CREATED",
    purpose: "CREATE_KITCHEN_TICKET",
    reasonCode: "ORDER_CONFIRMED",
    actorType: "System",
    actorReference: null,
    sourceChannel: "EVENT_CONSUMER",
    dataClassification: "Restricted",
    ticketReference: ticket.ticketReference,
    brandReference: ticket.brandReference,
    storeReference: ticket.storeReference,
    sourceEventReference: ticket.sourceEventReference,
    correlationReference: ticket.correlationReference,
    workItemCount: ticket.workItems.length,
    occurredAt: ticket.createdAt,
  });
}

function parseAudit(
  value: unknown,
  ticket: KitchenTicket,
  onMalformed: () => never = dependency,
): AppendAuditRecordInput {
  const raw = safeObject(
    value,
    [
      "auditId",
      "brandId",
      "storeId",
      "actor",
      "actionCode",
      "targetType",
      "targetId",
      "afterSummary",
      "reasonCode",
      "correlationId",
      "occurredAt",
      "sourceChannel",
      "dataClassification",
      "retentionPolicyCode",
      "retentionPolicyVersion",
    ],
    onMalformed,
  );
  const actor = safeObject(raw.actor, ["type"], onMalformed);
  const afterSummary = safeObject(raw.afterSummary, ["status", "workItemCount"], onMalformed);
  const candidate = Object.freeze({
    auditId: raw.auditId,
    brandId: raw.brandId,
    storeId: raw.storeId,
    actor: Object.freeze({ type: actor.type }),
    actionCode: raw.actionCode,
    targetType: raw.targetType,
    targetId: raw.targetId,
    afterSummary: Object.freeze({
      status: afterSummary.status,
      workItemCount: afterSummary.workItemCount,
    }),
    reasonCode: raw.reasonCode,
    correlationId: raw.correlationId,
    occurredAt: raw.occurredAt,
    sourceChannel: raw.sourceChannel,
    dataClassification: raw.dataClassification,
    retentionPolicyCode: raw.retentionPolicyCode,
    retentionPolicyVersion: raw.retentionPolicyVersion,
  });
  let parsed: AppendAuditRecordInput;
  try {
    parsed = validateAuditRecord(candidate as AppendAuditRecordInput, Date.parse(ticket.createdAt));
  } catch {
    return onMalformed();
  }
  if (
    parsed.brandId !== ticket.brandReference ||
    parsed.storeId !== ticket.storeReference ||
    parsed.actor.type !== "System" ||
    parsed.actionCode !== "KITCHEN_TICKET_CREATED" ||
    parsed.targetType !== "KitchenTicket" ||
    parsed.targetId !== ticket.ticketReference ||
    parsed.beforeSummary !== undefined ||
    parsed.afterSummary?.status !== "Open" ||
    parsed.afterSummary.workItemCount !== ticket.workItems.length ||
    parsed.reasonCode !== "ORDER_CONFIRMED" ||
    parsed.correlationId !== ticket.correlationReference ||
    parsed.occurredAt !== ticket.createdAt ||
    parsed.sourceChannel !== "EVENT_CONSUMER" ||
    parsed.dataClassification !== "Restricted" ||
    parsed.retentionPolicyCode !== kitchenTicketAuditRetentionPolicyCode ||
    parsed.retentionPolicyVersion !== kitchenTicketAuditRetentionPolicyVersion
  )
    return onMalformed();
  return candidate as AppendAuditRecordInput;
}

function createAudit(
  ports: KitchenTicketCreationPorts,
  ticket: KitchenTicket,
): AppendAuditRecordInput {
  return parseAudit(
    {
      auditId: reference(ports, "KitchenCreationAudit", {
        ticketReference: ticket.ticketReference,
        purpose: "CREATE_KITCHEN_TICKET",
      }),
      brandId: ticket.brandReference,
      storeId: ticket.storeReference,
      actor: { type: "System" },
      actionCode: "KITCHEN_TICKET_CREATED",
      targetType: "KitchenTicket",
      targetId: ticket.ticketReference,
      afterSummary: { status: "Open", workItemCount: ticket.workItems.length },
      reasonCode: "ORDER_CONFIRMED",
      correlationId: ticket.correlationReference,
      occurredAt: ticket.createdAt,
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      retentionPolicyCode: kitchenTicketAuditRetentionPolicyCode,
      retentionPolicyVersion: kitchenTicketAuditRetentionPolicyVersion,
    },
    ticket,
  );
}

function effectBinding(effect: Omit<KitchenTicketCreationEffect, "effectDigest">): string {
  return canonical({
    receipt: effect.receipt,
    ticket: effect.ticket,
    action: effect.action,
    audit: effect.audit,
    event: effect.event,
  });
}

function effectMatchesTicket(effect: Omit<KitchenTicketCreationEffect, "effectDigest">): boolean {
  const { receipt, ticket, action, audit, event } = effect;
  const generatedReferences: readonly string[] = [
    ticket.ticketReference,
    ...ticket.workItems.map((entry) => entry.workItemReference),
    action.actionReference,
    audit.auditId,
    event.eventId,
  ];
  const inputReferences = new Set<string>([
    receipt.sourceEventReference,
    receipt.brandReference,
    receipt.storeReference,
    receipt.orderReference,
    receipt.orderBatchReference,
    receipt.confirmationReference,
    receipt.correlationReference,
    ticket.sourceEvidenceReference,
    ticket.planReference,
    ...ticket.workItems.flatMap((entry) => [
      entry.brandReference,
      entry.storeReference,
      entry.orderItemReference,
      entry.orderBatchReference,
      entry.productReference,
      entry.productVersionReference,
      entry.skuReference,
      entry.menuVersionReference,
      ...entry.selectedOptions.map((option) => option.optionReference),
      entry.stationRouting.stationReference,
      entry.stationRouting.routingRuleReference,
      entry.preparation.preparationReference,
    ]),
  ]);
  return (
    new Set(generatedReferences).size === generatedReferences.length &&
    generatedReferences.every((generatedReference) => !inputReferences.has(generatedReference)) &&
    confirmedOrderReceiptsMatchExact(receipt, receiptFromKitchenTicket(ticket)) &&
    action.ticketReference === ticket.ticketReference &&
    action.brandReference === ticket.brandReference &&
    action.storeReference === ticket.storeReference &&
    action.sourceEventReference === ticket.sourceEventReference &&
    action.correlationReference === ticket.correlationReference &&
    action.workItemCount === ticket.workItems.length &&
    action.actorType === "System" &&
    action.actorReference === null &&
    action.sourceChannel === "EVENT_CONSUMER" &&
    action.dataClassification === "Restricted" &&
    action.occurredAt === ticket.createdAt &&
    audit.auditId !== action.actionReference &&
    event.eventId !== action.actionReference &&
    event.eventId !== audit.auditId &&
    event.tenantId === ticket.brandReference &&
    event.storeId === ticket.storeReference &&
    event.aggregateId === ticket.ticketReference &&
    event.correlationId === ticket.correlationReference &&
    event.causationId === ticket.sourceEventReference &&
    event.occurredAt === ticket.createdAt &&
    event.payload.kitchenTicketReference === ticket.ticketReference &&
    event.payload.orderReference === ticket.orderReference &&
    event.payload.orderBatchReference === ticket.orderBatchReference &&
    event.payload.confirmationReference === ticket.confirmationReference &&
    event.payload.workItemCount === ticket.workItems.length &&
    event.payload.createdAt === ticket.createdAt
  );
}

function effectReferencesMatchDerivation(
  ports: KitchenTicketCreationPorts,
  effect: Omit<KitchenTicketCreationEffect, "effectDigest">,
): boolean {
  const { ticket, action, audit, event } = effect;
  return (
    ticket.ticketReference ===
      reference(ports, "KitchenTicket", {
        brandReference: ticket.brandReference,
        storeReference: ticket.storeReference,
        orderBatchReference: ticket.orderBatchReference,
      }) &&
    ticket.workItems.every(
      (item) =>
        item.workItemReference ===
        reference(ports, "KitchenWorkItem", {
          ticketReference: ticket.ticketReference,
          orderItemReference: item.orderItemReference,
          splitOrdinal: item.splitOrdinal,
        }),
    ) &&
    action.actionReference ===
      reference(ports, "KitchenCreationAction", {
        ticketReference: ticket.ticketReference,
        purpose: "CREATE_KITCHEN_TICKET",
      }) &&
    audit.auditId ===
      reference(ports, "KitchenCreationAudit", {
        ticketReference: ticket.ticketReference,
        purpose: "CREATE_KITCHEN_TICKET",
      }) &&
    event.eventId ===
      reference(ports, "KitchenWorkCreatedEvent", {
        ticketReference: ticket.ticketReference,
        purpose: "CREATE_KITCHEN_TICKET",
      })
  );
}

function reconstructEffectSnapshots(ticket: KitchenTicket): {
  readonly source: ConfirmedOrderKitchenSourceEvidence;
  readonly plan: KitchenWorkPlan;
} | null {
  try {
    const source = parseConfirmedOrderKitchenSourceEvidence({
      evidenceReference: ticket.sourceEvidenceReference,
      brandReference: ticket.brandReference,
      storeReference: ticket.storeReference,
      orderReference: ticket.orderReference,
      orderBatchReference: ticket.orderBatchReference,
      confirmationReference: ticket.confirmationReference,
      sourceEventReference: ticket.sourceEventReference,
      sourceAggregateVersion: ticket.sourceAggregateVersion,
      sourceSnapshotDigest: ticket.sourceSnapshotDigest,
      capturedAt: ticket.sourceEvidenceCapturedAt,
      evidenceVersion: ticket.sourceEvidenceVersion,
      items: ticket.workItems.map((item) => ({
        orderItemReference: item.orderItemReference,
        orderBatchReference: item.orderBatchReference,
        ordinal: item.sourceOrdinal,
        quantity: item.requiredQuantity,
        productReference: item.productReference,
        productVersionReference: item.productVersionReference,
        skuReference: item.skuReference,
        menuVersionReference: item.menuVersionReference,
        localizedDisplayNames: item.localizedDisplayNames,
        selectedOptions: item.selectedOptions,
        customerNote: item.customerNote,
        lineDigest: item.sourceLineDigest,
      })),
      evidenceDigest: ticket.sourceEvidenceDigest,
    });
    const plan = parseKitchenWorkPlan({
      planReference: ticket.planReference,
      brandReference: ticket.brandReference,
      storeReference: ticket.storeReference,
      orderReference: ticket.orderReference,
      orderBatchReference: ticket.orderBatchReference,
      confirmationReference: ticket.confirmationReference,
      sourceEvidenceDigest: ticket.sourceEvidenceDigest,
      planVersion: ticket.planVersion,
      generatedAt: ticket.planGeneratedAt,
      items: ticket.workItems.map((item) => ({
        orderItemReference: item.orderItemReference,
        splitOrdinal: item.splitOrdinal,
        stationRouting: item.stationRouting,
        preparation: item.preparation,
      })),
      planDigest: ticket.planDigest,
    });
    return Object.freeze({ source, plan });
  } catch {
    return null;
  }
}

function effectSnapshotDigestsMatch(
  ports: KitchenTicketCreationPorts,
  ticket: KitchenTicket,
): boolean {
  const snapshots = reconstructEffectSnapshots(ticket);
  if (snapshots === null) return false;
  const planItems = new Map(
    snapshots.plan.items.map((item) => [String(item.orderItemReference), item]),
  );
  for (const sourceItem of snapshots.source.items) {
    if (
      digest(ports, createOrderKitchenSourceLineBinding(sourceItem)) !==
      String(sourceItem.lineDigest)
    )
      return false;
  }
  for (const sourceItem of snapshots.source.items) {
    const planItem = planItems.get(String(sourceItem.orderItemReference));
    if (
      planItem === undefined ||
      digest(ports, createKitchenExecutionSnapshotDigestBinding(sourceItem, planItem)) !==
        ticket.workItems.find(
          (item) => item.orderItemReference === String(sourceItem.orderItemReference),
        )?.executionSnapshotDigest
    )
      return false;
  }
  return (
    digest(ports, createOrderKitchenSourceEvidenceBinding(snapshots.source)) ===
      String(snapshots.source.evidenceDigest) &&
    digest(ports, createKitchenWorkPlanDigestBinding(snapshots.plan)) === snapshots.plan.planDigest
  );
}

function parseEffect(
  value: unknown,
  ports: KitchenTicketCreationPorts,
  onMalformed: () => never = dependency,
): KitchenTicketCreationEffect {
  const raw = safeObject(
    value,
    ["receipt", "ticket", "action", "audit", "event", "effectDigest"],
    onMalformed,
  );
  let receipt: ConfirmedOrderIntakeReceipt;
  let ticket: KitchenTicket;
  let action: KitchenTicketCreationAction;
  try {
    receipt = parseConfirmedOrderIntakeReceipt(raw.receipt);
    ticket = parseKitchenTicket(raw.ticket);
    action = parseKitchenTicketCreationAction(raw.action);
  } catch {
    return onMalformed();
  }
  const audit = parseAudit(raw.audit, ticket, onMalformed);
  let event;
  try {
    event = parseKitchenWorkCreatedEnvelope(raw.event);
  } catch {
    return onMalformed();
  }
  let effectDigest;
  try {
    effectDigest = parseKitchenTicketDigest(raw.effectDigest);
  } catch {
    return onMalformed();
  }
  const withoutDigest = Object.freeze({ receipt, ticket, action, audit, event });
  if (
    !effectMatchesTicket(withoutDigest) ||
    !effectReferencesMatchDerivation(ports, withoutDigest) ||
    !effectSnapshotDigestsMatch(ports, ticket) ||
    digest(ports, effectBinding(withoutDigest)) !== effectDigest
  )
    return onMalformed();
  return Object.freeze({ ...withoutDigest, effectDigest });
}

function createEffect(
  ports: KitchenTicketCreationPorts,
  receipt: ConfirmedOrderIntakeReceipt,
  ticket: KitchenTicket,
): KitchenTicketCreationEffect {
  const action = createAction(ports, ticket);
  const audit = createAudit(ports, ticket);
  const eventReference = reference(ports, "KitchenWorkCreatedEvent", {
    ticketReference: ticket.ticketReference,
    purpose: "CREATE_KITCHEN_TICKET",
  });
  let event;
  try {
    event = createKitchenWorkCreatedEnvelope({ eventReference, ticket });
  } catch {
    return dependency();
  }
  const withoutDigest = Object.freeze({ receipt, ticket, action, audit, event });
  return parseEffect(
    { ...withoutDigest, effectDigest: digest(ports, effectBinding(withoutDigest)) },
    ports,
  );
}

function effectsMatchExact(
  left: KitchenTicketCreationEffect,
  right: KitchenTicketCreationEffect,
): boolean {
  return left.effectDigest === right.effectDigest && effectBinding(left) === effectBinding(right);
}

function concurrentEffectBinding(
  effect: KitchenTicketCreationEffect,
  differentSourceEvent: boolean,
): string {
  const sourceEventReference = differentSourceEvent
    ? "<semantic-order-confirmed-event>"
    : effect.receipt.sourceEventReference;
  return canonical({
    receipt: { ...effect.receipt, sourceEventReference },
    ticket: {
      ...effect.ticket,
      sourceEventReference,
      ...(differentSourceEvent
        ? {
            sourceEvidenceReference: "<event-bound-source-evidence-reference>",
            sourceEvidenceDigest: "<event-bound-source-evidence-digest>",
            sourceEvidenceCapturedAt: "<event-bound-source-evidence-captured-at>",
            planReference: "<event-bound-plan-reference>",
            planDigest: "<event-bound-plan-digest>",
            planGeneratedAt: "<event-bound-plan-generated-at>",
          }
        : {}),
      createdAt: "<concurrent-creation-time>",
      workItems: effect.ticket.workItems.map((item) => ({
        ...item,
        createdAt: "<concurrent-creation-time>",
      })),
    },
    action: {
      ...effect.action,
      sourceEventReference,
      occurredAt: "<concurrent-creation-time>",
    },
    audit: {
      ...effect.audit,
      occurredAt: "<concurrent-creation-time>",
    },
    event: {
      ...effect.event,
      occurredAt: "<concurrent-creation-time>",
      causationId: sourceEventReference,
      payload: {
        ...effect.event.payload,
        createdAt: "<concurrent-creation-time>",
      },
    },
  });
}

function effectsMatchSemantic(
  left: KitchenTicketCreationEffect,
  right: KitchenTicketCreationEffect,
): boolean {
  const differentSourceEvent =
    left.receipt.sourceEventReference !== right.receipt.sourceEventReference;
  if (
    differentSourceEvent
      ? !confirmedOrderReceiptsMatchSemantic(left.receipt, right.receipt)
      : !confirmedOrderReceiptsMatchExact(left.receipt, right.receipt)
  )
    return false;
  return (
    concurrentEffectBinding(left, differentSourceEvent) ===
    concurrentEffectBinding(right, differentSourceEvent)
  );
}

function effectMatchesIdentity(
  effect: KitchenTicketCreationEffect,
  identity: KitchenTicketSemanticIdentity,
): boolean {
  return (
    effect.receipt.brandReference === identity.brandReference &&
    effect.receipt.storeReference === identity.storeReference &&
    effect.receipt.confirmationReference === identity.confirmationReference &&
    effect.receipt.orderBatchReference === identity.orderBatchReference
  );
}

async function repositoryResolution(
  ports: KitchenTicketCreationPorts,
  identity: KitchenTicketSemanticIdentity,
): Promise<
  | { readonly status: "NotFound" }
  | { readonly status: "Resolved"; readonly effect: KitchenTicketCreationEffect }
> {
  let resolution: KitchenTicketIdentityResolution;
  try {
    resolution = parseResolution(await ports.repository.resolveBySemanticKeys(identity));
  } catch (error) {
    if (error instanceof KitchenTicketCreationError) throw error;
    return dependency();
  }
  if (resolution.status === "Conflict") return conflict();
  if (resolution.status === "NotFound") return Object.freeze({ status: "NotFound" as const });
  const effect = parseEffect(resolution.effect, ports, conflict);
  if (!effectMatchesIdentity(effect, identity)) return conflict();
  return Object.freeze({ status: "Resolved" as const, effect });
}

function result(
  status: "Created" | "AlreadyCreated",
  effect: KitchenTicketCreationEffect,
): KitchenTicketCreationResult {
  return parseKitchenTicketCreationResult({
    status,
    receipt: effect.receipt,
    ticketReference: effect.ticket.ticketReference,
    workItemCount: effect.ticket.workItems.length,
  });
}

async function recoverCommitUnknown(
  ports: KitchenTicketCreationPorts,
  identity: KitchenTicketSemanticIdentity,
  expected: KitchenTicketCreationEffect,
): Promise<KitchenTicketCreationResult> {
  const recovered = await repositoryResolution(ports, identity);
  if (recovered.status === "NotFound") return dependency();
  if (!effectsMatchSemantic(recovered.effect, expected)) return conflict();
  return result("AlreadyCreated", recovered.effect);
}

export function createKitchenTicketCreationService(ports: KitchenTicketCreationPorts) {
  return Object.freeze({
    async resolveExisting(value: KitchenTicketSemanticIdentity) {
      return repositoryResolution(ports, semanticIdentity(value));
    },

    async create(value: {
      readonly receipt: ConfirmedOrderIntakeReceipt;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenTicketCreationResult> {
      const raw = safeObject(value, ["receipt", "transaction"], inputInvalid);
      let receipt: ConfirmedOrderIntakeReceipt;
      try {
        receipt = parseConfirmedOrderIntakeReceipt(raw.receipt);
      } catch {
        return inputInvalid();
      }
      if (
        raw.transaction === null ||
        typeof raw.transaction !== "object" ||
        typeof (raw.transaction as { readonly query?: unknown }).query !== "function"
      )
        return inputInvalid();
      const transaction = raw.transaction as ConsumerTransaction;
      const identity = identityFromReceipt(receipt, transaction);
      const prior = await repositoryResolution(ports, identity);
      if (prior.status === "Resolved") {
        if (!confirmedOrderReceiptsMatchSemantic(receipt, prior.effect.receipt)) return conflict();
        return result("AlreadyCreated", prior.effect);
      }

      const source = await resolveSource(ports, receipt);
      const planned = await resolvePlan(ports, receipt, source);
      let createdAt;
      try {
        createdAt = parseKitchenTicketInstant(await ports.clock.now());
      } catch {
        return dependency();
      }
      if (
        Date.parse(createdAt) < Date.parse(receipt.confirmedAt) ||
        Date.parse(createdAt) < Date.parse(source.capturedAt) ||
        Date.parse(createdAt) < Date.parse(planned.plan.generatedAt)
      )
        return dependency();
      const ticket = createTicket({
        ports,
        receipt,
        source,
        plan: planned.plan,
        planItems: planned.items,
        createdAt,
      });
      const expected = createEffect(ports, receipt, ticket);

      let commit: KitchenTicketCommitResult;
      try {
        commit = parseCommit(await ports.repository.commit({ effect: expected, transaction }));
      } catch {
        return recoverCommitUnknown(ports, identity, expected);
      }
      const stored = parseEffect(commit.effect, ports, conflict);
      if (commit.status === "Conflict") {
        if (effectsMatchExact(stored, expected)) return dependency();
        return conflict();
      }
      if (commit.status === "Created" && !effectsMatchExact(stored, expected)) return conflict();
      if (commit.status === "AlreadyCreated" && !effectsMatchSemantic(stored, expected))
        return conflict();
      return result(commit.status, stored);
    },
  });
}
