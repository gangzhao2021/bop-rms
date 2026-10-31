/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a: the Brand's Owner opens another
 * Store. A retried request (the same operation) answers from the record, never opening twice.
 */
export class StoreOpeningClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "Invalid"
      | "CodeTaken"
      | "Conflict"
      /** No answer: send the same opening (its operation) again; it is never recorded twice. */
      | "OutcomeUnknown"
      | "Unavailable",
  ) {
    super(code);
    this.name = "StoreOpeningClientError";
  }
}
export const storeOpeningTimeZones = [
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Regina",
  "America/Halifax",
  "America/St_Johns",
  "America/Moncton",
  "America/Whitehorse",
] as const;
export const storeOpeningLocales = ["en-CA", "fr-CA"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Coordinator 2026-10-31 decision 3: whether the server says this person may open a Store (Brand
 * Owner authority). Any failure is "no": the form is simply not offered.
 */
export async function mayOpenStore(csrf: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher("/merchant/organization/stores/may-open", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-bop-csrf": csrf },
      body: "{}",
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as { mayOpen?: unknown } | null;
    return payload?.mayOpen === true;
  } catch {
    return false;
  }
}

export async function openStore(
  csrf: string,
  input: {
    readonly operationReference: string;
    readonly code: string;
    readonly displayName: string;
    readonly timeZone: string;
    readonly locale: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ readonly status: "Opened" | "AlreadyOpened"; readonly storeReference: string }> {
  let response: Response;
  try {
    response = await fetcher("/merchant/organization/stores", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-bop-csrf": csrf },
      body: JSON.stringify(input),
    });
  } catch {
    throw new StoreOpeningClientError("OutcomeUnknown");
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    if (
      (payload?.status !== "Opened" && payload?.status !== "AlreadyOpened") ||
      typeof payload.storeReference !== "string" ||
      !uuid.test(payload.storeReference)
    )
      throw new StoreOpeningClientError("OutcomeUnknown");
    return Object.freeze({ status: payload.status, storeReference: payload.storeReference });
  }
  if (response.status === 403) throw new StoreOpeningClientError("PermissionDenied");
  if (payload?.error === "store_opening_invalid") throw new StoreOpeningClientError("Invalid");
  if (payload?.error === "store_code_taken") throw new StoreOpeningClientError("CodeTaken");
  if (payload?.error === "store_opening_conflict") throw new StoreOpeningClientError("Conflict");
  throw new StoreOpeningClientError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
}
