import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { MerchantStaffPinError, type createMerchantStaffPin } from "./merchant-staff-pin.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 Q18 option A: HTTP for the shared-tablet staff PIN. The tablet secret travels only in
 * the `__Host-bop-store-device` cookie (HttpOnly, Secure, SameSite=Strict, never in a URL, body or
 * log); PINs travel only in POST bodies and are never echoed. Lock-screen routes need no session:
 * the tablet cookie and the PIN authorize them, with exact-origin checks against cross-site use.
 */
export const storeDeviceCookieName = "__Host-bop-store-device";
const sessionCookieName = "__Host-bop-merchant";
const NO_STORE = "no-store";
/** A registered tablet keeps its cookie for 400 days (the browser maximum); revocation is server-side. */
const deviceCookieMaxAgeSeconds = 400 * 24 * 60 * 60;
export const staffSwitchPath = "/operations/switch-staff";

/**
 * Sensitive actions a PIN session may do only after a step-up in that session (or with a full
 * sign-in): money back to a customer, prices and tax, staff, roles and Store payment settings,
 * and switching to another Store.
 */
export const fullSignInMutationPaths: ReadonlySet<string> = new Set([
  "/payments/refunds/request",
  "/payments/refunds/approve",
  "/payments/refunds/decline",
  "/payments/refunds/prepare",
  "/payments/refunds/send",
  "/payments/unmatched-capture-refund/request",
  "/payments/unmatched-capture-refund/approve",
  "/orders/card-machine-refund",
  "/orders/acceptance-hold/refund",
  "/orders/cancel",
  "/orders/cancel-items",
  "/orders/cancel-items/refund",
  "/commerce/pricing/command",
  "/pricing/price-books",
  "/commerce/option-prices/command",
  "/pricing/option-prices/command",
  "/pricing/option-prices/resolve",
  "/pricing/option-prices/review/command",
  "/pricing/option-prices/review/resolve",
  "/tax-config/authoring/commands",
  "/tax-config/authoring/resolve-original",
  "/organization/roles/command",
  "/organization/staff/command",
  "/organization/sole-operator",
  "/store-setup/payment-configuration",
  "/store-context",
]);

export interface MerchantStaffPinRouteOptions {
  readonly exactOrigin: string;
  readonly staffPin?: ReturnType<typeof createMerchantStaffPin>;
  /** Where to sign in fully (the default sign-in entry). */
  readonly fullSignIn: { readonly path: string; readonly testOnly: boolean };
}

function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  return values;
}
function exactHeader(request: Request, name: string): string | null {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}
export function requestCookie(request: Request, name: string): string | null {
  const headers = rawHeaderValues(request, "cookie");
  const header = headers[0];
  if (headers.length !== 1 || header === undefined || header.length > 4096) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1 || matches[0] === undefined) return null;
  const value = matches[0].slice(name.length + 1);
  return value && !/[\s;,]/u.test(value) ? value : null;
}
const deviceCookie = (secret: string) =>
  `${storeDeviceCookieName}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${deviceCookieMaxAgeSeconds}`;
const clearDeviceCookie = `${storeDeviceCookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
const sessionCookie = (value: string) =>
  `${sessionCookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`;

function denied(response: Response) {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}
function readGuard(options: MerchantStaffPinRouteOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const site = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      (site !== "same-origin" && site !== "none") ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    next();
  };
}
function mutationGuard(options: MerchantStaffPinRouteOptions): RequestHandler {
  return (request, response, next) => {
    if (
      exactHeader(request, "origin") !== options.exactOrigin ||
      exactHeader(request, "sec-fetch-site") !== "same-origin" ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    next();
  };
}
const parseJson = express.json({ limit: "1kb", strict: true });
/** Small JSON bodies only; a malformed or oversized body is a refused request. */
const json: RequestHandler = (request, response, next) => {
  parseJson(request, response, (error?: unknown) => {
    if (error) {
      denied(response);
      return;
    }
    next();
  });
};
function body(request: Request, keys: readonly string[]): Record<string, unknown> | null {
  const value: unknown = request.body;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return null;
  return value as Record<string, unknown>;
}

/** The sign-in a browser should use: the PIN lock screen on a registered tablet. */
export async function resolveStaffSignInEntry(
  request: Request,
  options: MerchantStaffPinRouteOptions,
): Promise<{ readonly path: string; readonly testOnly: boolean }> {
  const secret = requestCookie(request, storeDeviceCookieName);
  if (options.staffPin === undefined || secret === null) return options.fullSignIn;
  try {
    return (await options.staffPin.isRegisteredDevice(secret))
      ? { path: staffSwitchPath, testOnly: false }
      : options.fullSignIn;
  } catch {
    return options.fullSignIn;
  }
}

/** Refuses sensitive mutations of a PIN session that has not been verified (BFF-wide gate). */
export function staffPinFullSignInGate(options: MerchantStaffPinRouteOptions): RequestHandler {
  return (request, response, next) => {
    const port = options.staffPin;
    if (
      port === undefined ||
      request.method !== "POST" ||
      !fullSignInMutationPaths.has(request.path)
    ) {
      next();
      return;
    }
    const session = requestCookie(request, sessionCookieName);
    if (session === null) {
      next();
      return;
    }
    void retryTransactionConflict(() =>
      port.requiresFullSignIn({ sessionCookie: session, csrf: exactHeader(request, "x-bop-csrf") }),
    )
      .then((required) => {
        if (!required) {
          next();
          return;
        }
        response
          .status(403)
          .set("Cache-Control", NO_STORE)
          .json({ error: "full_sign_in_required" });
      })
      .catch(() => {
        response
          .status(503)
          .set("Cache-Control", NO_STORE)
          .json({ error: "staff_pin_unavailable" });
      });
  };
}

function failure(response: Response, error: unknown, notFound = "not_found") {
  response.set("Cache-Control", NO_STORE);
  if (!(error instanceof MerchantStaffPinError)) {
    response.status(503).json({ error: "staff_pin_unavailable" });
    return;
  }
  switch (error.code) {
    case "Denied":
      response.status(403).json({ error: "request_denied" });
      return;
    case "FullSignInRequired":
      response.status(403).json({ error: "full_sign_in_required" });
      return;
    case "DeviceNotRegistered":
      response.status(404).json({ error: "device_not_registered" });
      return;
    case "NotFound":
      response.status(404).json({ error: notFound });
      return;
    case "AlreadyRegistered":
      response.status(409).json({ error: "device_already_registered" });
      return;
    case "NotSet":
      response.status(409).json({ error: "pin_not_set" });
      return;
    default:
      response.status(503).json({ error: "staff_pin_unavailable" });
  }
}

export function installMerchantStaffPinRoutes(
  router: Router,
  options: MerchantStaffPinRouteOptions,
): void {
  const port = () => options.staffPin;
  const unavailable = (response: Response, error = "staff_pin_unavailable") =>
    response.status(503).set("Cache-Control", NO_STORE).json({ error });

  // The lock screen of a registered tablet (no session needed).
  router.get("/staff-switch", readGuard(options), (request, response) => {
    const staffPin = port();
    if (staffPin === undefined) {
      unavailable(response, "staff_switch_unavailable");
      return;
    }
    const secret = requestCookie(request, storeDeviceCookieName);
    void retryTransactionConflict(() => staffPin.switchScreen(secret))
      .then((screen) =>
        response
          .set("Cache-Control", NO_STORE)
          .json({ ...screen, fullSignIn: { ...options.fullSignIn } }),
      )
      .catch((error: unknown) => {
        if (error instanceof MerchantStaffPinError && error.code === "DeviceNotRegistered") {
          if (secret !== null) response.set("Set-Cookie", clearDeviceCookie);
          response
            .status(404)
            .set("Cache-Control", NO_STORE)
            .json({ error: "device_not_registered", fullSignIn: { ...options.fullSignIn } });
          return;
        }
        unavailable(response, "staff_switch_unavailable");
      });
  });

  router.post("/staff-switch/unlock", mutationGuard(options), json, (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const staffPin = port();
    if (staffPin === undefined) {
      unavailable(response, "staff_switch_unavailable");
      return;
    }
    const input = body(request, ["choice", "pin"]);
    if (input === null) {
      denied(response);
      return;
    }
    const secret = requestCookie(request, storeDeviceCookieName);
    if (secret === null) {
      response.status(404).json({ error: "device_not_registered" });
      return;
    }
    void retryTransactionConflict(() =>
      staffPin.unlock({
        deviceCookie: secret,
        sessionCookie: requestCookie(request, sessionCookieName),
        choice: input.choice,
        pin: input.pin,
      }),
    )
      .then((result) => {
        switch (result.status) {
          case "SignedIn":
            response
              .set("Set-Cookie", sessionCookie(result.sessionCookie))
              .json({ status: "SignedIn", next: "/operations/orders" });
            return;
          case "Rejected":
            response.status(401).json({ error: "pin_rejected" });
            return;
          case "Locked":
            response.status(423).json({ error: "pin_locked", lockedUntil: result.lockedUntil });
            return;
          case "Throttled":
            response
              .status(429)
              .set("Retry-After", String(result.retryAfterSeconds))
              .json({ error: "device_busy", retryAfterSeconds: result.retryAfterSeconds });
            return;
        }
      })
      .catch((error: unknown) => {
        if (error instanceof MerchantStaffPinError && error.code === "DeviceNotRegistered") {
          response.set("Set-Cookie", clearDeviceCookie).status(404).json({
            error: "device_not_registered",
          });
          return;
        }
        if (error instanceof MerchantStaffPinError && error.code === "Denied") {
          denied(response);
          return;
        }
        unavailable(response, "staff_switch_unavailable");
      });
  });

  router.get("/staff-pin", readGuard(options), (request, response) => {
    const staffPin = port();
    const session = requestCookie(request, sessionCookieName);
    if (staffPin === undefined) {
      unavailable(response);
      return;
    }
    if (session === null) {
      denied(response);
      return;
    }
    void retryTransactionConflict(() => staffPin.ownPin({ sessionCookie: session }))
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch((error: unknown) => failure(response, error));
  });

  router.post("/staff-pin", mutationGuard(options), json, (request, response) => {
    const staffPin = port();
    const session = requestCookie(request, sessionCookieName);
    const csrf = exactHeader(request, "x-bop-csrf");
    const input = body(request, ["pin", "confirmation"]);
    if (staffPin === undefined) {
      unavailable(response);
      return;
    }
    if (session === null || csrf === null || csrf.length === 0 || input === null) {
      denied(response);
      return;
    }
    void retryTransactionConflict(() =>
      staffPin.setOwnPin({
        sessionCookie: session,
        csrf,
        pin: input.pin,
        confirmation: input.confirmation,
      }),
    )
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        if ("problem" in result) {
          response.status(422).json({ error: "pin_invalid", reason: result.problem });
          return;
        }
        response.json({ pin: result });
      })
      .catch((error: unknown) => failure(response, error));
  });

  router.get("/store-devices", readGuard(options), (request, response) => {
    const staffPin = port();
    const session = requestCookie(request, sessionCookieName);
    if (staffPin === undefined) {
      unavailable(response);
      return;
    }
    if (session === null) {
      denied(response);
      return;
    }
    void retryTransactionConflict(() =>
      staffPin.overview({
        sessionCookie: session,
        deviceCookie: requestCookie(request, storeDeviceCookieName),
      }),
    )
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch((error: unknown) => failure(response, error));
  });

  router.post("/store-devices/register", mutationGuard(options), json, (request, response) => {
    const staffPin = port();
    const session = requestCookie(request, sessionCookieName);
    const csrf = exactHeader(request, "x-bop-csrf");
    const input = body(request, ["label"]);
    if (staffPin === undefined) {
      unavailable(response);
      return;
    }
    if (session === null || csrf === null || csrf.length === 0 || input === null) {
      denied(response);
      return;
    }
    void retryTransactionConflict(() =>
      staffPin.registerDevice({
        sessionCookie: session,
        csrf,
        deviceCookie: requestCookie(request, storeDeviceCookieName),
        label: input.label,
      }),
    )
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        if (result.status === "LabelInvalid") {
          response.status(422).json({ error: "label_invalid" });
          return;
        }
        response
          .status(201)
          .set("Set-Cookie", deviceCookie(result.deviceCookie))
          .json({ device: result.device });
      })
      .catch((error: unknown) => failure(response, error));
  });

  router.post("/store-devices/revoke", mutationGuard(options), json, (request, response) => {
    const staffPin = port();
    const session = requestCookie(request, sessionCookieName);
    const csrf = exactHeader(request, "x-bop-csrf");
    const input = body(request, ["device"]);
    if (staffPin === undefined) {
      unavailable(response);
      return;
    }
    if (session === null || csrf === null || csrf.length === 0 || input === null) {
      denied(response);
      return;
    }
    void retryTransactionConflict(() =>
      staffPin.revokeDevice({
        sessionCookie: session,
        csrf,
        deviceCookie: requestCookie(request, storeDeviceCookieName),
        device: input.device,
      }),
    )
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        if (result.thisDevice) response.set("Set-Cookie", clearDeviceCookie);
        response.json({ revoked: true, signedOut: result.signedOut });
      })
      .catch((error: unknown) => failure(response, error, "device_not_found"));
  });

  router.post("/staff-pins/reset", mutationGuard(options), json, (request, response) => {
    const staffPin = port();
    const session = requestCookie(request, sessionCookieName);
    const csrf = exactHeader(request, "x-bop-csrf");
    const input = body(request, ["staff"]);
    if (staffPin === undefined) {
      unavailable(response);
      return;
    }
    if (session === null || csrf === null || csrf.length === 0 || input === null) {
      denied(response);
      return;
    }
    void retryTransactionConflict(() =>
      staffPin.resetPin({ sessionCookie: session, csrf, staff: input.staff }),
    )
      .then((pin) => response.set("Cache-Control", NO_STORE).json({ pin }))
      .catch((error: unknown) => failure(response, error, "staff_not_found"));
  });
}
