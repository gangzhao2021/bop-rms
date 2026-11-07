import {
  createPublicStoreProfileService,
  parseGetPublicStoreRequest,
  type StoreUpcomingHours,
} from "@rms/store";
import {
  GuestSessionError,
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  parseGuestRawCredential,
} from "@bop/identity";
import type { RequestHandler } from "express";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import type { CustomerEntryOperatingReader } from "./customer-entry-composition.js";
import {
  createPersistentPublicStoreProfilePorts,
  type PersistentPublicStoreProfileOptions,
} from "./persistent-public-store-profile.js";

/**
 * WP-2423 (store identity on the customer start and menu pages): what a guest needs to know about
 * the Store they are ordering from — its published name, address and phone (the Store's public
 * profile, DEC-STORE-CUSTOMER-NAME) and whether it is open now with today's published hours (the
 * same published operating reader the entry gate uses). Read only for the Guest Session's own
 * Store, in one transaction; nothing about the guest, staff or orders is included. Every field is
 * Public classification, so the browser may keep it for a short while (`private, max-age=30`).
 *
 * No pickup ready time is given: no owner computes one (the capacity schedule paces orders per
 * hour; it does not promise a preparation time), so none is shown rather than an invented one.
 */
export const customerStoreProfileRoute = "/api/v1/customer/store";

const localTimePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/u;

export interface CustomerStoreHoursInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
}

export interface CustomerStoreHours {
  /** Open: taking this guest's service now. Closed: outside hours. Paused: online ordering paused. */
  readonly status: "Open" | "Closed" | "Paused";
  readonly todayHours: readonly CustomerStoreHoursInterval[];
  /** Local "HH:MM:SS" the current period ends, when it is one of today's published intervals. */
  readonly closesAt: string | null;
  /** Local "HH:MM:SS" of the next opening later today, when the Store is closed until then. */
  readonly opensAt: string | null;
  /**
   * WP-2423 item 8 ③ (Owner decision 16). The Store's local date now; today's holiday, special
   * hours or closure; when the kitchen stops taking orders in the current period (while open and
   * only when the Store set a cut-off); the next opening within 7 days (while not open); and the
   * holidays and special hours in the next 7 days.
   */
  readonly localDate: string | null;
  readonly todayKind: StoreUpcomingHours["todayKind"];
  readonly lastOrdersAt: string | null;
  /**
   * Follow-up (v15 2026-10-28): open, but past last orders — guests can't send new orders or
   * rounds now (the checkout and payment gates refuse them); staff still can.
   */
  readonly ordersStopped: boolean;
  readonly nextOpening: StoreUpcomingHours["nextOpening"];
  readonly upcoming: StoreUpcomingHours["upcoming"];
}

export interface CustomerStoreProfileView {
  readonly storeDisplayName: string;
  readonly brandDisplayName: string;
  readonly timeZone: string;
  readonly address: {
    readonly addressLines: readonly string[];
    readonly locality: string;
    readonly regionCode: string;
    readonly postalCode: string;
    readonly countryCode: string;
  };
  readonly phone: string | null;
  /** Null when the published hours can't be read now; the page then states no hours at all. */
  readonly hours: CustomerStoreHours | null;
}

const seconds = (value: string): number => {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
};

/**
 * Today's open period and next opening from the published intervals and the Store's local time.
 * Only what the intervals state is returned: an overnight period carried over from yesterday, or
 * an opening on another day, is left out (null) rather than guessed.
 */
export function describeCustomerStoreHours(input: {
  readonly state: "Open" | "Closed" | "TemporarilyClosed";
  readonly servesChannel: boolean;
  readonly localTime: string | null;
  readonly todayHours: readonly CustomerStoreHoursInterval[];
  readonly localDate?: string | null;
  readonly upcoming?: StoreUpcomingHours | null;
}): CustomerStoreHours {
  const todayHours = Object.freeze(
    input.todayHours
      .filter(
        (interval) =>
          localTimePattern.test(interval.startLocalTime) &&
          localTimePattern.test(interval.endLocalTime),
      )
      .map((interval) =>
        Object.freeze({
          startLocalTime: interval.startLocalTime,
          endLocalTime: interval.endLocalTime,
          endsNextDay: interval.endsNextDay === true,
        }),
      )
      .sort((a, b) => seconds(a.startLocalTime) - seconds(b.startLocalTime)),
  );
  const status =
    input.state === "TemporarilyClosed"
      ? ("Paused" as const)
      : input.state === "Open" && input.servesChannel
        ? ("Open" as const)
        : ("Closed" as const);
  const now =
    input.localTime !== null && localTimePattern.test(input.localTime)
      ? seconds(input.localTime)
      : null;
  const ahead = input.upcoming ?? null;
  const known = {
    localDate: input.localDate ?? null,
    todayKind: ahead?.todayKind ?? null,
    lastOrdersAt: status === "Open" ? (ahead?.lastOrdersAt ?? null) : null,
    ordersStopped: status === "Open" && ahead?.pastLastOrders === true,
    nextOpening: status === "Open" ? null : (ahead?.nextOpening ?? null),
    upcoming: ahead?.upcoming ?? Object.freeze([]),
  };
  if (now === null)
    return Object.freeze({ status, todayHours, closesAt: null, opensAt: null, ...known });
  const current = todayHours.find(
    (interval) =>
      seconds(interval.startLocalTime) <= now &&
      (interval.endsNextDay || now < seconds(interval.endLocalTime)),
  );
  const next = todayHours.find((interval) => seconds(interval.startLocalTime) > now);
  return Object.freeze({
    status,
    todayHours,
    closesAt: status === "Open" && current !== undefined ? current.endLocalTime : null,
    opensAt: status === "Closed" && next !== undefined ? next.startLocalTime : null,
    ...known,
  });
}

export interface CustomerStoreProfileReadOptions extends CustomerCheckoutSessionAuthorizationOptions {
  readonly publicProfile: PersistentPublicStoreProfileOptions;
  /** The published operating reader the entry gate uses, in this request's transaction. */
  readonly operatingReader: (
    transaction: Parameters<
      Parameters<CustomerCheckoutSessionAuthorizationOptions["transactions"]["run"]>[0]
    >[0],
  ) => CustomerEntryOperatingReader;
}

export function createCustomerStoreProfileRead(options: CustomerStoreProfileReadOptions) {
  return {
    async read(sessionCredential: string): Promise<CustomerStoreProfileView> {
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
        const guest = await identity.resolve({ sessionCredential, activity: "Background" });
        if (
          guest.brandReference !== options.scope.brandReference ||
          guest.storeReference !== options.scope.storeReference
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        const evaluatedAt = options.now();
        const request = parseGetPublicStoreRequest({
          publicStoreReference: guest.publicStoreReference,
          requestedLocale: guest.locale,
          evaluatedAt,
          purpose: "CustomerCart",
        });
        const profile = await createPublicStoreProfileService(
          createPersistentPublicStoreProfilePorts(
            transaction as Parameters<typeof createPersistentPublicStoreProfilePorts>[0],
            options.publicProfile,
            request,
          ),
        ).getPublicStore(request);
        if (profile.status !== "Available") throw new Error("STORE_PROFILE_UNAVAILABLE");
        let hours: CustomerStoreHours | null = null;
        try {
          const current = await options.operatingReader(transaction).readCurrent({
            brandReference: String(guest.brandReference),
            storeReference: String(guest.storeReference),
            publicStoreReference: String(guest.publicStoreReference),
            evaluatedAt,
          });
          if (
            current !== null &&
            current.brandReference === String(guest.brandReference) &&
            current.storeReference === String(guest.storeReference) &&
            current.evaluatedAt === evaluatedAt
          )
            hours = describeCustomerStoreHours({
              state: current.state,
              servesChannel: current.availableServiceModes.includes(guest.channel),
              localTime: current.localTime ?? null,
              todayHours: current.todayHours ?? [],
              localDate: current.localDate ?? null,
              upcoming: current.upcomingHours ?? null,
            });
        } catch {
          hours = null;
        }
        const { address } = profile.profile;
        return Object.freeze({
          storeDisplayName: profile.profile.storeDisplayName,
          brandDisplayName: profile.profile.brandDisplayName,
          timeZone: profile.profile.timeZone,
          address: Object.freeze({
            addressLines: Object.freeze([...address.addressLines]),
            locality: address.locality,
            regionCode: address.regionCode,
            postalCode: address.postalCode,
            countryCode: address.countryCode,
          }),
          phone: profile.profile.businessPhone,
          hours,
        });
      });
    },
  };
}

/** Explicit public-field serialization. */
export function customerStoreProfileJson(view: CustomerStoreProfileView) {
  return {
    schemaVersion: 1 as const,
    store: {
      storeDisplayName: view.storeDisplayName,
      brandDisplayName: view.brandDisplayName,
      timeZone: view.timeZone,
      address: {
        addressLines: [...view.address.addressLines],
        locality: view.address.locality,
        regionCode: view.address.regionCode,
        postalCode: view.address.postalCode,
        countryCode: view.address.countryCode,
      },
      phone: view.phone,
      hours:
        view.hours === null
          ? null
          : {
              status: view.hours.status,
              todayHours: view.hours.todayHours.map((interval) => ({
                startLocalTime: interval.startLocalTime,
                endLocalTime: interval.endLocalTime,
                endsNextDay: interval.endsNextDay,
              })),
              closesAt: view.hours.closesAt,
              opensAt: view.hours.opensAt,
              localDate: view.hours.localDate,
              todayKind: view.hours.todayKind,
              lastOrdersAt: view.hours.lastOrdersAt,
              ordersStopped: view.hours.ordersStopped,
              nextOpening: view.hours.nextOpening,
              upcoming: view.hours.upcoming.map((day) => ({
                localDate: day.localDate,
                kind: day.kind,
                intervals: day.intervals.map((interval) => ({
                  startLocalTime: interval.startLocalTime,
                  endLocalTime: interval.endLocalTime,
                  endsNextDay: interval.endsNextDay,
                })),
              })),
            },
    },
  };
}

export function createCustomerStoreProfileHandler(options?: {
  readonly allowedOrigin: string;
  readonly port: { read(sessionCredential: string): Promise<CustomerStoreProfileView> };
}): RequestHandler {
  const origin = options && new URL(options.allowedOrigin).origin;
  return async (request, response) => {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const reject = (status: 400 | 401 | 503) => {
      response.setHeader("Cache-Control", "no-store");
      if (status === 503) response.setHeader("Retry-After", "5");
      response.status(status).json({
        schemaVersion: 1,
        error: {
          code:
            status === 400
              ? "store_request_invalid"
              : status === 401
                ? "session_unavailable"
                : "store_unavailable",
        },
      });
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
        Object.keys(request.query).length !== 0
      )
        throw new Error();
      const cookies = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter(([name]) => name === "__Host-bop-guest");
      if (cookies.length !== 1 || cookies[0]?.length !== 2) {
        reject(401);
        return;
      }
      credential = parseGuestRawCredential(cookies[0]?.[1]);
    } catch {
      reject(400);
      return;
    }
    try {
      const view = await options.port.read(credential);
      response.setHeader("Cache-Control", "private, max-age=30");
      response.setHeader("Vary", "Cookie");
      response.status(200).json(customerStoreProfileJson(view));
    } catch (error) {
      reject(error instanceof GuestSessionError ? 401 : 503);
    }
  };
}
