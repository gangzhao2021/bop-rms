import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import type { RequestHandler } from "express";
import {
  createLocalFilesystemMediaImageObjectStore,
  createProductImageService,
  type MediaImageObjectStore,
} from "@bop/media";

const imageName = /^[0-9a-f]{64}\.(?:jpg|webp)$/u;
const immutable = "public, max-age=31536000, immutable";

/**
 * WP-2423 menu descriptions and photos: `GET /media/images/<sha256>.<jpg|webp>` serves one stored
 * product photo size. The name is the hash of the bytes (no record identity), so a file never
 * changes and is cached for a year; anything else is a 404. Photos are public menu content (no
 * personal data); the response cannot run script or be framed.
 */
export function createProductImageFileHandler(
  store: Pick<MediaImageObjectStore, "read">,
): RequestHandler {
  return (request, response) => {
    response.set("X-Content-Type-Options", "nosniff");
    const name = request.params.name;
    const missing = () => {
      response.status(404).set("Cache-Control", "no-store").end();
    };
    if (typeof name !== "string" || !imageName.test(name) || Object.keys(request.query).length) {
      missing();
      return;
    }
    const etag = `"${name.slice(0, 64)}"`;
    void store
      .read(name)
      .then((object) => {
        if (object === null) {
          missing();
          return;
        }
        response.set({
          "Cache-Control": immutable,
          ETag: etag,
          "Content-Type": object.contentType,
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        if (request.headers["if-none-match"] === etag) {
          response.status(304).end();
          return;
        }
        response.status(200).end(Buffer.from(object.bytes));
      })
      .catch(() => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.status(503).set("Cache-Control", "no-store").end();
      });
  };
}

/**
 * The pilot's product photos: the Media service over the local filesystem storage adapter in the
 * pilot runtime directory (production object storage is an external gate; it replaces the adapter
 * behind the same port) and the file handler serving the stored sizes.
 */
export function createPilotProductImages(directory: string): {
  readonly service: ReturnType<typeof createProductImageService>;
  readonly fileHandler: RequestHandler;
} {
  const objectStore = createLocalFilesystemMediaImageObjectStore({
    directory: resolve(directory),
  });
  return Object.freeze({
    service: createProductImageService({ objectStore }),
    fileHandler: createProductImageFileHandler(objectStore),
  });
}
