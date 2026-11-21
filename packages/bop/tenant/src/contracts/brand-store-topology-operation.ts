import { parseBrandReference, parseCanonicalInstant } from "../domain/brand-store.js";
import { parsePlatformTenantReference } from "./platform-tenant-administration.js";
import {
  parseBrandStoreTopologyDraft,
  type BrandStoreTopologyDraft,
} from "./brand-store-topology.js";
export class BrandStoreTopologyError extends Error {
  constructor(
    readonly code:
      | "BRAND_STORE_TOPOLOGY_INPUT_INVALID"
      | "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED"
      | "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE"
      | "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT"
      | "BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT",
  ) {
    super("Brand Store topology operation is unavailable");
    this.name = "BrandStoreTopologyError";
  }
}
export interface BrandStoreTopologyActorScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
}
export interface BrandStoreTopologySave extends BrandStoreTopologyActorScope {
  readonly profile: "BrandStoreTopologySaveV1";
  readonly operationReference: string;
  readonly expectedRevision: number;
  readonly content: BrandStoreTopologyDraft;
}
export interface BrandStoreTopologyResolve extends BrandStoreTopologyActorScope {
  readonly profile: "BrandStoreTopologyResolveV1";
  readonly operationReference: string;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface BrandStoreTopologyDraftRevision extends BrandStoreTopologyActorScope {
  readonly profile: "BrandStoreTopologyDraftRevisionV1";
  readonly revision: number;
  readonly content: BrandStoreTopologyDraft;
  readonly snapshotDigest: string;
  readonly operationReference: string;
  readonly auditReference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
export interface BrandStoreTopologyCurrent extends BrandStoreTopologyActorScope {
  readonly profile: "BrandStoreTopologyCurrentV1";
  readonly current: BrandStoreTopologyDraftRevision | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface BrandStoreTopologyOperationReceipt extends BrandStoreTopologyActorScope {
  readonly profile: "BrandStoreTopologyOperationV1";
  readonly operationReference: string;
  readonly expectedRevision: number;
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: BrandStoreTopologyDraftRevision | null;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
const scopeKeys = ["tenantReference", "brandReference", "actorReference"];
const invalid = (): never => {
  throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
};
function admitted<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof BrandStoreTopologyError) throw error;
    return invalid();
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return invalid();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    r[key] = d.value;
  }
  return r;
}
function scope(r: Record<string, unknown>): BrandStoreTopologyActorScope {
  return {
    tenantReference: parsePlatformTenantReference(r.tenantReference),
    brandReference: parseBrandReference(r.brandReference),
    actorReference: parseBrandReference(r.actorReference),
  };
}
function revision(value: unknown, minimum: number, maximum = 2147483647): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    return invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) return invalid();
  return value;
}
function sameScope(
  a: BrandStoreTopologyActorScope,
  b: BrandStoreTopologyActorScope,
  actor = true,
): boolean {
  return (
    a.tenantReference === b.tenantReference &&
    a.brandReference === b.brandReference &&
    (!actor || a.actorReference === b.actorReference)
  );
}
function content(value: unknown, bound: BrandStoreTopologyActorScope): BrandStoreTopologyDraft {
  const parsed = parseBrandStoreTopologyDraft(value);
  if (
    parsed.tenantReference !== bound.tenantReference ||
    parsed.brandReference !== bound.brandReference
  )
    return invalid();
  return parsed;
}
export function parseBrandStoreTopologySave(value: unknown): BrandStoreTopologySave {
  return admitted(() => {
    const r = closed(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "expectedRevision",
      "content",
    ]);
    if (r.profile !== "BrandStoreTopologySaveV1") return invalid();
    const bound = scope(r);
    return Object.freeze({
      profile: "BrandStoreTopologySaveV1",
      ...bound,
      operationReference: parseBrandReference(r.operationReference),
      expectedRevision: revision(r.expectedRevision, 0, 2147483646),
      content: content(r.content, bound),
    });
  });
}
export function parseBrandStoreTopologyResolve(value: unknown): BrandStoreTopologyResolve {
  return admitted(() => {
    const r = closed(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "BrandStoreTopologyResolveV1") return invalid();
    return Object.freeze({
      profile: "BrandStoreTopologyResolveV1",
      ...scope(r),
      operationReference: parseBrandReference(r.operationReference),
      expectedRevision: revision(r.expectedRevision, 0, 2147483646),
      intentDigest: hash(r.intentDigest),
    });
  });
}
export function parseBrandStoreTopologyDraftRevision(
  value: unknown,
): BrandStoreTopologyDraftRevision {
  return admitted(() => {
    const r = closed(value, [
      "profile",
      ...scopeKeys,
      "revision",
      "content",
      "snapshotDigest",
      "operationReference",
      "auditReference",
      "createdAt",
      "updatedAt",
      "dataClassification",
    ]);
    if (
      r.profile !== "BrandStoreTopologyDraftRevisionV1" ||
      r.dataClassification !== "ConfigurationMetadata"
    )
      return invalid();
    const bound = scope(r),
      createdAt = parseCanonicalInstant(r.createdAt),
      updatedAt = parseCanonicalInstant(r.updatedAt);
    if (updatedAt < createdAt) return invalid();
    return Object.freeze({
      profile: "BrandStoreTopologyDraftRevisionV1",
      ...bound,
      revision: revision(r.revision, 1),
      content: content(r.content, bound),
      snapshotDigest: hash(r.snapshotDigest),
      operationReference: parseBrandReference(r.operationReference),
      auditReference: parseBrandReference(r.auditReference),
      createdAt,
      updatedAt,
      dataClassification: "ConfigurationMetadata",
    });
  });
}
/** Current observation freshness does not authenticate the acquiring holder. */
export function parseBrandStoreTopologyCurrent(
  value: unknown,
  observedAt: unknown,
): BrandStoreTopologyCurrent {
  return admitted(() => {
    const r = closed(value, ["profile", ...scopeKeys, "current", "observedAt", "validUntil"]);
    if (r.profile !== "BrandStoreTopologyCurrentV1") return invalid();
    const bound = scope(r),
      at = parseCanonicalInstant(r.observedAt),
      until = parseCanonicalInstant(r.validUntil),
      now = parseCanonicalInstant(observedAt);
    if (until <= at || Date.parse(until) - Date.parse(at) > 5000 || now < at || now >= until)
      return invalid();
    const current = r.current === null ? null : parseBrandStoreTopologyDraftRevision(r.current);
    if (current && (!sameScope(bound, current, false) || current.updatedAt > at)) return invalid();
    return Object.freeze({
      profile: "BrandStoreTopologyCurrentV1",
      ...bound,
      current,
      observedAt: at,
      validUntil: until,
    });
  });
}
/** Immutable original receipt admission never renews current authorization. */
export function parseBrandStoreTopologyOperationReceipt(
  value: unknown,
): BrandStoreTopologyOperationReceipt {
  return admitted(() => {
    const r = closed(value, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "expectedRevision",
      "intentDigest",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ]);
    if (
      r.profile !== "BrandStoreTopologyOperationV1" ||
      r.dataClassification !== "ConfigurationMetadata" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const bound = scope(r),
      operationReference = parseBrandReference(r.operationReference),
      expectedRevision = revision(r.expectedRevision, 0, 2147483646),
      auditReference = parseBrandReference(r.auditReference),
      occurredAt = parseCanonicalInstant(r.occurredAt);
    const snapshot = r.snapshot === null ? null : parseBrandStoreTopologyDraftRevision(r.snapshot);
    if (
      r.outcome === "Abandoned"
        ? snapshot !== null
        : !snapshot ||
          !sameScope(bound, snapshot) ||
          snapshot.revision !== expectedRevision + 1 ||
          snapshot.operationReference !== operationReference ||
          snapshot.auditReference !== auditReference ||
          snapshot.updatedAt !== occurredAt
    )
      return invalid();
    return Object.freeze({
      profile: "BrandStoreTopologyOperationV1",
      ...bound,
      operationReference,
      expectedRevision,
      intentDigest: hash(r.intentDigest),
      outcome: r.outcome,
      snapshot,
      auditReference,
      occurredAt,
      dataClassification: "ConfigurationMetadata",
    });
  });
}
