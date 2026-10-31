import {
  organizationLifecycles,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
  type OrganizationLifecycle,
} from "../domain/brand-store.js";

const invalid = (): never => {
  throw new Error("TENANT_STORE_REFERENCE_INVALID");
};
export const maximumTenantStoreReferences = 10_000;
export interface TenantStoreReferenceRequest {
  readonly brandReference: string;
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
}
export interface TenantStoreReference {
  readonly storeReference: string;
  readonly lifecycle: OrganizationLifecycle;
  readonly version: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface TenantStoreReferenceSnapshot {
  readonly profile: "TenantStoreReferenceV1";
  readonly brandReference: string;
  readonly brandLifecycle: OrganizationLifecycle;
  readonly brandVersion: string;
  readonly generation: string;
  readonly referenceCount: string;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly references: readonly TenantStoreReference[];
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const item = descriptors[key];
    if (!item || !("value" in item) || !item.enumerable) return invalid();
    result[key] = item.value;
  }
  return result;
}
function integer(value: unknown, zero: boolean): string {
  if (typeof value !== "string" || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value))
    return invalid();
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n || (!zero && parsed === 0n)) return invalid();
  return value;
}
function lifecycle(value: unknown): OrganizationLifecycle {
  if (!(organizationLifecycles as readonly unknown[]).includes(value)) return invalid();
  return value as OrganizationLifecycle;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) return invalid();
  return value;
}
export function parseTenantStoreReferenceRequest(value: unknown): TenantStoreReferenceRequest {
  try {
    const r = record(value, [
      "brandReference",
      "actorReference",
      "purposeCode",
      "originalIntentDigest",
      "observedAt",
    ]);
    if (typeof r.purposeCode !== "string" || !/^[A-Z][A-Z0-9_.:-]{0,63}$/.test(r.purposeCode))
      return invalid();
    return Object.freeze({
      brandReference: parseBrandReference(r.brandReference),
      actorReference: parseBrandReference(r.actorReference),
      purposeCode: r.purposeCode,
      originalIntentDigest: digest(r.originalIntentDigest),
      observedAt: parseCanonicalInstant(r.observedAt),
    });
  } catch {
    return invalid();
  }
}
export function parseTenantStoreReferenceSnapshot(value: unknown): TenantStoreReferenceSnapshot {
  try {
    const r = record(value, [
      "profile",
      "brandReference",
      "brandLifecycle",
      "brandVersion",
      "generation",
      "referenceCount",
      "originalIntentDigest",
      "observedAt",
      "references",
    ]);
    if (r.profile !== "TenantStoreReferenceV1") return invalid();
    const observedAt = parseCanonicalInstant(r.observedAt);
    const count = integer(r.referenceCount, true);
    if (
      !Array.isArray(r.references) ||
      r.references.length > maximumTenantStoreReferences ||
      BigInt(count) !== BigInt(r.references.length)
    )
      return invalid();
    const arrayDescriptors = Object.getOwnPropertyDescriptors(r.references);
    if (Reflect.ownKeys(r.references).length !== r.references.length + 1) return invalid();
    let previous = "";
    const references: TenantStoreReference[] = [];
    for (let i = 0; i < r.references.length; i++) {
      const descriptor = arrayDescriptors[String(i)];
      if (!descriptor || !("value" in descriptor)) return invalid();
      const item = record(descriptor.value, [
        "storeReference",
        "lifecycle",
        "version",
        "createdAt",
        "updatedAt",
      ]);
      const reference = parseStoreReference(item.storeReference);
      const createdAt = parseCanonicalInstant(item.createdAt),
        updatedAt = parseCanonicalInstant(item.updatedAt);
      if (reference <= previous || updatedAt < createdAt || updatedAt > observedAt)
        return invalid();
      previous = reference;
      references.push(
        Object.freeze({
          storeReference: reference,
          lifecycle: lifecycle(item.lifecycle),
          version: integer(item.version, false),
          createdAt,
          updatedAt,
        }),
      );
    }
    return Object.freeze({
      profile: "TenantStoreReferenceV1",
      brandReference: parseBrandReference(r.brandReference),
      brandLifecycle: lifecycle(r.brandLifecycle),
      brandVersion: integer(r.brandVersion, false),
      generation: integer(r.generation, true),
      referenceCount: count,
      originalIntentDigest: digest(r.originalIntentDigest),
      observedAt,
      references: Object.freeze(references),
    });
  } catch {
    return invalid();
  }
}

export interface TenantStoreLabelReference extends TenantStoreReference {
  readonly code: string;
  readonly displayName: string;
}
export interface TenantStoreLabelReferenceSnapshot extends Omit<
  TenantStoreReferenceSnapshot,
  "profile" | "references"
> {
  readonly profile: "TenantStoreLabelReferenceV1";
  readonly references: readonly TenantStoreLabelReference[];
}
/** Owning Store labels attached to the same complete identity metadata; no eligibility inference. */
export function parseTenantStoreLabelReferenceSnapshot(
  value: unknown,
): TenantStoreLabelReferenceSnapshot {
  try {
    const r = record(value, [
      "profile",
      "brandReference",
      "brandLifecycle",
      "brandVersion",
      "generation",
      "referenceCount",
      "originalIntentDigest",
      "observedAt",
      "references",
    ]);
    if (
      r.profile !== "TenantStoreLabelReferenceV1" ||
      !Array.isArray(r.references) ||
      Object.getPrototypeOf(r.references) !== Array.prototype ||
      r.references.length > maximumTenantStoreReferences ||
      Reflect.ownKeys(r.references).length !== r.references.length + 1
    )
      return invalid();
    const rawReferences = r.references;
    const labels = Array.from({ length: rawReferences.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(rawReferences, String(i));
      if (!d?.enumerable || !("value" in d)) return invalid();
      const item = record(d.value, [
        "storeReference",
        "lifecycle",
        "version",
        "createdAt",
        "updatedAt",
        "code",
        "displayName",
      ]);
      // Exact owning Store code/display-name lexical limits, without invented defaults.
      if (
        typeof item.code !== "string" ||
        !/^[A-Z][A-Z0-9_-]{0,62}$/u.test(item.code) ||
        typeof item.displayName !== "string" ||
        item.displayName.length < 1 ||
        item.displayName.length > 160 ||
        item.displayName.trim() !== item.displayName
      )
        return invalid();
      return item;
    });
    const metadata = parseTenantStoreReferenceSnapshot({
      ...r,
      profile: "TenantStoreReferenceV1",
      references: labels.map((item) => ({
        storeReference: item.storeReference,
        lifecycle: item.lifecycle,
        version: item.version,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    });
    return Object.freeze({
      ...metadata,
      profile: "TenantStoreLabelReferenceV1",
      references: Object.freeze(
        metadata.references.map((reference, i) => {
          const label = labels[i];
          if (!label || typeof label.code !== "string" || typeof label.displayName !== "string")
            return invalid();
          return Object.freeze({ ...reference, code: label.code, displayName: label.displayName });
        }),
      ),
    });
  } catch {
    return invalid();
  }
}
