import { boundedFetch } from "../network/bounded-fetch.js";

/**
 * DEC-PILOT-NOTIFICATIONS R1 — IDR-0031 one-time order link, `https://<host>/resume#t=<token>`.
 *
 * The token is read from the fragment into memory and the address bar is cleaned at once
 * (`history.replaceState`), before anything else runs, so it never reaches history, the service
 * worker cache, telemetry, a Referrer or Web Storage. It is then sent once in a same-origin POST.
 */
const tokenFragment = /^#t=([A-Za-z0-9_-]{43})$/u;
const orderPath =
  /^\/orders\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const orderRecoveryPath = "/resume";

export function takeOrderRecoveryToken(input: {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly replaceState: (data: unknown, unused: string, url: string) => void;
}): string | null {
  if (input.pathname !== orderRecoveryPath) return null;
  const match = input.search === "" ? tokenFragment.exec(input.hash) : null;
  // Always clear the address bar, whatever it held.
  input.replaceState(null, "", orderRecoveryPath);
  return match?.[1] ?? null;
}

export type OrderRecoveryOutcome =
  | { readonly kind: "Open"; readonly path: string }
  | { readonly kind: "Expired" }
  | { readonly kind: "TooManyTries" }
  | { readonly kind: "TryAgain" };

export async function redeemOrderRecovery(
  request: typeof globalThis.fetch,
  token: string,
): Promise<OrderRecoveryOutcome> {
  let response: Response;
  try {
    response = await boundedFetch(request, "/api/v1/customer/order-recovery", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: "TryAgain" };
  }
  if (response.status === 429) return { kind: "TooManyTries" };
  if (response.status >= 500) return { kind: "TryAgain" };
  if (response.status !== 200) return { kind: "Expired" };
  const payload = (await response.json().catch(() => null)) as {
    schemaVersion?: unknown;
    redirectPath?: unknown;
  } | null;
  return payload?.schemaVersion === 1 &&
    typeof payload.redirectPath === "string" &&
    orderPath.test(payload.redirectPath)
    ? { kind: "Open", path: payload.redirectPath }
    : { kind: "Expired" };
}
