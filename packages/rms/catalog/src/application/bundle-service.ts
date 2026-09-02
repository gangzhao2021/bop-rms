import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";

import {
  parseBundleAggregate,
  type BundleAggregate,
  type BundleLifecycle,
} from "../domain/bundle.js";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
  type CatalogInstant,
  type CatalogReference,
} from "../domain/product.js";
import type {
  BundleEvent,
  BundleOperationAction,
  BundleOperationRecord,
  BundlePorts,
} from "./ports/bundle-ports.js";

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
function hasMoney(aggregate: BundleAggregate): boolean {
  return (
    aggregate.currentVersion.fixedPrice !== null ||
    aggregate.currentVersion.componentGroups.some((group) =>
      group.eligibleSellables.some((item) => item.upgradePrice !== null),
    )
  );
}
async function authorize(
  ports: BundlePorts,
  action: BundleOperationAction,
  operationReference: CatalogReference,
  bundleReference: CatalogReference,
  at: CatalogInstant,
  moneyBearing: boolean,
): Promise<{ brand: CatalogReference; actor: CatalogReference; audit: AppendAuditRecordInput }> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, bundleReference, observedAt: at })
    .catch(failure);
  if (evidence === null) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    const pricingApproved =
      !moneyBearing ||
      (evidence.pricingApproval?.effect === "Allow" &&
        evidence.pricingApproval.action === "pricing.bundle.approve" &&
        evidence.pricingApproval.scopeKind === "Brand");
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.scopeKind !== "Brand" ||
      evidence.permission.action !== "catalog.bundle.manage" ||
      !pricingApproved ||
      audit.brandId !== String(context.brand.brandReference) ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `CATALOG_BUNDLE_${action.toUpperCase()}` ||
      audit.targetType !== "CatalogBundle" ||
      audit.targetId !== bundleReference ||
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
  ports: BundlePorts,
  operationReference: CatalogReference,
  intent: ReturnType<typeof parseCatalogHash>,
) {
  const prior = await ports.repository.resolveOperation(operationReference).catch(failure);
  if (prior === null) return null;
  try {
    if (!ports.references.equals(prior.operationIntentHash, intent))
      throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      status: "AlreadyApplied" as const,
      aggregate: parseBundleAggregate(prior.aggregate),
    });
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
function event(
  action: BundleOperationAction,
  aggregate: BundleAggregate,
  at: CatalogInstant,
): BundleEvent {
  const eventTypes: Record<BundleOperationAction, BundleEvent["eventType"]> = {
    Create: "BundleDraftCreated",
    ReplaceDraft: "BundleDraftReplaced",
    Publish: "BundleVersionPublished",
    ChangeLifecycle: "BundleLifecycleChanged",
  };
  return Object.freeze({
    eventType: eventTypes[action],
    aggregateReference: aggregate.bundleReference,
    versionReference: aggregate.currentVersion.versionReference,
    aggregateVersion: aggregate.aggregateVersion,
    brandReference: aggregate.brandReference,
    lifecycle: aggregate.lifecycle,
    validationDigest: aggregate.currentVersion.validationDigest,
    occurredAt: at,
  });
}
function verify(saved: BundleOperationRecord, expected: BundleOperationRecord, ports: BundlePorts) {
  const aggregate = parseBundleAggregate(saved.aggregate);
  if (
    saved.action !== expected.action ||
    saved.operationReference !== expected.operationReference ||
    !ports.references.equals(saved.operationIntentHash, expected.operationIntentHash) ||
    aggregate.bundleReference !== expected.aggregate.bundleReference ||
    aggregate.aggregateVersion !== expected.aggregate.aggregateVersion ||
    JSON.stringify(saved.event) !== JSON.stringify(expected.event)
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return aggregate;
}
function transition(current: BundleLifecycle, target: BundleLifecycle): BundleLifecycle {
  const allowed: Record<BundleLifecycle, readonly BundleLifecycle[]> = {
    Draft: ["Archived"],
    Published: ["Suspended", "Discontinued"],
    Suspended: ["Published", "Discontinued"],
    Discontinued: ["Archived"],
    Archived: [],
  };
  if (!allowed[current].includes(target)) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return target;
}

export function createBundleService(ports: BundlePorts) {
  async function commit(
    action: BundleOperationAction,
    aggregate: BundleAggregate,
    expected: number,
    operationReference: CatalogReference,
    intent: ReturnType<typeof parseCatalogHash>,
    at: CatalogInstant,
    audit: AppendAuditRecordInput,
  ) {
    const record = Object.freeze({
      action,
      operationReference,
      operationIntentHash: intent,
      aggregate,
      event: event(action, aggregate, at),
    });
    const saved = await ports.repository
      .commit({ record, expectedAggregateVersion: expected, audit })
      .catch(failure);
    return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
  }
  return Object.freeze({
    async create(value: unknown) {
      const raw = exact(value, ["candidate", "operationReference", "requestedAt"]);
      const candidate = parseBundleAggregate(raw.candidate);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const intent = parseCatalogHash(
        ports.references.hashIntent(`Create:${JSON.stringify(candidate)}`),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const auth = await authorize(
        ports,
        "Create",
        operationReference,
        candidate.bundleReference,
        requestedAt,
        false,
      );
      if (
        candidate.brandReference !== auth.brand ||
        candidate.createdByActorReference !== auth.actor ||
        candidate.aggregateVersion !== 1 ||
        candidate.lifecycle !== "Draft" ||
        candidate.createdAt !== requestedAt ||
        candidate.updatedAt !== requestedAt
      )
        return invalid();
      if (
        !(await ports.repository
          .codeAvailable({
            brandReference: auth.brand,
            internalCode: candidate.internalCode,
            excludingBundleReference: null,
          })
          .catch(failure))
      )
        throw new CatalogError("CATALOG_CODE_CONFLICT");
      const record = Object.freeze({
        action: "Create" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        event: event("Create", candidate, requestedAt),
      });
      const saved = await ports.repository.create({ record, audit: auth.audit }).catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
    async replaceDraft(value: unknown) {
      const raw = exact(value, [
        "candidate",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const candidate = parseBundleAggregate(raw.candidate);
      const expected = positive(raw.expectedAggregateVersion);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const intent = parseCatalogHash(
        ports.references.hashIntent(`ReplaceDraft:${expected}:${JSON.stringify(candidate)}`),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(candidate.bundleReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseBundleAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "ReplaceDraft",
        operationReference,
        current.bundleReference,
        requestedAt,
        false,
      );
      if (
        current.lifecycle !== "Draft" ||
        candidate.lifecycle !== "Draft" ||
        candidate.brandReference !== auth.brand ||
        candidate.internalCode !== current.internalCode ||
        candidate.createdAt !== current.createdAt ||
        candidate.createdByActorReference !== current.createdByActorReference ||
        candidate.aggregateVersion !== expected + 1 ||
        candidate.updatedAt !== requestedAt
      )
        return invalid();
      return commit(
        "ReplaceDraft",
        candidate,
        expected,
        operationReference,
        intent,
        requestedAt,
        auth.audit,
      );
    },
    async publish(value: unknown) {
      const raw = exact(value, [
        "bundleReference",
        "validationDigest",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const bundleReference = parseCatalogReference(raw.bundleReference);
      const expected = positive(raw.expectedAggregateVersion);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const validationDigest = parseCatalogHash(raw.validationDigest);
      const intent = parseCatalogHash(
        ports.references.hashIntent(`Publish:${bundleReference}:${expected}:${validationDigest}`),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(bundleReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseBundleAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "Publish",
        operationReference,
        bundleReference,
        requestedAt,
        hasMoney(current),
      );
      if (
        current.lifecycle !== "Draft" ||
        !(await ports.facts.validatePublishedReferences(current).catch(failure))
      )
        throw new CatalogError("CATALOG_UNAVAILABLE");
      const aggregate = parseBundleAggregate({
        ...current,
        lifecycle: "Published",
        aggregateVersion: expected + 1,
        currentVersion: {
          ...current.currentVersion,
          status: "Published",
          validationDigest,
          updatedAt: requestedAt,
          publishedAt: requestedAt,
        },
        updatedAt: requestedAt,
      });
      return commit(
        "Publish",
        aggregate,
        expected,
        operationReference,
        intent,
        requestedAt,
        auth.audit,
      );
    },
    async changeLifecycle(value: unknown) {
      const raw = exact(value, [
        "bundleReference",
        "targetLifecycle",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const bundleReference = parseCatalogReference(raw.bundleReference);
      const expected = positive(raw.expectedAggregateVersion);
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      if (
        !["Draft", "Published", "Suspended", "Discontinued", "Archived"].includes(
          String(raw.targetLifecycle),
        )
      )
        return invalid();
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `Lifecycle:${bundleReference}:${raw.targetLifecycle}:${expected}`,
        ),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(bundleReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseBundleAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "ChangeLifecycle",
        operationReference,
        bundleReference,
        requestedAt,
        false,
      );
      if (current.brandReference !== auth.brand)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const target = transition(current.lifecycle, raw.targetLifecycle as BundleLifecycle);
      const aggregate = parseBundleAggregate({
        ...current,
        lifecycle: target,
        aggregateVersion: expected + 1,
        updatedAt: requestedAt,
      });
      return commit(
        "ChangeLifecycle",
        aggregate,
        expected,
        operationReference,
        intent,
        requestedAt,
        auth.audit,
      );
    },
  });
}
