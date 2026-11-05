import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { parseStoreReference } from "@bop/tenant";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { cookie } from "./merchant-bff-http.js";
import {
  isDatabaseContention,
  isMerchantRefusal,
  merchantFailureKind,
} from "./merchant-failure.js";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import { storeDeviceCookieName } from "./merchant-staff-pin-http.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Store a staff request belongs to is the Store the
 * server has bound to the person's current Session (the selection the sign-in or an audited Store
 * switch recorded, re-validated against their current Tenant association). Never a request field.
 * Null when there is no current Session (signed out, expired) or no valid selection. A read that
 * failed is neither (WP-2423 item 10): sent to the first Store, a person of another Store would be
 * told they have no permission because of a lock timeout.
 */
export function createMerchantSessionStoreResolver(
  options: Pick<
    PersistentMerchantBffOptions,
    "identity" | "transactions" | "currentActor" | "now" | "validateAssociation"
  >,
) {
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: options.identity.hasher,
    now: options.now,
    currentActor: options.currentActor,
  });
  const selectedContext = createMerchantSelectedContext({
    now: options.now,
    validateSelection: async (...args) => (await options.validateAssociation(...args)) === true,
  });
  return async (sessionCookie: unknown): Promise<string | null> => {
    if (typeof sessionCookie !== "string" || sessionCookie === "") return null;
    try {
      return await options.transactions.run(async (tx) => {
        const session = await currentSession(tx, sessionCookie);
        const selected = await selectedContext(tx, session);
        const store = selected.context.store;
        return store ? String(parseStoreReference(store.storeReference)) : null;
      });
    } catch (error) {
      if (isMerchantRefusal(error)) return null;
      throw error;
    }
  };
}

const BRAND_STORE_READ =
  /^\/reports\/stores\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/tonight(?:\?.*)?$/u;

const STAFF_SWITCH = /^\/staff-switch(?:[/?].*)?$/u;

/**
 * One installation, several Stores: each Store has its own staff composition (its own Store facts,
 * Provider account, queues). A request goes to the composition of the Store its Session is bound
 * to; without a Session (sign-in, sign-out, bootstrap of a signed-out browser) to the installation's
 * first Store, which answers exactly as a single-Store installation does. A Session bound to a
 * Store this installation does not serve gets no data.
 *
 * DEC-MULTI-MERCHANT-ONE-INSTALLATION: a registered tablet belongs to its Store. Its lock screen and
 * PIN sign-in always go to that Store, and without a Session so does everything else it asks.
 */
export function createMerchantStoreRouting(options: {
  readonly primaryStoreReference: string;
  readonly routers: ReadonlyMap<string, RequestHandler>;
  readonly resolve: (sessionCookie: unknown) => Promise<string | null>;
  readonly resolveDevice?: (deviceCookie: unknown) => Promise<string | null>;
  readonly onUnexpected?: (error: unknown) => void;
}): RequestHandler {
  const primary = options.routers.get(options.primaryStoreReference);
  if (primary === undefined) throw new Error("MERCHANT_STORE_ROUTING_INVALID");
  // A single-Store installation reads nothing extra per request.
  if (options.routers.size === 1) return primary;
  return (request: Request, response: Response, next: NextFunction) => {
    // Segment 7: another Store's summary is read by that Store's composition, which authorizes
    // the person at that Store itself; a Store this installation does not serve gets no data.
    const brandRead = BRAND_STORE_READ.exec(request.url);
    if (brandRead) {
      const router = options.routers.get(brandRead[1] ?? "");
      if (router === undefined) {
        response.setHeader("Cache-Control", "no-store");
        response.status(403).json({ code: "MERCHANT_STORE_NOT_SERVED" });
        return;
      }
      router(request, response, next);
      return;
    }
    const device = () =>
      options.resolveDevice?.(cookie(request, storeDeviceCookieName)) ?? Promise.resolve(null);
    const session = () => options.resolve(cookie(request, "__Host-bop-merchant"));
    (STAFF_SWITCH.test(request.url)
      ? device().then(async (store) => store ?? (await session()))
      : session().then(async (store) => store ?? (await device()))
    )
      .then((store) => {
        if (store === null) return primary(request, response, next);
        const router = options.routers.get(store);
        if (router === undefined) {
          response.setHeader("Cache-Control", "no-store");
          return response.status(403).json({ code: "MERCHANT_STORE_NOT_SERVED" });
        }
        return router(request, response, next);
      })
      .catch((error: unknown) => {
        response.setHeader("Cache-Control", "no-store");
        // A lock or a race passes if the page waits: the same answer as the Store's own routes.
        if (isDatabaseContention(error) || merchantFailureKind(error) === "Changed") {
          response.setHeader("Retry-After", "2");
          response.status(503).json({ error: "retry_later" });
          return;
        }
        options.onUnexpected?.(error);
        response.status(503).json({ code: "MERCHANT_STORE_UNAVAILABLE" });
      });
  };
}
