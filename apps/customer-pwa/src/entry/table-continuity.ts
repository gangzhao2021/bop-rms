import { boundedFetch } from "../network/bounded-fetch.js";
import { getCustomerCsrfCredential } from "../session/customer-transaction-context.js";

/**
 * WP-2423 shared-table-checkout (b), lost cookie: a seated phone keeps a continuity token in this
 * page's own storage (never a URL, a log or analytics). If the cookie is later lost, the next scan
 * of the table code sends it, and the phone is the same one at the table again, with the dishes it
 * added. Storage that can't be used (a private window, blocked site data) just means a re-scan
 * joins as a new phone, as before: nothing here ever stops ordering.
 */
const key = "bop.customer.table-continuity";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export function readContinuityToken(): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value !== null && tokenPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}
export function rememberContinuityToken(token: unknown): void {
  if (typeof token !== "string" || !tokenPattern.test(token)) return;
  try {
    window.localStorage.setItem(key, token);
  } catch {
    // Storage unavailable: a lost cookie later means joining again, as before.
  }
}

let asking: Promise<void> | null = null;
/**
 * Once this phone is seated: ask for its continuity token (one per seated session). A failure is
 * silent and asked again on the next seat; it never blocks the guest.
 */
export function refreshContinuityToken(
  request: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  asking ??= (async () => {
    const csrf = getCustomerCsrfCredential();
    if (csrf === null || !tokenPattern.test(csrf)) return;
    try {
      const response = await boundedFetch(request, "/api/v1/dine-in/continuity", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: "{}",
      });
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as {
        continuityToken?: unknown;
      } | null;
      rememberContinuityToken(body?.continuityToken);
    } catch {
      // Offline or the store's side: asked again on the next seat.
    }
  })().finally(() => {
    asking = null;
  });
  return asking;
}
