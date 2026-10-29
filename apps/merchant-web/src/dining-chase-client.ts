/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner decision 4): a server chases a dish not yet served;
 * the kitchen's ticket turns red and sounds. A round is chased at most once in any 5 minutes.
 */
export class DiningChaseClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotOffered"
      | "NotBeingMade"
      | "TooSoon"
      /** No answer: the same chase (its operation) is sent again, never twice recorded. */
      | "OutcomeUnknown"
      | "Unavailable",
    /** For TooSoon: when the round may be chased again. */
    readonly retryAt: string | null = null,
  ) {
    super(code);
    this.name = "DiningChaseClientError";
  }
}
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Chases one dish; how many times it has been chased now. */
export async function chaseDish(
  csrf: string,
  input: { readonly orderItemReference: string; readonly operationReference: string },
  fetcher: typeof fetch = fetch,
): Promise<{ readonly status: "Chased" | "AlreadyChased"; readonly chaseCount: number }> {
  let response: Response;
  try {
    response = await fetcher("/merchant/dining/chase", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-bop-csrf": csrf },
      body: JSON.stringify(input),
    });
  } catch {
    throw new DiningChaseClientError("OutcomeUnknown");
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    if (
      (payload?.status !== "Chased" && payload?.status !== "AlreadyChased") ||
      !Number.isSafeInteger(payload.chaseCount) ||
      Number(payload.chaseCount) < 1
    )
      throw new DiningChaseClientError("OutcomeUnknown");
    return Object.freeze({ status: payload.status, chaseCount: Number(payload.chaseCount) });
  }
  if (response.status === 403) throw new DiningChaseClientError("PermissionDenied");
  if (
    response.status === 429 &&
    typeof payload?.retryAt === "string" &&
    instant.test(payload.retryAt)
  )
    throw new DiningChaseClientError("TooSoon", payload.retryAt);
  if (payload?.error === "dining_chase_not_offered") throw new DiningChaseClientError("NotOffered");
  if (payload?.error === "dining_chase_not_being_made")
    throw new DiningChaseClientError("NotBeingMade");
  throw new DiningChaseClientError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
}
