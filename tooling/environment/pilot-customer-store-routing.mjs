import { Buffer } from "node:buffer";
import { createPostgresGuestSessionEntryStore } from "../../packages/bop/identity/src/index.ts";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 4: which of the installation's Stores a
 * guest request belongs to, from server-side facts only, so it reaches that Store's own customer
 * API (each Store's runtime then verifies everything itself, exactly as a single-Store
 * installation does):
 *
 * - the public menu: the Store whose public Store reference is in the path;
 * - the table or pickup entry: the public Store reference in the signed QR token (decoded only to
 *   choose the Store; that Store's runtime verifies the signature and the table); for a replay of a
 *   scan that started no visit yet (`{resume:true}`, M02), the token in the `__Secure-bop-scan`
 *   cookie. At an installation whose stores.json names several Stores (`multiStore`, even when
 *   only one of them is served now), a scan or replay naming a Store not served right now (it
 *   failed to load) answers 503 CUSTOMER_STORE_UNAVAILABLE: a retryable outage, never another
 *   Store (which would refuse the code and lose the guest's place) nor "scan the code";
 * - every other guest request: the Store whose own records hold the guest's Session (the guest
 *   cookie, hashed with the installation's guest key, looked up through Identity's Store-scoped
 *   owner read in each Store in turn; a found answer is remembered for that Session);
 * - otherwise (no Session, unknown token or reference): the installation's first Store, which
 *   answers as a single-Store installation would (a refusal for anything not its own). With Stores
 *   of more than one Tenant (DEC-MULTI-MERCHANT-ONE-INSTALLATION) no merchant answers for a request
 *   that isn't its own: null, and the entry refuses it without reaching any Store.
 */
const GUEST_COOKIE = "__Host-bop-guest";
const SCAN_COOKIE = "__Secure-bop-scan";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MENU = /^\/api\/v1\/public\/stores\/([^/?]+)\/menu(?:[?].*)?$/u;
const ENTRY = /^\/bff\/customer\/entry(?:[?].*)?$/u;
/**
 * What a fresh browser reads before it belongs to any Store: its CSRF token and how the app takes
 * payment (the public mode and publishable key). They name no merchant's data.
 */
const BEFORE_ANY_STORE =
  /^\/(?:api\/v1\/customer\/session\/csrf|bff\/customer\/payment-configuration)(?:[?].*)?$/u;
/** Requests whose Store is in their body (read before forwarding, at most this many bytes). */
export const bodyRoutedLimit = 16 * 1024;
export const isBodyRouted = (method, url) => method === "POST" && ENTRY.test(url);

function guestCookie(header) {
  if (typeof header !== "string" || header.length > 8192) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(GUEST_COOKIE + "="));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(GUEST_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
function tokenPublicStore(token) {
  try {
    if (typeof token !== "string" || token.length > 4096) return null;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof payload?.publicStoreReference === "string" ? payload.publicStoreReference : null;
  } catch {
    return null;
  }
}
/** The public Store reference a QR token's payload names (unverified; only to choose the Store). */
export function qrTokenPublicStore(body) {
  try {
    return tokenPublicStore(JSON.parse(body.toString("utf8"))?.qrToken);
  } catch {
    return null;
  }
}
/** M02: whether an entry body replays this browser's waiting scan instead of carrying a code. */
function isResume(body) {
  try {
    return JSON.parse(body.toString("utf8"))?.resume === true;
  } catch {
    return false;
  }
}
/** The public Store reference of the one waiting-scan cookie (unverified), or null. */
function scanCookiePublicStore(header) {
  if (typeof header !== "string" || header.length > 8192) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(SCAN_COOKIE + "="));
  return matches.length === 1 ? tokenPublicStore(matches[0].slice(SCAN_COOKIE.length + 1)) : null;
}

/**
 * WP-2423 live minor 25: the waiting-scan cookie for a fresh scan answered "Store unavailable".
 * The app has already taken the code out of the address, and only a Store that answers sets this
 * cookie, so without it a reload during the outage had nothing to replay and asked the guest to
 * scan again. Exactly the cookie a Store's own entry sets (same name, attributes and lifetime, no
 * Domain), so the Store's own answer replaces or clears it once it is back. Only a code framed as
 * the Store's entry accepts it (at most 2048 characters, compact JWS framing with a 64-byte
 * signature); it is the guest's own code, unverified here and verified by the Store's runtime on
 * replay, and never logged. A replay (`{resume:true}`) or anything else sets nothing.
 */
const SCAN_COOKIE_ATTRIBUTES =
  "Max-Age=1800; Path=/bff/customer/entry; Secure; HttpOnly; SameSite=Strict";
const COMPACT_SEGMENT = /^[A-Za-z0-9_-]+$/u;
function compactFraming(value) {
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !COMPACT_SEGMENT.test(part))) return false;
  const bytes = Buffer.from(parts[2], "base64url");
  return bytes.length === 64 && bytes.toString("base64url") === parts[2];
}
export function outageScanCookie(body) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body ?? "").toString("utf8"));
  } catch {
    return null;
  }
  const token = parsed?.qrToken;
  if (parsed?.resume === true || typeof token !== "string" || token.length > 2048) return null;
  return compactFraming(token) ? SCAN_COOKIE + "=" + token + "; " + SCAN_COOKIE_ATTRIBUTES : null;
}

/**
 * What the installation answers when routing a request failed: a scan or replay of a Store not
 * served now is a retryable outage (a fresh scan keeps its code, `outageScanCookie`); anything
 * else is the internal API being unavailable, with nothing set.
 */
export function routingFailureAnswer(error, { method, url, body }) {
  if (error?.message !== "CUSTOMER_STORE_UNAVAILABLE")
    return { code: "INTERNAL_API_UNAVAILABLE", setCookie: null };
  return {
    code: "CUSTOMER_STORE_UNAVAILABLE",
    setCookie: isBodyRouted(method, url) ? outageScanCookie(body) : null,
  };
}

/**
 * `stores`: the installation's Stores, its own first: { storeReference, brandReference,
 * tenantReference, publicStoreReference, target, transactions, hashSession(cookie) → hex selector }.
 */
export function createCustomerStoreRouting({
  stores,
  // M02 (v15 07b7a1b7): stores.json names more than one Store, whichever of them are served now.
  multiStore = Array.isArray(stores) && stores.length > 1,
  cacheLimit = 10_000,
  createSessions = createPostgresGuestSessionEntryStore,
}) {
  if (!Array.isArray(stores) || stores.length < 1)
    throw new Error("CUSTOMER_STORE_ROUTING_INVALID");
  const primary = stores[0];
  const unowned = new Set(stores.map((store) => store.tenantReference)).size > 1 ? null : primary;
  const sessionStores = new Map();
  const remember = (selector, store) => {
    if (sessionStores.size >= cacheLimit) sessionStores.delete(sessionStores.keys().next().value);
    sessionStores.set(selector, store);
  };
  const byPublic = new Map(stores.map((store) => [store.publicStoreReference, store]));
  const owners = stores.map((store) => ({
    store,
    sessions: createSessions(store.transactions, {
      brandReference: store.brandReference,
      storeReference: store.storeReference,
    }),
  }));
  /** The Store a request goes to (its `target`). */
  /** The Store a scanned (or replayed) code names; null when the code names none. */
  const scannedStore = (reference) => {
    if (reference === null || !UUID_V7.test(reference)) return null;
    const store = byPublic.get(reference);
    // The Store the guest scanned isn't being served now (it failed to start): say so, keep the
    // scan for when it is back, and never hand it to a Store that would refuse it.
    if (store === undefined && multiStore) throw new Error("CUSTOMER_STORE_UNAVAILABLE");
    return store ?? null;
  };
  return async function storeOf({ method, url, cookie, body }) {
    const entry = isBodyRouted(method, url) && body !== undefined;
    if (entry && multiStore)
      return (
        scannedStore(isResume(body) ? scanCookiePublicStore(cookie) : qrTokenPublicStore(body)) ??
        unowned
      );
    if (stores.length === 1) return primary;
    const nobody = typeof url === "string" && BEFORE_ANY_STORE.test(url) ? primary : unowned;
    const menu = typeof url === "string" ? MENU.exec(url) : null;
    if (menu) return byPublic.get(decodeURIComponent(menu[1])) ?? unowned;
    if (entry) return scannedStore(qrTokenPublicStore(body)) ?? unowned;
    const credential = guestCookie(cookie);
    if (credential === null) return nobody;
    // Each Store's own hash of the cookie, in its own records (merchants don't share a guest key).
    for (const { store, sessions } of owners) {
      let selector;
      try {
        selector = store.hashSession(credential);
      } catch {
        continue;
      }
      const known = sessionStores.get(selector);
      if (known !== undefined) return known;
      const found = await sessions.resolve(selector).catch(() => null);
      if (found !== null) {
        remember(selector, store);
        return store;
      }
    }
    return nobody;
  };
}
