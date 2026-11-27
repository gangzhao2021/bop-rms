import { createHash } from "node:crypto";
import {
  MediaContractError,
  parseMediaInstant,
  parseMediaReferenceId,
} from "../contracts/media.js";
import {
  MediaProductImageError,
  productImageExtension,
  productImageMaxAspectRatio,
  productImageMaxSourceBytes,
  productImageMinShorterEdge,
  productImagePathPrefix,
  productImageRenditionWidths,
  type ProductImageContentType,
  type ProductImageRecord,
  type ProductImageRendition,
  type ProductImageSourceContentType,
} from "../contracts/product-image.js";
import type { MediaImageObjectStore } from "./ports/media-image-object-store.js";

/** Processed image as produced by the private public-image processor. */
export interface ProductImageProcessorResult {
  readonly source: { readonly width: number; readonly height: number };
  readonly renditions: readonly {
    readonly contentType: ProductImageContentType;
    readonly width: number;
    readonly height: number;
    readonly byteSize: number;
    readonly bytes: Uint8Array;
  }[];
}
export interface ProductImageStoredFact {
  readonly tenantReference: string;
  readonly sourceContentType: ProductImageSourceContentType;
  readonly sourceByteSize: number;
  readonly record: ProductImageRecord;
}
export interface ProductImageApplicationPorts<Tx> {
  readonly objectStore: MediaImageObjectStore;
  processImage(input: {
    readonly bytes: Uint8Array;
    readonly declaredContentType: ProductImageSourceContentType;
  }): Promise<ProductImageProcessorResult>;
  readonly records: {
    find(
      tx: Tx,
      brandReference: string,
      imageReferences: readonly string[],
    ): Promise<readonly ProductImageStoredFact[]>;
    insert(tx: Tx, row: Omit<ProductImageStoredFact, "record"> & ProductImageRecord): Promise<void>;
  };
}
/** Processed, stored photo ready to be recorded. Holds no image bytes. Only values returned
 * by `prepare` are accepted by `record` (its renditions are known to be stored). */
export interface PreparedProductImage {
  readonly width: number;
  readonly height: number;
  readonly sourceContentType: ProductImageSourceContentType;
  readonly sourceByteSize: number;
  readonly renditions: readonly ProductImageRendition[];
}
export interface PrepareProductImageInput {
  readonly declaredContentType: string;
  readonly bytes: Uint8Array;
}
export interface RecordProductImageInput {
  readonly imageReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly actorReference: string;
  readonly createdAt: string;
  readonly prepared: PreparedProductImage;
}
export type IngestProductImageInput = Omit<RecordProductImageInput, "prepared"> &
  PrepareProductImageInput;
export interface LoadProductImagesInput {
  readonly brandReference: string;
  readonly imageReferences: readonly string[];
}
export interface ProductImageService<Tx> {
  /** Validates and processes the upload and stores its six renditions. No database access:
   * run it outside the transaction. Errors: MEDIA_IMAGE_TYPE_UNSUPPORTED, MEDIA_IMAGE_TOO_LARGE,
   * MEDIA_IMAGE_TOO_SMALL, MEDIA_IMAGE_UNREADABLE, MEDIA_IMAGE_STORAGE_UNAVAILABLE. */
  prepare(input: PrepareProductImageInput): Promise<PreparedProductImage>;
  /** Records a prepared photo. Idempotent on `imageReference`: a retry returns the recorded
   * image as is. A reference already recorded for another product, Tenant or upload (different
   * source type or size), or for another Brand, is a conflict reported as MEDIA_IMAGE_NOT_FOUND
   * (that reference does not name this upload). Database failure: MEDIA_IMAGE_STORAGE_UNAVAILABLE. */
  record(tx: Tx, input: RecordProductImageInput): Promise<ProductImageRecord>;
  /** Convenience for callers without a transaction time limit: prepare, then record. */
  ingest(tx: Tx, input: IngestProductImageInput): Promise<ProductImageRecord>;
  /** Images of this Brand only; references not recorded for the Brand are absent. */
  load(tx: Tx, input: LoadProductImagesInput): Promise<ReadonlyMap<string, ProductImageRecord>>;
}

/** Module-wide so a value prepared by one service instance can be recorded by another. */
const preparedImages = new WeakSet<PreparedProductImage>();

const error = (code: MediaProductImageError["code"]): never => {
  throw new MediaProductImageError(code);
};
const storageUnavailable = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof MediaProductImageError) throw cause;
    return error("MEDIA_IMAGE_STORAGE_UNAVAILABLE");
  }
};
const sourceTypes = new Set<string>(["image/jpeg", "image/png", "image/webp"]);

/** Oriented source dimensions: the processor reports raw source dimensions and renders the
 * EXIF-oriented image, so the 1280 rendition's aspect decides whether the source is rotated. */
function orientedSource(
  source: { readonly width: number; readonly height: number },
  largest: { readonly width: number; readonly height: number },
): { width: number; height: number } {
  const upright = Math.abs((largest.width * source.height) / source.width - largest.height);
  const rotated = Math.abs((largest.width * source.width) / source.height - largest.height);
  return upright <= rotated ? { ...source } : { width: source.height, height: source.width };
}

export function createProductImageApplicationService<Tx>(
  ports: ProductImageApplicationPorts<Tx>,
): ProductImageService<Tx> {
  const prepare = async (input: PrepareProductImageInput): Promise<PreparedProductImage> => {
    const declared: unknown = input.declaredContentType;
    if (typeof declared !== "string" || !sourceTypes.has(declared))
      return error("MEDIA_IMAGE_TYPE_UNSUPPORTED");
    const declaredContentType = declared as ProductImageSourceContentType;
    if (!(input.bytes instanceof Uint8Array)) return error("MEDIA_IMAGE_UNREADABLE");
    const byteSize = input.bytes.byteLength;
    if (byteSize > productImageMaxSourceBytes) return error("MEDIA_IMAGE_TOO_LARGE");
    if (byteSize < 1) return error("MEDIA_IMAGE_UNREADABLE");

    let processed: ProductImageProcessorResult;
    try {
      processed = await ports.processImage({ bytes: input.bytes, declaredContentType });
    } catch {
      // Never surface decoder messages, metadata or paths.
      return error("MEDIA_IMAGE_UNREADABLE");
    }
    const largest = processed.renditions.find(
      (rendition) => rendition.width === 1280 && rendition.contentType === "image/jpeg",
    );
    if (!largest || processed.renditions.length !== 6) return error("MEDIA_IMAGE_UNREADABLE");
    const oriented = orientedSource(processed.source, largest);
    const shorter = Math.min(oriented.width, oriented.height);
    const longer = Math.max(oriented.width, oriented.height);
    if (longer > shorter * productImageMaxAspectRatio) return error("MEDIA_IMAGE_UNREADABLE");
    if (shorter < productImageMinShorterEdge) return error("MEDIA_IMAGE_TOO_SMALL");

    const objects: { name: string; contentType: ProductImageContentType; bytes: Uint8Array }[] = [];
    const renditions: ProductImageRendition[] = [];
    productImageRenditionWidths.forEach((width, widthIndex) => {
      (["image/jpeg", "image/webp"] as const).forEach((contentType, typeIndex) => {
        const rendition = processed.renditions[widthIndex * 2 + typeIndex];
        if (
          !rendition ||
          rendition.width !== width ||
          rendition.contentType !== contentType ||
          rendition.byteSize !== rendition.bytes.byteLength
        )
          return error("MEDIA_IMAGE_UNREADABLE");
        const name =
          createHash("sha256").update(rendition.bytes).digest("hex") +
          "." +
          productImageExtension(contentType);
        objects.push({ name, contentType, bytes: rendition.bytes });
        renditions.push(
          Object.freeze({
            contentType,
            width,
            height: rendition.height,
            byteSize: rendition.byteSize,
            path: productImagePathPrefix + name,
          }),
        );
      });
    });

    // Every rendition is stored before any row can name it, so a record never points at a
    // missing file. Content-addressed objects of an upload that is never recorded are harmless.
    await storageUnavailable(async () => {
      for (const object of objects) await ports.objectStore.put(object);
    });
    const prepared: PreparedProductImage = Object.freeze({
      width: largest.width,
      height: largest.height,
      sourceContentType: declaredContentType,
      sourceByteSize: byteSize,
      renditions: Object.freeze(renditions),
    });
    preparedImages.add(prepared);
    return prepared;
  };

  const record = async (tx: Tx, input: RecordProductImageInput): Promise<ProductImageRecord> => {
    const imageReference = parseMediaReferenceId(input.imageReference);
    const tenantReference = parseMediaReferenceId(input.tenantReference);
    const brandReference = parseMediaReferenceId(input.brandReference);
    const productReference = parseMediaReferenceId(input.productReference);
    const actorReference = parseMediaReferenceId(input.actorReference);
    const createdAt = parseMediaInstant(input.createdAt);
    const prepared = input.prepared;
    if (!preparedImages.has(prepared)) throw new MediaContractError("MEDIA_INPUT_INVALID");

    const existing = await storageUnavailable(() =>
      ports.records.find(tx, brandReference, [imageReference]),
    );
    const recorded = existing[0];
    if (recorded) {
      if (
        recorded.tenantReference !== tenantReference ||
        recorded.record.productReference !== productReference ||
        recorded.sourceContentType !== prepared.sourceContentType ||
        recorded.sourceByteSize !== prepared.sourceByteSize
      )
        return error("MEDIA_IMAGE_NOT_FOUND");
      return recorded.record;
    }
    const result: ProductImageRecord = Object.freeze({
      imageReference,
      brandReference,
      productReference,
      width: prepared.width,
      height: prepared.height,
      renditions: prepared.renditions,
      createdAt,
      createdByActorReference: actorReference,
    });
    // Insert failure covers a reference already used by another Brand (invisible under RLS).
    await storageUnavailable(() =>
      ports.records.insert(tx, {
        ...result,
        tenantReference,
        sourceContentType: prepared.sourceContentType,
        sourceByteSize: prepared.sourceByteSize,
      }),
    );
    return result;
  };

  return Object.freeze({
    prepare,
    record,
    async ingest(tx: Tx, input: IngestProductImageInput): Promise<ProductImageRecord> {
      const prepared = await prepare({
        declaredContentType: input.declaredContentType,
        bytes: input.bytes,
      });
      return record(tx, {
        imageReference: input.imageReference,
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        productReference: input.productReference,
        actorReference: input.actorReference,
        createdAt: input.createdAt,
        prepared,
      });
    },

    load: (tx: Tx, input: LoadProductImagesInput) =>
      loadProductImagesFrom(ports.records.find, tx, input),
  });
}

/** Brand-scoped read shared by the service and the standalone loader. */
export async function loadProductImagesFrom<Tx>(
  find: ProductImageApplicationPorts<Tx>["records"]["find"],
  tx: Tx,
  input: LoadProductImagesInput,
): Promise<ReadonlyMap<string, ProductImageRecord>> {
  const brandReference = parseMediaReferenceId(input.brandReference);
  if (!Array.isArray(input.imageReferences)) throw new MediaContractError("MEDIA_INPUT_INVALID");
  const references = [...new Set(input.imageReferences.map(parseMediaReferenceId))] as string[];
  if (references.length === 0) return new Map();
  const found = await storageUnavailable(() => find(tx, brandReference, references));
  return new Map(found.map((image) => [image.record.imageReference, image.record]));
}
