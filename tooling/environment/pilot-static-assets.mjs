import { stat, readFile } from "node:fs/promises";
import { URL } from "node:url";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip } from "node:zlib";

const brotli = promisify(brotliCompress),
  gzipAsync = promisify(gzip);

/** Vite's content-hashed build output: a new deploy gives changed files a new name. */
const hashedAsset = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/u;
const compressible = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest"]);
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Picks the smallest encoding the browser accepts (q=0 refuses one). */
export function preferredEncoding(acceptEncoding) {
  const accepted = new Map();
  for (const part of String(acceptEncoding ?? "").split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (name === "") continue;
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    accepted.set(name, q === undefined ? 1 : Number(q.slice(2)));
  }
  const allows = (name) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  if (allows("br")) return "br";
  if (allows("gzip")) return "gzip";
  return null;
}

/**
 * WP-2423 (v15 run): serves a built app (merchant-web or customer-pwa dist) for the pilot HTTPS
 * entry. Content-hashed files under /assets are cached for a year (a deploy changes their names);
 * every other file (index.html, service worker, manifest, icons) is revalidated on each use so a
 * deploy is picked up. Text files are sent brotli or gzip compressed, compressed once per file
 * version and kept in memory.
 */
export function createPilotStaticAssets(root) {
  const base = resolve(root);
  const compressed = new Map();
  const compress = (file, version, body, encoding) => {
    const key = file + "\0" + version + "\0" + encoding;
    let pending = compressed.get(key);
    if (pending === undefined) {
      pending =
        encoding === "br"
          ? brotli(body, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
              },
            })
          : gzipAsync(body, { level: 9 });
      // Drop older versions of the same file left by an in-place rebuild.
      for (const existing of compressed.keys())
        if (existing.startsWith(file + "\0") && !existing.startsWith(file + "\0" + version + "\0"))
          compressed.delete(existing);
      compressed.set(key, pending);
      pending.catch(() => compressed.delete(key));
    }
    return pending;
  };
  return async function pilotStaticAssets(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, "http://local").pathname);
    } catch {
      return next();
    }
    if (path.includes("\0") || path.split("/").some((segment) => segment.startsWith(".")))
      return next();
    const file = resolve(base, "." + path);
    if (!file.startsWith(base + sep)) return next();
    let info;
    try {
      info = await stat(file);
    } catch {
      return next();
    }
    if (!info.isFile()) return next();
    try {
      const version = info.size + "-" + Math.trunc(info.mtimeMs);
      const extension = extname(file).toLowerCase();
      res.type(extension === ".webmanifest" ? "application/manifest+json" : extension);
      res.setHeader("Cache-Control", hashedAsset.test(path) ? IMMUTABLE_CACHE : "no-cache");
      res.setHeader("ETag", 'W/"' + version + '"');
      res.setHeader("Last-Modified", info.mtime.toUTCString());
      const encoding = compressible.has(extension)
        ? preferredEncoding(req.headers["accept-encoding"])
        : null;
      if (compressible.has(extension)) res.setHeader("Vary", "Accept-Encoding");
      if (req.fresh) return res.status(304).end();
      const raw = await readFile(file);
      const body =
        encoding === null || raw.length < 1024 ? raw : await compress(file, version, raw, encoding);
      if (body !== raw) res.setHeader("Content-Encoding", encoding);
      res.setHeader("Content-Length", String(body.length));
      return req.method === "HEAD" ? res.end() : res.end(body);
    } catch (error) {
      return next(error);
    }
  };
}

/** A missing build file is a 404, never the app page (a script must not receive HTML). */
export function missingPilotAsset(_req, res) {
  res.status(404).set("Cache-Control", "no-store").end();
}

/**
 * WP-2423 Q30: the public menu answer is the largest thing a guest downloads after the app (about
 * 100 KB of JSON for a small menu) and was sent uncompressed through the pilot entry. Only public
 * reads (`/api/v1/public/`, no tokens, no personal data, so compression cannot leak a secret next
 * to reflected input) of a JSON body the API sent without an encoding are compressed, on the fly.
 * Returns the encoding to use, or null to pass the answer through unchanged.
 */
export function publicApiEncoding(path, method, upstream, acceptEncoding) {
  if (method !== "GET" || !String(path).startsWith("/api/v1/public/")) return null;
  const headers = upstream.headers ?? {};
  if (upstream.statusCode !== 200 || headers["content-encoding"] !== undefined) return null;
  if (!/^application\/json\b/iu.test(String(headers["content-type"] ?? ""))) return null;
  const length = Number(headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(length) && length < 1024) return null;
  return preferredEncoding(acceptEncoding);
}

/** The upstream headers for a body re-sent with `encoding` (length unknown until it is sent). */
export function encodedHeaders(headers, encoding) {
  const next = { ...headers };
  delete next["content-length"];
  next["content-encoding"] = encoding;
  const vary = String(next.vary ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (!vary.some((part) => part.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
  next.vary = vary.join(", ");
  return next;
}

/** A streaming compressor for `encoding`, tuned for answers built per request. */
export function createResponseCompressor(encoding) {
  return encoding === "br"
    ? createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: 5,
        },
      })
    : createGzip({ level: 6 });
}
