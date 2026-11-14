import express, { type Request, type Response, type Router } from "express";
import {
  BrowserSessionError,
  parseRawBrowserCredential,
  platformSessionCookie,
} from "@bop/identity";
import { PlatformPermissionError } from "@bop/permission";
import { PublishingContractError } from "@bop/publishing";
import { PlatformBrandTemplateError } from "@bop/tenant";
import {
  parsePlatformTemplateAdministrationQuery,
  parsePlatformTemplateAdministrationCommand,
  type PlatformTemplateAdministration,
} from "./platform-template-administration.js";

export interface PlatformTemplateAdministrationHttpOptions {
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly administration: Pick<PlatformTemplateAdministration, "query" | "command">;
}
export const platformTemplateAdministrationRoutes = Object.freeze([
  "/platform/templates/query",
  "/platform/templates/command",
]);
class InvalidRequest extends Error {}
const unavailable = (): never => {
  throw new Error("PLATFORM_TEMPLATE_ADMINISTRATION_UNAVAILABLE");
};
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
function rawHeaders(request: Request, name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) result.push(request.rawHeaders[i + 1] ?? "");
  return result;
}
function header(request: Request, name: string): string | null {
  const values = rawHeaders(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}
function sessionCookie(request: Request) {
  const value = header(request, "cookie");
  if (!value || value.length > 4096) return denied();
  const prefix = `${platformSessionCookie.name}=`;
  const matches = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (matches.length !== 1) return denied();
  return parseRawBrowserCredential(matches[0]?.slice(prefix.length));
}
function failure(response: Response, error: unknown) {
  const code =
    error instanceof PlatformBrandTemplateError || error instanceof PlatformPermissionError
      ? error.code
      : null;
  const status =
    error instanceof BrowserSessionError ||
    code === "PLATFORM_TEMPLATE_PERMISSION_DENIED" ||
    code === "PLATFORM_PERMISSION_DENIED"
      ? 403
      : error instanceof InvalidRequest ||
          error instanceof PublishingContractError ||
          code === "PLATFORM_TEMPLATE_INPUT_INVALID" ||
          code === "PLATFORM_PERMISSION_INPUT_INVALID"
        ? 400
        : code === "PLATFORM_TEMPLATE_VERSION_CONFLICT" ||
            code === "PLATFORM_TEMPLATE_INTENT_CONFLICT" ||
            code === "PLATFORM_PERMISSION_VERSION_CONFLICT" ||
            code === "PLATFORM_PERMISSION_INTENT_CONFLICT"
          ? 409
          : 503;
  response.status(status).json({
    error:
      status === 403
        ? "request_denied"
        : status === 400
          ? "request_invalid"
          : status === 409
            ? "request_conflict"
            : "platform_template_administration_unavailable",
  });
}
function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new InvalidRequest();
  }
}

/** Mounted only at /platform/templates. Queries also require current Session
 * CSRF admission. Actor, scope and authority are supplied by the composition. */
export function createPlatformTemplateAdministrationRouter(
  options: PlatformTemplateAdministrationHttpOptions,
): Router {
  const origin = new URL(options.exactOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.exactOrigin ||
    origin.host !== options.acceptedHost
  )
    return unavailable();
  const administration = options.administration,
    query = administration.query,
    command = administration.command,
    exactOrigin = options.exactOrigin,
    acceptedHost = options.acceptedHost;
  if (typeof query !== "function" || typeof command !== "function") return unavailable();
  const check = () => {
    if (
      options.administration !== administration ||
      administration.query !== query ||
      administration.command !== command ||
      options.exactOrigin !== exactOrigin ||
      options.acceptedHost !== acceptedHost
    )
      return unavailable();
  };
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use((request, response, next) => {
    if (
      request.baseUrl !== "/platform/templates" ||
      (request.path !== "/query" && request.path !== "/command")
    ) {
      next("router");
      return;
    }
    response.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    try {
      check();
      if (
        header(request, "host") !== acceptedHost ||
        header(request, "origin") !== exactOrigin ||
        header(request, "sec-fetch-site") !== "same-origin" ||
        [
          "cookie",
          "x-bop-csrf",
          "content-type",
          "content-length",
          "transfer-encoding",
          "content-encoding",
          "sec-fetch-mode",
          "sec-fetch-dest",
        ].some((name) => rawHeaders(request, name).length > 1) ||
        (header(request, "sec-fetch-mode") !== null &&
          !["cors", "same-origin"].includes(header(request, "sec-fetch-mode") ?? "")) ||
        (header(request, "sec-fetch-dest") !== null &&
          header(request, "sec-fetch-dest") !== "empty")
      )
        return denied();
      if (request.method !== "POST") {
        response.set("Allow", "POST").status(405).json({ error: "request_invalid" });
        return;
      }
      if (
        request.url !== request.path ||
        request.originalUrl.length > 1024 ||
        !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
          header(request, "content-type") ?? "",
        ) ||
        header(request, "content-encoding") !== null
      )
        throw new InvalidRequest();
      next();
    } catch (error) {
      failure(response, error);
    }
  });
  router.use(express.json({ limit: "32kb", strict: true, inflate: false }));
  for (const mode of ["query", "command"] as const)
    router.post(`/${mode}`, async (request, response) => {
      try {
        const credential = sessionCookie(request),
          csrf = parseRawBrowserCredential(header(request, "x-bop-csrf"));
        const result =
          mode === "query"
            ? await query.call(administration, {
                sessionCookie: credential,
                csrf,
                request: parsed(parsePlatformTemplateAdministrationQuery, request.body),
              })
            : await command.call(administration, {
                sessionCookie: credential,
                csrf,
                request: parsed(parsePlatformTemplateAdministrationCommand, request.body),
              });
        check();
        response.json(result);
      } catch (error) {
        failure(response, error);
      }
    });
  router.use(
    (error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
      void next;
      const large =
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large";
      response.status(large ? 413 : 400).json({ error: "request_invalid" });
    },
  );
  return router;
}
