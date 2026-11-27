import { t } from "./i18n/i18n.js";
/**
 * WP-2423 DEC-KITCHEN-STALE-TICKETS: close a kitchen ticket left open from an earlier business day.
 * The browser sends intent only; actor, Store, time and business days are decided by the server.
 */
export type KitchenStaleCloseReason =
  "ALREADY_SERVED" | "CANCELLED_ELSEWHERE" | "NOT_MADE_ABANDONED";

export const kitchenStaleCloseReasonLabels: Readonly<Record<KitchenStaleCloseReason, string>> =
  Object.freeze({
    ALREADY_SERVED: t("Already served or handed over"),
    CANCELLED_ELSEWHERE: t("Order cancelled elsewhere"),
    NOT_MADE_ABANDONED: t("Not made — order abandoned"),
  });

export interface KitchenStaleCloseBody {
  readonly idempotencyKey: string;
  readonly ticketReference: string;
  readonly expectedTicketVersion: string;
  readonly reasonCode: KitchenStaleCloseReason;
  readonly correlationReference: string;
}

export class KitchenStaleCloseClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "NotEarlierDay"
      | "NothingOpen"
      | "OutcomeUnknown",
  ) {
    super(t("Kitchen ticket was not closed"));
    this.name = "KitchenStaleCloseClientError";
  }
}

const fail = (code: KitchenStaleCloseClientError["code"]): never => {
  throw new KitchenStaleCloseClientError(code);
};

/** One immutable body per intent, so a lost answer is retried as the same close. */
export function createKitchenStaleCloseClient(options: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  return Object.freeze({
    async close(body: KitchenStaleCloseBody): Promise<{ readonly status: string }> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(options.csrf)) return fail("Invalid");
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetcher("/merchant/kitchen/stale-ticket/close", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": options.csrf,
          },
          body: JSON.stringify(body),
        });
        if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
        if (response.status === 404) return fail("NotFound");
        if (response.status === 409) return fail("Conflict");
        if (response.status === 400) return fail("Invalid");
        if (response.status === 422) {
          const error = (await response.json().catch(() => null)) as { error?: unknown } | null;
          return fail(
            error?.error === "KITCHEN_STALE_TICKET_NOTHING_OPEN" ? "NothingOpen" : "NotEarlierDay",
          );
        }
        if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json"))
          return fail("OutcomeUnknown");
        const text = await response.text();
        if (text.length > 65536) return fail("OutcomeUnknown");
        const raw = JSON.parse(text) as Record<string, unknown> | null;
        if (
          raw === null ||
          typeof raw !== "object" ||
          !["Closed", "AlreadyClosed"].includes(String(raw.status)) ||
          raw.ticketReference !== body.ticketReference
        )
          return fail("OutcomeUnknown");
        return Object.freeze({ status: String(raw.status) });
      } catch (error) {
        if (error instanceof KitchenStaleCloseClientError) throw error;
        return fail("OutcomeUnknown");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
