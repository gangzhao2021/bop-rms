import { escalationReasons, type EscalationReason } from "./ordinary-refund-client.js";

/**
 * WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): second-factor re-verification of the signed-in staff
 * member, the Store's refunds awaiting an Owner/Finance approval, and the in-person approval that
 * sends the refund. The six-digit code is sent once and never kept, logged or shown again.
 */
export type StepUpPurpose = "RefundRequest" | "RefundApproval";
export type StepUpFailure =
  "CodeRejected" | "CodeAlreadyUsed" | "TooManyAttempts" | "NotSetUp" | "Denied" | "Unavailable";
export class StepUpError extends Error {
  constructor(
    readonly code: StepUpFailure,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super("Verification was not accepted");
    this.name = "StepUpError";
  }
}
export type ApprovalFailure =
  "Denied" | "SamePerson" | "NeedsReverification" | "Changed" | "Unavailable" | "OutcomeUnknown";
export class RefundApprovalClientError extends Error {
  constructor(
    readonly code: ApprovalFailure,
    readonly party: "Requester" | "Approver" | "Both" | null = null,
  ) {
    super("Refund approval could not be confirmed");
    this.name = "RefundApprovalClientError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const invalid = (): never => {
  throw new RefundApprovalClientError("Unavailable");
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : invalid());
const instant = (value: unknown) =>
  typeof value === "string" && instantPattern.test(value) && new Date(value).toISOString() === value
    ? value
    : invalid();
const nullable = <T>(value: unknown, parse: (v: unknown) => T): T | null =>
  value === null ? null : parse(value);
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= 120 &&
  !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : invalid();
const money = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value) ? value : invalid();
const csrfPattern = /^[A-Za-z0-9_-]{43}$/u;

async function body(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.toLowerCase().startsWith("application/json") !== true)
    return null;
  const raw = await response.text();
  if (raw.length > 300_000) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
const errorCode = (value: unknown) =>
  value && typeof value === "object" && "error" in value && typeof value.error === "string"
    ? value.error
    : null;

export interface RefundApprovalEntry {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly requestReference: string;
  readonly paymentIntentReferences: readonly string[];
  readonly currencyCode: "CAD";
  readonly amountMinor: string;
  readonly reasonCode: string;
  readonly escalationReasons: readonly EscalationReason[];
  readonly requestedAt: string;
  readonly requesterName: string | null;
  readonly requestedByYou: boolean;
  readonly requesterVerifiedUntil: string | null;
  readonly state: "AwaitingApproval" | "Approved";
  readonly approvalReference: string | null;
  readonly approvedAt: string | null;
  readonly approverName: string | null;
  readonly canApprove: boolean;
}

function entry(value: unknown): RefundApprovalEntry {
  const raw = record(value, [
    "orderReference",
    "orderNumber",
    "requestReference",
    "paymentIntentReferences",
    "currencyCode",
    "amountMinor",
    "reasonCode",
    "escalationReasons",
    "requestedAt",
    "requesterName",
    "requestedByYou",
    "requesterVerifiedUntil",
    "state",
    "approvalReference",
    "approvedAt",
    "approverName",
    "canApprove",
  ]);
  if (
    raw.currencyCode !== "CAD" ||
    (raw.state !== "AwaitingApproval" && raw.state !== "Approved") ||
    typeof raw.requestedByYou !== "boolean" ||
    typeof raw.canApprove !== "boolean" ||
    typeof raw.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
    !Array.isArray(raw.paymentIntentReferences) ||
    raw.paymentIntentReferences.length < 1 ||
    raw.paymentIntentReferences.length > 100 ||
    !Array.isArray(raw.escalationReasons) ||
    raw.escalationReasons.some((r) => !escalationReasons.includes(r as EscalationReason)) ||
    (raw.state === "Approved") !== (raw.approvalReference !== null) ||
    (raw.approvalReference === null) !== (raw.approvedAt === null)
  )
    return invalid();
  return Object.freeze({
    orderReference: ref(raw.orderReference),
    orderNumber: text(raw.orderNumber),
    requestReference: ref(raw.requestReference),
    paymentIntentReferences: Object.freeze(raw.paymentIntentReferences.map(ref)),
    currencyCode: "CAD" as const,
    amountMinor: money(raw.amountMinor),
    reasonCode: raw.reasonCode,
    escalationReasons: Object.freeze([...(raw.escalationReasons as EscalationReason[])]),
    requestedAt: instant(raw.requestedAt),
    requesterName: nullable(raw.requesterName, text),
    requestedByYou: raw.requestedByYou,
    requesterVerifiedUntil: nullable(raw.requesterVerifiedUntil, instant),
    state: raw.state,
    approvalReference: nullable(raw.approvalReference, ref),
    approvedAt: nullable(raw.approvedAt, instant),
    approverName: nullable(raw.approverName, text),
    canApprove: raw.canApprove,
  });
}

export function createRefundApprovalClient(fetcher: typeof fetch = fetch) {
  const request = async (path: string, init: RequestInit, signal?: AbortSignal) => {
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    try {
      return await fetcher(path, {
        ...init,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  return Object.freeze({
    /** Re-verify the signed-in staff member. The code is sent once and not retained. */
    async stepUp(purpose: StepUpPurpose, code: string, csrf: string, signal?: AbortSignal) {
      if (!/^[0-9]{6}$/u.test(code)) throw new StepUpError("CodeRejected");
      if (!csrfPattern.test(csrf)) throw new StepUpError("Unavailable");
      let response: Response;
      try {
        response = await request(
          "/merchant/identity/step-up",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": csrf,
            },
            body: JSON.stringify({ purpose, code }),
          },
          signal,
        );
      } catch {
        throw new StepUpError("Unavailable");
      }
      const data = await body(response);
      if (response.status === 200) {
        try {
          const raw = record(data, ["status", "verifiedAt", "validUntil"]);
          if (raw.status !== "Verified") return invalid();
          return Object.freeze({
            verifiedAt: instant(raw.verifiedAt),
            validUntil: instant(raw.validUntil),
          });
        } catch {
          throw new StepUpError("Unavailable");
        }
      }
      const code_ = errorCode(data);
      if (response.status === 422)
        throw new StepUpError(code_ === "code_already_used" ? "CodeAlreadyUsed" : "CodeRejected");
      if (response.status === 429) {
        const seconds =
          data && typeof data === "object" && "retryAfterSeconds" in data
            ? Number(data.retryAfterSeconds)
            : NaN;
        throw new StepUpError(
          "TooManyAttempts",
          Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : null,
        );
      }
      if (response.status === 503 && code_ === "step_up_not_set_up")
        throw new StepUpError("NotSetUp");
      if (response.status === 401 || response.status === 403) throw new StepUpError("Denied");
      throw new StepUpError("Unavailable");
    },
    /** Refunds at the selected Store awaiting approval, or approved and not yet sent. */
    async approvals(signal?: AbortSignal) {
      let response: Response;
      try {
        response = await request(
          "/merchant/payments/refunds/approvals",
          { method: "GET", headers: { Accept: "application/json" } },
          signal,
        );
      } catch {
        throw new RefundApprovalClientError("Unavailable");
      }
      if (response.status === 401 || response.status === 403)
        throw new RefundApprovalClientError("Denied");
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
        throw new RefundApprovalClientError("Unavailable");
      const raw = record(await body(response), ["observedAt", "canApprove", "entries"]);
      if (
        typeof raw.canApprove !== "boolean" ||
        !Array.isArray(raw.entries) ||
        raw.entries.length > 100
      )
        return invalid();
      const entries = raw.entries.map(entry);
      if (new Set(entries.map((e) => e.requestReference)).size !== entries.length) return invalid();
      return Object.freeze({
        observedAt: instant(raw.observedAt),
        canApprove: raw.canApprove,
        entries: Object.freeze(entries),
      });
    },
    /**
     * Approve in person and send at once. Retry with the same approval reference after an unknown
     * result: the server reuses the same approval, operation and send, so it never refunds twice.
     */
    async approve(
      command: { orderReference: string; requestReference: string; approvalReference: string },
      csrf: string,
      signal?: AbortSignal,
    ) {
      const payload = JSON.stringify({
        orderReference: ref(command.orderReference),
        requestReference: ref(command.requestReference),
        approvalReference: ref(command.approvalReference),
      });
      if (!csrfPattern.test(csrf)) throw new RefundApprovalClientError("Unavailable");
      let response: Response;
      try {
        response = await request(
          "/merchant/payments/refunds/approve",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": csrf,
            },
            body: payload,
          },
          signal,
        );
      } catch {
        throw new RefundApprovalClientError("OutcomeUnknown");
      }
      const data = await body(response);
      if (response.status === 202) {
        try {
          const raw = record(data, ["status", "approvalReference", "replayed", "payments"]);
          if (
            raw.status !== "Approved" ||
            raw.approvalReference !== command.approvalReference ||
            typeof raw.replayed !== "boolean" ||
            !Array.isArray(raw.payments) ||
            raw.payments.length < 1 ||
            raw.payments.length > 100
          )
            return invalid();
          return Object.freeze({
            replayed: raw.replayed,
            payments: Object.freeze(
              raw.payments.map((value) => {
                const payment = record(value, [
                  "paymentAttemptReference",
                  "operationReference",
                  "state",
                ]);
                if (payment.state !== "SendRecorded" && payment.state !== "ResultUnknown")
                  return invalid();
                return Object.freeze({
                  paymentAttemptReference: ref(payment.paymentAttemptReference),
                  operationReference: ref(payment.operationReference),
                  state: payment.state,
                });
              }),
            ),
          });
        } catch {
          throw new RefundApprovalClientError("OutcomeUnknown");
        }
      }
      const error = errorCode(data);
      if (response.status === 422 && error === "same_person")
        throw new RefundApprovalClientError("SamePerson");
      if (response.status === 409 && error === "needs_reverification") {
        const party =
          data && typeof data === "object" && "party" in data ? (data.party as unknown) : null;
        throw new RefundApprovalClientError(
          "NeedsReverification",
          party === "Requester" || party === "Approver" || party === "Both" ? party : "Both",
        );
      }
      if (response.status === 409) throw new RefundApprovalClientError("Changed");
      if (response.status === 401 || response.status === 403)
        throw new RefundApprovalClientError("Denied");
      throw new RefundApprovalClientError("OutcomeUnknown");
    },
  });
}
