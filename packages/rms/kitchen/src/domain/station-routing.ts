import {
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "./kitchen-ticket.js";

export type KitchenConfigurationStatus = "Active" | "Inactive";

export interface KitchenStationRoutingSelector {
  readonly kind: "AllPreparedItems";
}

export interface KitchenPreparationEvidenceOption {
  readonly optionReference: KitchenReference;
  readonly quantity: number;
}

export interface KitchenPreparationEvidenceItem {
  readonly orderItemReference: KitchenReference;
  readonly ordinal: number;
  readonly quantity: number;
  readonly productReference: KitchenReference;
  readonly productVersionReference: KitchenReference;
  readonly skuReference: KitchenReference;
  readonly menuVersionReference: KitchenReference;
  readonly selectedOptions: readonly KitchenPreparationEvidenceOption[];
  readonly sourceLineDigest: KitchenDigest;
  readonly preparationReference: KitchenReference;
  readonly preparationVersion: number;
  readonly preparationDigest: KitchenDigest;
  readonly instructions: readonly string[];
  readonly requiredStationCapabilityReferences: readonly KitchenReference[];
}

export interface KitchenPreparationEvidenceSet {
  readonly evidenceReference: KitchenReference;
  readonly evidenceVersion: number;
  readonly evidenceDigest: KitchenDigest;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly effectiveAt: KitchenInstant;
  readonly items: readonly KitchenPreparationEvidenceItem[];
}

export interface KitchenStationRoutingCandidate {
  readonly stationReference: KitchenReference;
  readonly stationVersion: number;
  readonly stationStatus: KitchenConfigurationStatus;
  readonly stationCapabilityReferences: readonly KitchenReference[];
  readonly routingRuleReference: KitchenReference;
  readonly routingRuleVersion: number;
  readonly routingRuleStatus: KitchenConfigurationStatus;
  readonly selector: KitchenStationRoutingSelector;
  readonly targetStationReference: KitchenReference;
  readonly routingRuleDigest: KitchenDigest;
}

export interface KitchenStationRoutingCandidateSetEvidence {
  readonly evidenceReference: KitchenReference;
  readonly evidenceVersion: number;
  readonly evidenceDigest: KitchenDigest;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly effectiveAt: KitchenInstant;
  readonly candidates: readonly KitchenStationRoutingCandidate[];
}

const invalidMessage = "kitchen station routing evidence is invalid";

function invalid(): never {
  throw new TypeError(invalidMessage);
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
    if (error instanceof TypeError && error.message === invalidMessage) throw error;
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
    if (error instanceof TypeError && error.message === invalidMessage) throw error;
    return invalid();
  }
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prohibitedCodePoint(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint <= 0x1f) return true;
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

function instruction(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) return invalid();
  const normalized = value.normalize("NFC");
  if (!normalized.isWellFormed() || [...normalized].some(prohibitedCodePoint)) return invalid();
  const trimmed = normalized.trim();
  if (trimmed.length === 0 || [...trimmed].length > 500) return invalid();
  return trimmed;
}

function referenceSet(value: unknown, maximum: number): readonly KitchenReference[] {
  const references = exactArray(value, 0, maximum)
    .map(parseKitchenTicketReference)
    .sort(compareAscii);
  if (new Set(references).size !== references.length) return invalid();
  return Object.freeze(references);
}

function preparationOption(value: unknown): KitchenPreparationEvidenceOption {
  const raw = exact(value, ["optionReference", "quantity"]);
  return Object.freeze({
    optionReference: parseKitchenTicketReference(raw.optionReference),
    quantity: positiveInteger(raw.quantity, 999),
  });
}

function preparationItem(value: unknown): KitchenPreparationEvidenceItem {
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
    "preparationReference",
    "preparationVersion",
    "preparationDigest",
    "instructions",
    "requiredStationCapabilityReferences",
  ]);
  const selectedOptions = exactArray(raw.selectedOptions, 0, 100)
    .map(preparationOption)
    .sort((left, right) => compareAscii(left.optionReference, right.optionReference));
  if (
    new Set(selectedOptions.map((entry) => entry.optionReference)).size !== selectedOptions.length
  )
    return invalid();
  const instructions = exactArray(raw.instructions, 1, 32).map(instruction);
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
    preparationReference: parseKitchenTicketReference(raw.preparationReference),
    preparationVersion: positiveInteger(raw.preparationVersion),
    preparationDigest: parseKitchenTicketDigest(raw.preparationDigest),
    instructions: Object.freeze(instructions),
    requiredStationCapabilityReferences: referenceSet(raw.requiredStationCapabilityReferences, 32),
  });
}

export function parseKitchenPreparationEvidenceSet(value: unknown): KitchenPreparationEvidenceSet {
  try {
    const raw = exact(value, [
      "evidenceReference",
      "evidenceVersion",
      "evidenceDigest",
      "brandReference",
      "storeReference",
      "effectiveAt",
      "items",
    ]);
    const items = exactArray(raw.items, 1, 100)
      .map(preparationItem)
      .sort((left, right) => compareAscii(left.orderItemReference, right.orderItemReference));
    if (new Set(items.map((entry) => entry.orderItemReference)).size !== items.length)
      return invalid();
    return Object.freeze({
      evidenceReference: parseKitchenTicketReference(raw.evidenceReference),
      evidenceVersion: positiveInteger(raw.evidenceVersion),
      evidenceDigest: parseKitchenTicketDigest(raw.evidenceDigest),
      brandReference: parseKitchenTicketReference(raw.brandReference),
      storeReference: parseKitchenTicketReference(raw.storeReference),
      effectiveAt: parseKitchenTicketInstant(raw.effectiveAt),
      items: Object.freeze(items),
    });
  } catch {
    return invalid();
  }
}

function selector(value: unknown): KitchenStationRoutingSelector {
  const raw = exact(value, ["kind"]);
  if (raw.kind !== "AllPreparedItems") return invalid();
  return Object.freeze({ kind: "AllPreparedItems" });
}

function status(value: unknown): KitchenConfigurationStatus {
  if (value !== "Active" && value !== "Inactive") return invalid();
  return value;
}

function routingCandidate(value: unknown): KitchenStationRoutingCandidate {
  const raw = exact(value, [
    "stationReference",
    "stationVersion",
    "stationStatus",
    "stationCapabilityReferences",
    "routingRuleReference",
    "routingRuleVersion",
    "routingRuleStatus",
    "selector",
    "targetStationReference",
    "routingRuleDigest",
  ]);
  return Object.freeze({
    stationReference: parseKitchenTicketReference(raw.stationReference),
    stationVersion: positiveInteger(raw.stationVersion),
    stationStatus: status(raw.stationStatus),
    stationCapabilityReferences: referenceSet(raw.stationCapabilityReferences, 32),
    routingRuleReference: parseKitchenTicketReference(raw.routingRuleReference),
    routingRuleVersion: positiveInteger(raw.routingRuleVersion),
    routingRuleStatus: status(raw.routingRuleStatus),
    selector: selector(raw.selector),
    targetStationReference: parseKitchenTicketReference(raw.targetStationReference),
    routingRuleDigest: parseKitchenTicketDigest(raw.routingRuleDigest),
  });
}

export function parseKitchenStationRoutingCandidateSetEvidence(
  value: unknown,
): KitchenStationRoutingCandidateSetEvidence {
  try {
    const raw = exact(value, [
      "evidenceReference",
      "evidenceVersion",
      "evidenceDigest",
      "brandReference",
      "storeReference",
      "effectiveAt",
      "candidates",
    ]);
    const candidates = exactArray(raw.candidates, 0, 100)
      .map(routingCandidate)
      .sort((left, right) => compareAscii(left.routingRuleReference, right.routingRuleReference));
    if (new Set(candidates.map((entry) => entry.routingRuleReference)).size !== candidates.length)
      return invalid();
    return Object.freeze({
      evidenceReference: parseKitchenTicketReference(raw.evidenceReference),
      evidenceVersion: positiveInteger(raw.evidenceVersion),
      evidenceDigest: parseKitchenTicketDigest(raw.evidenceDigest),
      brandReference: parseKitchenTicketReference(raw.brandReference),
      storeReference: parseKitchenTicketReference(raw.storeReference),
      effectiveAt: parseKitchenTicketInstant(raw.effectiveAt),
      candidates: Object.freeze(candidates),
    });
  } catch {
    return invalid();
  }
}

export function createKitchenPreparationEvidenceSetDigestBinding(value: unknown): string {
  const evidence = parseKitchenPreparationEvidenceSet(value);
  return JSON.stringify({
    evidenceReference: evidence.evidenceReference,
    evidenceVersion: evidence.evidenceVersion,
    brandReference: evidence.brandReference,
    storeReference: evidence.storeReference,
    effectiveAt: evidence.effectiveAt,
    normalizedItems: evidence.items.map((item) => ({
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
      sourceLineDigest: item.sourceLineDigest,
      preparationReference: item.preparationReference,
      preparationVersion: item.preparationVersion,
      preparationDigest: item.preparationDigest,
      instructions: item.instructions,
      requiredStationCapabilityReferences: item.requiredStationCapabilityReferences,
    })),
  });
}

export function createKitchenRoutingRuleDigestBinding(value: unknown): string {
  const raw = exact(value, ["brandReference", "storeReference", "effectiveAt", "candidate"]);
  const brandReference = parseKitchenTicketReference(raw.brandReference);
  const storeReference = parseKitchenTicketReference(raw.storeReference);
  const effectiveAt = parseKitchenTicketInstant(raw.effectiveAt);
  const candidate = routingCandidate(raw.candidate);
  return JSON.stringify({
    brandReference,
    storeReference,
    effectiveAt,
    routingRuleReference: candidate.routingRuleReference,
    routingRuleVersion: candidate.routingRuleVersion,
    routingRuleStatus: candidate.routingRuleStatus,
    selector: candidate.selector,
    targetStationReference: candidate.targetStationReference,
    station: {
      stationReference: candidate.stationReference,
      stationVersion: candidate.stationVersion,
      stationStatus: candidate.stationStatus,
      stationCapabilityReferences: candidate.stationCapabilityReferences,
    },
  });
}

export function createKitchenStationRoutingCandidateSetDigestBinding(value: unknown): string {
  const evidence = parseKitchenStationRoutingCandidateSetEvidence(value);
  return JSON.stringify({
    evidenceReference: evidence.evidenceReference,
    evidenceVersion: evidence.evidenceVersion,
    brandReference: evidence.brandReference,
    storeReference: evidence.storeReference,
    effectiveAt: evidence.effectiveAt,
    normalizedCandidates: evidence.candidates.map((candidate) => ({
      stationReference: candidate.stationReference,
      stationVersion: candidate.stationVersion,
      stationStatus: candidate.stationStatus,
      stationCapabilityReferences: candidate.stationCapabilityReferences,
      routingRuleReference: candidate.routingRuleReference,
      routingRuleVersion: candidate.routingRuleVersion,
      routingRuleStatus: candidate.routingRuleStatus,
      selector: candidate.selector,
      targetStationReference: candidate.targetStationReference,
      routingRuleDigest: candidate.routingRuleDigest,
    })),
  });
}
