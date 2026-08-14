import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import { parseAvailabilityRule, type AvailabilityRuleLifecycle } from "../domain/availability.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
  type CatalogInstant,
  type CatalogReference,
} from "../domain/product.js";
import type {
  AvailabilityOperationAction,
  AvailabilityEvent,
  AvailabilityOperationRecord,
  AvailabilityPorts,
} from "./ports/availability-ports.js";

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
function failure(error: unknown): never {
  if (
    error instanceof CatalogError &&
    ["CATALOG_VERSION_CONFLICT", "CATALOG_IDEMPOTENCY_CONFLICT", "CATALOG_CODE_CONFLICT"].includes(
      error.code,
    )
  )
    throw error;
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}
async function authorize(
  ports: AvailabilityPorts,
  action: AvailabilityOperationAction,
  operationReference: CatalogReference,
  ruleReference: CatalogReference,
  at: CatalogInstant,
): Promise<{ brand: CatalogReference; actor: CatalogReference; audit: AppendAuditRecordInput }> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, ruleReference, observedAt: at })
    .catch(failure);
  if (evidence === null) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.scopeKind !== "Brand" ||
      evidence.permission.action !== "catalog.availability.manage" ||
      audit.brandId !== String(context.brand.brandReference) ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `CATALOG_AVAILABILITY_${action.toUpperCase()}` ||
      audit.targetType !== "CatalogAvailabilityRule" ||
      audit.targetId !== ruleReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return {
      brand: parseCatalogReference(context.brand.brandReference),
      actor: parseCatalogReference(actor),
      audit,
    };
  } catch {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  }
}
async function replay(
  ports: AvailabilityPorts,
  operationReference: CatalogReference,
  intent: ReturnType<typeof parseCatalogHash>,
) {
  const prior = await ports.repository.resolveOperation(operationReference).catch(failure);
  if (prior === null) return null;
  try {
    const aggregate = parseAvailabilityRule(prior.aggregate);
    if (prior.operationReference !== operationReference) throw new Error("bad");
    if (!ports.references.equals(prior.operationIntentHash, intent))
      throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ status: "AlreadyApplied" as const, aggregate });
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
function verify(
  saved: AvailabilityOperationRecord,
  expected: AvailabilityOperationRecord,
  ports: AvailabilityPorts,
) {
  try {
    const aggregate = parseAvailabilityRule(saved.aggregate);
    if (
      saved.action !== expected.action ||
      saved.operationReference !== expected.operationReference ||
      !ports.references.equals(saved.operationIntentHash, expected.operationIntentHash) ||
      aggregate.ruleReference !== expected.aggregate.ruleReference ||
      aggregate.aggregateVersion !== expected.aggregate.aggregateVersion ||
      JSON.stringify(saved.event) !== JSON.stringify(expected.event)
    )
      throw new Error("bad");
    return aggregate;
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
async function facts(
  ports: AvailabilityPorts,
  aggregate: ReturnType<typeof parseAvailabilityRule>,
) {
  if (
    !(await ports.facts
      .validate({
        brandReference: aggregate.brandReference,
        storeReference: aggregate.storeReference,
        sellableReference: aggregate.sellableReference,
        sellableType: aggregate.sellableType,
      })
      .catch(failure))
  )
    throw new CatalogError("CATALOG_UNAVAILABLE");
}
function event(
  action: AvailabilityOperationAction,
  aggregate: ReturnType<typeof parseAvailabilityRule>,
  at: CatalogInstant,
): AvailabilityEvent {
  const eventTypes: Record<AvailabilityOperationAction, AvailabilityEvent["eventType"]> = {
    Create: "AvailabilityRuleCreated",
    Replace: "AvailabilityRuleReplaced",
    ChangeLifecycle: "AvailabilityRuleLifecycleChanged",
  };
  return Object.freeze({
    eventType: eventTypes[action],
    aggregateReference: aggregate.ruleReference,
    aggregateVersion: aggregate.aggregateVersion,
    brandReference: aggregate.brandReference,
    sellableType: aggregate.sellableType,
    lifecycle: aggregate.lifecycle,
    occurredAt: at,
  });
}
function lifecycle(current: AvailabilityRuleLifecycle, target: AvailabilityRuleLifecycle) {
  const allowed: Record<AvailabilityRuleLifecycle, readonly AvailabilityRuleLifecycle[]> = {
    Draft: ["Active", "Archived"],
    Active: ["Inactive"],
    Inactive: ["Active", "Archived"],
    Archived: ["Draft"],
  };
  if (!allowed[current].includes(target)) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return target;
}

export function createAvailabilityService(ports: AvailabilityPorts) {
  return Object.freeze({
    async create(value: unknown) {
      const raw = exact(value, [
        "internalCode",
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
        "operationReference",
        "requestedAt",
      ]);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const intent = parseCatalogHash(ports.references.hashIntent(`Create:${JSON.stringify(raw)}`));
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const ruleReference = parseCatalogReference(ports.references.generate("AvailabilityRule"));
      const auth = await authorize(ports, "Create", operationReference, ruleReference, requestedAt);
      const aggregate = parseAvailabilityRule({
        ruleReference,
        brandReference: auth.brand,
        internalCode: parseCatalogCode(raw.internalCode),
        aggregateVersion: 1,
        lifecycle: "Draft",
        sellableReference: raw.sellableReference,
        sellableType: raw.sellableType,
        storeReference: raw.storeReference,
        channelCodes: raw.channelCodes,
        orderTypeCodes: raw.orderTypeCodes,
        effectiveFrom: raw.effectiveFrom,
        effectiveUntil: raw.effectiveUntil,
        decision: raw.decision,
        priority: raw.priority,
        reasonCode: raw.reasonCode,
        createdAt: requestedAt,
        createdByActorReference: auth.actor,
        updatedAt: requestedAt,
      });
      if (
        !(await ports.repository
          .codeAvailable({
            brandReference: auth.brand,
            internalCode: aggregate.internalCode,
            excludingRuleReference: null,
          })
          .catch(failure))
      )
        throw new CatalogError("CATALOG_CODE_CONFLICT");
      await facts(ports, aggregate);
      const record = Object.freeze({
        action: "Create" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate,
        event: event("Create", aggregate, requestedAt),
      });
      const saved = await ports.repository.create({ record, audit: auth.audit }).catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
    async replace(value: unknown) {
      const raw = exact(value, [
        "ruleReference",
        "expectedAggregateVersion",
        "rule",
        "operationReference",
        "requestedAt",
      ]);
      const ruleReference = parseCatalogReference(raw.ruleReference);
      const expected = positive(raw.expectedAggregateVersion);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const candidate = parseAvailabilityRule(raw.rule);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `Replace:${ruleReference}:${expected}:${JSON.stringify(candidate)}`,
        ),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(ruleReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseAvailabilityRule(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "Replace",
        operationReference,
        ruleReference,
        requestedAt,
      );
      if (
        auth.brand !== current.brandReference ||
        candidate.ruleReference !== current.ruleReference ||
        candidate.brandReference !== current.brandReference ||
        candidate.internalCode !== current.internalCode ||
        candidate.createdAt !== current.createdAt ||
        candidate.createdByActorReference !== current.createdByActorReference ||
        candidate.aggregateVersion !== expected + 1 ||
        candidate.lifecycle !== current.lifecycle ||
        candidate.updatedAt !== requestedAt
      )
        return invalid();
      await facts(ports, candidate);
      const record = Object.freeze({
        action: "Replace" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        event: event("Replace", candidate, requestedAt),
      });
      const saved = await ports.repository
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
    async changeLifecycle(value: unknown) {
      const raw = exact(value, [
        "ruleReference",
        "targetLifecycle",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const ruleReference = parseCatalogReference(raw.ruleReference);
      const expected = positive(raw.expectedAggregateVersion);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      if (!["Draft", "Active", "Inactive", "Archived"].includes(String(raw.targetLifecycle)))
        return invalid();
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `Lifecycle:${ruleReference}:${raw.targetLifecycle}:${expected}`,
        ),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(ruleReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseAvailabilityRule(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "ChangeLifecycle",
        operationReference,
        ruleReference,
        requestedAt,
      );
      if (auth.brand !== current.brandReference)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const aggregate = parseAvailabilityRule({
        ...current,
        lifecycle: lifecycle(current.lifecycle, raw.targetLifecycle as AvailabilityRuleLifecycle),
        aggregateVersion: expected + 1,
        updatedAt: requestedAt,
      });
      await facts(ports, aggregate);
      const record = Object.freeze({
        action: "ChangeLifecycle" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate,
        event: event("ChangeLifecycle", aggregate, requestedAt),
      });
      const saved = await ports.repository
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
  });
}
