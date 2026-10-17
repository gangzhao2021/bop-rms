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
    /**
     * WP-2423 (v15 3cd0f8dd M5): a visit that ended (its table closed, or it sat idle) and placed an
     * order: the CSRF credential that lets this device read that order's receipt (read only, until
     * the Session's absolute expiry) and which order it is. Nothing else is restored: no menu, cart
     * or checkout. A visit without an order, or past that bound, has nothing to restore.
     */
    async readEndedVisit(sessionCredential: string) {
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
        const ended = await identity.recoverEndedVisitCsrf({
          sessionCredential,
          observedAt: options.now(),
        });
        if (
          ended.session.brandReference !== options.scope.brandReference ||
          ended.session.storeReference !== options.scope.storeReference
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        const order = await findLatestGuestSessionOrder(transaction, options.scope, {
          guestSessionReference: String(ended.session.sessionReference),
          observedAt: options.now(),
        });
        if (order === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return {
          csrfToken: ended.csrfCredential,
          order: {
            orderReference: order.orderReference,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
          },
          receiptAvailableUntil: String(ended.session.absoluteExpiresAt),
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
    /** WP-2423 (v15 3cd0f8dd M5): receipt-only access for a visit that ended (absent: none). */
    readEndedVisit?(sessionCredential: string): Promise<{
      csrfToken: string;
      order: { orderReference: string; orderNumber: string; orderType: "Pickup" | "DineIn" };
      receiptAvailableUntil: string;
    }>;
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
    /** The ended visit's receipt access, validated; null when there is none to give. */
    const readEndedVisit = async (sessionCredential: string) => {
      if (options.port.readEndedVisit === undefined) return null;
      try {
        const ended = await options.port.readEndedVisit(sessionCredential);
        const until = ended.receiptAvailableUntil;
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(until) ||
          !/^[1-9][0-9]{0,18}$/u.test(ended.order.orderNumber) ||
          (ended.order.orderType !== "Pickup" && ended.order.orderType !== "DineIn")
        )
          return null;
        return {
          csrfToken: parseGuestRawCredential(ended.csrfToken),
          order: {
            orderReference: String(parseOrderingReference(ended.order.orderReference)),
            orderNumber: ended.order.orderNumber,
            orderType: ended.order.orderType,
          },
          receiptAvailableUntil: until,
        };
      } catch {
        return null;
      }
    };
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
        // WP-2423 (v15 3cd0f8dd M5): a guest who left can still open their receipt here.
        const ended = await readEndedVisit(credential);
        if (ended === null) response.status(204).end();
        else response.status(200).json({ schemaVersion: 1, endedVisit: ended });
        return;
      }
      reject(error instanceof GuestSessionError ? 401 : 503);
    }
  };
}
