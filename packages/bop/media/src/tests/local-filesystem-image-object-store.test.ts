import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalFilesystemMediaImageObjectStore } from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fresh = async () => {
  const root = await mkdtemp(join(tmpdir(), "bop-media-store-"));
  roots.push(root);
  return root;
};
const named = (bytes: Uint8Array, extension: "jpg" | "webp") =>
  createHash("sha256").update(bytes).digest("hex") + "." + extension;

describe("pilot local filesystem image object store", () => {
  it("creates the directory, writes atomically with public file modes, and reads back", async () => {
    const directory = join(await fresh(), "media", "product-images");
    const store = createLocalFilesystemMediaImageObjectStore({ directory });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const name = named(bytes, "jpg");
    expect(await store.read(name)).toBeNull();
    await store.put({ name, contentType: "image/jpeg", bytes });
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(join(directory, name))).mode & 0o777).toBe(0o644);
    expect(await readdir(directory)).toEqual([name]);
    const read = await store.read(name);
    expect(read?.contentType).toBe("image/jpeg");
    expect([...(read?.bytes ?? [])]).toEqual([1, 2, 3, 4]);

    const webp = new Uint8Array([9, 9]);
    const webpName = named(webp, "webp");
    await store.put({ name: webpName, contentType: "image/webp", bytes: webp });
    expect((await store.read(webpName))?.contentType).toBe("image/webp");
  });

  it("is idempotent and skips an existing file of the same size", async () => {
    const directory = await fresh();
    const store = createLocalFilesystemMediaImageObjectStore({ directory });
    const bytes = new Uint8Array([5, 6, 7]);
    const name = named(bytes, "jpg");
    await store.put({ name, contentType: "image/jpeg", bytes });
    const before = (await stat(join(directory, name))).mtimeMs;
    await store.put({ name, contentType: "image/jpeg", bytes });
    expect((await stat(join(directory, name))).mtimeMs).toBe(before);
    // A truncated leftover is replaced.
    await writeFile(join(directory, name), new Uint8Array([5]));
    await store.put({ name, contentType: "image/jpeg", bytes });
    expect([...(await readFile(join(directory, name)))]).toEqual([5, 6, 7]);
    expect(await readdir(directory)).toEqual([name]);
  });

  it("refuses names that are not content addressed and bytes that do not match the name", async () => {
    const directory = await fresh();
    const store = createLocalFilesystemMediaImageObjectStore({ directory });
    const bytes = new Uint8Array([1, 2, 3]);
    const name = named(bytes, "jpg");
    for (const bad of [
      "../" + name,
      name.toUpperCase(),
      name.replace(".jpg", ".png"),
      name + "/x",
      "a".repeat(64) + ".jpg/../x",
      "",
    ]) {
      await expect(store.put({ name: bad, contentType: "image/jpeg", bytes })).rejects.toThrow(
        "MEDIA_IMAGE_OBJECT_STORE_REFUSED",
      );
      await expect(store.read(bad)).rejects.toThrow("MEDIA_IMAGE_OBJECT_STORE_REFUSED");
    }
    await expect(
      store.put({ name, contentType: "image/jpeg", bytes: new Uint8Array([1, 2, 4]) }),
    ).rejects.toThrow("MEDIA_IMAGE_OBJECT_STORE_REFUSED");
    await expect(store.put({ name, contentType: "image/webp", bytes })).rejects.toThrow(
      "MEDIA_IMAGE_OBJECT_STORE_REFUSED",
    );
    expect(await readdir(directory)).toEqual([]);
    expect(() => createLocalFilesystemMediaImageObjectStore({ directory: "relative" })).toThrow();
  });
});
