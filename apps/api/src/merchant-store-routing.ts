import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { parseStoreReference } from "@bop/tenant";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { cookie } from "./merchant-bff-http.js";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Store a staff request belongs to is the Store the
 * server has bound to the person's current Session (the selection the sign-in or an audited Store
 * switch recorded, re-validated against their current Tenant association). Never a request field.
 * Null when there is no current Session (signed out, expired) or no valid selection.
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
    } catch {
      return null;
    }
  };
}

/**
 * One installation, several Stores: each Store has its own staff composition (its own Store facts,
 * Provider account, queues). A request goes to the composition of the Store its Session is bound
 * to; without a Session (sign-in, sign-out, bootstrap of a signed-out browser) to the installation's
 * first Store, which answers exactly as a single-Store installation does. A Session bound to a
 * Store this installation does not serve gets no data.
 */
export function createMerchantStoreRouting(options: {
  readonly primaryStoreReference: string;
  readonly routers: ReadonlyMap<string, RequestHandler>;
  readonly resolve: (sessionCookie: unknown) => Promise<string | null>;
  readonly onUnexpected?: (error: unknown) => void;
}): RequestHandler {
  const primary = options.routers.get(options.primaryStoreReference);
  if (primary === undefined) throw new Error("MERCHANT_STORE_ROUTING_INVALID");
  // A single-Store installation reads nothing extra per request.
  if (options.routers.size === 1) return primary;
  return (request: Request, response: Response, next: NextFunction) => {
    options
      .resolve(cookie(request, "__Host-bop-merchant"))
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
        options.onUnexpected?.(error);
        response.setHeader("Cache-Control", "no-store");
        response.status(503).json({ code: "MERCHANT_STORE_UNAVAILABLE" });
      });
  };
}
