import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
  type CatalogCode,
  type CatalogInstant,
  type CatalogReference,
} from "./product.js";

export type AvailabilityRuleLifecycle = "Draft" | "Active" | "Inactive" | "Archived";
export type AvailabilityDecision = "Available" | "Unavailable";
export type AvailabilityResolutionStatus = AvailabilityDecision | "Indeterminate";
export type AvailabilitySellableType = "Product" | "Sku" | "Bundle";

export interface AvailabilityRuleAggregate {
  readonly ruleReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly aggregateVersion: number;
  readonly lifecycle: AvailabilityRuleLifecycle;
  readonly sellableReference: CatalogReference;
  readonly sellableType: AvailabilitySellableType;
  readonly storeReference: CatalogReference | null;
  readonly channelCodes: readonly CatalogCode[];
  readonly orderTypeCodes: readonly CatalogCode[];
  readonly effectiveFrom: CatalogInstant;
  readonly effectiveUntil: CatalogInstant | null;
  readonly decision: AvailabilityDecision;
  readonly priority: number;
  readonly reasonCode: CatalogCode;
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
  readonly updatedAt: CatalogInstant;
}

export interface AvailabilitySafetyEvidence {
  readonly kind: "KillSwitch" | "Inventory";
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly status: "Clear" | "Blocked" | "Available" | "Unavailable" | "Indeterminate";
  readonly observedAt: CatalogInstant;
  readonly expiresAt: CatalogInstant;
  readonly reasonCode: CatalogCode;
}

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const own = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    return invalid();
  }
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function priority(value: unknown): number {
  const parsed = positive(value);
  if (parsed > 1000) return invalid();
  return parsed;
}
function codes(value: unknown): readonly CatalogCode[] {
  if (!Array.isArray(value)) return invalid();
  const parsed = Object.freeze(value.map(parseCatalogCode));
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}

export function parseAvailabilityRule(value: unknown): AvailabilityRuleAggregate {
  const raw = exact(value, [
    "ruleReference",
    "brandReference",
    "internalCode",
    "aggregateVersion",
    "lifecycle",
    "sellableReference",
    "sellableType",
    "storeReference",
    "channelCodes",
    "orderTypeCodes",
    "effectiveFrom",
    "effectiveUntil",
    "decision",
    "priority",
    "reasonCode",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
  ]);
  if (
    !["Draft", "Active", "Inactive", "Archived"].includes(String(raw.lifecycle)) ||
    !["Product", "Sku", "Bundle"].includes(String(raw.sellableType)) ||
    (raw.decision !== "Available" && raw.decision !== "Unavailable")
  )
    return invalid();
  const effectiveFrom = parseCatalogInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseCatalogInstant(raw.effectiveUntil);
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  )
    return invalid();
  return Object.freeze({
    ruleReference: parseCatalogReference(raw.ruleReference),
    brandReference: parseCatalogReference(raw.brandReference),
    internalCode: parseCatalogCode(raw.internalCode),
    aggregateVersion: positive(raw.aggregateVersion),
    lifecycle: raw.lifecycle as AvailabilityRuleLifecycle,
    sellableReference: parseCatalogReference(raw.sellableReference),
    sellableType: raw.sellableType as AvailabilitySellableType,
    storeReference: raw.storeReference === null ? null : parseCatalogReference(raw.storeReference),
    channelCodes: codes(raw.channelCodes),
    orderTypeCodes: codes(raw.orderTypeCodes),
    effectiveFrom,
    effectiveUntil,
    decision: raw.decision,
    priority: priority(raw.priority),
    reasonCode: parseCatalogCode(raw.reasonCode),
    createdAt,
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
    updatedAt,
  });
}

function businessDateAt(instant: CatalogInstant, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (value.year === undefined || value.month === undefined || value.day === undefined)
      return invalid();
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return invalid();
  }
}

export function simulateEffectiveAvailability(value: unknown): Readonly<{
  status: AvailabilityResolutionStatus;
  reasonCode: CatalogCode;
  ruleReference: CatalogReference | null;
  businessDate: string;
  timeZone: string;
}> {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "sellableReference",
    "sellableType",
    "channelCode",
    "orderTypeCode",
    "at",
    "timeZone",
    "businessDate",
    "rules",
    "safetyEvidence",
  ]);
  if (
    !["Product", "Sku", "Bundle"].includes(String(raw.sellableType)) ||
    typeof raw.timeZone !== "string" ||
    raw.timeZone.length < 1 ||
    raw.timeZone.length > 63 ||
    typeof raw.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(raw.businessDate) ||
    !Array.isArray(raw.rules) ||
    !Array.isArray(raw.safetyEvidence)
  )
    return invalid();
  const at = parseCatalogInstant(raw.at);
  if (businessDateAt(at, raw.timeZone) !== raw.businessDate) return invalid();
  const sellableType = raw.sellableType as AvailabilitySellableType;
  const rules = raw.rules.map(parseAvailabilityRule);
  if (rules.some((rule) => rule.sellableType !== sellableType)) return invalid();
  const result = resolveStoreAvailability({
    brandReference: parseCatalogReference(raw.brandReference),
    storeReference: parseCatalogReference(raw.storeReference),
    sellableReference: parseCatalogReference(raw.sellableReference),
    channelCode: parseCatalogCode(raw.channelCode),
    orderTypeCode: parseCatalogCode(raw.orderTypeCode),
    at,
    rules,
    safetyEvidence: raw.safetyEvidence.map(parseAvailabilitySafetyEvidence),
  });
  return Object.freeze({ ...result, businessDate: raw.businessDate, timeZone: raw.timeZone });
}

export function parseAvailabilitySafetyEvidence(value: unknown): AvailabilitySafetyEvidence {
  const raw = exact(value, [
    "kind",
    "brandReference",
    "storeReference",
    "sellableReference",
    "status",
    "observedAt",
    "expiresAt",
    "reasonCode",
  ]);
  if (
    (raw.kind !== "KillSwitch" && raw.kind !== "Inventory") ||
    !["Clear", "Blocked", "Available", "Unavailable", "Indeterminate"].includes(
      String(raw.status),
    ) ||
    (raw.kind === "KillSwitch" &&
      raw.status !== "Clear" &&
      raw.status !== "Blocked" &&
      raw.status !== "Indeterminate") ||
    (raw.kind === "Inventory" &&
      raw.status !== "Available" &&
      raw.status !== "Unavailable" &&
      raw.status !== "Indeterminate")
  )
    return invalid();
  const observedAt = parseCatalogInstant(raw.observedAt);
  const expiresAt = parseCatalogInstant(raw.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) return invalid();
  return Object.freeze({
    kind: raw.kind,
    brandReference: parseCatalogReference(raw.brandReference),
    storeReference: parseCatalogReference(raw.storeReference),
    sellableReference: parseCatalogReference(raw.sellableReference),
    status: raw.status as AvailabilitySafetyEvidence["status"],
    observedAt,
    expiresAt,
    reasonCode: parseCatalogCode(raw.reasonCode),
  });
}

export function resolveStoreAvailability(input: {
  readonly brandReference: CatalogReference;
  readonly storeReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly channelCode: CatalogCode;
  readonly orderTypeCode: CatalogCode;
  readonly at: CatalogInstant;
  readonly rules: readonly AvailabilityRuleAggregate[];
  readonly safetyEvidence: readonly AvailabilitySafetyEvidence[];
}): Readonly<{
  status: AvailabilityResolutionStatus;
  reasonCode: CatalogCode;
  ruleReference: CatalogReference | null;
}> {
  const at = Date.parse(input.at);
  const safety = input.safetyEvidence.map(parseAvailabilitySafetyEvidence);
  if (
    safety.some(
      (item) =>
        item.brandReference !== input.brandReference ||
        item.storeReference !== input.storeReference ||
        item.sellableReference !== input.sellableReference ||
        Date.parse(item.observedAt) > at ||
        Date.parse(item.expiresAt) <= at,
    )
  )
    return Object.freeze({
      status: "Indeterminate",
      reasonCode: parseCatalogCode("EVIDENCE_INVALID"),
      ruleReference: null,
    });
  const blocked = safety.find((item) => item.status === "Blocked" || item.status === "Unavailable");
  if (blocked !== undefined)
    return Object.freeze({
      status: "Unavailable",
      reasonCode: blocked.reasonCode,
      ruleReference: null,
    });
  if (safety.some((item) => item.status === "Indeterminate"))
    return Object.freeze({
      status: "Indeterminate",
      reasonCode: parseCatalogCode("EVIDENCE_INDETERMINATE"),
      ruleReference: null,
    });
  const matching = input.rules
    .map(parseAvailabilityRule)
    .filter(
      (rule) =>
        rule.brandReference === input.brandReference &&
        rule.sellableReference === input.sellableReference &&
        rule.lifecycle === "Active" &&
        (rule.storeReference === null || rule.storeReference === input.storeReference) &&
        (rule.channelCodes.length === 0 || rule.channelCodes.includes(input.channelCode)) &&
        (rule.orderTypeCodes.length === 0 || rule.orderTypeCodes.includes(input.orderTypeCode)) &&
        Date.parse(rule.effectiveFrom) <= at &&
        (rule.effectiveUntil === null || at < Date.parse(rule.effectiveUntil)),
    );
  if (matching.length === 0)
    return Object.freeze({
      status: "Indeterminate",
      reasonCode: parseCatalogCode("NO_EFFECTIVE_RULE"),
      ruleReference: null,
    });
  const specificity = matching.some((rule) => rule.storeReference !== null) ? 1 : 0;
  const scoped = matching.filter((rule) => (rule.storeReference === null ? 0 : 1) === specificity);
  const priority = Math.max(...scoped.map((rule) => rule.priority));
  const winners = scoped.filter((rule) => rule.priority === priority);
  if (new Set(winners.map((rule) => rule.decision)).size !== 1)
    return Object.freeze({
      status: "Indeterminate",
      reasonCode: parseCatalogCode("AMBIGUOUS_RULE"),
      ruleReference: null,
    });
  const winner = winners.toSorted((left, right) =>
    left.ruleReference.localeCompare(right.ruleReference),
  )[0];
  if (winner === undefined) return invalid();
  return Object.freeze({
    status: winner.decision,
    reasonCode: winner.reasonCode,
    ruleReference: winner.ruleReference,
  });
}
