import {
  productCommandRecord as record,
  parseCatalogReference as reference,
} from "./catalog-product-command-values.js";
import {
  createMerchantBrandWorkspaceClient,
  parseMerchantBrandSessionUrl,
  type MerchantBrandRequestOptions,
} from "./merchant-brand-workspace.js";
export class BrandDiscoveryError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "AccessRequired"
      | "SelectionConflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged"
      | "Stale",
  ) {
    super("Brand discovery could not be confirmed");
    this.name = "BrandDiscoveryError";
  }
}
const fail = (code: BrandDiscoveryError["code"] = "Invalid"): never => {
  throw new BrandDiscoveryError(code);
};
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof BrandDiscoveryError) throw error;
    return fail();
  }
};
const csrf = (v: unknown): string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{43}$/u.test(v) ? v : fail();
const nullableRef = (v: unknown) => (v === null ? null : reference(v));
const text = (v: unknown, max: number): string =>
  typeof v === "string" &&
  v.trim() === v &&
  v.length > 0 &&
  v.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(v)
    ? v
    : fail();
const instant = (v: unknown): string =>
  typeof v === "string" &&
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(v) &&
  v.slice(0, 4) !== "0000" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v
    ? v
    : fail();
const dense = (v: unknown, max: number): readonly unknown[] => {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > max ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return fail();
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
  }
  return v;
};
const locale = (v: unknown) =>
  typeof v === "string" && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|[0-9]{3})$/u.test(v)
    ? v
    : fail();
export interface MerchantBrandDiscoverySession {
  readonly authenticated: true;
  readonly csrf: string;
  readonly recentMfaRequired: boolean;
  readonly actorReference: string;
  readonly selectedBrandReference: string | null;
}
export interface MerchantBrandDiscoveryItem {
  readonly brandReference: string;
  readonly code: string;
  readonly displayName: string;
  readonly lifecycle: "Draft" | "Active" | "Suspended" | "Archived";
  readonly defaultLocale: string;
  readonly version: number;
}
export interface MerchantBrandDiscoveryPage {
  readonly profile: "MerchantBrandDiscoveryV1";
  readonly actorReference: string;
  readonly afterBrandReference: string | null;
  readonly items: readonly MerchantBrandDiscoveryItem[];
  readonly hasMore: boolean;
  readonly nextAfterBrandReference: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantBrandDiscoverySelection {
  readonly actorReference: string;
  readonly brandReference: string;
  readonly href: string;
}
export interface MerchantBrandInvitationStart {
  readonly authorizationUrl: string;
}
const invitationPath = "/merchant/organization/brands/invitation";
function invitationOrigin(): string {
  return safe(() => {
    const origin = globalThis.location.origin,
      url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) return fail();
    return origin;
  });
}
/** The same-origin API checks its configured Provider identity. This parser
 * constrains the returned protocol and callback; it is not a Provider allowlist. */
export function parseMerchantBrandInvitationStart(
  value: unknown,
  expectedOrigin: string,
): MerchantBrandInvitationStart {
  return safe(() => {
    const r = record(value, ["authorizationUrl"]),
      authorizationUrl = parseMerchantBrandSessionUrl(r.authorizationUrl),
      url = new URL(authorizationUrl),
      origin = new URL(expectedOrigin),
      keys = [
        "client_id",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
        "nonce",
        "code_challenge",
        "code_challenge_method",
        "identity_provider",
        "prompt",
        "max_age",
        "acr_values",
      ];
    if (
      origin.protocol !== "https:" ||
      origin.origin !== expectedOrigin ||
      url.pathname !== "/oauth2/authorize" ||
      url.searchParams.size !== keys.length ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
      !/^[a-z0-9]{1,128}$/u.test(url.searchParams.get("client_id") ?? "") ||
      url.searchParams.get("redirect_uri") !==
        `${expectedOrigin}/merchant/organization/brands/callback` ||
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("scope") !== "openid" ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      url.searchParams.get("identity_provider") !== "COGNITO" ||
      url.searchParams.get("prompt") !== "login" ||
      url.searchParams.get("max_age") !== "0" ||
      url.searchParams.get("acr_values") !== "urn:cognito:loa:4"
    )
      return fail();
    csrf(url.searchParams.get("state"));
    csrf(url.searchParams.get("nonce"));
    csrf(url.searchParams.get("code_challenge"));
    return Object.freeze({ authorizationUrl });
  });
}
export function parseMerchantBrandDiscoverySession(value: unknown): MerchantBrandDiscoverySession {
  return safe(() => {
    const r = record(value, [
      "authenticated",
      "csrf",
      "recentMfaRequired",
      "actorReference",
      "selectedBrandReference",
    ]);
    if (r.authenticated !== true || typeof r.recentMfaRequired !== "boolean") return fail();
    return Object.freeze({
      authenticated: true,
      csrf: csrf(r.csrf),
      recentMfaRequired: r.recentMfaRequired,
      actorReference: reference(r.actorReference),
      selectedBrandReference: nullableRef(r.selectedBrandReference),
    });
  });
}
export function parseMerchantBrandDiscoveryPage(
  value: unknown,
  session: MerchantBrandDiscoverySession,
  after: string | null,
  now: number = Date.now(),
): MerchantBrandDiscoveryPage {
  return safe(() => {
    const s = parseMerchantBrandDiscoverySession(session),
      r = record(value, [
        "profile",
        "actorReference",
        "afterBrandReference",
        "items",
        "hasMore",
        "nextAfterBrandReference",
        "observedAt",
        "validUntil",
      ]);
    if (
      r.profile !== "MerchantBrandDiscoveryV1" ||
      r.actorReference !== s.actorReference ||
      r.afterBrandReference !== nullableRef(after)
    )
      return fail("ScopeChanged");
    if (s.recentMfaRequired) return fail("AccessRequired");
    if (typeof r.hasMore !== "boolean") return fail();
    const items = dense(r.items, 20).map((value: unknown) => {
      const i = record(value, [
        "brandReference",
        "code",
        "displayName",
        "lifecycle",
        "defaultLocale",
        "version",
      ]);
      if (
        i.lifecycle !== "Draft" &&
        i.lifecycle !== "Active" &&
        i.lifecycle !== "Suspended" &&
        i.lifecycle !== "Archived"
      )
        return fail();
      if (!Number.isInteger(i.version) || Number(i.version) < 1 || Number(i.version) > 2147483647)
        return fail();
      const code = text(i.code, 63);
      if (!/^[A-Z][A-Z0-9_-]{0,62}$/u.test(code)) return fail();
      return Object.freeze({
        brandReference: reference(i.brandReference),
        code,
        displayName: text(i.displayName, 160),
        lifecycle: i.lifecycle,
        defaultLocale: locale(i.defaultLocale),
        version: Number(i.version),
      });
    });
    let previous = after;
    for (const item of items) {
      if (previous !== null && item.brandReference <= previous) return fail();
      previous = item.brandReference;
    }
    const next = nullableRef(r.nextAfterBrandReference);
    if (
      r.hasMore
        ? next === null ||
          (after !== null && next <= after) ||
          (previous !== null && next < previous)
        : next !== null
    )
      return fail();
    const observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil);
    if (
      Date.parse(validUntil) <= Date.parse(observedAt) ||
      Date.parse(validUntil) > Date.parse(observedAt) + 5000
    )
      return fail();
    if (!Number.isFinite(now) || Date.parse(observedAt) > now || now >= Date.parse(validUntil))
      return fail("Stale");
    return Object.freeze({
      profile: "MerchantBrandDiscoveryV1",
      actorReference: s.actorReference,
      afterBrandReference: after,
      items: Object.freeze(items),
      hasMore: r.hasMore,
      nextAfterBrandReference: next,
      observedAt,
      validUntil,
    });
  });
}
export function parseMerchantBrandDiscoverySelection(
  value: unknown,
  session: MerchantBrandDiscoverySession,
  wanted: string,
): MerchantBrandDiscoverySelection {
  return safe(() => {
    const r = record(value, ["actorReference", "brandReference", "href"]),
      brand = reference(wanted);
    if (
      r.actorReference !== session.actorReference ||
      r.brandReference !== brand ||
      r.href !== `/app/organization/brands/${brand}`
    )
      return fail("ScopeChanged");
    return Object.freeze({
      actorReference: session.actorReference,
      brandReference: brand,
      href: r.href as string,
    });
  });
}
export function createMerchantBrandDiscoveryClient(request: typeof fetch = globalThis.fetch) {
  let epoch = 0;
  const controllers = new Set<AbortController>(),
    workspace = createMerchantBrandWorkspaceClient(request);
  const check = (generation: number, signal?: AbortSignal) => {
    if (generation !== epoch || signal?.aborted) fail("ScopeChanged");
  };
  async function packet(
    path: string,
    body: unknown | undefined,
    token: string | undefined,
    controls: MerchantBrandRequestOptions,
    mutation = false,
    expectedResponseUrl?: string,
  ): Promise<unknown> {
    const generation = epoch,
      c = new AbortController();
    check(generation, controls.signal);
    const abort = () => c.abort();
    controls.signal?.addEventListener("abort", abort, { once: true });
    controllers.add(c);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await request(
            path === "invitation"
              ? invitationPath
              : "/merchant/organization/brands/discovery/" + path,
            {
              method: body === undefined ? "GET" : "POST",
              credentials: "same-origin",
              mode: "same-origin",
              cache: "no-store",
              redirect: "error",
              headers: {
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                ...(token === undefined ? {} : { "X-BOP-CSRF": csrf(token) }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              signal: c.signal,
            },
          );
          check(generation, controls.signal);
          if (
            expectedResponseUrl !== undefined &&
            (response.url !== expectedResponseUrl ||
              response.redirected ||
              response.type === "opaque" ||
              response.type === "opaqueredirect")
          )
            return fail("OutcomeUnknown");
          if (path === "invitation" && response.status === 400) return fail("Invalid");
          if (response.status === 401 || response.status === 403) return fail("AccessRequired");
          if (response.status === 409) return fail("SelectionConflict");
          if (!response.ok) return fail("Unavailable");
          if (
            response.headers.get("cache-control") !== "no-store" ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !response.body
          )
            return fail(mutation ? "OutcomeUnknown" : "Unavailable");
          const reader = response.body.getReader(),
            decoder = new TextDecoder("utf-8", { fatal: true });
          let length = 0,
            value = "";
          const cancel = () => {
            void reader.cancel().catch(() => undefined);
          };
          c.signal.addEventListener("abort", cancel, { once: true });
          try {
            for (;;) {
              check(generation, controls.signal);
              if (c.signal.aborted) return fail(mutation ? "OutcomeUnknown" : "Unavailable");
              const part = await reader.read();
              if (part.done) break;
              length += part.value.byteLength;
              if (length > 65536) return fail(mutation ? "OutcomeUnknown" : "Unavailable");
              value += decoder.decode(part.value, { stream: true });
            }
            value += decoder.decode();
          } finally {
            cancel();
            reader.releaseLock();
            c.signal.removeEventListener("abort", cancel);
          }
          check(generation, controls.signal);
          return JSON.parse(value) as unknown;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            c.abort();
            reject(new BrandDiscoveryError(mutation ? "OutcomeUnknown" : "Unavailable"));
          }, 15000);
        }),
      ]);
      check(generation, controls.signal);
      return result;
    } catch (error) {
      check(generation, controls.signal);
      if (error instanceof BrandDiscoveryError) throw error;
      return fail(mutation ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      controllers.delete(c);
      controls.signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    async startInvitation(
      value: { readonly secret: string },
      controls: MerchantBrandRequestOptions = {},
    ): Promise<MerchantBrandInvitationStart> {
      const secret = safe(() => csrf(record(value, ["secret"]).secret)),
        origin = invitationOrigin(),
        generation = epoch;
      const result = await packet(
        "invitation",
        { secret },
        undefined,
        controls,
        true,
        origin + invitationPath,
      );
      check(generation, controls.signal);
      if (invitationOrigin() !== origin) return fail("ScopeChanged");
      try {
        return parseMerchantBrandInvitationStart(result, origin);
      } catch {
        return fail("OutcomeUnknown");
      }
    },
    async bootstrap(controls: MerchantBrandRequestOptions = {}) {
      const generation = epoch,
        result = parseMerchantBrandDiscoverySession(
          await packet("session", undefined, undefined, controls),
        );
      check(generation, controls.signal);
      return result;
    },
    async list(
      session: MerchantBrandDiscoverySession,
      after: string | null,
      controls: MerchantBrandRequestOptions = {},
    ) {
      const s = parseMerchantBrandDiscoverySession(session),
        cursor = safe(() => nullableRef(after)),
        generation = epoch;
      if (s.recentMfaRequired) return fail("AccessRequired");
      const result = parseMerchantBrandDiscoveryPage(
        await packet("list", { afterBrandReference: cursor }, s.csrf, controls),
        s,
        cursor,
      );
      check(generation, controls.signal);
      return result;
    },
    async select(
      session: MerchantBrandDiscoverySession,
      brand: string,
      controls: MerchantBrandRequestOptions = {},
    ) {
      const s = parseMerchantBrandDiscoverySession(session),
        wanted = safe(() => reference(brand)),
        generation = epoch;
      if (s.recentMfaRequired) return fail("AccessRequired");
      try {
        const raw = await packet(
          "select",
          { brandReference: wanted, expectedSelectedBrandReference: s.selectedBrandReference },
          s.csrf,
          controls,
          true,
        );
        check(generation, controls.signal);
        let result: MerchantBrandDiscoverySelection;
        try {
          result = parseMerchantBrandDiscoverySelection(raw, s, wanted);
        } catch {
          return fail("OutcomeUnknown");
        }
        check(generation, controls.signal);
        return result;
      } catch (error) {
        if (error instanceof BrandDiscoveryError && error.code === "Invalid")
          return fail("OutcomeUnknown");
        throw error;
      }
    },
    rotate: workspace.rotate,
    logout: workspace.logout,
    invalidate() {
      epoch++;
      for (const c of controllers) c.abort();
      controllers.clear();
      workspace.invalidate();
    },
  });
}
export type MerchantBrandDiscoveryClient = ReturnType<typeof createMerchantBrandDiscoveryClient>;
