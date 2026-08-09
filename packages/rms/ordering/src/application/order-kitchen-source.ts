import {
  OrderKitchenSourceError,
  type ConfirmedOrderKitchenSourceEvidence,
  type ConfirmedOrderKitchenSourceItem,
  type ConfirmedOrderKitchenSourceOption,
  type OrderKitchenSourceQueryPorts,
  type ResolveConfirmedOrderKitchenSourceInput,
} from "../contracts/order-kitchen-source.js";
import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
} from "../domain/cart.js";

const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const prohibitedDirectionalText = /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function fail(code: ConstructorParameters<typeof OrderKitchenSourceError>[0]): never {
  throw new OrderKitchenSourceError(code);
}

function invalid(): never {
  return fail("ORDER_KITCHEN_SOURCE_INPUT_INVALID");
}

function conflict(): never {
  return fail("ORDER_KITCHEN_SOURCE_CONFLICT");
}

function dependency(): never {
  return fail("ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE");
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
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

function exactArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
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
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function safeText(value: unknown, maximumCodePoints: number): string {
  if (typeof value !== "string") return invalid();
  const nfc = value.normalize("NFC");
  if (!nfc.isWellFormed() || containsProhibitedText(nfc) || nfc.includes("\n")) return invalid();
  const normalized = nfc.trim();
  if (normalized.length === 0 || [...normalized].length > maximumCodePoints) return invalid();
  return normalized;
}

function containsProhibitedText(value: string): boolean {
  return (
    prohibitedDirectionalText.test(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return (codePoint <= 0x1f && codePoint !== 0x0a) || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

function localizedNames(value: unknown): Readonly<Record<string, string>> {
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
      keys.some((key) => typeof key !== "string" || !localePattern.test(key))
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
      result[key] = safeText(descriptor.value, 200);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

export function parseOrderKitchenCustomerNote(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return invalid();
  const nfc = value.normalize("NFC");
  if (!nfc.isWellFormed() || containsProhibitedText(nfc)) return invalid();
  const normalized = nfc.trim();
  if (normalized.length === 0 || [...normalized].length > 240 || normalized.split("\n").length > 4)
    return invalid();
  return normalized;
}

function option(value: unknown): ConfirmedOrderKitchenSourceOption {
  const raw = exact(value, ["optionReference", "quantity", "localizedNames"]);
  try {
    return Object.freeze({
      optionReference: parseOrderingReference(raw.optionReference),
      quantity: positiveInteger(raw.quantity, 999),
      localizedNames: localizedNames(raw.localizedNames),
    });
  } catch (error) {
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

function item(value: unknown): ConfirmedOrderKitchenSourceItem {
  const raw = exact(value, [
    "orderItemReference",
    "orderBatchReference",
    "ordinal",
    "quantity",
    "productReference",
    "productVersionReference",
    "skuReference",
    "menuVersionReference",
    "localizedDisplayNames",
    "selectedOptions",
    "customerNote",
    "lineDigest",
  ]);
  const selectedOptions = exactArray(raw.selectedOptions, 0, 100)
    .map(option)
    .sort((left, right) => left.optionReference.localeCompare(right.optionReference));
  if (
    new Set(selectedOptions.map((entry) => entry.optionReference)).size !== selectedOptions.length
  )
    return invalid();
  try {
    return Object.freeze({
      orderItemReference: parseOrderingReference(raw.orderItemReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      ordinal: positiveInteger(raw.ordinal, 100),
      quantity: positiveInteger(raw.quantity, 999),
      productReference: parseOrderingReference(raw.productReference),
      productVersionReference: parseOrderingReference(raw.productVersionReference),
      skuReference: parseOrderingReference(raw.skuReference),
      menuVersionReference: parseOrderingReference(raw.menuVersionReference),
      localizedDisplayNames: localizedNames(raw.localizedDisplayNames),
      selectedOptions: Object.freeze(selectedOptions),
      customerNote: parseOrderKitchenCustomerNote(raw.customerNote),
      lineDigest: parseOrderingHash(raw.lineDigest),
    });
  } catch (error) {
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

export function parseConfirmedOrderKitchenSourceEvidence(
  value: unknown,
): ConfirmedOrderKitchenSourceEvidence {
  const raw = exact(value, [
    "evidenceReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEventReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "capturedAt",
    "evidenceVersion",
    "items",
    "evidenceDigest",
  ]);
  if (typeof raw.sourceAggregateVersion !== "bigint" || raw.sourceAggregateVersion <= 0n)
    return invalid();
  const items = exactArray(raw.items, 1, 100)
    .map(item)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (
    new Set(items.map((entry) => entry.orderItemReference)).size !== items.length ||
    items.some((entry, index) => entry.ordinal !== index + 1)
  )
    return invalid();
  try {
    const orderBatchReference = parseOrderingReference(raw.orderBatchReference);
    if (items.some((entry) => entry.orderBatchReference !== orderBatchReference)) return invalid();
    return Object.freeze({
      evidenceReference: parseOrderingReference(raw.evidenceReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference,
      confirmationReference: parseOrderingReference(raw.confirmationReference),
      sourceEventReference: parseOrderingReference(raw.sourceEventReference),
      sourceAggregateVersion: raw.sourceAggregateVersion,
      sourceSnapshotDigest: parseOrderingHash(raw.sourceSnapshotDigest),
      capturedAt: parseOrderingInstant(raw.capturedAt),
      evidenceVersion: positiveInteger(raw.evidenceVersion),
      items: Object.freeze(items),
      evidenceDigest: parseOrderingHash(raw.evidenceDigest),
    });
  } catch (error) {
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

function itemValue(value: ConfirmedOrderKitchenSourceItem) {
  return {
    orderItemReference: value.orderItemReference,
    orderBatchReference: value.orderBatchReference,
    ordinal: value.ordinal,
    quantity: value.quantity,
    productReference: value.productReference,
    productVersionReference: value.productVersionReference,
    skuReference: value.skuReference,
    menuVersionReference: value.menuVersionReference,
    localizedDisplayNames: value.localizedDisplayNames,
    selectedOptions: value.selectedOptions.map((entry) => ({
      optionReference: entry.optionReference,
      quantity: entry.quantity,
      localizedNames: entry.localizedNames,
    })),
    customerNote: value.customerNote,
  };
}

export function createOrderKitchenSourceLineBinding(value: unknown): string {
  const parsed = item(value);
  return JSON.stringify({ line: itemValue(parsed) });
}

export function createOrderKitchenSourceEvidenceBinding(value: unknown): string {
  const parsed = parseConfirmedOrderKitchenSourceEvidence(value);
  return JSON.stringify({
    evidenceReference: parsed.evidenceReference,
    brandReference: parsed.brandReference,
    storeReference: parsed.storeReference,
    orderReference: parsed.orderReference,
    orderBatchReference: parsed.orderBatchReference,
    confirmationReference: parsed.confirmationReference,
    sourceEventReference: parsed.sourceEventReference,
    sourceAggregateVersion: String(parsed.sourceAggregateVersion),
    sourceSnapshotDigest: parsed.sourceSnapshotDigest,
    capturedAt: parsed.capturedAt,
    evidenceVersion: parsed.evidenceVersion,
    items: parsed.items.map((entry) => ({ ...itemValue(entry), lineDigest: entry.lineDigest })),
  });
}

export function parseResolveConfirmedOrderKitchenSourceInput(
  value: unknown,
): ResolveConfirmedOrderKitchenSourceInput {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEventReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "observedAt",
  ]);
  if (typeof raw.sourceAggregateVersion !== "bigint" || raw.sourceAggregateVersion <= 0n)
    return invalid();
  try {
    return Object.freeze({
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      confirmationReference: parseOrderingReference(raw.confirmationReference),
      sourceEventReference: parseOrderingReference(raw.sourceEventReference),
      sourceAggregateVersion: raw.sourceAggregateVersion,
      sourceSnapshotDigest: parseOrderingHash(raw.sourceSnapshotDigest),
      observedAt: parseOrderingInstant(raw.observedAt),
    });
  } catch (error) {
    if (error instanceof OrderKitchenSourceError) throw error;
    return invalid();
  }
}

function digest(ports: OrderKitchenSourceQueryPorts, canonicalValue: string): OrderingHash {
  try {
    return parseOrderingHash(ports.digests.sha256(canonicalValue));
  } catch {
    return dependency();
  }
}

function evidenceMatchesInput(
  evidence: ConfirmedOrderKitchenSourceEvidence,
  input: ResolveConfirmedOrderKitchenSourceInput,
): boolean {
  return (
    evidence.brandReference === input.brandReference &&
    evidence.storeReference === input.storeReference &&
    evidence.orderReference === input.orderReference &&
    evidence.orderBatchReference === input.orderBatchReference &&
    evidence.confirmationReference === input.confirmationReference &&
    evidence.sourceEventReference === input.sourceEventReference &&
    evidence.sourceAggregateVersion === input.sourceAggregateVersion &&
    evidence.sourceSnapshotDigest === input.sourceSnapshotDigest &&
    Date.parse(evidence.capturedAt) <= Date.parse(input.observedAt)
  );
}

export function createOrderKitchenSourceQueryService(ports: OrderKitchenSourceQueryPorts) {
  return Object.freeze({
    async resolve(value: unknown): Promise<ConfirmedOrderKitchenSourceEvidence> {
      const input = parseResolveConfirmedOrderKitchenSourceInput(value);
      let authorized: boolean;
      try {
        authorized = await ports.authorization.authorize({
          action: "ResolveConfirmedOrderKitchenSource",
          purpose: "CreateKitchenWork",
          ...input,
        });
      } catch {
        return dependency();
      }
      if (authorized !== true) return fail("ORDER_KITCHEN_SOURCE_PERMISSION_DENIED");

      let source: unknown | null;
      try {
        source = await ports.source.loadExact(input);
      } catch {
        return dependency();
      }
      if (source === null) return dependency();

      let evidence: ConfirmedOrderKitchenSourceEvidence;
      try {
        evidence = parseConfirmedOrderKitchenSourceEvidence(source);
      } catch {
        return conflict();
      }
      if (!evidenceMatchesInput(evidence, input)) return conflict();
      for (const sourceItem of evidence.items) {
        if (
          digest(ports, createOrderKitchenSourceLineBinding(sourceItem)) !== sourceItem.lineDigest
        )
          return conflict();
      }
      if (
        digest(ports, createOrderKitchenSourceEvidenceBinding(evidence)) !== evidence.evidenceDigest
      )
        return conflict();
      return evidence;
    },
  });
}
