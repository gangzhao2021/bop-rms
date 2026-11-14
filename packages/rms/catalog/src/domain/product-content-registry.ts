import {
  CatalogError,
  parseCatalogCode,
  parseCatalogLocale,
  parseCatalogReference,
  parseCatalogInstant,
  parseLocalizedNames,
  type ProductAggregate,
} from "./product.js";
export type ContentDefinitionLifecycle = "Active" | "Inactive" | "Retired";
export interface CatalogTagDefinition {
  readonly tagReference: string;
  readonly code: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly lifecycle: ContentDefinitionLifecycle;
}
interface AttributeIdentity {
  readonly attributeReference: string;
  readonly code: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly lifecycle: ContentDefinitionLifecycle;
}
export type CatalogAttributeDefinition = AttributeIdentity &
  (
    | { readonly type: "Text"; readonly maximumLength: number }
    | { readonly type: "Boolean" }
    | {
        readonly type: "Decimal";
        readonly unitCode: string | null;
        readonly minimumValue: string | null;
        readonly maximumValue: string | null;
      }
    | {
        readonly type: "Enum";
        readonly values: readonly {
          readonly valueReference: string;
          readonly code: string;
          readonly localizedNames: Readonly<Record<string, string>>;
          readonly lifecycle: ContentDefinitionLifecycle;
        }[];
      }
  );
export interface CatalogProductContentRegistry {
  readonly profile: "CatalogProductContentRegistryV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly registryReference: string;
  readonly versionReference: string;
  readonly registryVersion: number;
  readonly defaultLocale: string;
  readonly previousSnapshotDigest: string | null;
  readonly registeredAt: string;
  readonly tags: readonly CatalogTagDefinition[];
  readonly attributes: readonly CatalogAttributeDefinition[];
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const conflict = (): never => {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
};
function record(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function list<T>(value: unknown, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  return Object.freeze(value.map(parse));
}
function unique<T>(items: readonly T[], reference: (item: T) => string, code: (item: T) => string) {
  if (
    new Set(items.map(reference)).size !== items.length ||
    new Set(items.map(code)).size !== items.length
  )
    return invalid();
  return Object.freeze([...items].sort((a, b) => reference(a).localeCompare(reference(b))));
}
function lifecycle(value: unknown): ContentDefinitionLifecycle {
  if (value !== "Active" && value !== "Inactive" && value !== "Retired") return invalid();
  return value;
}
/** Exact signed six-fractional-place comparison; no binary floating-point value. */
export function contentRegistryDecimalUnits(value: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/.test(value)) return invalid();
  const negative = value.startsWith("-"),
    [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole ?? "0") * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -units : units;
}
function decimal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return invalid();
  const units = contentRegistryDecimalUnits(value),
    absolute = units < 0n ? -units : units;
  const fraction = String(absolute % 1000000n)
      .padStart(6, "0")
      .replace(/0+$/, ""),
    whole = String(absolute / 1000000n);
  return (units < 0n ? "-" : "") + whole + (fraction ? "." + fraction : "");
}
/** Called only after the public descriptor-safe bounded copy. */
export function parseProductContentRegistryStructure(
  value: unknown,
): CatalogProductContentRegistry {
  const r = record(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "registryReference",
    "versionReference",
    "registryVersion",
    "defaultLocale",
    "previousSnapshotDigest",
    "registeredAt",
    "tags",
    "attributes",
  ]);
  if (
    r.profile !== "CatalogProductContentRegistryV1" ||
    !Number.isSafeInteger(r.registryVersion) ||
    (r.registryVersion as number) < 1 ||
    (r.registryVersion as number) > 2147483647 ||
    (r.previousSnapshotDigest !== null &&
      (typeof r.previousSnapshotDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(r.previousSnapshotDigest))) ||
    (r.registryVersion === 1) !== (r.previousSnapshotDigest === null)
  )
    return invalid();
  const defaultLocale = parseCatalogLocale(r.defaultLocale);
  const common = (v: Record<string, unknown>) => ({
    code: parseCatalogCode(v.code),
    localizedNames: parseLocalizedNames(v.localizedNames, defaultLocale),
    lifecycle: lifecycle(v.lifecycle),
  });
  const tags = unique(
    list(r.tags, (value): CatalogTagDefinition => {
      const t = record(value, ["tagReference", "code", "localizedNames", "lifecycle"]);
      return Object.freeze({ tagReference: parseCatalogReference(t.tagReference), ...common(t) });
    }),
    (t) => t.tagReference,
    (t) => t.code,
  );
  const attributes = unique(
    list(r.attributes, (value): CatalogAttributeDefinition => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
      const kind = (value as Record<string, unknown>).type;
      const fields =
        kind === "Text"
          ? ["maximumLength"]
          : kind === "Decimal"
            ? ["unitCode", "minimumValue", "maximumValue"]
            : kind === "Enum"
              ? ["values"]
              : [];
      const a = record(value, [
        "attributeReference",
        "code",
        "localizedNames",
        "lifecycle",
        "type",
        ...fields,
      ]);
      const base = {
        attributeReference: parseCatalogReference(a.attributeReference),
        ...common(a),
      };
      if (kind === "Boolean") return Object.freeze({ ...base, type: kind });
      if (kind === "Text") {
        if (
          !Number.isSafeInteger(a.maximumLength) ||
          (a.maximumLength as number) < 1 ||
          (a.maximumLength as number) > 240
        )
          return invalid();
        return Object.freeze({ ...base, type: kind, maximumLength: a.maximumLength as number });
      }
      if (kind === "Decimal") {
        const minimumValue = decimal(a.minimumValue),
          maximumValue = decimal(a.maximumValue);
        if (
          minimumValue !== null &&
          maximumValue !== null &&
          contentRegistryDecimalUnits(minimumValue) > contentRegistryDecimalUnits(maximumValue)
        )
          return invalid();
        return Object.freeze({
          ...base,
          type: kind,
          unitCode: a.unitCode === null ? null : parseCatalogCode(a.unitCode),
          minimumValue,
          maximumValue,
        });
      }
      if (kind === "Enum") {
        const values = unique(
          list(a.values, (value) => {
            const v = record(value, ["valueReference", "code", "localizedNames", "lifecycle"]);
            return Object.freeze({
              valueReference: parseCatalogReference(v.valueReference),
              ...common(v),
            });
          }),
          (v) => v.valueReference,
          (v) => v.code,
        );
        if (values.length === 0) return invalid();
        return Object.freeze({ ...base, type: kind, values });
      }
      return invalid();
    }),
    (a) => a.attributeReference,
    (a) => a.code,
  );
  // Shared identity space forbids a definition ID being reinterpreted across groups.
  const ids = [
    ...tags.map((t) => t.tagReference),
    ...attributes.map((a) => a.attributeReference),
    ...attributes.flatMap((a) => (a.type === "Enum" ? a.values.map((v) => v.valueReference) : [])),
  ];
  if (new Set(ids).size !== ids.length) return invalid();
  return Object.freeze({
    profile: "CatalogProductContentRegistryV1",
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    registryReference: parseCatalogReference(r.registryReference),
    versionReference: parseCatalogReference(r.versionReference),
    registryVersion: r.registryVersion as number,
    defaultLocale,
    previousSnapshotDigest: r.previousSnapshotDigest as string | null,
    registeredAt: parseCatalogInstant(r.registeredAt),
    tags,
    attributes,
  });
}
export function assertProductContentRegistrySuccessor(
  current: CatalogProductContentRegistry | null,
  next: CatalogProductContentRegistry,
): void {
  if (current === null) {
    if (next.registryVersion !== 1) return conflict();
    return;
  }
  if (
    next.tenantReference !== current.tenantReference ||
    next.brandReference !== current.brandReference ||
    next.registryReference !== current.registryReference ||
    next.registryVersion !== current.registryVersion + 1 ||
    next.versionReference === current.versionReference ||
    next.registeredAt < current.registeredAt
  )
    return conflict();
  const preserves = (
    old: { code: string; lifecycle: ContentDefinitionLifecycle },
    value: { code: string; lifecycle: ContentDefinitionLifecycle } | undefined,
  ) => {
    if (
      !value ||
      old.code !== value.code ||
      (old.lifecycle === "Retired" && value.lifecycle !== "Retired")
    )
      return conflict();
  };
  for (const old of current.tags)
    preserves(
      old,
      next.tags.find((t) => t.tagReference === old.tagReference),
    );
  for (const old of current.attributes) {
    const value = next.attributes.find((a) => a.attributeReference === old.attributeReference);
    preserves(old, value);
    if (!value || old.type !== value.type) return conflict();
    if (old.type === "Decimal" && (value.type !== "Decimal" || old.unitCode !== value.unitCode))
      return conflict();
    if (old.type === "Enum") {
      if (value.type !== "Enum") return conflict();
      for (const member of old.values)
        preserves(
          member,
          value.values.find((v) => v.valueReference === member.valueReference),
        );
    }
  }
  // Old IDs cannot move from a Tag/Attribute/Enum member to another definition.
  const oldIds = new Map<string, string>();
  for (const t of current.tags) oldIds.set(t.tagReference, "Tag");
  for (const a of current.attributes) {
    oldIds.set(a.attributeReference, "Attribute");
    if (a.type === "Enum")
      for (const v of a.values) oldIds.set(v.valueReference, a.attributeReference);
  }
  for (const t of next.tags)
    if (oldIds.has(t.tagReference) && oldIds.get(t.tagReference) !== "Tag") return conflict();
  for (const a of next.attributes) {
    if (oldIds.has(a.attributeReference) && oldIds.get(a.attributeReference) !== "Attribute")
      return conflict();
    if (a.type === "Enum")
      for (const v of a.values)
        if (oldIds.has(v.valueReference) && oldIds.get(v.valueReference) !== a.attributeReference)
          return conflict();
  }
}
export function assertProductRegisteredContentReferences(
  aggregate: ProductAggregate,
  registry: CatalogProductContentRegistry,
): void {
  if (
    aggregate.brandReference !== registry.brandReference ||
    aggregate.draft.editorContent === undefined
  )
    return conflict();
  const content = aggregate.draft.editorContent;
  for (const id of content.tagReferences)
    if (registry.tags.find((t) => t.tagReference === id)?.lifecycle !== "Active") return conflict();
  const active = (id: string) => {
    const definition = registry.attributes.find((a) => a.attributeReference === id);
    if (!definition || definition.lifecycle !== "Active") return conflict();
    return definition;
  };
  for (const supplied of content.attributeValues) {
    const definition = active(supplied.attributeReference);
    if (definition.type !== supplied.type) return conflict();
    if (
      definition.type === "Text" &&
      supplied.type === "Text" &&
      supplied.value.length > definition.maximumLength
    )
      return conflict();
    if (definition.type === "Decimal" && supplied.type === "Decimal") {
      const units = contentRegistryDecimalUnits(supplied.value);
      if (
        definition.unitCode !== supplied.unitCode ||
        (definition.minimumValue !== null &&
          units < contentRegistryDecimalUnits(definition.minimumValue)) ||
        (definition.maximumValue !== null &&
          units > contentRegistryDecimalUnits(definition.maximumValue))
      )
        return conflict();
    }
    if (
      definition.type === "Enum" &&
      supplied.type === "Enum" &&
      definition.values.find((v) => v.valueReference === supplied.valueReference)?.lifecycle !==
        "Active"
    )
      return conflict();
  }
  for (const dimension of content.variantDimensions)
    for (const value of dimension.values)
      if (value.attributeReference !== null) active(value.attributeReference);
}
