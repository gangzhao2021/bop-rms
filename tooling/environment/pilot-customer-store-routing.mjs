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
 *   choose the Store; that Store's runtime verifies the signature and the table);
 * - every other guest request: the Store whose own records hold the guest's Session (the guest
 *   cookie, hashed with the installation's guest key, looked up through Identity's Store-scoped
 *   owner read in each Store in turn; a found answer is remembered for that Session);
 * - otherwise (no Session, unknown token or reference): the installation's first Store, which
 *   answers as a single-Store installation would (a refusal for anything not its own).
 */
const GUEST_COOKIE = "__Host-bop-guest";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MENU = /^\/api\/v1\/public\/stores\/([^/?]+)\/menu(?:[?].*)?$/u;
const ENTRY = /^\/bff\/customer\/entry(?:[?].*)?$/u;
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
/** The public Store reference a QR token's payload names (unverified; only to choose the Store). */
export function qrTokenPublicStore(body) {
  try {
    const token = JSON.parse(body.toString("utf8"))?.qrToken;
    if (typeof token !== "string" || token.length > 4096) return null;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof payload?.publicStoreReference === "string" ? payload.publicStoreReference : null;
  } catch {
    return null;
  }
}

/**
 * `stores`: the installation's Stores, its own first: { storeReference, brandReference,
 * publicStoreReference, target, transactions, hashSession(cookie) → hex selector }.
 */
export function createCustomerStoreRouting({ stores, cacheLimit = 10_000 }) {
  if (!Array.isArray(stores) || stores.length < 1)
    throw new Error("CUSTOMER_STORE_ROUTING_INVALID");
  const primary = stores[0];
  const sessionStores = new Map();
  const remember = (selector, store) => {
    if (sessionStores.size >= cacheLimit) sessionStores.delete(sessionStores.keys().next().value);
    sessionStores.set(selector, store);
  };
  const byPublic = new Map(stores.map((store) => [store.publicStoreReference, store]));
  const owners = stores.map((store) => ({
    store,
    sessions: createPostgresGuestSessionEntryStore(store.transactions, {
      brandReference: store.brandReference,
      storeReference: store.storeReference,
    }),
  }));
  /** The Store a request goes to (its `target`). */
  return async function storeOf({ method, url, cookie, body }) {
    if (stores.length === 1) return primary;
    const menu = typeof url === "string" ? MENU.exec(url) : null;
    if (menu) return byPublic.get(decodeURIComponent(menu[1])) ?? primary;
    if (isBodyRouted(method, url) && body !== undefined) {
      const reference = qrTokenPublicStore(body);
      return (reference !== null && UUID_V7.test(reference) && byPublic.get(reference)) || primary;
    }
    const credential = guestCookie(cookie);
    if (credential === null) return primary;
    let selector;
    try {
      selector = primary.hashSession(credential);
    } catch {
      return primary;
    }
    const known = sessionStores.get(selector);
    if (known !== undefined) return known;
    for (const { store, sessions } of owners) {
      const found = await sessions.resolve(selector).catch(() => null);
      if (found !== null) {
        remember(selector, store);
        return store;
      }
    }
    return primary;
  };
}
