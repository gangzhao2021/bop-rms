import express, { type Request, type Response, type Router } from "express";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  BrowserSessionError,
  readClosedRecord,
  parseExactHttpsUri,
  parseRawBrowserCredential,
  workforceAuthorizationCookie,
  workforceSessionCookie,
} from "@bop/identity";
import {
  BrandConfigurationOperationError,
  parseBrandReference,
  parseBrandConfigurationCommand,
  parseBrandConfigurationResolve,
  parseBrandConfigurationHistory,
  parseBrandConfigurationReceipt,
  parseCanonicalInstant,
  parseOrganizationVersion,
} from "@bop/tenant";
import type { createPersistentBrandDiscoveryBff } from "./persistent-brand-discovery-bff.js";
import { MerchantBrandDiscoveryError } from "./merchant-brand-discovery.js";
import {
  MerchantBrandLifecycleError,
  type createMerchantBrandLifecycleOrdinary,
} from "./merchant-brand-lifecycle-ordinary.js";
import {
  parseMerchantBrandLifecycleRequest,
  parseMerchantBrandLifecycleReceipt,
} from "./merchant-brand-lifecycle-transport.js";
import {
  parseMerchantBrandDiscoverySessionPacket,
  parseMerchantBrandDiscoveryPagePacket,
  parseMerchantBrandDiscoverySelectionPacket,
  assertMerchantBrandDiscoveryWindow,
} from "./merchant-brand-discovery-transport.js";
import type { createPersistentBrandAdministrationBff } from "./persistent-brand-administration-bff.js";
import type { createMerchantBrandConfigurationOrdinary } from "./merchant-brand-configuration-ordinary.js";
import { parseMerchantBrandConfigurationCurrent } from "./merchant-brand-configuration-recorded-review.js";
import { parseMerchantBrandTemplateCandidates } from "./merchant-brand-template-candidates.js";
import type { createMerchantBrandCatalogSource } from "./merchant-brand-catalog-source.js";
import {
  CatalogError,
  parseBrandCatalogSourceScope,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceRegister,
  parseBrandCatalogSourceResolve,
  brandCatalogSourceIntentDigest,
  parseCatalogReference,
} from "@rms/catalog";

export interface MerchantBrandAdministrationHttpOptions {
  readonly brandReference: string | null;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly authorizationOrigin: string;
  readonly logoutUrl: string;
  readonly service:
    | ReturnType<typeof createPersistentBrandAdministrationBff>
    | ReturnType<typeof createPersistentBrandDiscoveryBff>;
  readonly discovery?: Pick<
    ReturnType<typeof createPersistentBrandDiscoveryBff>,
    "discoveryBootstrap" | "list" | "select"
  >;
  readonly configuration?: ReturnType<typeof createMerchantBrandConfigurationOrdinary>;
  readonly catalogSource?: ReturnType<typeof createMerchantBrandCatalogSource>;
  readonly lifecycle?: ReturnType<typeof createMerchantBrandLifecycleOrdinary>;
  readonly clock: { now(): string };
}
export const merchantBrandAdministrationRoutes = Object.freeze([
  "/merchant/organization/brands/login",
  "/merchant/organization/brands/invitation",
  "/merchant/organization/brands/callback",
  "/merchant/organization/brands/session",
  ...["session", "list", "select"].map((mode) => `/merchant/organization/brands/discovery/${mode}`),
  "/merchant/organization/brands/session/rotate",
  "/merchant/organization/brands/session/logout",
  "/merchant/organization/brands/lifecycle",
  ...["current", "history", "templates", "execute", "resolve"].map(
    (mode) => `/merchant/organization/brands/configuration/${mode}`,
  ),
  ...["current", "exact", "register", "resolve"].map(
    (mode) => `/merchant/organization/brands/catalog-source/${mode}`,
  ),
]);
const rawHeaders = (request: Request, name: string): string[] => {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? "");
  return values;
};
const header = (request: Request, name: string): string | null => {
  const values = rawHeaders(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
};
function cookie(request: Request, name: string): string | null {
  const value = header(request, "cookie");
  if (!value || value.length > 4096) return null;
  const matches = value
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  const result = matches.length === 1 ? matches[0]?.slice(name.length + 1) : null;
  return result && /^[A-Za-z0-9_-]{43}$/u.test(result) ? result : null;
}
function serializeCookie(
  value: unknown,
  expected: typeof workforceAuthorizationCookie | typeof workforceSessionCookie,
  clear: boolean,
): string {
  const mutation = readClosedRecord(value, ["descriptor", "value", "clear"]),
    descriptor = readClosedRecord(mutation.descriptor, [
      "name",
      "secure",
      "httpOnly",
      "sameSite",
      "path",
      "maxAgeSeconds",
    ]);
  if (
    descriptor.name !== expected.name ||
    descriptor.secure !== true ||
    descriptor.httpOnly !== true ||
    descriptor.sameSite !== "lax" ||
    descriptor.path !== "/" ||
    descriptor.maxAgeSeconds !== expected.maxAgeSeconds ||
    mutation.clear !== clear ||
    (clear && mutation.value !== "")
  )
    return unavailable();
  const credential = clear ? "" : parseRawBrowserCredential(mutation.value);
  return [
    `${expected.name}=${credential}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    ...(clear
      ? ["Max-Age=0"]
      : expected.maxAgeSeconds === null
        ? []
        : [`Max-Age=${expected.maxAgeSeconds}`]),
  ].join("; ");
}
const unavailable = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
const requestRecord = (value: unknown, keys: readonly string[]) => {
  try {
    return readClosedRecord(value, keys);
  } catch {
    throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_INPUT_INVALID");
  }
};
const requestReference = (value: unknown): string => {
  try {
    return String(parseBrandReference(value));
  } catch {
    throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_INPUT_INVALID");
  }
};
const ownerPacket = <T>(parse: (value: unknown) => T, value: unknown): T => {
  try {
    return parse(value);
  } catch {
    return unavailable();
  }
};
function failure(response: Response, error: unknown) {
  if (error instanceof MerchantBrandDiscoveryError && error.reason === "SelectionConflict") {
    response.status(409).json({ error: "brand_selection_conflict" });
    return;
  }
  const code =
    error instanceof BrandConfigurationOperationError || error instanceof CatalogError
      ? error.code
      : null;
  const status =
    error instanceof BrowserSessionError ||
    (error instanceof MerchantBrandDiscoveryError && error.reason === "Denied") ||
    code === "BRAND_CONFIGURATION_PERMISSION_DENIED" ||
    code === "CATALOG_PERMISSION_DENIED"
      ? 403
      : code === "BRAND_CONFIGURATION_INPUT_INVALID" || code === "CATALOG_INPUT_INVALID"
        ? 400
        : code === "BRAND_CONFIGURATION_VERSION_CONFLICT" ||
            code === "BRAND_CONFIGURATION_OPERATION_INTENT_CONFLICT" ||
            code === "CATALOG_VERSION_CONFLICT" ||
            code === "CATALOG_CODE_CONFLICT" ||
            code === "CATALOG_IDEMPOTENCY_CONFLICT"
          ? 409
          : 503;
  response.status(status).json({
    error:
      status === 403
        ? "request_denied"
        : status === 400
          ? "brand_configuration_invalid"
          : status === 409
            ? "brand_configuration_conflict"
            : "brand_administration_unavailable",
  });
}
function workspace(value: unknown, brandReference: string, actorReference: string | null) {
  const r = readClosedRecord(value, ["profile", "selectedScope", "brand", "navigation"]);
  const s = readClosedRecord(r.selectedScope, [
    "tenantReference",
    "brandReference",
    "actorReference",
  ]);
  const b = readClosedRecord(r.brand, ["brandReference", "label", "lifecycle", "version"]);
  try {
    parseOrganizationVersion(b.version);
  } catch {
    return unavailable();
  }
  if (
    r.profile !== "BrandAdministrationWorkspaceV1" ||
    actorReference === null ||
    s.tenantReference !== brandReference ||
    s.brandReference !== brandReference ||
    s.actorReference !== actorReference ||
    b.brandReference !== brandReference ||
    (b.lifecycle !== "Draft" &&
      b.lifecycle !== "Active" &&
      b.lifecycle !== "Suspended" &&
      b.lifecycle !== "Archived") ||
    typeof b.label !== "string" ||
    !/^[^\p{Cc}\p{Cf}]{1,200}$/u.test(b.label) ||
    !Array.isArray(r.navigation) ||
    r.navigation.length > 1
  )
    return unavailable();
  const navigation = r.navigation.map((item: unknown) => {
    const n = readClosedRecord(item, ["screenId", "label", "href", "permission"]);
    if (
      n.screenId !== "ORG-BRAND-DETAIL" ||
      n.label !== "Brand" ||
      n.href !== `/app/organization/brands/${brandReference}` ||
      n.permission !== "organization.manage"
    )
      return unavailable();
    return n;
  });
  return Object.freeze({
    profile: r.profile,
    selectedScope: s,
    brand: b,
    navigation: Object.freeze(navigation),
  });
}

/** Fixed noStore entry. Its workspace is deliberately parsed against the real
 * Brand selection; the Store-only dashboard parser is not a valid substitute. */
export function createMerchantBrandAdministrationRouter(
  options: MerchantBrandAdministrationHttpOptions,
): Router {
  const router = express.Router(),
    brand =
      options.brandReference === null ? null : String(parseBrandReference(options.brandReference)),
    discovery = options.discovery,
    service = options.service,
    configuration = options.configuration,
    catalogSource = options.catalogSource,
    lifecycle = options.lifecycle,
    clock = options.clock,
    now = clock.now,
    exactOrigin = options.exactOrigin,
    acceptedHost = options.acceptedHost,
    authorizationOrigin = options.authorizationOrigin,
    logoutUrl = parseExactHttpsUri(options.logoutUrl);
  const configured = new URL(exactOrigin),
    providerOrigin = new URL(authorizationOrigin);
  if (
    configured.origin !== exactOrigin ||
    configured.protocol !== "https:" ||
    configured.host !== acceptedHost ||
    providerOrigin.protocol !== "https:" ||
    providerOrigin.origin !== authorizationOrigin ||
    logoutUrl !== options.logoutUrl ||
    new URL(logoutUrl).origin !== authorizationOrigin
  )
    return unavailable();
  const path = brand === null ? "/app/organization/brands" : `/app/organization/brands/${brand}`;
  const readInvitationStart = () =>
    "startInvitation" in service ? service.startInvitation : undefined;
  const invitationStart = readInvitationStart();
  if (invitationStart !== undefined && typeof invitationStart !== "function") return unavailable();
  const methods = [
    service.start,
    service.callback,
    service.bootstrap,
    service.authorize,
    service.rotate,
    service.logout,
  ];
  const discoveryMethods = discovery
    ? [discovery.discoveryBootstrap, discovery.list, discovery.select]
    : [];
  const configurationMethods = configuration
    ? [
        configuration.current,
        configuration.history,
        configuration.templates,
        configuration.execute,
        configuration.resolve,
      ]
    : [];
  const catalogMethods = catalogSource
    ? [catalogSource.current, catalogSource.exact, catalogSource.register, catalogSource.resolve]
    : [];
  const lifecycleExecute = lifecycle?.execute;
  const captured = () => {
    if (
      options.service !== service ||
      readInvitationStart() !== invitationStart ||
      options.discovery !== discovery ||
      options.configuration !== configuration ||
      options.catalogSource !== catalogSource ||
      options.lifecycle !== lifecycle ||
      lifecycle?.execute !== lifecycleExecute ||
      options.clock !== clock ||
      clock.now !== now ||
      options.brandReference !== brand ||
      options.exactOrigin !== exactOrigin ||
      options.acceptedHost !== acceptedHost ||
      options.authorizationOrigin !== authorizationOrigin ||
      options.logoutUrl !== logoutUrl ||
      methods.some(
        (method, i) =>
          method !==
          [
            service.start,
            service.callback,
            service.bootstrap,
            service.authorize,
            service.rotate,
            service.logout,
          ][i],
      ) ||
      (discovery &&
        discoveryMethods.some(
          (method, i) =>
            method !== [discovery.discoveryBootstrap, discovery.list, discovery.select][i],
        )) ||
      (configuration &&
        configurationMethods.some(
          (method, i) =>
            method !==
            [
              configuration.current,
              configuration.history,
              configuration.templates,
              configuration.execute,
              configuration.resolve,
            ][i],
        )) ||
      (catalogSource &&
        catalogMethods.some(
          (method, i) =>
            method !==
            [
              catalogSource.current,
              catalogSource.exact,
              catalogSource.register,
              catalogSource.resolve,
            ][i],
        ))
    )
      return unavailable();
  };
  const authorization = (value: unknown) =>
    ownerPacket(() => {
      const r = readClosedRecord(value, ["authorizationUrl", "cookie"]),
        url = parseExactHttpsUri(r.authorizationUrl);
      if (new URL(url).origin !== authorizationOrigin) return unavailable();
      return { url, cookie: serializeCookie(r.cookie, workforceAuthorizationCookie, false) };
    }, value);
  const ownedPaths = new Set(
    merchantBrandAdministrationRoutes.map((route) =>
      route.slice("/merchant/organization/brands".length),
    ),
  );
  router.use((request, response, next) => {
    if (!ownedPaths.has(request.path)) {
      next("router");
      return;
    }
    response.set("Cache-Control", "no-store");
    try {
      captured();
    } catch {
      response.status(403).json({ error: "request_denied" });
      return;
    }
    const origins = rawHeaders(request, "origin"),
      fetchSites = rawHeaders(request, "sec-fetch-site");
    const callback = request.method === "GET" && request.path === "/callback";
    const mutation = request.method === "POST";
    if (
      options.discovery !== discovery ||
      options.service !== service ||
      options.configuration !== configuration ||
      options.catalogSource !== catalogSource ||
      options.lifecycle !== lifecycle ||
      lifecycle?.execute !== lifecycleExecute ||
      options.clock !== clock ||
      clock.now !== now ||
      options.brandReference !== brand ||
      options.exactOrigin !== exactOrigin ||
      options.acceptedHost !== acceptedHost ||
      header(request, "host") !== acceptedHost ||
      origins.length > 1 ||
      fetchSites.length !== 1 ||
      (origins.length === 1 && origins[0] !== exactOrigin) ||
      (mutation
        ? origins.length !== 1 || fetchSites[0] !== "same-origin"
        : !(
            callback ? ["same-origin", "same-site", "cross-site", "none"] : ["same-origin", "none"]
          ).includes(fetchSites[0] ?? ""))
    ) {
      response.status(403).json({ error: "request_denied" });
      return;
    }
    if (request.method === "POST" && Object.keys(request.query).length !== 0) {
      response.status(400).json({ error: "brand_configuration_invalid" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "32kb", strict: true }));
  router.get("/login", (request, response) => {
    try {
      // The configured entry has exactly one destination. It never needs a
      // browser-provided return path in the URL.
      readClosedRecord({ ...request.query }, []);
    } catch {
      response.status(400).json({ error: "brand_configuration_invalid" });
      return;
    }
    void service
      .start(path)
      .then((value) => {
        captured();
        const result = authorization(value);
        response.set("Set-Cookie", result.cookie).redirect(303, result.url);
      })
      .catch((error: unknown) => failure(response, error));
  });
  router.post("/invitation", (request, response) => {
    let secret: ReturnType<typeof parseRawBrowserCredential>;
    try {
      const body = requestRecord(request.body, ["secret"]);
      secret = parseRawBrowserCredential(body.secret);
    } catch {
      response.status(400).json({ error: "request_denied" });
      return;
    }
    if (!invitationStart) {
      response.status(503).json({ error: "brand_administration_unavailable" });
      return;
    }
    void Promise.resolve()
      .then(() => {
        captured();
        return invitationStart.call(service, secret);
      })
      .then((value) => {
        captured();
        const result = authorization(value);
        response
          .set("Set-Cookie", result.cookie)
          .status(200)
          .json({ authorizationUrl: result.url });
      })
      .catch(() => {
        response.status(503).json({ error: "brand_administration_unavailable" });
      });
  });
  router.get("/callback", (request, response) => {
    let q: Record<string, unknown>;
    try {
      q = readClosedRecord({ ...request.query }, ["code", "state"]);
    } catch {
      response.status(403).json({ error: "request_denied" });
      return;
    }
    void service
      .callback({ code: q.code, state: q.state, authCookie: cookie(request, "__Host-bop-auth") })
      .then((result) => {
        captured();
        if (
          result.postLoginPath !== path ||
          !Array.isArray(result.cookies) ||
          result.cookies.length !== 2
        )
          return unavailable();
        response
          .set("Set-Cookie", [
            serializeCookie(result.cookies[0], workforceAuthorizationCookie, true),
            serializeCookie(result.cookies[1], workforceSessionCookie, false),
          ])
          .redirect(303, path);
      })
      .catch(() => {
        response.set(
          "Set-Cookie",
          "__Host-bop-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        response.status(403).json({ error: "request_denied" });
      });
  });
  router.get("/session", (request, response) => {
    if (Object.keys(request.query).length !== 0) {
      response.status(400).json({ error: "brand_configuration_invalid" });
      return;
    }
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (sessionCookie === null) {
      response.status(403).json({ error: "request_denied" });
      return;
    }
    void service
      .bootstrap(sessionCookie)
      .then((result) => {
        if (
          !/^[A-Za-z0-9_-]{43}$/u.test(result.csrf) ||
          typeof result.recentMfaRequired !== "boolean" ||
          (result.recentMfaRequired && result.workspace !== null)
        )
          return unavailable();
        captured();
        if (brand === null && !result.recentMfaRequired && result.workspace === null) {
          response.status(409).json({ error: "brand_selection_required" });
          return;
        }
        const expectedBrand = result.recentMfaRequired
          ? brand
          : (brand ??
            String(
              parseBrandReference(
                readClosedRecord(
                  readClosedRecord(result.workspace, [
                    "profile",
                    "selectedScope",
                    "brand",
                    "navigation",
                  ]).selectedScope,
                  ["tenantReference", "brandReference", "actorReference"],
                ).brandReference,
              ),
            ));
        response.json({
          authenticated: true,
          csrf: result.csrf,
          recentMfaRequired: result.recentMfaRequired,
          workspace: result.recentMfaRequired
            ? null
            : workspace(
                result.workspace,
                expectedBrand ?? unavailable(),
                result.session.actor.actorReference,
              ),
        });
      })
      .catch((error: unknown) => failure(response, error));
  });
  function credentials(request: Request) {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = header(request, "x-bop-csrf");
    if (sessionCookie === null || csrf === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrf))
      throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
    return { sessionCookie, csrf };
  }
  router.post("/lifecycle", (request, response) => {
    let origin: string | null = null;
    const check = () => {
      captured();
      const at = parseCanonicalInstant(now.call(clock));
      if (origin === null || at < origin || Date.parse(at) - Date.parse(origin) >= 5000)
        return unavailable();
      return at;
    };
    void (async () => {
      origin = String(parseCanonicalInstant(now.call(clock)));
      const command = parseMerchantBrandLifecycleRequest(request.body);
      if (brand !== null && command.brandReference !== brand)
        throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
      const input = credentials(request);
      if (!lifecycle || !lifecycleExecute) return unavailable();
      const session = await service.authorize(input);
      if (session.actor.actorReference === null) return unavailable();
      check();
      const result = await lifecycleExecute.call(lifecycle, { ...input, command });
      const packet = parseMerchantBrandLifecycleReceipt(
        result,
        command,
        String(session.actor.actorReference),
        check(),
      );
      response.json(packet);
    })().catch((error: unknown) => {
      let actual = error;
      try {
        check();
      } catch {
        actual = new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
      }
      const code = actual instanceof BrandConfigurationOperationError ? actual.code : null;
      const reason = actual instanceof MerchantBrandLifecycleError ? actual.reason : null;
      const status =
        reason === "Conflict"
          ? 409
          : reason === "Invalid" || code === "BRAND_CONFIGURATION_INPUT_INVALID"
            ? 400
            : reason === "Denied" ||
                actual instanceof BrowserSessionError ||
                code === "BRAND_CONFIGURATION_PERMISSION_DENIED"
              ? 403
              : 503;
      response.status(status).json({
        error:
          status === 409
            ? "brand_lifecycle_conflict"
            : status === 400
              ? "brand_lifecycle_invalid"
              : status === 403
                ? "request_denied"
                : "brand_lifecycle_unavailable",
      });
    });
  });
  router.get("/discovery/session", (request, response) => {
    void (async () => {
      if (!discovery) return unavailable();
      requestRecord({ ...request.query }, []);
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      if (sessionCookie === null)
        throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
      const origin = parseCanonicalInstant(now.call(clock));
      const packet = parseMerchantBrandDiscoverySessionPacket(
        await discovery.discoveryBootstrap(sessionCookie),
      );
      captured();
      assertMerchantBrandDiscoveryWindow(origin, now.call(clock));
      response.json(packet);
    })().catch((error: unknown) => failure(response, error));
  });
  for (const mode of ["list", "select"] as const)
    router.post(`/discovery/${mode}`, (request, response) => {
      void (async () => {
        if (!discovery) return unavailable();
        const body = requestRecord(
            request.body,
            mode === "list"
              ? ["afterBrandReference"]
              : ["brandReference", "expectedSelectedBrandReference"],
          ),
          input = credentials(request),
          origin = parseCanonicalInstant(now.call(clock)),
          after =
            mode === "list"
              ? body.afterBrandReference === null
                ? null
                : requestReference(body.afterBrandReference)
              : null,
          wanted = mode === "select" ? requestReference(body.brandReference) : null,
          expected =
            mode === "select"
              ? body.expectedSelectedBrandReference === null
                ? null
                : requestReference(body.expectedSelectedBrandReference)
              : null;
        const session = await service.authorize(input),
          actor = session.actor.actorReference;
        if (actor === null) return unavailable();
        captured();
        assertMerchantBrandDiscoveryWindow(origin, now.call(clock));
        let result;
        if (mode === "list") {
          result = parseMerchantBrandDiscoveryPagePacket(
            await discovery.list({ ...input, afterBrandReference: after }),
            actor,
            after,
            origin,
            now.call(clock),
          );
        } else {
          if (wanted === null) return unavailable();
          result = parseMerchantBrandDiscoverySelectionPacket(
            await discovery.select({
              ...input,
              brandReference: wanted,
              expectedSelectedBrandReference: expected,
            }),
            actor,
            wanted,
          );
        }
        captured();
        assertMerchantBrandDiscoveryWindow(origin, now.call(clock));
        response.json(result);
      })().catch((error: unknown) => failure(response, error));
    });
  for (const mode of ["rotate", "logout"] as const)
    router.post(`/session/${mode}`, (request, response) => {
      void (async () => {
        requestRecord(request.body, []);
        const input = credentials(request);
        captured();
        if (mode === "rotate") {
          const value = await service.rotate(input);
          captured();
          const result = authorization(value);
          response
            .set("Set-Cookie", result.cookie)
            .json({ status: "step_up_required", authorizationUrl: result.url });
        } else {
          // A prior attempt may already have revoked the local Session. The
          // owner validates retained CSRF and retries remote revocation itself.
          const result = readClosedRecord(await service.logout(input), [
            "status",
            "cookies",
            "browserLogoutUrl",
          ]);
          captured();
          if (
            !Array.isArray(result.cookies) ||
            Object.keys(result.cookies).length !== result.cookies.length
          )
            return unavailable();
          if (
            result.status === "Unknown" &&
            result.cookies.length === 0 &&
            result.browserLogoutUrl === null
          ) {
            response.json({ status: "logout_unknown" });
            return;
          }
          if (
            result.status !== "BrowserLogoutRequired" ||
            result.cookies.length !== 1 ||
            result.browserLogoutUrl !== logoutUrl
          )
            return unavailable();
          response
            .set("Set-Cookie", serializeCookie(result.cookies[0], workforceSessionCookie, true))
            .json({ status: "browser_logout_required", logoutUrl });
        }
      })().catch((error: unknown) => failure(response, error));
    });
  for (const mode of ["current", "history", "templates", "execute", "resolve"] as const)
    router.post(`/configuration/${mode}`, (request, response) => {
      void (async () => {
        if (!configuration) return unavailable();
        const body = requestRecord(
          request.body,
          mode === "current"
            ? ["brandReference"]
            : mode === "history"
              ? ["brandReference", "beforeRevision"]
              : mode === "templates"
                ? ["brandReference", "afterTemplateReference"]
                : ["brandReference", "command"],
        );
        const requestedBrand = requestReference(body.brandReference);
        if (brand !== null && requestedBrand !== brand)
          throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
        const input = credentials(request),
          session = await service.authorize(input),
          actor = session.actor.actorReference;
        if (actor === null) return unavailable();
        captured();
        const scope = {
          tenantReference: requestedBrand,
          brandReference: requestedBrand,
          actorReference: String(actor),
        };
        const requestInput = { ...input, expectedBrandReference: requestedBrand };
        let result;
        if (mode === "templates") {
          let afterTemplateReference: string | null;
          try {
            afterTemplateReference =
              body.afterTemplateReference === null
                ? null
                : String(parseBrandReference(body.afterTemplateReference));
          } catch {
            throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_INPUT_INVALID");
          }
          result = ownerPacket(
            (value) =>
              parseMerchantBrandTemplateCandidates(
                value,
                scope,
                now.call(clock),
                afterTemplateReference,
              ),
            await configuration.templates({ ...requestInput, afterTemplateReference }),
          );
        } else if (mode === "current")
          result = ownerPacket(
            (value) => parseMerchantBrandConfigurationCurrent(value, scope, now.call(clock)),
            await configuration.current(requestInput),
          );
        else if (mode === "history") {
          const before = body.beforeRevision;
          if (
            before !== null &&
            (typeof before !== "number" ||
              !Number.isSafeInteger(before) ||
              before < 1 ||
              before > 2147483647)
          )
            throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_INPUT_INVALID");
          const page = ownerPacket(
            parseBrandConfigurationHistory,
            await configuration.history({ ...requestInput, beforeRevision: before }),
          );
          if (page.beforeRevision !== before) return unavailable();
          result = page;
        } else {
          const raw = requestRecord(
            body.command,
            mode === "execute"
              ? [
                  "command",
                  "operationReference",
                  "expectedBrandVersion",
                  "expectedHead",
                  "configuration",
                  "reviewValidUntil",
                ]
              : [
                  "command",
                  "operationReference",
                  "expectedBrandVersion",
                  "expectedHead",
                  "intentDigest",
                ],
          );
          const identity = { ...raw, ...scope, purposeCode: "BRAND_CONFIGURATION" };
          const expected =
            mode === "execute"
              ? parseBrandConfigurationCommand({
                  ...identity,
                  profile: "TenantBrandConfigurationCommandV1",
                })
              : parseBrandConfigurationResolve({
                  ...identity,
                  profile: "TenantBrandConfigurationResolveV1",
                });
          const intent =
            "intentDigest" in expected
              ? expected.intentDigest
              : `sha256:${sha256Hex(canonicalizeRfc8785(expected))}`;
          const receipt = ownerPacket(
            parseBrandConfigurationReceipt,
            await (mode === "execute"
              ? configuration.execute({ ...requestInput, command: raw })
              : configuration.resolve({ ...requestInput, original: raw })),
          );
          if (
            receipt.command !== expected.command ||
            receipt.operationReference !== expected.operationReference ||
            receipt.expectedBrandVersion !== expected.expectedBrandVersion ||
            canonicalizeRfc8785(receipt.expectedHead) !==
              canonicalizeRfc8785(expected.expectedHead) ||
            receipt.intentDigest !== intent
          )
            return unavailable();
          result = receipt;
        }
        if (
          result.tenantReference !== requestedBrand ||
          result.brandReference !== requestedBrand ||
          result.actorReference !== actor
        )
          return unavailable();
        if ("observedAt" in result) {
          const at = parseCanonicalInstant(now.call(clock));
          if (at < result.observedAt || at >= result.validUntil) return unavailable();
        }
        captured();
        response.json(result);
      })().catch((error: unknown) => failure(response, error));
    });
  for (const mode of ["current", "exact", "register", "resolve"] as const)
    router.post(`/catalog-source/${mode}`, (request, response) => {
      void (async () => {
        if (!catalogSource) return unavailable();
        const body = requestRecord(
          request.body,
          mode === "current"
            ? ["brandReference"]
            : mode === "exact"
              ? ["brandReference", "sourceReference"]
              : mode === "register"
                ? ["brandReference", "command"]
                : ["brandReference", "original"],
        );
        const requestedBrand = requestReference(body.brandReference);
        if (brand !== null && requestedBrand !== brand)
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        const credentialsInput = credentials(request),
          session = await service.authorize(credentialsInput);
        if (session.actor.actorReference === null) return unavailable();
        captured();
        const scope = parseBrandCatalogSourceScope({
          tenantReference: requestedBrand,
          brandReference: requestedBrand,
          actorReference: session.actor.actorReference,
        });
        const input = { ...credentialsInput, expectedBrandReference: requestedBrand };
        let result;
        if (mode === "current") {
          const value = await catalogSource.current(input);
          result = ownerPacket(
            (packet) => parseBrandCatalogSourceCurrent(packet, scope, now.call(clock)),
            value,
          );
        } else if (mode === "exact") {
          const sourceReference = parseCatalogReference(body.sourceReference);
          const value = await catalogSource.exact({ ...input, sourceReference });
          result = ownerPacket(
            (packet) =>
              parseBrandCatalogSourceExact(packet, scope, sourceReference, now.call(clock)),
            value,
          );
        } else {
          const raw = requestRecord(
            mode === "register" ? body.command : body.original,
            mode === "register"
              ? ["operationReference", "code", "label"]
              : ["operationReference", "intentDigest"],
          );
          const expected =
            mode === "register"
              ? parseBrandCatalogSourceRegister({
                  ...raw,
                  ...scope,
                  profile: "BrandCatalogSourceRegisterV1",
                })
              : parseBrandCatalogSourceResolve({
                  ...raw,
                  ...scope,
                  profile: "BrandCatalogSourceResolveV1",
                });
          const intent =
            "intentDigest" in expected
              ? expected.intentDigest
              : brandCatalogSourceIntentDigest(expected);
          const value = await (mode === "register"
            ? catalogSource.register({ ...input, command: raw })
            : catalogSource.resolve({ ...input, original: raw }));
          result = ownerPacket(parseBrandCatalogSourceReceipt, value);
          if (
            result.operationReference !== expected.operationReference ||
            result.intentDigest !== intent
          )
            return unavailable();
        }
        if (
          result.tenantReference !== scope.tenantReference ||
          result.brandReference !== scope.brandReference ||
          result.actorReference !== scope.actorReference
        )
          return unavailable();
        captured();
        response.json(result);
      })().catch((error: unknown) => failure(response, error));
    });
  router.use(
    (error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
      void next;
      const large =
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large";
      response.status(large ? 413 : 400).json({ error: "brand_configuration_invalid" });
    },
  );
  return router;
}
