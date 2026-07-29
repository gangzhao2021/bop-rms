import type {
  AuthenticationSession,
  BrowserCookieMutation,
  RawBrowserCredential,
} from "@bop/identity";
import express, { type Request, type RequestHandler, type Router } from "express";

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
  }>;
  authorize(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }): Promise<AuthenticationSession>;
  logout(sessionCookie: unknown): Promise<BrowserCookieMutation>;
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

function sameOrigin(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origins = rawHeaderValues(request, "origin");
    const hosts = rawHeaderValues(request, "host");
    const fetchSites = rawHeaderValues(request, "sec-fetch-site");
    if (
      origins.length !== 1 ||
      origins[0] !== options.exactOrigin ||
      hosts.length !== 1 ||
      hosts[0] !== options.acceptedHost ||
      fetchSites.length !== 1 ||
      fetchSites[0] !== "same-origin"
    ) {
      response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
      return;
    }
    next();
  };
}

function denied(response: express.Response): void {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}

export function createMerchantBffRouter(options: MerchantBffRouterOptions): Router {
  const router = express.Router();
  router.use(express.json({ limit: "8kb", strict: true }));
  router.use(sameOrigin(options));
  router.use((_request, response, next) => {
    response.set("Cache-Control", NO_STORE);
    next();
  });

  router.get("/login", (request, response) => {
    void options.service
      .start(request.query.returnTo ?? "/")
      .then((result) => {
        response.set("Set-Cookie", serializeCookie(result.cookie));
        response.redirect(303, result.authorizationUrl);
      })
      .catch(() => denied(response));
  });

  router.get("/callback", (request, response) => {
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

  router.get("/session", (request, response) => {
    void options.service
      .bootstrap(cookie(request, "__Host-bop-merchant"))
      .then((result) => {
        response.json({
          authenticated: true,
          csrf: result.csrf,
        });
      })
      .catch(() => denied(response));
  });

  router.post("/protected", (request, response) => {
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

  router.post("/logout", (request, response) => {
    void options.service
      .logout(cookie(request, "__Host-bop-merchant"))
      .then((mutation) => {
        response.set("Set-Cookie", serializeCookie(mutation)).status(204).end();
      })
      .catch(() => denied(response));
  });

  return router;
}
