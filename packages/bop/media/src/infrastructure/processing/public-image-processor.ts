import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import sharp from "sharp";

type InputContentType = "image/jpeg" | "image/png" | "image/webp";
type OutputContentType = "image/jpeg" | "image/webp";
interface PublicImageInput {
  readonly bytes: Uint8Array;
  readonly declaredContentType: InputContentType;
}
interface PublicImageRendition {
  readonly contentType: OutputContentType;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly checksum: string;
  readonly bytes: Uint8Array;
}
interface ProcessedPublicImage {
  readonly profile: "PUBLIC_IMAGE_V1";
  readonly source: {
    readonly contentType: InputContentType;
    readonly byteSize: number;
    readonly checksum: string;
    readonly width: number;
    readonly height: number;
  };
  readonly renditions: readonly PublicImageRendition[];
}

const maxInputBytes = 10 * 1024 * 1024;
const maxPixels = 25_000_000;
const widths = [320, 640, 1280] as const;
// Private execution limits, not configurable business policy. WebP's maximum
// edge is 16,383 pixels. Reject an unsafe aspect ratio rather than crop or alter
// the required widths. Processing is sequential; RGBA input is at most 100 MB.
const maxOutputEdge = 16_383;
const maxOutputBytes = 10 * 1024 * 1024;
const maxTotalOutputBytes = 30 * 1024 * 1024;
const processingSeconds = 10;
const formats = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" } as const;

class MediaImageProcessingError extends Error {
  readonly code = "MEDIA_IMAGE_PROCESSING_FAILED";
  constructor() {
    super("MEDIA_IMAGE_PROCESSING_FAILED");
    this.name = "MediaImageProcessingError";
  }
}
const fail = (): never => {
  throw new MediaImageProcessingError();
};
const checksum = (bytes: Uint8Array): string =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;

function capture(value: unknown): {
  readonly bytes: Buffer;
  readonly contentType: InputContentType;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2
  )
    return fail();
  const bytesDescriptor = Object.getOwnPropertyDescriptor(value, "bytes");
  const contentDescriptor = Object.getOwnPropertyDescriptor(value, "declaredContentType");
  if (
    !bytesDescriptor?.enumerable ||
    !("value" in bytesDescriptor) ||
    !contentDescriptor?.enumerable ||
    !("value" in contentDescriptor)
  )
    return fail();
  const contentType: unknown = contentDescriptor.value,
    bytes: unknown = bytesDescriptor.value;
  if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp")
    return fail();
  if (
    !ArrayBuffer.isView(bytes) ||
    !(bytes instanceof Uint8Array) ||
    !byteLengthGetter ||
    !byteOffsetGetter ||
    !bufferGetter
  )
    return fail();
  // Intrinsic access avoids caller-defined getters/iterators. Shared buffers can
  // change during a copy, so they cannot provide one immutable source snapshot.
  const length: unknown = byteLengthGetter.call(bytes),
    offset: unknown = byteOffsetGetter.call(bytes),
    buffer: unknown = bufferGetter.call(bytes);
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > maxInputBytes ||
    typeof offset !== "number" ||
    !(buffer instanceof ArrayBuffer)
  )
    return fail();
  const copy = Buffer.alloc(length);
  copy.set(new Uint8Array(buffer, offset, length));
  return { bytes: copy, contentType };
}

function sniff(bytes: Buffer): InputContentType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  )
    return "image/webp";
  return fail();
}
function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > maxPixels
  )
    return fail();
  return { width, height };
}
function outputHeight(
  width: number,
  source: { readonly width: number; readonly height: number },
): number {
  const height = Math.max(1, Math.round((width * source.height) / source.width));
  dimensions(width, height);
  if (width > maxOutputEdge || height > maxOutputEdge) return fail();
  return height;
}

/** Private, byte-only raster processor. No path, URL, Provider access, trust
 * state, or public Media eligibility is accepted or produced. A fresh owned
 * copy is made before the first await. Raw pixels are the metadata boundary:
 * EXIF/GPS/IPTC/XMP/ICC cannot pass into any derivative encoder.
 * Sharp timeouts bound libvips processing, not time waiting in its thread queue.
 */
export async function processPublicImage(input: PublicImageInput): Promise<ProcessedPublicImage> {
  try {
    const { bytes, contentType } = capture(input);
    if (sniff(bytes) !== contentType) return fail();
    const decodeOptions = {
      failOn: "warning",
      limitInputPixels: maxPixels,
      limitInputChannels: 5,
      sequentialRead: true,
      pages: 1,
      page: 0,
      animated: false,
      unlimited: false,
    } as const;
    const metadata = await sharp(bytes, decodeOptions)
      .timeout({ seconds: processingSeconds })
      .metadata();
    if (metadata.format !== formats[contentType]) return fail();
    const source = dimensions(metadata.width, metadata.height);
    const orientation = metadata.orientation ?? 1;
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) return fail();
    const oriented = orientation >= 5 ? { width: source.height, height: source.width } : source;
    for (const width of widths) outputHeight(width, oriented);

    // Header inspection is insufficient: fully decode the selected first frame
    // before any resize. Converting to fresh 8-bit sRGB RGBA also strips all
    // embedded metadata and avoids decoding the untrusted source six times.
    const decoded = await sharp(bytes, { ...decodeOptions, autoOrient: true })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw({ depth: "uchar" })
      .timeout({ seconds: processingSeconds })
      .toBuffer({ resolveWithObject: true });
    const actual = dimensions(decoded.info.width, decoded.info.height);
    if (
      actual.width !== oriented.width ||
      actual.height !== oriented.height ||
      decoded.info.channels !== 4 ||
      decoded.data.byteLength !== actual.width * actual.height * 4
    )
      return fail();

    const renditions: PublicImageRendition[] = [];
    let totalBytes = 0;
    for (const width of widths) {
      const height = outputHeight(width, actual);
      for (const outputType of ["image/jpeg", "image/webp"] as const) {
        const pipeline = sharp(decoded.data, {
          raw: { width: actual.width, height: actual.height, channels: 4 },
          limitInputPixels: maxPixels,
          sequentialRead: true,
        })
          .resize({ width })
          .timeout({ seconds: processingSeconds });
        const encoded = await (
          outputType === "image/jpeg"
            ? pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 80 })
            : pipeline.webp({ quality: 80 })
        ).toBuffer({ resolveWithObject: true });
        dimensions(encoded.info.width, encoded.info.height);
        if (
          encoded.info.format !== formats[outputType] ||
          encoded.info.width !== width ||
          encoded.info.height !== height ||
          encoded.data.byteLength < 1 ||
          encoded.data.byteLength > maxOutputBytes ||
          encoded.info.size !== encoded.data.byteLength
        )
          return fail();
        totalBytes += encoded.data.byteLength;
        if (totalBytes > maxTotalOutputBytes) return fail();
        renditions.push(
          Object.freeze({
            contentType: outputType,
            width,
            height,
            byteSize: encoded.data.byteLength,
            checksum: checksum(encoded.data),
            bytes: encoded.data,
          }),
        );
      }
    }
    return Object.freeze({
      profile: "PUBLIC_IMAGE_V1",
      source: Object.freeze({
        contentType,
        byteSize: bytes.byteLength,
        checksum: checksum(bytes),
        ...source,
      }),
      renditions: Object.freeze(renditions),
    });
  } catch {
    // Never expose decoder text, source bytes, metadata, paths or error causes.
    return fail();
  }
}
