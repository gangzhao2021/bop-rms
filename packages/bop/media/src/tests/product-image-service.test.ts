import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createProductImageService,
  loadProductImages,
  MediaContractError,
  MediaProductImageError,
  productImagePathPattern,
  type MediaImageObjectStore,
  type MediaPersistenceTransaction,
  type PreparedProductImage,
} from "../index.js";

const id = (n: number) => "01902473-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tenant = id(1),
  brand = id(2),
  otherBrand = id(3),
  product = id(4),
  actor = id(5);
const createdAt = "2026-10-17T12:00:00.000Z";

function memoryObjectStore(options: { failPut?: boolean } = {}) {
  const objects = new Map<string, { contentType: string; bytes: Uint8Array }>();
  const store: MediaImageObjectStore = {
    async put(object) {
      if (options.failPut) throw new Error("disk full at /var/secret/path");
      objects.set(object.name, { contentType: object.contentType, bytes: object.bytes });
    },
    async read(name) {
      const found = objects.get(name);
      return found ? { contentType: found.contentType as "image/jpeg", bytes: found.bytes } : null;
    },
  };
  return { store, objects };
}

/** Fake transaction with Brand-scoped visibility like the RLS policy (rows of the current
 * `bop.brand_id` only, never with a Store scope). */
function fakeDatabase() {
  const rows: Record<string, unknown>[] = [];
  const statements: string[] = [];
  let currentBrand = "",
    currentStore = "unset";
  const tx: MediaPersistenceTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("set_config")) {
        currentBrand = String(values[0]);
        currentStore = sql.includes("'bop.store_id',''") ? "" : "unset";
        return { rows: [] as Row[], rowCount: 1 };
      }
      const visible = rows.filter((row) => row.brand_id === currentBrand && currentStore === "");
      if (sql.startsWith("SELECT")) {
        const references = values[1] as string[];
        return {
          rows: visible.filter(
            (row) => row.brand_id === values[0] && references.includes(String(row.image_id)),
          ) as Row[],
          rowCount: null,
        };
      }
      if (sql.startsWith("INSERT")) {
        if (values[2] !== currentBrand || currentStore !== "")
          throw new Error("row level security");
        if (rows.some((row) => row.image_id === values[0])) throw new Error("duplicate key");
        rows.push({
          image_id: values[0],
          tenant_id: values[1],
          brand_id: values[2],
          product_id: values[3],
          storage_profile: "PilotLocalFilesystemV1",
          data_classification: "Public",
          source_content_type: values[4],
          source_byte_size: values[5],
          width: values[6],
          height: values[7],
          renditions_json: JSON.parse(String(values[8])),
          created_by_actor_id: values[9],
          created_at: values[10],
        });
        return { rows: [] as Row[], rowCount: 1 };
      }
      throw new Error("unexpected statement");
    },
  };
  return { tx, rows, statements };
}

const image = (
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp",
  orientation?: number,
) => {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 90, b: 40 } },
  });
  const encoded = format === "jpeg" ? base.jpeg() : format === "png" ? base.png() : base.webp();
  return (
    orientation === undefined
      ? encoded
      : encoded.withMetadata({ orientation }).withExif({
          IFD0: { Make: "Test camera" },
          IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 39/1 0/1" },
        })
  ).toBuffer();
};
const ingestInput = (bytes: Uint8Array, declaredContentType: string, imageReference = id(10)) => ({
  imageReference,
  tenantReference: tenant,
  brandReference: brand,
  productReference: product,
  actorReference: actor,
  declaredContentType,
  bytes,
  createdAt,
});
async function failure(work: Promise<unknown>): Promise<MediaProductImageError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(MediaProductImageError);
    expect((error as Error).message).toBe((error as MediaProductImageError).code);
    return error as MediaProductImageError;
  }
  throw new Error("expected a failure");
}

describe("product image service", () => {
  it("strips EXIF/GPS, stores six content-addressed renditions before recording, and is idempotent", async () => {
    const source = await image(800, 600, "jpeg", 1);
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const { store, objects } = memoryObjectStore();
    const database = fakeDatabase();
    const service = createProductImageService({ objectStore: store });
    const record = await service.ingest(database.tx, ingestInput(source, "image/jpeg"));

    expect(record).toMatchObject({
      imageReference: id(10),
      brandReference: brand,
      productReference: product,
      width: 1280,
      height: 960,
      createdAt,
      createdByActorReference: actor,
    });
    expect(record.renditions.map((r) => [r.width, r.contentType, r.height])).toEqual([
      [320, "image/jpeg", 240],
      [320, "image/webp", 240],
      [640, "image/jpeg", 480],
      [640, "image/webp", 480],
      [1280, "image/jpeg", 960],
      [1280, "image/webp", 960],
    ]);
    expect(objects.size).toBe(6);
    for (const rendition of record.renditions) {
      expect(rendition.path).toMatch(productImagePathPattern);
      const name = rendition.path.slice("/media/images/".length);
      const stored = await store.read(name);
      if (!stored) throw new Error("rendition not stored");
      expect(stored.bytes.byteLength).toBe(rendition.byteSize);
      expect(createHash("sha256").update(stored.bytes).digest("hex")).toBe(name.slice(0, 64));
      const metadata = await sharp(stored.bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.width).toBe(rendition.width);
    }
    expect(database.rows).toHaveLength(1);
    expect(database.rows[0]).not.toHaveProperty("checksum");
    expect(JSON.stringify(database.rows[0])).not.toContain("sha256:");

    const again = await service.ingest(database.tx, ingestInput(source, "image/jpeg"));
    expect(again).toEqual(record);
    expect(database.rows).toHaveLength(1);

    const loaded = await service.load(database.tx, {
      brandReference: brand,
      imageReferences: [id(10), id(10), id(99)],
    });
    expect([...loaded.keys()]).toEqual([id(10)]);
    expect(loaded.get(id(10))).toEqual(record);
    expect(
      (
        await loadProductImages(database.tx, {
          brandReference: otherBrand,
          imageReferences: [id(10)],
        })
      ).size,
    ).toBe(0);
    expect(
      (await loadProductImages(database.tx, { brandReference: brand, imageReferences: [] })).size,
    ).toBe(0);
  });

  it("prepares outside the transaction and records inside it; conflicting reuse is refused", async () => {
    const { store, objects } = memoryObjectStore();
    const database = fakeDatabase();
    const service = createProductImageService({ objectStore: store });
    const prepared = await service.prepare({
      declaredContentType: "image/png",
      bytes: await image(1000, 500, "png"),
    });
    expect(database.statements).toHaveLength(0);
    expect(objects.size).toBe(6);
    expect(prepared).toMatchObject({ width: 1280, height: 640, sourceContentType: "image/png" });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain("bytes");

    const recordInput = {
      imageReference: id(20),
      tenantReference: tenant,
      brandReference: brand,
      productReference: product,
      actorReference: actor,
      createdAt,
      prepared,
    };
    const record = await service.record(database.tx, recordInput);
    expect(await service.record(database.tx, recordInput)).toEqual(record);
    expect(database.rows).toHaveLength(1);
    expect(
      (await failure(service.record(database.tx, { ...recordInput, productReference: id(21) })))
        .code,
    ).toBe("MEDIA_IMAGE_NOT_FOUND");
    await expect(
      service.record(database.tx, {
        ...recordInput,
        imageReference: id(22),
        prepared: { ...prepared } as PreparedProductImage,
      }),
    ).rejects.toBeInstanceOf(MediaContractError);
    // Another Brand cannot reuse the reference: the insert fails (key exists, invisible row).
    expect(
      (await failure(service.record(database.tx, { ...recordInput, brandReference: otherBrand })))
        .code,
    ).toBe("MEDIA_IMAGE_STORAGE_UNAVAILABLE");
  });

  it("accepts WebP and uses the EXIF-oriented dimensions", async () => {
    const service = createProductImageService({ objectStore: memoryObjectStore().store });
    const webp = await service.prepare({
      declaredContentType: "image/webp",
      bytes: await image(900, 600, "webp"),
    });
    expect([webp.width, webp.height]).toEqual([1280, 853]);
    // Stored 1200x600 rotated 90 degrees: shown 600x1200 (portrait).
    const rotated = await service.prepare({
      declaredContentType: "image/jpeg",
      bytes: await image(1200, 600, "jpeg", 6),
    });
    expect([rotated.width, rotated.height]).toEqual([1280, 2560]);
    // Stored 1400x470 rotated: shorter edge 470.
    expect(
      (
        await failure(
          service.prepare({
            declaredContentType: "image/jpeg",
            bytes: await image(1400, 470, "jpeg", 6),
          }),
        )
      ).code,
    ).toBe("MEDIA_IMAGE_TOO_SMALL");
  });

  it("maps every rejected upload to a plain code and stores nothing", async () => {
    const { store, objects } = memoryObjectStore();
    const service = createProductImageService({ objectStore: store });
    const code = async (declaredContentType: string, bytes: Uint8Array) =>
      (await failure(service.prepare({ declaredContentType, bytes }))).code;
    const png = await image(800, 600, "png");
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><script>alert(1)</script></svg>',
    );
    expect(await code("image/svg+xml", svg)).toBe("MEDIA_IMAGE_TYPE_UNSUPPORTED");
    expect(await code("image/gif", png)).toBe("MEDIA_IMAGE_TYPE_UNSUPPORTED");
    expect(await code("image/jpeg", svg)).toBe("MEDIA_IMAGE_UNREADABLE");
    expect(await code("image/jpeg", png)).toBe("MEDIA_IMAGE_UNREADABLE");
    const polyglot = new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode("<html>")]);
    expect(await code("image/jpeg", polyglot)).toBe("MEDIA_IMAGE_UNREADABLE");
    expect(await code("image/png", new Uint8Array())).toBe("MEDIA_IMAGE_UNREADABLE");
    expect(await code("image/jpeg", await image(400, 300, "jpeg"))).toBe("MEDIA_IMAGE_TOO_SMALL");
    expect(await code("image/png", await image(2000, 500, "png"))).toBe("MEDIA_IMAGE_UNREADABLE");
    expect(await code("image/jpeg", new Uint8Array(10 * 1024 * 1024 + 1))).toBe(
      "MEDIA_IMAGE_TOO_LARGE",
    );
    expect(objects.size).toBe(0);
  });

  it("reports storage failure without detail and never records a row", async () => {
    const database = fakeDatabase();
    const service = createProductImageService({
      objectStore: memoryObjectStore({ failPut: true }).store,
    });
    const error = await failure(
      service.ingest(database.tx, ingestInput(await image(800, 600, "jpeg"), "image/jpeg")),
    );
    expect(error.code).toBe("MEDIA_IMAGE_STORAGE_UNAVAILABLE");
    expect(error.message).not.toContain("/var");
    expect(database.rows).toHaveLength(0);
    expect(database.statements.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });
});
