import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "../domain/product.js";
import {
  parseAvailabilityRule,
  parseAvailabilitySafetyEvidence,
  resolveStoreAvailability,
  type AvailabilitySafetyEvidence,
} from "../domain/availability.js";
import type {
  CurrentAvailabilityQueryInput,
  CurrentAvailabilityQueryPorts,
} from "./ports/current-availability-query-ports.js";

function data(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error();
  const keys = Reflect.ownKeys(value);
  if (
    fields &&
    (keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)))
  )
    throw new Error();
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
    captured[key] = descriptor.value;
  }
  return captured;
}
function collection(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as number;
  if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1)
    throw new Error();
  const captured: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
    captured.push(descriptor.value);
  }
  return Object.freeze(captured);
}
function request(value: unknown): CurrentAvailabilityQueryInput {
  try {
    const raw = data(value, [
      "brandReference",
      "storeReference",
      "sellableReference",
      "channelCode",
      "orderTypeCode",
      "observedAt",
    ]);
    return Object.freeze({
      brandReference: parseCatalogReference(raw.brandReference),
      storeReference: parseCatalogReference(raw.storeReference),
      sellableReference: parseCatalogReference(raw.sellableReference),
      channelCode: parseCatalogCode(raw.channelCode),
      orderTypeCode: parseCatalogCode(raw.orderTypeCode),
      observedAt: parseCatalogInstant(raw.observedAt),
    });
  } catch {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  }
}
function evidence(
  value: unknown,
  kind: AvailabilitySafetyEvidence["kind"],
  input: CurrentAvailabilityQueryInput,
) {
  if (value === null) return null;
  const raw = data(value);
  if (typeof raw.kind !== "string" || typeof raw.status !== "string" || raw.kind !== kind)
    throw new Error();
  const captured = parseAvailabilitySafetyEvidence({ ...raw });
  if (
    captured.brandReference !== input.brandReference ||
    captured.storeReference !== input.storeReference ||
    captured.sellableReference !== input.sellableReference
  )
    throw new Error();
  return captured;
}
function rules(value: unknown, input: CurrentAvailabilityQueryInput) {
  const captured = collection(value).map((value) => {
    const raw = data(value);
    if (typeof raw.lifecycle !== "string" || typeof raw.sellableType !== "string")
      throw new Error();
    const rule = parseAvailabilityRule({
      ...raw,
      channelCodes: collection(raw.channelCodes),
      orderTypeCodes: collection(raw.orderTypeCodes),
    });
    if (
      rule.brandReference !== input.brandReference ||
      rule.sellableReference !== input.sellableReference ||
      rule.sellableType !== "Sku" ||
      (rule.storeReference !== null && rule.storeReference !== input.storeReference) ||
      rule.lifecycle !== "Active" ||
      rule.effectiveFrom > input.observedAt ||
      (rule.effectiveUntil !== null && rule.effectiveUntil <= input.observedAt) ||
      rule.updatedAt > input.observedAt ||
      (rule.channelCodes.length > 0 && !rule.channelCodes.includes(input.channelCode)) ||
      (rule.orderTypeCodes.length > 0 && !rule.orderTypeCodes.includes(input.orderTypeCode))
    )
      throw new Error();
    return rule;
  });
  if (new Set(captured.map((rule) => rule.ruleReference)).size !== captured.length)
    throw new Error();
  return Object.freeze(captured);
}

/** An explicit observation result, never a lease or final selection/checkout authorization. */
export function createCurrentAvailabilityQueryService(
  ports: CurrentAvailabilityQueryPorts,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const fixed = data(scope, ["brandReference", "storeReference"]);
  const brand = parseCatalogReference(fixed.brandReference);
  const store = parseCatalogReference(fixed.storeReference);
  return Object.freeze({
    async resolveCurrent(value: unknown) {
      const input = request(value);
      if (input.brandReference !== brand || input.storeReference !== store)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const indeterminate = (reason: string) =>
        Object.freeze({
          status: "Indeterminate" as const,
          reasonCode: parseCatalogCode(reason),
          ruleReference: null,
          observedAt: input.observedAt,
        });
      try {
        const startedAt = parseCatalogInstant(ports.clock.now());
        if (input.observedAt > startedAt) return indeterminate("EVIDENCE_INVALID");
        const candidates = rules(await ports.rules.loadCurrentRules(input), input);
        const killSwitch = evidence(
          await ports.killSwitch.loadEvidence(input),
          "KillSwitch",
          input,
        );
        const inventory = evidence(await ports.inventory.loadEvidence(input), "Inventory", input);
        const completedAt = parseCatalogInstant(ports.clock.now());
        if (completedAt < startedAt) throw new Error();
        if (killSwitch === null || inventory === null) return indeterminate("EVIDENCE_MISSING");
        const safety = Object.freeze([killSwitch, inventory]);
        for (const item of safety) {
          if (item.observedAt > input.observedAt || item.expiresAt <= completedAt)
            return indeterminate("EVIDENCE_INVALID");
        }
        const decision = {
          ...input,
          rules: candidates,
          safetyEvidence: safety,
          at: input.observedAt,
        };
        const observed = resolveStoreAvailability(decision);
        const completed = resolveStoreAvailability({ ...decision, at: completedAt });
        if (
          observed.status !== completed.status ||
          observed.reasonCode !== completed.reasonCode ||
          observed.ruleReference !== completed.ruleReference
        )
          return indeterminate("RULE_OBSERVATION_CHANGED");
        return Object.freeze({ ...observed, observedAt: input.observedAt });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
