import { parsePickupReference, type PickupQueueItem } from "./pickup.js";

/**
 * WP-2423: what staff compare when they check a pickup customer in person: the name on the order
 * and the last four digits of its phone. Held in memory for the open dialog only.
 */
export type PickupIdentityDetails =
  | { readonly status: "Available"; readonly name: string; readonly phoneLast4: string | null }
  | { readonly status: "Removed" }
  | { readonly status: "NotGiven" };

export type PickupIdentityOutcome =
  PickupIdentityDetails | { readonly status: "NotEligible" } | { readonly status: "Unavailable" };

function parse(raw: unknown): PickupIdentityDetails | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>,
    keys = Object.keys(r).sort().join(",");
  if ((r.status === "Removed" || r.status === "NotGiven") && keys === "status")
    return Object.freeze({ status: r.status });
  if (
    r.status === "Available" &&
    keys === "name,phoneLast4,status" &&
    typeof r.name === "string" &&
    r.name.trim().length > 0 &&
    r.name.length <= 200 &&
    (r.phoneLast4 === null || (typeof r.phoneLast4 === "string" && /^[0-9]{4}$/.test(r.phoneLast4)))
  )
    return Object.freeze({ status: "Available", name: r.name.trim(), phoneLast4: r.phoneLast4 });
  return null;
}

export async function readPickupIdentityCheck(
  input: { item: PickupQueueItem; storeReference: string; csrf: string; signal?: AbortSignal },
  fetcher: typeof fetch = fetch,
): Promise<PickupIdentityOutcome> {
  let body: string;
  try {
    body = JSON.stringify({
      orderReference: parsePickupReference(input.item.orderReference),
      storeReference: parsePickupReference(input.storeReference),
      fulfillmentReference: parsePickupReference(input.item.fulfillmentReference),
    });
  } catch {
    return { status: "Unavailable" };
  }
  try {
    const response = await fetcher("/merchant/pickup/identity-check", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-BOP-CSRF": input.csrf,
      },
      body,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status === 422 || response.status === 409) return { status: "NotEligible" };
    if (!response.ok) return { status: "Unavailable" };
    const text = await response.text();
    if (text.length > 2048) return { status: "Unavailable" };
    return parse(JSON.parse(text)) ?? { status: "Unavailable" };
  } catch {
    return { status: "Unavailable" };
  }
}
