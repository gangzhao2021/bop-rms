import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import helmet from "helmet";

export type DeploymentEnvironment = "development" | "staging" | "production" | "test";

const headerBytesMaximum = 16 * 1024;
const headerFieldsMaximum = 100;
const targetBytesMaximum = 8 * 1024;
const duplicateSensitiveHeaders = new Set(["host", "content-length", "transfer-encoding"]);
const responseNonces = new WeakMap<object, string>();

function reject(
  status: 400 | 414 | 431,
  code: "ambiguous_request" | "request_headers_too_large" | "request_target_too_long",
): RequestHandler {
  return (_request, response) => {
    response.status(status).json({
      error: { code, message: "The request was rejected." },
    });
  };
}

const rejectHeaders = reject(431, "request_headers_too_large");
const rejectTarget = reject(414, "request_target_too_long");
const rejectAmbiguous = reject(400, "ambiguous_request");

export function createHttpRequestLimitMiddleware(): RequestHandler {
  return (request, response, next) => {
    if (Buffer.byteLength(request.originalUrl, "utf8") > targetBytesMaximum) {
      rejectTarget(request, response, next);
      return;
    }
    if (
      /%(?:2f|5c)/iu.test(request.originalUrl) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(request.originalUrl)
    ) {
      rejectAmbiguous(request, response, next);
      return;
    }

    const rawHeaders = request.rawHeaders;
    if (rawHeaders.length / 2 > headerFieldsMaximum) {
      rejectHeaders(request, response, next);
      return;
    }

    let totalBytes = 2;
    const counts = new Map<string, number>();
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index] ?? "";
      const value = rawHeaders[index + 1] ?? "";
      totalBytes += Buffer.byteLength(name, "latin1") + Buffer.byteLength(value, "latin1") + 4;
      const normalized = name.toLowerCase();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }

    if (
      totalBytes > headerBytesMaximum ||
      [...duplicateSensitiveHeaders].some((name) => (counts.get(name) ?? 0) > 1) ||
      ((counts.get("content-length") ?? 0) > 0 && (counts.get("transfer-encoding") ?? 0) > 0)
    ) {
      rejectHeaders(request, response, next);
      return;
    }

    next();
  };
}

export function createHttpSecurityHeadersMiddleware(
  environment: DeploymentEnvironment,
): RequestHandler[] {
  const nonce: RequestHandler = (_request, response, next) => {
    responseNonces.set(response, randomBytes(16).toString("base64"));
    next();
  };
  const headers = helmet({
    contentSecurityPolicy: {
      directives: {
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        defaultSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: [
          "'self'",
          (_request, response) => `'nonce-${responseNonces.get(response) ?? "unavailable"}'`,
        ],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'"],
      },
      reportOnly: environment !== "production",
      useDefaults: false,
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    frameguard: { action: "deny" },
    hsts:
      environment === "production"
        ? { includeSubDomains: true, maxAge: 31_536_000, preload: false }
        : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });
  const permissions: RequestHandler = (_request, response, next) => {
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), usb=(), bluetooth=(), payment=()",
    );
    next();
  };
  return [nonce, headers, permissions];
}

export const httpRequestLimits = {
  headerBytesMaximum,
  headerFieldsMaximum,
  jsonBodyBytesMaximum: 64 * 1024,
  targetBytesMaximum,
} as const;
