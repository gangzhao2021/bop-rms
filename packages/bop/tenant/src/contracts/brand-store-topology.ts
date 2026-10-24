import {
  OrganizationContractError,
  parseBrandReference,
  parseStoreReference,
} from "../domain/brand-store.js";
import { parsePlatformTenantReference } from "./platform-tenant-administration.js";
import { parseTenantStoreReferenceSnapshot } from "./store-reference-source.js";

export const brandStoreTopologyMaximumSelectors = 1000;
export const brandStoreTopologyMaximumAssignments = 10000;
export interface BrandStoreTopologyDraft {
  readonly profile: "BrandStoreTopologyDraftV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly draftReference: string;
  readonly selectors: readonly Readonly<{
    kind: "Region" | "StoreGroup";
    reference: string;
    code: string;
    name: string;
  }>[];
  readonly assignments: readonly Readonly<{ storeReference: string; selectorReference: string }>[];
}
const invalid = (): never => {
  throw new OrganizationContractError("ORGANIZATION_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
function dense(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return invalid();
    return d.value;
  });
}
/** Configuration intent only; no current membership, eligibility or approval is inferred. */
export function parseBrandStoreTopologyDraft(value: unknown): BrandStoreTopologyDraft {
  try {
    const r = closed(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "draftReference",
      "selectors",
      "assignments",
    ]);
    if (r.profile !== "BrandStoreTopologyDraftV1") return invalid();
    const references = new Set<string>(),
      codes = new Set<string>();
    const selectors = dense(r.selectors, brandStoreTopologyMaximumSelectors)
      .map((value) => {
        const s = closed(value, ["kind", "reference", "code", "name"]);
        if (s.kind !== "Region" && s.kind !== "StoreGroup") return invalid();
        const reference = parseBrandReference(s.reference);
        // Same canonical organization code grammar as the owning Brand/Store contract.
        if (
          typeof s.code !== "string" ||
          !/^[A-Z][A-Z0-9_-]{0,62}$/u.test(s.code) ||
          typeof s.name !== "string" ||
          s.name.length < 1 ||
          s.name.length > 120 ||
          s.name.trim() !== s.name ||
          /[\p{Cc}\p{Cf}<>]/u.test(s.name)
        )
          return invalid();
        const codeKey = `${s.kind}:${s.code}`;
        if (references.has(reference) || codes.has(codeKey)) return invalid();
        references.add(reference);
        codes.add(codeKey);
        return Object.freeze({ kind: s.kind, reference, code: s.code, name: s.name });
      })
      .sort((a, b) =>
        a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : a.reference < b.reference
              ? -1
              : a.reference > b.reference
                ? 1
                : 0,
      );
    const pairs = new Set<string>();
    const assignments = dense(r.assignments, brandStoreTopologyMaximumAssignments)
      .map((value) => {
        const a = closed(value, ["storeReference", "selectorReference"]),
          storeReference = parseStoreReference(a.storeReference),
          selectorReference = parseBrandReference(a.selectorReference);
        const key = `${storeReference}:${selectorReference}`;
        if (!references.has(selectorReference) || pairs.has(key)) return invalid();
        pairs.add(key);
        return Object.freeze({ storeReference, selectorReference });
      })
      .sort((a, b) =>
        a.storeReference < b.storeReference
          ? -1
          : a.storeReference > b.storeReference
            ? 1
            : a.selectorReference < b.selectorReference
              ? -1
              : a.selectorReference > b.selectorReference
                ? 1
                : 0,
      );
    const result: BrandStoreTopologyDraft = Object.freeze({
      profile: "BrandStoreTopologyDraftV1",
      tenantReference: parsePlatformTenantReference(r.tenantReference),
      brandReference: parseBrandReference(r.brandReference),
      draftReference: parseBrandReference(r.draftReference),
      selectors: Object.freeze(selectors),
      assignments: Object.freeze(assignments),
    });
    if (new TextEncoder().encode(JSON.stringify(result)).length > 2097152) return invalid();
    return result;
  } catch {
    return invalid();
  }
}
/** Checks identities against an owning roster supplied by the actual source holder.
 * This pure helper neither authenticates acquisition nor establishes live topology. */
export function validateBrandStoreTopologyDraftStores(
  value: unknown,
  actualRoster: unknown,
): BrandStoreTopologyDraft {
  try {
    const draft = parseBrandStoreTopologyDraft(value),
      roster = parseTenantStoreReferenceSnapshot(actualRoster);
    if (roster.brandReference !== draft.brandReference) return invalid();
    const stores = new Set(roster.references.map((store) => store.storeReference));
    if (draft.assignments.some((a) => !stores.has(a.storeReference))) return invalid();
    return draft;
  } catch {
    return invalid();
  }
}
