import type { ProductImageRecord } from "../contracts/product-image.js";
import type { MediaImageObjectStore } from "../application/ports/media-image-object-store.js";
import {
  createProductImageApplicationService,
  loadProductImagesFrom,
  type LoadProductImagesInput,
  type ProductImageService,
} from "../application/product-image-service.js";
import type { MediaPersistenceTransaction } from "./persistence/media-upload-store.js";
import { findProductImages, insertProductImage } from "./persistence/product-image-store.js";
import { processPublicImage } from "./processing/public-image-processor.js";

/** Product photo service: the private public-image processor (sniffing, full decode, metadata
 * stripped, six renditions), the given object store and Brand-scoped `bop_media.product_image`. */
export function createProductImageService(options: {
  readonly objectStore: MediaImageObjectStore;
}): ProductImageService<MediaPersistenceTransaction> {
  return createProductImageApplicationService<MediaPersistenceTransaction>({
    objectStore: options.objectStore,
    processImage: (input) => processPublicImage(input),
    records: { find: findProductImages, insert: insertProductImage },
  });
}

/** Standalone Brand-scoped read of recorded product photos (no object store needed). Only
 * images of `brandReference` are returned; other references are absent from the map.
 * Database failure: MEDIA_IMAGE_STORAGE_UNAVAILABLE. */
export function loadProductImages(
  tx: MediaPersistenceTransaction,
  input: LoadProductImagesInput,
): Promise<ReadonlyMap<string, ProductImageRecord>> {
  return loadProductImagesFrom(findProductImages, tx, input);
}
