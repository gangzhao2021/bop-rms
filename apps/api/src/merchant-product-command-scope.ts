import { readClosedRecord } from "@bop/identity";
import { CatalogError, parseCatalogReference } from "@rms/catalog";

export interface MerchantProductCommandScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
/** An intent anchor, never caller-supplied authority or a tenant selection command. */
export function parseMerchantProductCommandScope(value: unknown): MerchantProductCommandScope {
  try {
    const raw = readClosedRecord(value, ["brandReference", "storeReference"]);
    return Object.freeze({
      brandReference: parseCatalogReference(raw.brandReference),
      storeReference: parseCatalogReference(raw.storeReference),
    });
  } catch {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  }
}
export function decodeMerchantProductCommandScopeHeader(
  value: unknown,
): MerchantProductCommandScope {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(value))
      throw new Error("invalid");
    const bytes = Buffer.from(value, "base64url"),
      decoded = bytes.toString("utf8");
    if (
      bytes.length > 384 ||
      bytes.toString("base64url") !== value ||
      !Buffer.from(decoded, "utf8").equals(bytes)
    )
      throw new Error("invalid");
    return parseMerchantProductCommandScope(JSON.parse(decoded));
  } catch {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  }
}

/** Invalid owning scope is an unavailable dependency, not malformed user input. */
export function bindMerchantProductCommandScope(
  actualValue: unknown,
  expected: MerchantProductCommandScope,
): MerchantProductCommandScope {
  let actual: MerchantProductCommandScope;
  try {
    actual = parseMerchantProductCommandScope(actualValue);
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
  if (
    actual.brandReference !== expected.brandReference ||
    actual.storeReference !== expected.storeReference
  )
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  return actual;
}
