import {
  productImagePathPattern,
  productImageRenditionWidths,
  type ProductImageRecord,
  type ProductImageRendition,
  type ProductImageSourceContentType,
} from "../../contracts/product-image.js";
import type { MediaPersistenceTransaction } from "./media-upload-store.js";

/** Brand-scoped persistence of `bop_media.product_image` (append-only, migration 2000_079).
 * Every call sets the transaction-local Brand scope and clears the Store scope itself. */
export interface ProductImageRow {
  readonly imageReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly sourceContentType: ProductImageSourceContentType;
  readonly sourceByteSize: number;
  readonly width: number;
  readonly height: number;
  readonly renditions: readonly ProductImageRendition[];
  readonly createdByActorReference: string;
  readonly createdAt: string;
}
export interface StoredProductImage {
  readonly tenantReference: string;
  readonly sourceContentType: ProductImageSourceContentType;
  readonly sourceByteSize: number;
  readonly record: ProductImageRecord;
}

const storageProfile = "PilotLocalFilesystemV1";
const columns = `image_id::text image_id,tenant_id::text tenant_id,brand_id::text brand_id,
  product_id::text product_id,source_content_type,source_byte_size,width,height,renditions_json,
  created_by_actor_id::text created_by_actor_id,storage_profile,data_classification,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') created_at`;
const selectSql = `SELECT ${columns} FROM bop_media.product_image
WHERE brand_id=$1::uuid AND image_id=ANY($2::uuid[])`;
const insertSql = `INSERT INTO bop_media.product_image(image_id,tenant_id,brand_id,product_id,
  storage_profile,source_content_type,source_byte_size,width,height,renditions_json,
  data_classification,created_by_actor_id,created_at)
VALUES($1,$2,$3,$4,'${storageProfile}',$5,$6,$7,$8,$9::jsonb,'Public',$10,$11::timestamptz)`;

interface Row {
  image_id: unknown;
  tenant_id: unknown;
  brand_id: unknown;
  product_id: unknown;
  source_content_type: unknown;
  source_byte_size: unknown;
  width: unknown;
  height: unknown;
  renditions_json: unknown;
  created_by_actor_id: unknown;
  storage_profile: unknown;
  data_classification: unknown;
  created_at: unknown;
}

class ProductImageRowError extends Error {
  constructor() {
    super("MEDIA_PRODUCT_IMAGE_ROW_INVALID");
    this.name = "ProductImageRowError";
  }
}
const invalid = (): never => {
  throw new ProductImageRowError();
};
const text = (value: unknown): string => (typeof value === "string" ? value : invalid());
const positive = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : invalid();

/** Six renditions: widths 320/640/1280, each JPEG then WebP, content-addressed paths. */
export function parseProductImageRenditions(value: unknown): readonly ProductImageRendition[] {
  if (!Array.isArray(value) || value.length !== 6) return invalid();
  const renditions = value.map((item: unknown, index): ProductImageRendition => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).length !== 5) return invalid();
    const contentType = index % 2 === 0 ? "image/jpeg" : "image/webp";
    const width = productImageRenditionWidths[Math.floor(index / 2)];
    const path = text(entry.path);
    if (
      entry.contentType !== contentType ||
      entry.width !== width ||
      width === undefined ||
      !productImagePathPattern.test(path) ||
      !path.endsWith(contentType === "image/jpeg" ? ".jpg" : ".webp")
    )
      return invalid();
    return Object.freeze({
      contentType,
      width,
      height: positive(entry.height),
      byteSize: positive(entry.byteSize),
      path,
    });
  });
  return Object.freeze(renditions);
}

function storedImage(row: Row, brandReference: string): StoredProductImage {
  const sourceContentType = row.source_content_type;
  if (
    sourceContentType !== "image/jpeg" &&
    sourceContentType !== "image/png" &&
    sourceContentType !== "image/webp"
  )
    return invalid();
  if (
    row.storage_profile !== storageProfile ||
    row.data_classification !== "Public" ||
    text(row.brand_id) !== brandReference
  )
    return invalid();
  const renditions = parseProductImageRenditions(row.renditions_json);
  const largestJpeg = renditions[4];
  const width = positive(row.width),
    height = positive(row.height);
  if (!largestJpeg || largestJpeg.width !== width || largestJpeg.height !== height)
    return invalid();
  return Object.freeze({
    tenantReference: text(row.tenant_id),
    sourceContentType,
    sourceByteSize: positive(row.source_byte_size),
    record: Object.freeze({
      imageReference: text(row.image_id),
      brandReference,
      productReference: text(row.product_id),
      width,
      height,
      renditions,
      createdAt: text(row.created_at),
      createdByActorReference: text(row.created_by_actor_id),
    }),
  });
}

async function enterBrandScope(
  tx: MediaPersistenceTransaction,
  brandReference: string,
): Promise<void> {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    brandReference,
  ]);
}

export async function findProductImages(
  tx: MediaPersistenceTransaction,
  brandReference: string,
  imageReferences: readonly string[],
): Promise<readonly StoredProductImage[]> {
  await enterBrandScope(tx, brandReference);
  const result = await tx.query<Row>(selectSql, [brandReference, [...imageReferences]]);
  const images = result.rows.map((row) => storedImage(row, brandReference));
  if (
    images.some((image) => !imageReferences.includes(image.record.imageReference)) ||
    new Set(images.map((image) => image.record.imageReference)).size !== images.length
  )
    return invalid();
  return Object.freeze(images);
}

export async function insertProductImage(
  tx: MediaPersistenceTransaction,
  row: ProductImageRow,
): Promise<void> {
  await enterBrandScope(tx, row.brandReference);
  const result = await tx.query(insertSql, [
    row.imageReference,
    row.tenantReference,
    row.brandReference,
    row.productReference,
    row.sourceContentType,
    row.sourceByteSize,
    row.width,
    row.height,
    JSON.stringify(row.renditions),
    row.createdByActorReference,
    row.createdAt,
  ]);
  if (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== 1) invalid();
}
