export const confirmedOrderConsumerName = "kitchen.confirmed-order:v1" as const;
export const confirmedOrderConsumerVersion = 1 as const;

export type KitchenReference = string & { readonly __kitchenReference: unique symbol };
export type KitchenInstant = string & { readonly __kitchenInstant: unique symbol };
export type KitchenDigest = string & { readonly __kitchenDigest: unique symbol };

export interface ConfirmedOrderIntakeReceipt {
  readonly consumerName: typeof confirmedOrderConsumerName;
  readonly consumerVersion: typeof confirmedOrderConsumerVersion;
  readonly sourceEventReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: KitchenDigest;
  readonly confirmedAt: KitchenInstant;
  readonly correlationReference: KitchenReference;
  readonly semanticEventBindingDigest: KitchenDigest;
}

export type ConfirmedOrderIntakeResult =
  | {
      readonly status: "Accepted";
      readonly receipt: ConfirmedOrderIntakeReceipt;
    }
  | {
      readonly status: "AlreadyAccepted";
      readonly receipt: ConfirmedOrderIntakeReceipt;
    };

export const confirmedOrderIntakeErrorCodes = [
  "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID",
  "KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED",
  "KITCHEN_CONFIRMED_ORDER_CONFLICT",
  "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
] as const;
export type ConfirmedOrderIntakeErrorCode = (typeof confirmedOrderIntakeErrorCodes)[number];

export class ConfirmedOrderIntakeError extends Error {
  constructor(readonly code: ConfirmedOrderIntakeErrorCode) {
    super(
      code === "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID"
        ? "confirmed order intake is invalid"
        : code === "KITCHEN_CONFIRMED_ORDER_CONFLICT"
          ? "confirmed order intake conflict"
          : "confirmed order intake is unavailable",
    );
    this.name = "ConfirmedOrderIntakeError";
  }
}

export const kitchenTicketAuditRetentionPolicyCode = "KITCHEN_BUSINESS_RECORD" as const;
export const kitchenTicketAuditRetentionPolicyVersion = 1 as const;

export type KitchenTicketStatus = "Open";
export type KitchenWorkItemStatus = "Queued";

export type KitchenLocalizedNamesSnapshot = Readonly<Record<string, string>>;

export interface KitchenSelectedOptionSnapshot {
  readonly optionReference: KitchenReference;
  readonly quantity: number;
  readonly localizedNames: KitchenLocalizedNamesSnapshot;
}

export interface KitchenStationRoutingSnapshot {
  readonly stationReference: KitchenReference;
  readonly routingRuleReference: KitchenReference;
  readonly routingRuleVersion: number;
  readonly routingRuleDigest: KitchenDigest;
}

export interface KitchenPreparationSnapshot {
  readonly preparationReference: KitchenReference;
  readonly preparationVersion: number;
  readonly preparationDigest: KitchenDigest;
  readonly instructions: readonly string[];
}

export interface KitchenPlanningSourceOption {
  readonly optionReference: KitchenReference;
  readonly quantity: number;
}

export interface KitchenPlanningSourceItem {
  readonly orderItemReference: KitchenReference;
  readonly ordinal: number;
  readonly quantity: number;
  readonly productReference: KitchenReference;
  readonly productVersionReference: KitchenReference;
  readonly skuReference: KitchenReference;
  readonly menuVersionReference: KitchenReference;
  readonly selectedOptions: readonly KitchenPlanningSourceOption[];
  readonly sourceLineDigest: KitchenDigest;
}

export interface KitchenPlanningSource {
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly sourceEvidenceReference: KitchenReference;
  readonly sourceEvidenceVersion: number;
  readonly sourceEvidenceDigest: KitchenDigest;
  readonly items: readonly KitchenPlanningSourceItem[];
}

export interface KitchenWorkPlanItem {
  readonly orderItemReference: KitchenReference;
  readonly splitOrdinal: 1;
  readonly stationRouting: KitchenStationRoutingSnapshot;
  readonly preparation: KitchenPreparationSnapshot;
}

export interface KitchenWorkPlan {
  readonly planReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly sourceEvidenceDigest: KitchenDigest;
  readonly planVersion: number;
  readonly generatedAt: KitchenInstant;
  readonly items: readonly KitchenWorkPlanItem[];
  readonly planDigest: KitchenDigest;
}

export interface KitchenWorkItem {
  readonly workItemReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly sourceOrdinal: number;
  readonly splitOrdinal: 1;
  readonly requiredQuantity: number;
  readonly completedQuantity: 0;
  readonly status: KitchenWorkItemStatus;
  readonly productReference: KitchenReference;
  readonly productVersionReference: KitchenReference;
  readonly skuReference: KitchenReference;
  readonly menuVersionReference: KitchenReference;
  readonly localizedDisplayNames: KitchenLocalizedNamesSnapshot;
  readonly selectedOptions: readonly KitchenSelectedOptionSnapshot[];
  readonly customerNote: string | null;
  readonly sourceLineDigest: KitchenDigest;
  readonly stationRouting: KitchenStationRoutingSnapshot;
  readonly preparation: KitchenPreparationSnapshot;
  readonly executionSnapshotDigest: KitchenDigest;
  readonly createdAt: KitchenInstant;
}

export interface KitchenTicket {
  readonly ticketReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly sourceEventReference: KitchenReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: KitchenDigest;
  readonly sourceEvidenceReference: KitchenReference;
  readonly sourceEvidenceVersion: number;
  readonly sourceEvidenceDigest: KitchenDigest;
  readonly sourceEvidenceCapturedAt: KitchenInstant;
  readonly planReference: KitchenReference;
  readonly planVersion: number;
  readonly planDigest: KitchenDigest;
  readonly planGeneratedAt: KitchenInstant;
  readonly consumerName: ConfirmedOrderIntakeReceipt["consumerName"];
  readonly consumerVersion: ConfirmedOrderIntakeReceipt["consumerVersion"];
  readonly confirmedAt: KitchenInstant;
  readonly correlationReference: KitchenReference;
  readonly semanticEventBindingDigest: KitchenDigest;
  readonly aggregateVersion: 1n;
  readonly status: KitchenTicketStatus;
  readonly createdAt: KitchenInstant;
  readonly workItems: readonly KitchenWorkItem[];
}

export interface KitchenTicketCreationAction {
  readonly actionReference: KitchenReference;
  readonly actionVersion: 1;
  readonly actionCode: "KITCHEN_TICKET_CREATED";
  readonly purpose: "CREATE_KITCHEN_TICKET";
  readonly reasonCode: "ORDER_CONFIRMED";
  readonly actorType: "System";
  readonly actorReference: null;
  readonly sourceChannel: "EVENT_CONSUMER";
  readonly dataClassification: "Restricted";
  readonly ticketReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly sourceEventReference: KitchenReference;
  readonly correlationReference: KitchenReference;
  readonly workItemCount: number;
  readonly occurredAt: KitchenInstant;
}

export interface KitchenTicketCreationResult {
  readonly status: "Created" | "AlreadyCreated";
  readonly receipt: ConfirmedOrderIntakeReceipt;
  readonly ticketReference: KitchenReference;
  readonly workItemCount: number;
}

export const kitchenTicketCreationErrorCodes = [
  "KITCHEN_TICKET_INPUT_INVALID",
  "KITCHEN_TICKET_PERMISSION_DENIED",
  "KITCHEN_TICKET_CONFLICT",
  "KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE",
] as const;

export type KitchenTicketCreationErrorCode = (typeof kitchenTicketCreationErrorCodes)[number];

export class KitchenTicketCreationError extends Error {
  constructor(readonly code: KitchenTicketCreationErrorCode) {
    super("kitchen ticket creation is unavailable");
    this.name = "KitchenTicketCreationError";
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;

function invalid(): never {
  throw new KitchenTicketCreationError("KITCHEN_TICKET_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
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
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenTicketCreationError) throw error;
    return invalid();
  }
}

function exactArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = (descriptors as unknown as Record<PropertyKey, PropertyDescriptor>)[
      "length"
    ];
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < minimum ||
      lengthDescriptor.value > maximum
    )
      return invalid();
    const length = lengthDescriptor.value;
    const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.size ||
      keys.some((key) => typeof key !== "string" || !expected.has(key))
    )
      return invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenTicketCreationError) throw error;
    return invalid();
  }
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

export function parseKitchenTicketReference(value: unknown): KitchenReference {
  if (typeof value !== "string" || !uuidV7.test(value)) return invalid();
  return value as KitchenReference;
}

export function parseKitchenTicketInstant(value: unknown): KitchenInstant {
  if (typeof value !== "string" || !instant.test(value) || new Date(value).toISOString() !== value)
    return invalid();
  return value as KitchenInstant;
}

export function parseKitchenTicketDigest(value: unknown): KitchenDigest {
  if (typeof value !== "string" || !digest.test(value)) return invalid();
  return value as KitchenDigest;
}

function normalizedText(value: unknown, maximum: number, allowNewline: boolean): string {
  if (typeof value !== "string" || !value.isWellFormed()) return invalid();
  const normalized = value.normalize("NFC");
  if (
    !normalized.isWellFormed() ||
    [...normalized].some((character) => prohibitedCodePoint(character, allowNewline))
  )
    return invalid();
  const trimmed = normalized.trim();
  if (trimmed.length === 0 || [...trimmed].length > maximum) return invalid();
  return trimmed;
}

function prohibitedCodePoint(character: string, allowNewline: boolean): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return true;
  if (codePoint <= 0x1f) return !(allowNewline && codePoint === 0x0a);
  return (
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

export function parseKitchenCustomerNote(value: unknown): string | null {
  if (value === null) return null;
  const normalized = normalizedText(value, 240, true);
  if (normalized.split("\n").length > 4) return invalid();
  return normalized;
}

function localizedNames(value: unknown): KitchenLocalizedNamesSnapshot {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length < 1 ||
      keys.length > 20 ||
      keys.some((key) => typeof key !== "string" || !locale.test(key))
    )
      return invalid();
    const result: Record<string, string> = {};
    for (const key of [...keys].sort()) {
      if (typeof key !== "string") return invalid();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[key] = normalizedText(descriptor.value, 200, false);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenTicketCreationError) throw error;
    return invalid();
  }
}

function selectedOption(value: unknown): KitchenSelectedOptionSnapshot {
  const raw = exact(value, ["optionReference", "quantity", "localizedNames"]);
  return Object.freeze({
    optionReference: parseKitchenTicketReference(raw.optionReference),
    quantity: positiveInteger(raw.quantity, 999),
    localizedNames: localizedNames(raw.localizedNames),
  });
}

function stationRouting(value: unknown): KitchenStationRoutingSnapshot {
  const raw = exact(value, [
    "stationReference",
    "routingRuleReference",
    "routingRuleVersion",
    "routingRuleDigest",
  ]);
  return Object.freeze({
    stationReference: parseKitchenTicketReference(raw.stationReference),
    routingRuleReference: parseKitchenTicketReference(raw.routingRuleReference),
    routingRuleVersion: positiveInteger(raw.routingRuleVersion),
    routingRuleDigest: parseKitchenTicketDigest(raw.routingRuleDigest),
  });
}

function preparation(value: unknown): KitchenPreparationSnapshot {
  const raw = exact(value, [
    "preparationReference",
    "preparationVersion",
    "preparationDigest",
    "instructions",
  ]);
  const instructions = exactArray(raw.instructions, 1, 32).map((entry) =>
    normalizedText(entry, 500, false),
  );
  return Object.freeze({
    preparationReference: parseKitchenTicketReference(raw.preparationReference),
    preparationVersion: positiveInteger(raw.preparationVersion),
    preparationDigest: parseKitchenTicketDigest(raw.preparationDigest),
    instructions: Object.freeze(instructions),
  });
}

function planningSourceOption(value: unknown): KitchenPlanningSourceOption {
  const raw = exact(value, ["optionReference", "quantity"]);
  return Object.freeze({
    optionReference: parseKitchenTicketReference(raw.optionReference),
    quantity: positiveInteger(raw.quantity, 999),
  });
}

function planningSourceItem(value: unknown): KitchenPlanningSourceItem {
  const raw = exact(value, [
    "orderItemReference",
    "ordinal",
    "quantity",
    "productReference",
    "productVersionReference",
    "skuReference",
    "menuVersionReference",
    "selectedOptions",
    "sourceLineDigest",
  ]);
  const selectedOptions = exactArray(raw.selectedOptions, 0, 100)
    .map(planningSourceOption)
    .sort((left, right) => left.optionReference.localeCompare(right.optionReference));
  if (
    new Set(selectedOptions.map((entry) => entry.optionReference)).size !== selectedOptions.length
  )
    return invalid();
  return Object.freeze({
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    ordinal: positiveInteger(raw.ordinal, 100),
    quantity: positiveInteger(raw.quantity, 999),
    productReference: parseKitchenTicketReference(raw.productReference),
    productVersionReference: parseKitchenTicketReference(raw.productVersionReference),
    skuReference: parseKitchenTicketReference(raw.skuReference),
    menuVersionReference: parseKitchenTicketReference(raw.menuVersionReference),
    selectedOptions: Object.freeze(selectedOptions),
    sourceLineDigest: parseKitchenTicketDigest(raw.sourceLineDigest),
  });
}

export function parseKitchenPlanningSource(value: unknown): KitchenPlanningSource {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEvidenceReference",
    "sourceEvidenceVersion",
    "sourceEvidenceDigest",
    "items",
  ]);
  const items = exactArray(raw.items, 1, 100)
    .map(planningSourceItem)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (
    new Set(items.map((entry) => entry.orderItemReference)).size !== items.length ||
    items.some((entry, index) => entry.ordinal !== index + 1)
  )
    return invalid();
  return Object.freeze({
    brandReference: parseKitchenTicketReference(raw.brandReference),
    storeReference: parseKitchenTicketReference(raw.storeReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    confirmationReference: parseKitchenTicketReference(raw.confirmationReference),
    sourceEvidenceReference: parseKitchenTicketReference(raw.sourceEvidenceReference),
    sourceEvidenceVersion: positiveInteger(raw.sourceEvidenceVersion),
    sourceEvidenceDigest: parseKitchenTicketDigest(raw.sourceEvidenceDigest),
    items: Object.freeze(items),
  });
}

function planItem(value: unknown): KitchenWorkPlanItem {
  const raw = exact(value, ["orderItemReference", "splitOrdinal", "stationRouting", "preparation"]);
  if (raw.splitOrdinal !== 1) return invalid();
  return Object.freeze({
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    splitOrdinal: 1,
    stationRouting: stationRouting(raw.stationRouting),
    preparation: preparation(raw.preparation),
  });
}

export function parseKitchenWorkPlan(value: unknown): KitchenWorkPlan {
  const raw = exact(value, [
    "planReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEvidenceDigest",
    "planVersion",
    "generatedAt",
    "items",
    "planDigest",
  ]);
  const items = exactArray(raw.items, 1, 100)
    .map(planItem)
    .sort((left, right) => left.orderItemReference.localeCompare(right.orderItemReference));
  if (new Set(items.map((entry) => entry.orderItemReference)).size !== items.length)
    return invalid();
  return Object.freeze({
    planReference: parseKitchenTicketReference(raw.planReference),
    brandReference: parseKitchenTicketReference(raw.brandReference),
    storeReference: parseKitchenTicketReference(raw.storeReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    confirmationReference: parseKitchenTicketReference(raw.confirmationReference),
    sourceEvidenceDigest: parseKitchenTicketDigest(raw.sourceEvidenceDigest),
    planVersion: positiveInteger(raw.planVersion),
    generatedAt: parseKitchenTicketInstant(raw.generatedAt),
    items: Object.freeze(items),
    planDigest: parseKitchenTicketDigest(raw.planDigest),
  });
}

function workItem(value: unknown): KitchenWorkItem {
  const raw = exact(value, [
    "workItemReference",
    "ticketReference",
    "brandReference",
    "storeReference",
    "orderItemReference",
    "orderBatchReference",
    "sourceOrdinal",
    "splitOrdinal",
    "requiredQuantity",
    "completedQuantity",
    "status",
    "productReference",
    "productVersionReference",
    "skuReference",
    "menuVersionReference",
    "localizedDisplayNames",
    "selectedOptions",
    "customerNote",
    "sourceLineDigest",
    "stationRouting",
    "preparation",
    "executionSnapshotDigest",
    "createdAt",
  ]);
  if (raw.splitOrdinal !== 1 || raw.completedQuantity !== 0 || raw.status !== "Queued")
    return invalid();
  const selectedOptions = exactArray(raw.selectedOptions, 0, 100)
    .map(selectedOption)
    .sort((left, right) => left.optionReference.localeCompare(right.optionReference));
  if (
    new Set(selectedOptions.map((entry) => entry.optionReference)).size !== selectedOptions.length
  )
    return invalid();
  return Object.freeze({
    workItemReference: parseKitchenTicketReference(raw.workItemReference),
    ticketReference: parseKitchenTicketReference(raw.ticketReference),
    brandReference: parseKitchenTicketReference(raw.brandReference),
    storeReference: parseKitchenTicketReference(raw.storeReference),
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    sourceOrdinal: positiveInteger(raw.sourceOrdinal, 100),
    splitOrdinal: 1,
    requiredQuantity: positiveInteger(raw.requiredQuantity, 999),
    completedQuantity: 0,
    status: "Queued",
    productReference: parseKitchenTicketReference(raw.productReference),
    productVersionReference: parseKitchenTicketReference(raw.productVersionReference),
    skuReference: parseKitchenTicketReference(raw.skuReference),
    menuVersionReference: parseKitchenTicketReference(raw.menuVersionReference),
    localizedDisplayNames: localizedNames(raw.localizedDisplayNames),
    selectedOptions: Object.freeze(selectedOptions),
    customerNote: parseKitchenCustomerNote(raw.customerNote),
    sourceLineDigest: parseKitchenTicketDigest(raw.sourceLineDigest),
    stationRouting: stationRouting(raw.stationRouting),
    preparation: preparation(raw.preparation),
    executionSnapshotDigest: parseKitchenTicketDigest(raw.executionSnapshotDigest),
    createdAt: parseKitchenTicketInstant(raw.createdAt),
  });
}

export function parseKitchenTicket(value: unknown): KitchenTicket {
  const raw = exact(value, [
    "ticketReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEventReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "sourceEvidenceReference",
    "sourceEvidenceVersion",
    "sourceEvidenceDigest",
    "sourceEvidenceCapturedAt",
    "planReference",
    "planVersion",
    "planDigest",
    "planGeneratedAt",
    "consumerName",
    "consumerVersion",
    "confirmedAt",
    "correlationReference",
    "semanticEventBindingDigest",
    "aggregateVersion",
    "status",
    "createdAt",
    "workItems",
  ]);
  if (
    raw.consumerName !== confirmedOrderConsumerName ||
    raw.consumerVersion !== confirmedOrderConsumerVersion ||
    typeof raw.sourceAggregateVersion !== "bigint" ||
    raw.sourceAggregateVersion <= 0n ||
    raw.aggregateVersion !== 1n ||
    raw.status !== "Open"
  )
    return invalid();
  const ticketReference = parseKitchenTicketReference(raw.ticketReference);
  const brandReference = parseKitchenTicketReference(raw.brandReference);
  const storeReference = parseKitchenTicketReference(raw.storeReference);
  const orderBatchReference = parseKitchenTicketReference(raw.orderBatchReference);
  const createdAt = parseKitchenTicketInstant(raw.createdAt);
  const workItems = exactArray(raw.workItems, 1, 100)
    .map(workItem)
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (
    new Set(workItems.map((entry) => entry.workItemReference)).size !== workItems.length ||
    new Set(workItems.map((entry) => entry.orderItemReference)).size !== workItems.length ||
    workItems.some(
      (entry, index) =>
        entry.sourceOrdinal !== index + 1 ||
        entry.ticketReference !== ticketReference ||
        entry.brandReference !== brandReference ||
        entry.storeReference !== storeReference ||
        entry.orderBatchReference !== orderBatchReference ||
        entry.createdAt !== createdAt,
    )
  )
    return invalid();
  const confirmedAt = parseKitchenTicketInstant(raw.confirmedAt);
  const sourceEvidenceCapturedAt = parseKitchenTicketInstant(raw.sourceEvidenceCapturedAt);
  const planGeneratedAt = parseKitchenTicketInstant(raw.planGeneratedAt);
  if (
    Date.parse(sourceEvidenceCapturedAt) > Date.parse(confirmedAt) ||
    Date.parse(confirmedAt) > Date.parse(planGeneratedAt) ||
    Date.parse(planGeneratedAt) > Date.parse(createdAt)
  )
    return invalid();
  return Object.freeze({
    ticketReference,
    brandReference,
    storeReference,
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference,
    confirmationReference: parseKitchenTicketReference(raw.confirmationReference),
    sourceEventReference: parseKitchenTicketReference(raw.sourceEventReference),
    sourceAggregateVersion: raw.sourceAggregateVersion,
    sourceSnapshotDigest: parseKitchenTicketDigest(raw.sourceSnapshotDigest),
    sourceEvidenceReference: parseKitchenTicketReference(raw.sourceEvidenceReference),
    sourceEvidenceVersion: positiveInteger(raw.sourceEvidenceVersion),
    sourceEvidenceDigest: parseKitchenTicketDigest(raw.sourceEvidenceDigest),
    sourceEvidenceCapturedAt,
    planReference: parseKitchenTicketReference(raw.planReference),
    planVersion: positiveInteger(raw.planVersion),
    planDigest: parseKitchenTicketDigest(raw.planDigest),
    planGeneratedAt,
    consumerName: confirmedOrderConsumerName,
    consumerVersion: confirmedOrderConsumerVersion,
    confirmedAt,
    correlationReference: parseKitchenTicketReference(raw.correlationReference),
    semanticEventBindingDigest: parseKitchenTicketDigest(raw.semanticEventBindingDigest),
    aggregateVersion: 1n,
    status: "Open",
    createdAt,
    workItems: Object.freeze(workItems),
  });
}

export function parseKitchenTicketCreationAction(value: unknown): KitchenTicketCreationAction {
  const raw = exact(value, [
    "actionReference",
    "actionVersion",
    "actionCode",
    "purpose",
    "reasonCode",
    "actorType",
    "actorReference",
    "sourceChannel",
    "dataClassification",
    "ticketReference",
    "brandReference",
    "storeReference",
    "sourceEventReference",
    "correlationReference",
    "workItemCount",
    "occurredAt",
  ]);
  if (
    raw.actionVersion !== 1 ||
    raw.actionCode !== "KITCHEN_TICKET_CREATED" ||
    raw.purpose !== "CREATE_KITCHEN_TICKET" ||
    raw.reasonCode !== "ORDER_CONFIRMED" ||
    raw.actorType !== "System" ||
    raw.actorReference !== null ||
    raw.sourceChannel !== "EVENT_CONSUMER" ||
    raw.dataClassification !== "Restricted"
  )
    return invalid();
  return Object.freeze({
    actionReference: parseKitchenTicketReference(raw.actionReference),
    actionVersion: 1,
    actionCode: "KITCHEN_TICKET_CREATED",
    purpose: "CREATE_KITCHEN_TICKET",
    reasonCode: "ORDER_CONFIRMED",
    actorType: "System",
    actorReference: null,
    sourceChannel: "EVENT_CONSUMER",
    dataClassification: "Restricted",
    ticketReference: parseKitchenTicketReference(raw.ticketReference),
    brandReference: parseKitchenTicketReference(raw.brandReference),
    storeReference: parseKitchenTicketReference(raw.storeReference),
    sourceEventReference: parseKitchenTicketReference(raw.sourceEventReference),
    correlationReference: parseKitchenTicketReference(raw.correlationReference),
    workItemCount: positiveInteger(raw.workItemCount, 100),
    occurredAt: parseKitchenTicketInstant(raw.occurredAt),
  });
}

function receipt(value: unknown): ConfirmedOrderIntakeReceipt {
  const raw = exact(value, [
    "consumerName",
    "consumerVersion",
    "sourceEventReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "confirmedAt",
    "correlationReference",
    "semanticEventBindingDigest",
  ]);
  if (
    raw.consumerName !== confirmedOrderConsumerName ||
    raw.consumerVersion !== confirmedOrderConsumerVersion ||
    typeof raw.sourceAggregateVersion !== "bigint" ||
    raw.sourceAggregateVersion <= 0n
  )
    return invalid();
  return Object.freeze({
    consumerName: confirmedOrderConsumerName,
    consumerVersion: confirmedOrderConsumerVersion,
    sourceEventReference: parseKitchenTicketReference(raw.sourceEventReference),
    brandReference: parseKitchenTicketReference(raw.brandReference),
    storeReference: parseKitchenTicketReference(raw.storeReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    confirmationReference: parseKitchenTicketReference(raw.confirmationReference),
    sourceAggregateVersion: raw.sourceAggregateVersion,
    sourceSnapshotDigest: parseKitchenTicketDigest(raw.sourceSnapshotDigest),
    confirmedAt: parseKitchenTicketInstant(raw.confirmedAt),
    correlationReference: parseKitchenTicketReference(raw.correlationReference),
    semanticEventBindingDigest: parseKitchenTicketDigest(raw.semanticEventBindingDigest),
  });
}

export function parseKitchenTicketCreationResult(value: unknown): KitchenTicketCreationResult {
  const raw = exact(value, ["status", "receipt", "ticketReference", "workItemCount"]);
  if (raw.status !== "Created" && raw.status !== "AlreadyCreated") return invalid();
  return Object.freeze({
    status: raw.status,
    receipt: receipt(raw.receipt),
    ticketReference: parseKitchenTicketReference(raw.ticketReference),
    workItemCount: positiveInteger(raw.workItemCount, 100),
  });
}

export function receiptFromKitchenTicket(ticketValue: unknown): ConfirmedOrderIntakeReceipt {
  const ticket = parseKitchenTicket(ticketValue);
  return Object.freeze({
    consumerName: ticket.consumerName,
    consumerVersion: ticket.consumerVersion,
    sourceEventReference: ticket.sourceEventReference,
    brandReference: ticket.brandReference,
    storeReference: ticket.storeReference,
    orderReference: ticket.orderReference,
    orderBatchReference: ticket.orderBatchReference,
    confirmationReference: ticket.confirmationReference,
    sourceAggregateVersion: ticket.sourceAggregateVersion,
    sourceSnapshotDigest: ticket.sourceSnapshotDigest,
    confirmedAt: ticket.confirmedAt,
    correlationReference: ticket.correlationReference,
    semanticEventBindingDigest: ticket.semanticEventBindingDigest,
  });
}

export function createKitchenWorkPlanDigestBinding(value: unknown): string {
  const plan = parseKitchenWorkPlan(value);
  return JSON.stringify({
    planReference: plan.planReference,
    brandReference: plan.brandReference,
    storeReference: plan.storeReference,
    orderReference: plan.orderReference,
    orderBatchReference: plan.orderBatchReference,
    confirmationReference: plan.confirmationReference,
    sourceEvidenceDigest: plan.sourceEvidenceDigest,
    planVersion: plan.planVersion,
    generatedAt: plan.generatedAt,
    items: plan.items.map((entry) => ({
      orderItemReference: entry.orderItemReference,
      splitOrdinal: entry.splitOrdinal,
      stationRouting: entry.stationRouting,
      preparation: entry.preparation,
    })),
  });
}
