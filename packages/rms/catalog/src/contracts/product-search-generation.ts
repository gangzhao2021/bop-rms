import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import { productListRecord, productListCopy } from "./product-list.js";

export interface ProductSearchBuildRequest {
  readonly operationReference: string;
  readonly actorReference: string;
  readonly observedAt: string;
}
export interface ProductSearchGeneration {
  readonly generationReference: string;
  readonly brandReference: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly projectedAt: string;
  readonly productCount: number;
  readonly coverage: "CatalogProductDraftV1";
  readonly partial: true;
}
export type ProductSearchGenerationState = "Current" | "Changed" | "Superseded" | "Stale";
export interface ProductSearchBuildResult {
  readonly status: "Built" | "AlreadyBuilt";
  readonly generation: ProductSearchGeneration;
  readonly state: ProductSearchGenerationState;
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
export function productSearchRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return invalid();
  return value;
}
export function parseProductSearchBuildRequest(value: unknown): ProductSearchBuildRequest {
  try {
    const row = productListRecord(productListCopy(value), [
      "operationReference",
      "actorReference",
      "observedAt",
    ]);
    return Object.freeze({
      operationReference: parseCatalogReference(row.operationReference),
      actorReference: parseCatalogReference(row.actorReference),
      observedAt: parseCatalogInstant(row.observedAt),
    });
  } catch {
    return invalid();
  }
}
export function parseProductSearchGeneration(value: unknown): ProductSearchGeneration {
  try {
    const row = productListRecord(productListCopy(value), [
      "generationReference",
      "brandReference",
      "sourceRevision",
      "sourceDigest",
      "projectedAt",
      "productCount",
      "coverage",
      "partial",
    ]);
    if (
      typeof row.sourceDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(row.sourceDigest) ||
      !Number.isSafeInteger(row.productCount) ||
      (row.productCount as number) < 0 ||
      row.coverage !== "CatalogProductDraftV1" ||
      row.partial !== true
    )
      return invalid();
    return Object.freeze({
      generationReference: parseCatalogReference(row.generationReference),
      brandReference: parseCatalogReference(row.brandReference),
      sourceRevision: productSearchRevision(row.sourceRevision),
      sourceDigest: row.sourceDigest,
      projectedAt: parseCatalogInstant(row.projectedAt),
      productCount: row.productCount as number,
      coverage: "CatalogProductDraftV1",
      partial: true,
    });
  } catch {
    return invalid();
  }
}
