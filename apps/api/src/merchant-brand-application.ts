import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RequestHandler } from "express";

export const merchantBrandApplicationRoutes = Object.freeze([
  "/",
  "/app/organization/brands",
  "/app/organization/brands/:brand_reference",
  "/assets/:basename",
]);
const maximumFiles = 256,
  maximumFileBytes = 8 * 1024 * 1024,
  maximumTotalBytes = 32 * 1024 * 1024,
  brandPath =
    /^\/app\/organization\/brands\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  assetName = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:js|css|woff2|png|svg|ico|webp)$/u,
  contentTypes: Readonly<Record<string, string>> = Object.freeze({
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    woff2: "font/woff2",
    png: "image/png",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    webp: "image/webp",
  });
const unavailable = (): never => {
  throw new Error("Merchant application build is unavailable");
};

/** Trusted build files are captured before serving; requests never access disk. */
export async function createMerchantBrandApplication(options: {
  readonly directory: string;
  readonly acceptedHost: string;
}): Promise<RequestHandler> {
  const directory = resolve(options.directory),
    acceptedHost = options.acceptedHost;
  try {
    const authority = new URL(`http://${acceptedHost}`);
    if (
      !acceptedHost ||
      authority.host !== acceptedHost ||
      authority.pathname !== "/" ||
      authority.username ||
      authority.password ||
      authority.search ||
      authority.hash
    )
      return unavailable();
    if ((await realpath(directory)) !== directory) return unavailable();
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return unavailable();
    const entries = await readdir(directory);
    if (entries.length !== 2 || !entries.includes("index.html") || !entries.includes("assets"))
      return unavailable();
    const assetsDirectory = join(directory, "assets"),
      assetsStat = await lstat(assetsDirectory);
    if (
      !assetsStat.isDirectory() ||
      assetsStat.isSymbolicLink() ||
      (await realpath(assetsDirectory)) !== assetsDirectory
    )
      return unavailable();
    const names = await readdir(assetsDirectory);
    if (names.length + 1 > maximumFiles || names.some((name) => !assetName.test(name)))
      return unavailable();
    let totalBytes = 0;
    const capture = async (path: string): Promise<Buffer> => {
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > maximumFileBytes
      )
        return unavailable();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const held = await file.stat();
        if (
          !held.isFile() ||
          held.nlink !== 1 ||
          held.dev !== before.dev ||
          held.ino !== before.ino ||
          held.size !== before.size
        )
          return unavailable();
        const bytes = Buffer.alloc(held.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) return unavailable();
          offset += read.bytesRead;
        }
        const after = await file.stat(),
          named = await lstat(path);
        if (
          after.size !== held.size ||
          after.mtimeMs !== held.mtimeMs ||
          after.ctimeMs !== held.ctimeMs ||
          after.nlink !== 1 ||
          named.dev !== held.dev ||
          named.ino !== held.ino ||
          named.isSymbolicLink()
        )
          return unavailable();
        totalBytes += bytes.length;
        if (totalBytes > maximumTotalBytes) return unavailable();
        return bytes;
      } finally {
        await file.close();
      }
    };
    const html = await capture(join(directory, "index.html"));
    if (html.length === 0) return unavailable();
    const assets = new Map<string, { bytes: Buffer; contentType: string }>();
    for (const name of names) {
      const extension = name.slice(name.lastIndexOf(".") + 1),
        contentType = contentTypes[extension];
      if (!contentType) return unavailable();
      assets.set(`/assets/${name}`, {
        bytes: await capture(join(assetsDirectory, name)),
        contentType,
      });
    }
    const finalRoot = await lstat(directory),
      finalAssets = await lstat(assetsDirectory);
    if (
      finalRoot.dev !== root.dev ||
      finalRoot.ino !== root.ino ||
      finalRoot.mtimeMs !== root.mtimeMs ||
      finalRoot.ctimeMs !== root.ctimeMs ||
      finalAssets.dev !== assetsStat.dev ||
      finalAssets.ino !== assetsStat.ino ||
      finalAssets.mtimeMs !== assetsStat.mtimeMs ||
      finalAssets.ctimeMs !== assetsStat.ctimeMs ||
      (await realpath(directory)) !== directory ||
      (await realpath(assetsDirectory)) !== assetsDirectory
    )
      return unavailable();
    return (request, response, next) => {
      const hosts = request.rawHeaders.filter(
        (_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host",
      );
      if (hosts.length !== 1 || request.headers.host !== acceptedHost) {
        response.status(403).json({ error: "request_denied" });
        return;
      }
      const path = request.originalUrl;
      const queryStart = path.indexOf("?"),
        pathname = queryStart < 0 ? path : path.slice(0, queryStart);
      // Other HTTP owners retain their own query contracts; this is not a SPA fallback.
      if (
        queryStart >= 0 &&
        pathname !== "/" &&
        pathname !== "/app/organization/brands" &&
        !pathname.startsWith("/app/organization/brands/") &&
        !pathname.startsWith("/assets/")
      ) {
        next();
        return;
      }
      if (
        path.length > 2048 ||
        !path.startsWith("/") ||
        path.includes("?") ||
        path.includes("#") ||
        path.includes("%") ||
        path.includes("\\") ||
        path.includes("//") ||
        path.split("/").some((part) => part === "." || part === "..") ||
        Array.from(path).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      ) {
        response.status(400).json({ error: "request_invalid" });
        return;
      }
      const isHtml = path === "/app/organization/brands" || brandPath.test(path),
        asset = assets.get(path);
      if (path !== "/" && !isHtml && !asset) {
        next();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        response.status(405).end();
        return;
      }
      if (path === "/") {
        response.redirect(302, "/app/organization/brands");
        return;
      }
      const bytes = asset?.bytes ?? html;
      response.setHeader("Content-Type", asset?.contentType ?? "text/html; charset=utf-8");
      response.setHeader("Content-Length", bytes.length);
      response.setHeader("Cache-Control", "no-store");
      response.status(200);
      if (request.method === "HEAD") response.end();
      else response.end(bytes);
    };
  } catch {
    return unavailable();
  }
}
