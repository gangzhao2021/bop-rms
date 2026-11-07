import type { ProductImageContentType } from "../../contracts/product-image.js";

/** Public image object storage port. Names are content addressed
 * (`<sha256 hex of the bytes>.<jpg|webp>`), so a put is idempotent and an orphaned
 * object is harmless. The pilot uses the local filesystem adapter; production object
 * storage is an external gate and replaces the adapter behind this port. */
export interface MediaImageObjectStore {
  put(object: {
    readonly name: string;
    readonly contentType: ProductImageContentType;
    readonly bytes: Uint8Array;
  }): Promise<void>;
  read(
    name: string,
  ): Promise<{ readonly contentType: ProductImageContentType; readonly bytes: Uint8Array } | null>;
}
