/** WP-2423 menu descriptions and photos: public product photo records owned by Media.
 * A record names six public renditions (JPEG and WebP at 320, 640 and 1280 px wide) by
 * content-addressed path. It never carries source bytes, source checksums or personal data. */
export type ProductImageContentType = "image/jpeg" | "image/webp";
export type ProductImageSourceContentType = "image/jpeg" | "image/png" | "image/webp";
export type ProductImageRenditionWidth = 320 | 640 | 1280;

export interface ProductImageRendition {
  readonly contentType: ProductImageContentType;
  readonly width: ProductImageRenditionWidth;
  readonly height: number;
  readonly byteSize: number;
  /** `/media/images/<sha256 hex of the rendition bytes>.<jpg|webp>` */
  readonly path: string;
}

export interface ProductImageRecord {
  readonly imageReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  /** Dimensions of the 1280 rendition (the aspect ratio source). */
  readonly width: number;
  readonly height: number;
  /** Exactly six, sorted by width then content type (JPEG before WebP). */
  readonly renditions: readonly ProductImageRendition[];
  readonly createdAt: string;
  readonly createdByActorReference: string;
}

export const mediaProductImageErrorCodes = Object.freeze([
  "MEDIA_IMAGE_TYPE_UNSUPPORTED",
  "MEDIA_IMAGE_TOO_LARGE",
  "MEDIA_IMAGE_TOO_SMALL",
  "MEDIA_IMAGE_UNREADABLE",
  "MEDIA_IMAGE_NOT_FOUND",
  "MEDIA_IMAGE_STORAGE_UNAVAILABLE",
] as const);
export type MediaProductImageErrorCode = (typeof mediaProductImageErrorCodes)[number];

/** The message is the code only: never decoder text, paths or storage detail. */
export class MediaProductImageError extends Error {
  readonly code: MediaProductImageErrorCode;
  constructor(code: MediaProductImageErrorCode) {
    super(code);
    this.name = "MediaProductImageError";
    this.code = code;
  }
}

export const productImageSourceContentTypes: readonly ProductImageSourceContentType[] =
  Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const productImageMaxSourceBytes = 10 * 1024 * 1024;
export const productImageMinShorterEdge = 480;
export const productImageMaxAspectRatio = 3;
export const productImageRenditionWidths: readonly ProductImageRenditionWidth[] = Object.freeze([
  320, 640, 1280,
]);
export const productImagePathPattern = /^\/media\/images\/[0-9a-f]{64}\.(?:jpg|webp)$/u;
/** Object name inside the image store: `<64 hex>.jpg` or `<64 hex>.webp`. */
export const productImageObjectNamePattern = /^[0-9a-f]{64}\.(?:jpg|webp)$/u;
export const productImagePathPrefix = "/media/images/";

export function productImageExtension(contentType: ProductImageContentType): "jpg" | "webp" {
  return contentType === "image/jpeg" ? "jpg" : "webp";
}
