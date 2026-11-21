import {
  productCommandRecord as record,
  parseCatalogReference as reference,
} from "./catalog-product-command-values.js";

export interface MerchantBrandScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
}
export interface MerchantBrandWorkspaceSnapshot {
  readonly profile: "BrandAdministrationWorkspaceV1";
  readonly selectedScope: MerchantBrandScope;
  readonly brand: {
    readonly brandReference: string;
    readonly label: string;
    readonly lifecycle: "Draft" | "Active" | "Suspended" | "Archived";
    readonly version: number;
  };
  readonly navigation: readonly {
    readonly screenId: "ORG-BRAND-DETAIL";
    readonly label: "Brand";
    readonly href: string;
    readonly permission: "organization.manage";
  }[];
}
export type MerchantBrandBootstrap =
  | {
      readonly csrf: string;
      readonly recentMfaRequired: false;
      readonly workspace: MerchantBrandWorkspaceSnapshot;
    }
  | { readonly csrf: string; readonly recentMfaRequired: true; readonly workspace: null };
export interface MerchantBrandSessionCredentials {
  readonly csrf: string;
}
export interface MerchantBrandStepUp {
  readonly status: "step_up_required";
  readonly authorizationUrl: string;
}
export type MerchantBrandLogout =
  | { readonly status: "logout_unknown" }
  | { readonly status: "browser_logout_required"; readonly logoutUrl: string };
export function parseMerchantBrandSessionUrl(value: unknown): string {
  if (typeof value !== "string" || !/^[^\p{Cc}\p{Cf}\s]{1,4096}$/u.test(value)) return fail();
  if (/[\p{Cc}\p{Cf}]/u.test(decodeURIComponent(value))) return fail();
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== value)
    return fail();
  return value;
}
export class MerchantBrandWorkspaceError extends Error {
  constructor(
    readonly code: "Invalid" | "AccessRequired" | "Unavailable" | "ScopeChanged" | "OutcomeUnknown",
  ) {
    super("Brand workspace could not be confirmed");
    this.name = "MerchantBrandWorkspaceError";
  }
}
const fail = (code: MerchantBrandWorkspaceError["code"] = "Invalid"): never => {
  throw new MerchantBrandWorkspaceError(code);
};
const credential = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : fail();
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof MerchantBrandWorkspaceError) throw error;
    return fail();
  }
};
export function parseMerchantBrandWorkspace(
  value: unknown,
  expectedBrandReference: string,
): MerchantBrandWorkspaceSnapshot {
  return safe(() => {
    const expected = reference(expectedBrandReference),
      r = record(value, ["profile", "selectedScope", "brand", "navigation"]),
      s = record(r.selectedScope, ["tenantReference", "brandReference", "actorReference"]),
      b = record(r.brand, ["brandReference", "label", "lifecycle", "version"]);
    const selectedScope = Object.freeze({
      tenantReference: reference(s.tenantReference),
      brandReference: reference(s.brandReference),
      actorReference: reference(s.actorReference),
    });
    if (
      r.profile !== "BrandAdministrationWorkspaceV1" ||
      selectedScope.tenantReference !== expected ||
      selectedScope.brandReference !== expected ||
      b.brandReference !== expected
    )
      return fail("ScopeChanged");
    if (
      (b.lifecycle !== "Draft" &&
        b.lifecycle !== "Active" &&
        b.lifecycle !== "Suspended" &&
        b.lifecycle !== "Archived") ||
      typeof b.label !== "string" ||
      !/^[^\p{Cc}\p{Cf}]{1,200}$/u.test(b.label) ||
      typeof b.version !== "number" ||
      !Number.isSafeInteger(b.version) ||
      b.version < 1 ||
      b.version > 2147483647 ||
      !Array.isArray(r.navigation) ||
      Object.getPrototypeOf(r.navigation) !== Array.prototype ||
      r.navigation.length > 1 ||
      Reflect.ownKeys(r.navigation).length !== r.navigation.length + 1
    )
      return fail();
    const navigation = Array.from({ length: r.navigation.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(r.navigation, String(i));
      if (!d?.enumerable || !("value" in d)) return fail();
      const n = record(d.value, ["screenId", "label", "href", "permission"]);
      if (
        n.screenId !== "ORG-BRAND-DETAIL" ||
        n.label !== "Brand" ||
        n.href !== `/app/organization/brands/${expected}` ||
        n.permission !== "organization.manage"
      )
        return fail();
      return Object.freeze({
        screenId: "ORG-BRAND-DETAIL" as const,
        label: "Brand" as const,
        href: n.href as string,
        permission: "organization.manage" as const,
      });
    });
    return Object.freeze({
      profile: "BrandAdministrationWorkspaceV1",
      selectedScope,
      brand: Object.freeze({
        brandReference: expected,
        label: b.label,
        lifecycle: b.lifecycle,
        version: b.version,
      }),
      navigation: Object.freeze(navigation),
    });
  });
}
export function parseMerchantBrandBootstrap(
  value: unknown,
  expected: string,
): MerchantBrandBootstrap {
  return safe(() => {
    const r = record(value, ["authenticated", "csrf", "recentMfaRequired", "workspace"]);
    if (r.authenticated !== true) return fail();
    if (r.recentMfaRequired === true) {
      if (r.workspace !== null) return fail();
      return Object.freeze({ csrf: credential(r.csrf), recentMfaRequired: true, workspace: null });
    }
    if (r.recentMfaRequired !== false) return fail();
    return Object.freeze({
      csrf: credential(r.csrf),
      recentMfaRequired: false,
      workspace: parseMerchantBrandWorkspace(r.workspace, expected),
    });
  });
}
export interface MerchantBrandRequestOptions {
  readonly signal?: AbortSignal;
}
export interface MerchantBrandWorkspaceClient {
  bootstrap(
    expectedBrandReference: string,
    options?: MerchantBrandRequestOptions,
  ): Promise<MerchantBrandBootstrap>;
  rotate(
    current: MerchantBrandSessionCredentials,
    options?: MerchantBrandRequestOptions,
  ): Promise<MerchantBrandStepUp>;
  logout(
    current: MerchantBrandSessionCredentials,
    options?: MerchantBrandRequestOptions,
  ): Promise<MerchantBrandLogout>;
  invalidate(): void;
}
const prefix = "/merchant/organization/brands";
export function createMerchantBrandWorkspaceClient(
  request: typeof fetch = globalThis.fetch,
): MerchantBrandWorkspaceClient {
  let epoch = 0;
  const controllers = new Set<AbortController>();
  async function packet(
    path: string,
    options: MerchantBrandRequestOptions,
    csrf?: string,
  ): Promise<unknown> {
    const generation = epoch,
      controller = new AbortController(),
      signal = options.signal;
    const check = () => {
      if (generation !== epoch || signal?.aborted) fail("ScopeChanged");
    };
    check();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await request(prefix + path, {
            method: csrf === undefined ? "GET" : "POST",
            mode: "same-origin",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers: {
              Accept: "application/json",
              ...(csrf === undefined
                ? {}
                : { "Content-Type": "application/json", "X-BOP-CSRF": credential(csrf) }),
            },
            ...(csrf === undefined ? {} : { body: "{}" }),
            signal: controller.signal,
          });
          check();
          if (response.status === 401 || response.status === 403) return fail("AccessRequired");
          if (!response.ok) return fail("Unavailable");
          if (
            response.headers.get("cache-control") !== "no-store" ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !response.body
          )
            return fail(csrf === undefined ? "Unavailable" : "OutcomeUnknown");
          const reader = response.body.getReader(),
            decoder = new TextDecoder("utf-8", { fatal: true });
          const cancel = () => {
            void reader.cancel().catch(() => undefined);
          };
          controller.signal.addEventListener("abort", cancel, { once: true });
          let bytes = 0,
            body = "";
          try {
            for (;;) {
              check();
              if (controller.signal.aborted)
                return fail(csrf === undefined ? "Unavailable" : "OutcomeUnknown");
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 32768) return fail(csrf === undefined ? "Unavailable" : "OutcomeUnknown");
              body += decoder.decode(part.value, { stream: true });
            }
            body += decoder.decode();
          } finally {
            cancel();
            controller.signal.removeEventListener("abort", cancel);
            reader.releaseLock();
          }
          const value: unknown = JSON.parse(body);
          check();
          return value;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new MerchantBrandWorkspaceError(
                csrf === undefined ? "Unavailable" : "OutcomeUnknown",
              ),
            );
          }, 15_000);
        }),
      ]);
      check();
      return result;
    } catch (error) {
      check();
      if (error instanceof MerchantBrandWorkspaceError) throw error;
      return fail(csrf === undefined ? "Unavailable" : "OutcomeUnknown");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controllers.delete(controller);
    }
  }
  const bootstrap = async (expected: string, options: MerchantBrandRequestOptions = {}) => {
    const captured = epoch;
    safe(() => reference(expected));
    const result = parseMerchantBrandBootstrap(await packet("/session", options), expected);
    if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
    return result;
  };
  const currentInput = (value: MerchantBrandSessionCredentials) =>
    safe(() => credential(record(value, ["csrf"]).csrf));
  return Object.freeze({
    bootstrap,
    async rotate(
      value: MerchantBrandSessionCredentials,
      options: MerchantBrandRequestOptions = {},
    ) {
      const captured = epoch,
        csrf = currentInput(value),
        raw = await packet("/session/rotate", options, csrf);
      if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
      return safe(() => {
        const r = record(raw, ["status", "authorizationUrl"]);
        if (r.status !== "step_up_required") return fail();
        return Object.freeze({
          status: "step_up_required" as const,
          authorizationUrl: parseMerchantBrandSessionUrl(r.authorizationUrl),
        });
      });
    },
    async logout(
      value: MerchantBrandSessionCredentials,
      options: MerchantBrandRequestOptions = {},
    ) {
      const captured = epoch,
        csrf = currentInput(value),
        raw = await packet("/session/logout", options, csrf);
      if (captured !== epoch || options.signal?.aborted) return fail("ScopeChanged");
      return safe(() => {
        const descriptor =
          raw !== null && typeof raw === "object"
            ? Object.getOwnPropertyDescriptor(raw, "status")
            : undefined;
        if (!descriptor || !("value" in descriptor)) return fail();
        if (descriptor.value === "logout_unknown") {
          record(raw, ["status"]);
          return Object.freeze({ status: "logout_unknown" as const });
        }
        const r = record(raw, ["status", "logoutUrl"]);
        if (r.status !== "browser_logout_required") return fail();
        return Object.freeze({
          status: "browser_logout_required" as const,
          logoutUrl: parseMerchantBrandSessionUrl(r.logoutUrl),
        });
      });
    },
    invalidate() {
      ++epoch;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  });
}
