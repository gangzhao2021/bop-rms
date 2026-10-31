import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, expect, it } from "vitest";
import { createMerchantBrandApplication } from "./merchant-brand-application.js";

const directories: string[] = [],
  servers: ReturnType<typeof createServer>[] = [],
  acceptedHost = "brand.example.test",
  html = "<!doctype html><title>Synthetic Brand administration</title>",
  detail = "/app/organization/brands/01902421-1013-7000-8000-000000000001";
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function build() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bop-merchant-build-")));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), html);
  await writeFile(
    join(directory, "assets", "index-synthetic.js"),
    "export const synthetic = true;",
  );
  await writeFile(join(directory, "assets", "index-synthetic.css"), "body { color: black; }");
  await writeFile(join(directory, "assets", "font-synthetic.woff2"), Buffer.from([1, 2, 3]));
  return directory;
}
async function serve(directory: string) {
  const app = express();
  app.use(await createMerchantBrandApplication({ directory, acceptedHost }));
  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic HTTP address");
  return (path: string, method = "GET", host = acceptedHost, duplicateHost = false) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method,
            headers: duplicateHost ? ["Host", host, "Host", host] : { Host: host },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
}
it("serves only canonical Brand HTML and finite captured public assets with exact HEAD semantics", async () => {
  const read = await serve(await build());
  for (const path of ["/app/organization/brands", detail]) {
    const response = await read(path);
    expect(response.status).toBe(200);
    expect(response.body).toBe(html);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    const head = await read(path, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(html)));
  }
  const root = await read("/");
  expect(root.status).toBe(302);
  expect(root.headers.location).toBe("/app/organization/brands");
  expect((await read("/assets/index-synthetic.js")).headers["content-type"]).toBe(
    "text/javascript; charset=utf-8",
  );
  expect((await read("/assets/index-synthetic.css")).headers["content-type"]).toBe(
    "text/css; charset=utf-8",
  );
  const font = await read("/assets/font-synthetic.woff2", "HEAD");
  expect(font.headers["content-type"]).toBe("font/woff2");
  expect(font.headers["content-length"]).toBe("3");
  expect(font.body).toBe("");
  expect((await read(detail, "POST")).status).toBe(405);
});
it("does not expose arbitrary SPA routes, private paths, unknown assets or malformed Brand identities", async () => {
  const read = await serve(await build());
  for (const path of [
    "/app/orders",
    "/app/organization/brands/create",
    "/index.html",
    "/package.json",
    "/.env",
    "/assets/missing.js",
    "/assets/index-synthetic.js.map",
  ])
    expect((await read(path)).status).toBe(404);
  expect((await read("/other-owner?filter=synthetic")).status).toBe(404);
});
it("rejects foreign or repeated Host and noncanonical query, encoding and traversal without echo", async () => {
  const read = await serve(await build());
  expect((await read(detail, "GET", "foreign.example.test")).status).toBe(403);
  expect((await read(detail, "GET", acceptedHost, true)).status).toBe(403);
  for (const path of [
    "/app/organization/brands?brand=synthetic",
    "/assets/%69ndex-synthetic.js",
    "/assets/%",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/assets//index-synthetic.js",
    "/assets\\index-synthetic.js",
    `/${"a".repeat(2048)}`,
  ]) {
    const response = await read(path);
    expect(response.status).toBe(400);
    expect(response.body).toBe('{"error":"request_invalid"}');
  }
});
it("keeps immutable startup bytes after build files are replaced or removed", async () => {
  const directory = await build(),
    read = await serve(directory);
  await writeFile(join(directory, "index.html"), "Changed synthetic build");
  await rm(join(directory, "assets"), { recursive: true });
  expect((await read(detail)).body).toBe(html);
  expect((await read("/assets/index-synthetic.js")).body).toBe("export const synthetic = true;");
});
it("refuses missing, private, map, directory, symlink and hardlinked preload entries", async () => {
  for (const kind of [
    "missing",
    "private",
    "map",
    "directory",
    "symlink",
    "hardlink",
    "assets-symlink",
  ] as const) {
    const directory = await build(),
      assets = join(directory, "assets");
    if (kind === "missing") await rm(join(directory, "index.html"));
    if (kind === "private") await writeFile(join(assets, ".env"), "synthetic private sentinel");
    if (kind === "map") await writeFile(join(assets, "index.js.map"), "{}");
    if (kind === "directory") await mkdir(join(assets, "nested.js"));
    if (kind === "symlink") await symlink(join(directory, "index.html"), join(assets, "linked.js"));
    if (kind === "hardlink") await link(join(directory, "index.html"), join(assets, "linked.js"));
    if (kind === "assets-symlink") {
      await rm(assets, { recursive: true });
      await symlink(directory, assets);
    }
    await expect(createMerchantBrandApplication({ directory, acceptedHost })).rejects.toThrow(
      "Merchant application build is unavailable",
    );
  }
});
it("refuses noncanonical build roots, unsafe configured Host and finite preload limit overflow", async () => {
  const directory = await build();
  for (const host of [
    "",
    "https://brand.example.test",
    "brand.example.test/path",
    "operator@brand.example.test",
    "brand.example.test?token=synthetic",
  ])
    await expect(createMerchantBrandApplication({ directory, acceptedHost: host })).rejects.toThrow(
      "Merchant application build is unavailable",
    );
  const linkedRoot = join(directory, "root-link");
  await symlink(directory, linkedRoot);
  await expect(
    createMerchantBrandApplication({ directory: linkedRoot, acceptedHost }),
  ).rejects.toThrow("Merchant application build is unavailable");
  const oversized = await build();
  await truncate(join(oversized, "assets", "index-synthetic.js"), 8 * 1024 * 1024 + 1);
  await expect(
    createMerchantBrandApplication({ directory: oversized, acceptedHost }),
  ).rejects.toThrow("Merchant application build is unavailable");
  const many = await build();
  await Promise.all(
    Array.from({ length: 253 }, (_unused, index) =>
      writeFile(join(many, "assets", `extra-${index}.js`), ""),
    ),
  );
  await expect(createMerchantBrandApplication({ directory: many, acceptedHost })).rejects.toThrow(
    "Merchant application build is unavailable",
  );
  const total = await build();
  for (let index = 0; index < 5; index++) {
    const file = join(total, "assets", `large-${index}.js`);
    await writeFile(file, "");
    await truncate(file, 8 * 1024 * 1024);
  }
  await expect(createMerchantBrandApplication({ directory: total, acceptedHost })).rejects.toThrow(
    "Merchant application build is unavailable",
  );
});
