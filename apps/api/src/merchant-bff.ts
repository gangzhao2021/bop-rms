import type {
  AuthenticationSession,
  BrowserCookieMutation,
  RawBrowserCredential,
} from "@bop/identity";
import express, { type Request, type RequestHandler, type Router } from "express";

export interface MerchantWorkspaceSnapshot {
  readonly screenId: "HOME-OVERVIEW";
  readonly selectedScope: {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
  };
  readonly authorizedStores: readonly {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
  }[];
  readonly businessDate: string;
  readonly storeStatus: "Open" | "Closed" | "Paused" | "Unavailable";
  readonly freshness: "Current" | "Stale";
  readonly dashboardAvailability: "UnavailableUntilWP1905";
}

export interface MerchantBffService {
  start(postLoginPath: unknown): Promise<{
    readonly authorizationUrl: string;
    readonly cookie: BrowserCookieMutation;
  }>;
  callback(input: {
    readonly code: unknown;
    readonly state: unknown;
    readonly authCookie: unknown;
  }): Promise<{
    readonly postLoginPath: string;
    readonly session: AuthenticationSession;
    readonly cookies: readonly BrowserCookieMutation[];
  }>;
  bootstrap(sessionCookie: unknown): Promise<{
    readonly session: AuthenticationSession;
    readonly csrf: RawBrowserCredential;
    readonly workspace: unknown;
  }>;
  authorize(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }): Promise<AuthenticationSession>;
  logout(sessionCookie: unknown): Promise<BrowserCookieMutation>;
  switchStore(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly targetStoreReference: unknown;
  }): Promise<{ readonly cookie: BrowserCookieMutation; readonly workspace: unknown }>;
}

export interface MerchantBffRouterOptions {
  readonly service: MerchantBffService;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
}

const NO_STORE = "no-store";

function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function cookie(request: Request, name: string): string | null {
  const headers = rawHeaderValues(request, "cookie");
  const header = headers[0];
  if (headers.length !== 1 || header === undefined || header.length > 4096) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match === undefined) return null;
  const value = match.slice(name.length + 1);
  return value && !/[\s;,]/u.test(value) ? value : null;
}

function serializeCookie(mutation: BrowserCookieMutation): string {
  const { descriptor } = mutation;
  const parts = [
    `${descriptor.name}=${mutation.value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mutation.clear) parts.push("Max-Age=0");
  else if (descriptor.maxAgeSeconds !== null) parts.push(`Max-Age=${descriptor.maxAgeSeconds}`);
  return parts.join("; ");
}

function exactHeader(request: Request, name: string): string | null {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function trustedHost(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (exactHeader(request, "host") !== options.acceptedHost) {
      response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
      return;
    }
    next();
  };
}

function safeRead(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      (fetchSite !== "same-origin" && fetchSite !== "none")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

function oidcCallbackNavigation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      !["same-origin", "cross-site", "none"].includes(fetchSite ?? "")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

function sameOriginMutation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (
      exactHeader(request, "origin") !== options.exactOrigin ||
      exactHeader(request, "sec-fetch-site") !== "same-origin"
    ) {
      denied(response);
      return;
    }
    next();
  };
}

const workspaceKeys = [
  "screenId",
  "selectedScope",
  "authorizedStores",
  "businessDate",
  "storeStatus",
  "freshness",
  "dashboardAvailability",
] as const;
const scopeKeys = ["brandLabel", "storeLabel", "storeReference"] as const;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeLabel = /^[^\p{Cc}\p{Cf}]{1,100}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function targetStoreReference(value: unknown): unknown {
  return closed(value, ["targetStoreReference"]).targetStoreReference;
}

function scope(value: unknown) {
  const input = closed(value, scopeKeys);
  if (
    typeof input.brandLabel !== "string" ||
    !safeLabel.test(input.brandLabel) ||
    typeof input.storeLabel !== "string" ||
    !safeLabel.test(input.storeLabel) ||
    typeof input.storeReference !== "string" ||
    !uuidV7.test(input.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    brandLabel: input.brandLabel,
    storeLabel: input.storeLabel,
    storeReference: input.storeReference,
  });
}

export function parseMerchantWorkspaceSnapshot(value: unknown): MerchantWorkspaceSnapshot {
  const input = closed(value, workspaceKeys);
  const parsedBusinessDate =
    typeof input.businessDate === "string"
      ? Date.parse(`${input.businessDate}T00:00:00.000Z`)
      : Number.NaN;
  if (
    input.screenId !== "HOME-OVERVIEW" ||
    !Array.isArray(input.authorizedStores) ||
    input.authorizedStores.length < 1 ||
    input.authorizedStores.length > 100 ||
    typeof input.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isFinite(parsedBusinessDate) ||
    new Date(parsedBusinessDate).toISOString().slice(0, 10) !== input.businessDate ||
    !["Open", "Closed", "Paused", "Unavailable"].includes(String(input.storeStatus)) ||
    (input.freshness !== "Current" && input.freshness !== "Stale") ||
    input.dashboardAvailability !== "UnavailableUntilWP1905"
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const selectedScope = scope(input.selectedScope);
  const authorizedStores = Object.freeze(input.authorizedStores.map(scope));
  if (
    new Set(authorizedStores.map((item) => item.storeReference)).size !== authorizedStores.length ||
    !authorizedStores.some((item) => item.storeReference === selectedScope.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId: "HOME-OVERVIEW",
    selectedScope,
    authorizedStores,
    businessDate: input.businessDate,
    storeStatus: input.storeStatus as MerchantWorkspaceSnapshot["storeStatus"],
    freshness: input.freshness,
    dashboardAvailability: "UnavailableUntilWP1905",
  });
}

function denied(response: express.Response): void {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}

export function createMerchantBffRouter(options: MerchantBffRouterOptions): Router {
  const router = express.Router();
  router.use(express.json({ limit: "8kb", strict: true }));
  router.use(trustedHost(options));
  router.use((_request, response, next) => {
    response.set("Cache-Control", NO_STORE);
    next();
  });

  router.get("/login", safeRead(options), (request, response) => {
    void options.service
      .start(request.query.returnTo ?? "/")
      .then((result) => {
        response.set("Set-Cookie", serializeCookie(result.cookie));
        response.redirect(303, result.authorizationUrl);
      })
      .catch(() => denied(response));
  });

  router.get("/callback", oidcCallbackNavigation(options), (request, response) => {
    void options.service
      .callback({
        code: request.query.code,
        state: request.query.state,
        authCookie: cookie(request, "__Host-bop-auth"),
      })
      .then((result) => {
        response.set("Set-Cookie", result.cookies.map(serializeCookie));
        response.redirect(303, result.postLoginPath);
      })
      .catch(() => {
        response.set(
          "Set-Cookie",
          "__Host-bop-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        denied(response);
      });
  });

  router.get("/session", safeRead(options), (request, response) => {
    void options.service
      .bootstrap(cookie(request, "__Host-bop-merchant"))
      .then((result) => {
        response.json({
          authenticated: true,
          csrf: result.csrf,
          workspace: parseMerchantWorkspaceSnapshot(result.workspace),
        });
      })
      .catch(() => denied(response));
  });

  router.post("/store-context", sameOriginMutation(options), (request, response) => {
    let target: unknown;
    try {
      target = targetStoreReference(request.body);
    } catch {
      denied(response);
      return;
    }
    void options.service
      .switchStore({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
        targetStoreReference: target,
      })
      .then((result) => {
        response
          .set("Set-Cookie", serializeCookie(result.cookie))
          .json({ workspace: parseMerchantWorkspaceSnapshot(result.workspace) });
      })
      .catch(() => denied(response));
  });

  router.post("/protected", sameOriginMutation(options), (request, response) => {
    void options.service
      .authorize({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
      })
      .then(() => {
        response.json({ authorized: true });
      })
      .catch(() => denied(response));
  });

  router.post("/logout", sameOriginMutation(options), (request, response) => {
    void options.service
      .logout(cookie(request, "__Host-bop-merchant"))
      .then((mutation) => {
        response.set("Set-Cookie", serializeCookie(mutation)).status(204).end();
      })
      .catch(() => denied(response));
  });

  return router;
}
