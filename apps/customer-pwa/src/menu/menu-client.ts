import { currentLanguage } from "../i18n/i18n.js";
import type { CustomerMenuClient, MenuJourneyContext, MenuLoadResult } from "./types.js";
import { boundedFetch } from "../network/bounded-fetch.js";
import {
  menuLocale,
  normalizeMenuSearch,
  parseMenuError,
  parseMenuFound,
  uuidV7,
} from "./menu-contract.js";

export { normalizeMenuSearch };

export interface CustomerMenuBoundary {
  readonly fetch: typeof globalThis.fetch;
  readonly online: () => boolean;
}

export function createCustomerMenuClient(
  context: MenuJourneyContext,
  boundary: CustomerMenuBoundary,
): CustomerMenuClient {
  const inFlight = new Map<string, Promise<MenuLoadResult>>();
  return Object.freeze({
    async load(
      input: Readonly<{ searchTerm?: string; sectionReference?: string }> = {},
    ): Promise<MenuLoadResult> {
      if (!uuidV7.test(context.publicStoreReference) || !menuLocale.test(context.locale))
        return Object.freeze({ kind: "Unavailable" });
      if (!boundary.online()) return Object.freeze({ kind: "Offline" });
      const parameters = new URLSearchParams({
        channel: "CUSTOMER_PWA",
        orderType: context.channel === "DineIn" ? "DINE_IN" : "PICKUP",
        locale: context.locale,
      });
      let normalizedSearch: string | null = null;
      if (input.searchTerm !== undefined) {
        const searchTerm = normalizeMenuSearch(input.searchTerm);
        if (searchTerm === null) return Object.freeze({ kind: "Unavailable" });
        normalizedSearch = searchTerm;
        parameters.set("q", searchTerm);
      }
      if (input.sectionReference !== undefined) {
        if (!uuidV7.test(input.sectionReference)) return Object.freeze({ kind: "Unavailable" });
        parameters.set("section", input.sectionReference);
      }
      const requestKey = `${normalizedSearch ?? ""}\u0000${input.sectionReference ?? ""}`;
      const pending = inFlight.get(requestKey);
      if (pending !== undefined) return pending;
      const request = (async (): Promise<MenuLoadResult> => {
        try {
          const response = await boundedFetch(
            boundary.fetch,
            `/api/v1/public/stores/${context.publicStoreReference}/menu?${parameters.toString()}`,
            {
              method: "GET",
              credentials: "same-origin",
              cache: "no-store",
              referrerPolicy: "no-referrer",
            },
          );
          if (response.status === 403) return Object.freeze({ kind: "PermissionDenied" });
          const payload: unknown = await response.json();
          if (response.status === 200)
            return Object.freeze({
              kind: "Found",
              menu: parseMenuFound(payload, context, currentLanguage()),
            });
          return Object.freeze({ kind: parseMenuError(payload) });
        } catch {
          return Object.freeze({ kind: boundary.online() ? "Unavailable" : "Offline" });
        }
      })();
      inFlight.set(requestKey, request);
      void request.finally(() => {
        if (inFlight.get(requestKey) === request) inFlight.delete(requestKey);
      });
      return request;
    },
  });
}
