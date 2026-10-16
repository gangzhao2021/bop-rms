import {
  createPostgresGuestCheckoutRecovery,
  findLatestGuestSessionOrder,
  parseOrderingReference,
} from "@rms/ordering";
import { createPublicStoreProfileService, parseGetPublicStoreRequest } from "@rms/store";
import {
  createPersistentPublicStoreProfilePorts,
  type PersistentPublicStoreProfileOptions,
} from "./persistent-public-store-profile.js";
import type { RequestHandler } from "express";
import {
  GuestSessionService,
  GuestSessionError,
  createPostgresGuestSessionEntryStore,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
export const customerSessionBootstrapRoute = "/api/v1/customer/session/csrf";
export function createCustomerSessionBootstrapRead(
  options: CustomerCheckoutSessionAuthorizationOptions & {
    publicProfile?: PersistentPublicStoreProfileOptions;
  },
) {
  return {
    async read(sessionCredential: string) {
      return options.transactions.run(async (transaction) => {
        const identity = new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(
            { run: async (work) => work(transaction) },
            options.scope,
          ),
          credentials: options.credentials,
          binding: options.binding(transaction),
          now: options.now,
          admission: { consume: async () => null },
        });
        const csrfToken = await identity.recoverForegroundCsrf({ sessionCredential });
        if (!options.publicProfile) return csrfToken;
        const guest = await identity.resolve({ sessionCredential, activity: "Background" });
        const request = parseGetPublicStoreRequest({
          publicStoreReference: guest.publicStoreReference,
          requestedLocale: guest.locale,
          evaluatedAt: options.now(),
          purpose: "CustomerCart",
        });
        const profile = await createPublicStoreProfileService(
          createPersistentPublicStoreProfilePorts(transaction, options.publicProfile, request),
        ).getPublicStore(request);
        if (profile.status !== "Available")
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        const allocation = await createPostgresGuestCheckoutRecovery({
          scope: options.scope,
          authorize: async (tx, input) => {
            const confirmed = await identity.resolve({ sessionCredential, activity: "Background" });
            return (
              tx === transaction &&
              confirmed.brandReference === options.scope.brandReference &&
              confirmed.storeReference === options.scope.storeReference &&
              String(confirmed.sessionReference) === input.guestSessionReference &&
              JSON.stringify(confirmed) === JSON.stringify(guest)
            );
          },
        }).latest(transaction, {
          guestSessionReference: guest.sessionReference,
          observedAt: options.now(),
        });
        // WP-2423 Q10: a customer who reopens the app can go straight back to the order this
        // Guest Session placed (read only after the Session is confirmed in this transaction).
        const latestOrder = await findLatestGuestSessionOrder(transaction, options.scope, {
          guestSessionReference: String(guest.sessionReference),
          observedAt: options.now(),
        });
        const current = await identity.resolve({ sessionCredential, activity: "Background" });
        if (JSON.stringify(current) !== JSON.stringify(guest))
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return {
          csrfToken,
          ...(allocation ? { checkoutSessionReference: allocation.checkoutSessionReference } : {}),
          ...(latestOrder
            ? {
                currentOrder: {
                  orderReference: latestOrder.orderReference,
                  orderNumber: latestOrder.orderNumber,
                  orderType: latestOrder.orderType,
                },
              }
            : {}),
          menuContext: {
            publicStoreReference: guest.publicStoreReference,
            channel: guest.channel,
            locale: guest.locale,
            brandDisplayName: profile.profile.brandDisplayName,
            storeDisplayName: profile.profile.storeDisplayName,
          },
        };
      });
    },
  };
}
export function createCustomerSessionBootstrapHandler(options?: {
  allowedOrigin: string;
  port: {
    read(sessionCredential: string): Promise<
      | string
      | {
          csrfToken: string;
          checkoutSessionReference?: string;
          currentOrder?: {
            orderReference: string;
            orderNumber: string;
            orderType: "Pickup" | "DineIn";
          };
          menuContext: {
            publicStoreReference: string;
            channel: "DineIn" | "Pickup";
            locale: string;
            brandDisplayName: string;
            storeDisplayName: string;
          };
        }
    >;
  };
}): RequestHandler {
  const origin = options && new URL(options.allowedOrigin).origin;
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const reject = (status: number) => {
      response.status(status).json({ schemaVersion: 1, error: { code: "session_unavailable" } });
    };
    if (!options) {
      reject(503);
      return;
    }
    let credential: string;
    try {
      if (
        request.get("sec-fetch-site") !== "same-origin" ||
        (request.get("origin") !== undefined && request.get("origin") !== origin) ||
        request.get("x-bop-session-bootstrap") !== "1" ||
        Object.keys(request.query).length !== 0
      )
        throw new Error();
      readClosedRecord(request.body ?? {}, []);
      const cookies = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter(([name]) => name === "__Host-bop-guest");
      // A first visit has no Guest Session yet: that is an ordinary state, not a bad request.
      // Nothing is issued (no CSRF token, no cookie) and every other check above still applies.
      if (cookies.length === 0) {
        response.status(204).end();
        return;
      }
      if (cookies.length !== 1 || cookies[0]?.length !== 2) throw new Error();
      credential = parseGuestRawCredential(cookies[0]?.[1]);
    } catch {
      reject(400);
      return;
    }
    try {
      const result = await options.port.read(credential);
      const csrfToken = parseGuestRawCredential(
        typeof result === "string" ? result : result.csrfToken,
      );
      const menuContext = typeof result === "string" ? undefined : result.menuContext;
      const currentOrder =
        typeof result === "string" || result.currentOrder === undefined
          ? undefined
          : {
              orderReference: String(parseOrderingReference(result.currentOrder.orderReference)),
              orderNumber: /^[1-9][0-9]{0,18}$/u.test(result.currentOrder.orderNumber)
                ? result.currentOrder.orderNumber
                : (() => {
                    throw new Error("invalid order number");
                  })(),
              orderType:
                result.currentOrder.orderType === "DineIn"
                  ? ("DineIn" as const)
                  : result.currentOrder.orderType === "Pickup"
                    ? ("Pickup" as const)
                    : (() => {
                        throw new Error("invalid order type");
                      })(),
            };
      const checkoutSessionReference =
        typeof result === "string" || result.checkoutSessionReference === undefined
          ? undefined
          : parseOrderingReference(result.checkoutSessionReference);
      response.status(200).json({
        schemaVersion: 1,
        csrfToken,
        ...(checkoutSessionReference ? { checkoutSessionReference } : {}),
        ...(currentOrder ? { currentOrder } : {}),
        ...(menuContext
          ? {
              menuContext: {
                publicStoreReference: menuContext.publicStoreReference,
                channel: menuContext.channel,
                locale: menuContext.locale,
                brandDisplayName: menuContext.brandDisplayName,
                storeDisplayName: menuContext.storeDisplayName,
              },
            }
          : {}),
      });
    } catch (error) {
      // WP-2423: a visit that ended or expired (or a cookie no Session matches) has nothing to
      // restore, exactly like a first visit: an empty 204 with no CSRF token, so the guest page
      // does not log a failed request. Every other Session failure still says so.
      if (error instanceof GuestSessionError && error.code === "GUEST_SESSION_UNAVAILABLE") {
        response.status(204).end();
        return;
      }
      reject(error instanceof GuestSessionError ? 401 : 503);
    }
  };
}
