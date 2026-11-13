import { timingSafeEqual } from "node:crypto";
import { parseGuestRawCredential, type GuestSessionCredentialPort } from "@bop/identity";
import { earlierVisitsCookieName } from "./customer-entry.js";

/**
 * WP-2423 (b11 guest-and-staff-wording): a guest who paid a pickup order and then joined a table at
 * the same Store keeps that pickup visit on the phone (the entry's `__Host-bop-visits` cookie). Its
 * order page, pickup code and "remove my contact details" answer for that kept visit, not "this
 * order isn't available on this phone", the same way its receipt already does.
 */
const credential = /^[A-Za-z0-9_-]{43}$/u;

/** The earlier visits this phone keeps (at most two), never the current one. */
export function earlierVisitCredentials(header: unknown, current: string): string[] {
  if (typeof header !== "string" || header.length > 8192) return [];
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(earlierVisitsCookieName + "="))
    .map((part) => part.slice(earlierVisitsCookieName.length + 1));
  if (values.length !== 1) return [];
  return (values[0] ?? "")
    .split(".")
    .slice(0, 2)
    .filter((value) => credential.test(value) && value !== current);
}

export interface CustomerVisitInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly orderReference: string;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The request for the same order under an earlier visit this phone keeps, with that visit's own
 * foreground CSRF derived on the server. Only a request that proved the current visit (its CSRF is
 * the current Session's) may use it; the owner checks of the read or command then run as usual.
 * Null: no derivation is configured, or the request did not prove the current visit.
 */
export function earlierVisitInput(
  credentials: Pick<GuestSessionCredentialPort, "deriveForegroundCsrf">,
  input: CustomerVisitInput,
  earlierCredential: string,
): CustomerVisitInput | null {
  const derive = credentials.deriveForegroundCsrf;
  if (derive === undefined) return null;
  try {
    const current = String(
      derive.call(credentials, parseGuestRawCredential(input.sessionCredential)),
    );
    if (!same(current, input.csrfCredential)) return null;
    const earlier = parseGuestRawCredential(earlierCredential);
    return Object.freeze({
      sessionCredential: String(earlier),
      csrfCredential: String(derive.call(credentials, earlier)),
      orderReference: input.orderReference,
    });
  } catch {
    return null;
  }
}
