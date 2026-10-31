import { CatalogError, parseCatalogReference, type CatalogReference } from "./product.js";

/** Internal configuration evidence. Absence in legacy review content means unknown,
 * not an empty set. A present packet covers every section, including empty ones. */
export interface MenuCategoryBinding {
  readonly sectionReference: CatalogReference;
  readonly categoryReferences: readonly CatalogReference[];
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function data(value: unknown, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
  return descriptor.value;
}
function array(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value)) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) return invalid();
  // Reject sparse arrays, custom fields and getters without invoking them.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) return invalid();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) result.push(data(value, String(i)));
  return result;
}
function parse(
  value: unknown,
  sectionReferences: readonly CatalogReference[],
): readonly MenuCategoryBinding[] {
  const entries = array(value, 10000);
  const required = new Set(sectionReferences);
  if (required.size !== sectionReferences.length || entries.length !== required.size)
    return invalid();
  const seen = new Set<CatalogReference>();
  let count = 0;
  const parsed = entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      return invalid();
    const keys = Reflect.ownKeys(entry);
    if (
      keys.length !== 2 ||
      !keys.includes("sectionReference") ||
      !keys.includes("categoryReferences")
    )
      return invalid();
    const sectionReference = parseCatalogReference(data(entry, "sectionReference"));
    if (!required.has(sectionReference) || seen.has(sectionReference)) return invalid();
    seen.add(sectionReference);
    const references = array(data(entry, "categoryReferences"), 10000);
    count += references.length;
    if (count > 50000) return invalid();
    const categoryReferences = references.map(parseCatalogReference).sort();
    if (new Set(categoryReferences).size !== categoryReferences.length) return invalid();
    return Object.freeze({
      sectionReference,
      categoryReferences: Object.freeze(categoryReferences),
    });
  });
  return Object.freeze(parsed.sort((a, b) => a.sectionReference.localeCompare(b.sectionReference)));
}

export function parseMenuCategoryBindings(
  value: unknown,
  sectionReferences: readonly CatalogReference[],
): readonly MenuCategoryBinding[] {
  try {
    return parse(value, sectionReferences);
  } catch {
    return invalid();
  }
}
