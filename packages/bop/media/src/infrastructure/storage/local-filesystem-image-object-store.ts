import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MediaImageObjectStore } from "../../application/ports/media-image-object-store.js";
import {
  productImageObjectNamePattern,
  type ProductImageContentType,
} from "../../contracts/product-image.js";

class LocalImageObjectStoreError extends Error {
  constructor() {
    super("MEDIA_IMAGE_OBJECT_STORE_REFUSED");
    this.name = "LocalImageObjectStoreError";
  }
}

const refuse = (): never => {
  throw new LocalImageObjectStoreError();
};
const objectName = (name: unknown): string =>
  typeof name === "string" && productImageObjectNamePattern.test(name) ? name : refuse();
const contentTypeOf = (name: string): ProductImageContentType =>
  name.endsWith(".jpg") ? "image/jpeg" : "image/webp";

/**
 * PILOT STORAGE ADAPTER (storage profile `PilotLocalFilesystemV1`). Stores public,
 * already-processed image renditions as files in one local directory that the pilot HTTPS
 * entry serves under `/media/images/`. Production object storage is an external gate; the
 * `MediaImageObjectStore` port is what production swaps, not this adapter.
 *
 * Only content-addressed names (`<64 hex>.jpg|webp`) are accepted, so no caller-controlled
 * path can escape the directory. A put verifies the SHA-256 of the bytes against the name,
 * writes a temporary file in the same directory and renames it into place (readers never see
 * a partial file), and skips an existing file of the same size.
 */
export function createLocalFilesystemMediaImageObjectStore(options: {
  readonly directory: string;
}): MediaImageObjectStore {
  const directory = options.directory;
  if (typeof directory !== "string" || directory.length === 0 || !directory.startsWith("/"))
    throw new TypeError("an absolute image directory is required");
  let ready: Promise<unknown> | undefined;
  const ensureDirectory = () => (ready ??= mkdir(directory, { recursive: true, mode: 0o755 }));
  return Object.freeze({
    async put(object: {
      readonly name: string;
      readonly contentType: ProductImageContentType;
      readonly bytes: Uint8Array;
    }): Promise<void> {
      const name = objectName(object.name);
      if (object.contentType !== contentTypeOf(name) || !(object.bytes instanceof Uint8Array))
        refuse();
      const bytes = Uint8Array.from(object.bytes);
      if (
        bytes.byteLength < 1 ||
        createHash("sha256").update(bytes).digest("hex") !== name.slice(0, 64)
      )
        refuse();
      try {
        await ensureDirectory();
      } catch (error) {
        ready = undefined;
        throw error;
      }
      const target = join(directory, name);
      const existing = await stat(target).catch(() => null);
      if (existing?.isFile() && existing.size === bytes.byteLength) return;
      const temporary = join(directory, "." + name + "." + randomBytes(8).toString("hex") + ".tmp");
      const handle = await open(temporary, "wx", 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.chmod(0o644);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      await handle.close();
      try {
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    async read(name: string): Promise<{
      readonly contentType: ProductImageContentType;
      readonly bytes: Uint8Array;
    } | null> {
      const checked = objectName(name);
      try {
        const bytes = await readFile(join(directory, checked));
        return Object.freeze({ contentType: contentTypeOf(checked), bytes: new Uint8Array(bytes) });
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") return null;
        throw error;
      }
    },
  });
}
