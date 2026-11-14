import { t } from "./i18n/i18n.js";
/**
 * WP-2423 item 11: the Store's kitchen setup. The browser sends only the version it saw and its
 * operation; Store, actor, time and what the line holds are decided by the server.
 */
export interface StoreKitchenSetupView {
  readonly canChange: boolean;
  /** 0: the kitchen has never been set up. */
  readonly version: number;
  readonly inEffectFrom: string | null;
  readonly uncoveredDishes: readonly string[];
}
export class StoreKitchenSetupClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super(t("Kitchen setup is unavailable"));
    this.name = "StoreKitchenSetupClientError";
  }
}
const fail = (code: StoreKitchenSetupClientError["code"]): never => {
  throw new StoreKitchenSetupClientError(code);
};
export function parseStoreKitchenSetupView(value: unknown): StoreKitchenSetupView {
  const raw = value as Record<string, unknown> | null;
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof raw.canChange !== "boolean" ||
    !Number.isSafeInteger(raw.version) ||
    !(raw.inEffectFrom === null || typeof raw.inEffectFrom === "string") ||
    !Array.isArray(raw.uncoveredDishes) ||
    !raw.uncoveredDishes.every((dish) => typeof dish === "string")
  )
    return fail("Unavailable");
  return Object.freeze({
    canChange: raw.canChange,
    version: raw.version as number,
    inEffectFrom: raw.inEffectFrom,
    uncoveredDishes: Object.freeze([...(raw.uncoveredDishes as string[])]),
  });
}
export function createStoreKitchenSetupClient(options: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  const request = async (init: RequestInit) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetcher("/merchant/store/kitchen-setup", {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.freeze({
    async load(): Promise<StoreKitchenSetupView> {
      let response: Response;
      try {
        response = await request({ method: "GET", headers: { Accept: "application/json" } });
      } catch {
        return fail("Unavailable");
      }
      if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
      if (!response.ok) return fail("Unavailable");
      return parseStoreKitchenSetupView(await response.json().catch(() => null));
    },
    async apply(body: { readonly operationReference: string; readonly expectedVersion: number }) {
      let response: Response;
      try {
        response = await request({
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": options.csrf,
          },
          body: JSON.stringify(body),
        });
      } catch {
        return fail("OutcomeUnknown");
      }
      if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 503) return fail("Unavailable");
      if (!response.ok) return fail("OutcomeUnknown");
    },
  });
}
