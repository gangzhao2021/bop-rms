import { escalationReasons, type EscalationReason } from "./ordinary-refund-client.js";
import {
  FULL_SIGN_IN_REQUIRED,
  isFullSignInRequired,
  type FullSignInRequired,
} from "./full-sign-in.js";

/** WP-2423 Q5: why an owner declines a refund (codes stay server-owned). */
export const declineReasons = [
  "NOT_ELIGIBLE",
  "NEEDS_MORE_INFORMATION",
  "ENTERED_IN_ERROR",
  "CUSTOMER_WITHDREW",
] as const;
export type DeclineReason = (typeof declineReasons)[number];

/**
 * WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): second-factor re-verification of the signed-in staff
 * member, the Store's refunds awaiting an Owner/Finance approval, and the in-person approval that
 * sends the refund. The six-digit code is sent once and never kept, logged or shown again.
 */
export type StepUpPurpose =
  | "RefundRequest"
  | "RefundApproval"
  | "SoleOperatorSetting"
  | "SoleOperatorApproval"
  /** WP-2423: a PIN sign-in confirms it is the staff member before sensitive changes. */
  | "PinSessionElevation";
export const stepUpPurposes: readonly StepUpPurpose[] = Object.freeze([
  "RefundRequest",
  "RefundApproval",
  "SoleOperatorSetting",
  "SoleOperatorApproval",
  "PinSessionElevation",
]);
/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: how the signed-in staff member confirms it is them — the
 * six-digit authenticator code entered here, or signing in again (password and authenticator app).
 */
export type StepUpMethod = "Code" | "SignIn";
export interface StepUpState {
  readonly validUntil: string | null;
  readonly method: StepUpMethod;
}
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
  | "Denied"
  | "SamePerson"
  | "NeedsReverification"
  | "Changed"
  | "AlreadyPrepared"
  | "AlreadyDeclined"
  | "NotPermitted"
  | "RequesterNotEligible"
  /** WP-2423 Q19: self-approval asked for, but another person now holds refund approval. */
  | "SoleOperatorNotInEffect"
  /** WP-2423: refused on a PIN sign-in that is not confirmed yet (verify, then retry the same). */
  | FullSignInRequired
  | "Unavailable"
  | "OutcomeUnknown";
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
  /** WP-2423 item 4: refunded on the store's card machine (staff record it) or sent online. */
  readonly paymentMethod: "Online" | "CardMachine";
  readonly currencyCode: "CAD";
  readonly amountMinor: string;
  readonly reasonCode: string;
  /** Staff note of an "Other" reason (shown to staff only). */
  readonly note: string | null;
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
  /** WP-2423 Q19: approving this one is the Owner approving their own request (sole operator). */
  readonly soleOperatorApproval: boolean;
}
/** WP-2423 Q19: whether sole operator is in effect for the signed-in approver (null: not read). */
export type SoleOperatorStatus = "Effective" | "NotSet" | "OtherApprovers";

function entry(value: unknown): RefundApprovalEntry {
  const raw = record(value, [
    "orderReference",
    "orderNumber",
    "requestReference",
    "paymentIntentReferences",
    "paymentMethod",
    "currencyCode",
    "amountMinor",
    "reasonCode",
    "note",
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
    "soleOperatorApproval",
  ]);
  if (
    typeof raw.soleOperatorApproval !== "boolean" ||
    (raw.soleOperatorApproval && (!raw.requestedByYou || !raw.canApprove)) ||
    raw.currencyCode !== "CAD" ||
    (raw.paymentMethod !== "Online" && raw.paymentMethod !== "CardMachine") ||
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
    (raw.approvalReference === null) !== (raw.approvedAt === null) ||
    (raw.note !== null &&
      (typeof raw.note !== "string" ||
        raw.note.trim() === "" ||
        [...raw.note].length > 200 ||
        raw.reasonCode !== "OTHER"))
  )
    return invalid();
  return Object.freeze({
    orderReference: ref(raw.orderReference),
    orderNumber: text(raw.orderNumber),
    requestReference: ref(raw.requestReference),
    paymentIntentReferences: Object.freeze(raw.paymentIntentReferences.map(ref)),
    paymentMethod: raw.paymentMethod,
    currencyCode: "CAD" as const,
    amountMinor: money(raw.amountMinor),
    reasonCode: raw.reasonCode,
    note: raw.note as string | null,
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
    soleOperatorApproval: raw.soleOperatorApproval,
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
  const stepUpState = async (signal?: AbortSignal): Promise<StepUpState> => {
    let response: Response;
    try {
      response = await request(
        "/merchant/identity/step-up",
        { method: "GET", headers: { Accept: "application/json" } },
        signal,
      );
    } catch {
      throw new StepUpError("Unavailable");
    }
    if (response.status === 401 || response.status === 403) throw new StepUpError("Denied");
    if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
      throw new StepUpError("Unavailable");
    try {
      const data = await body(response);
      const withMethod = data !== null && typeof data === "object" && Object.hasOwn(data, "method");
      const raw = record(data, withMethod ? ["validUntil", "method"] : ["validUntil"]);
      const method = withMethod ? raw.method : "Code";
      if (method !== "Code" && method !== "SignIn") return invalid();
      return Object.freeze({ validUntil: nullable(raw.validUntil, instant), method });
    } catch {
      throw new StepUpError("Unavailable");
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
    /** WP-2423 Q5: the signed-in member's current verification (server-computed), or null. */
    async stepUpStatus(signal?: AbortSignal): Promise<string | null> {
      return (await stepUpState(signal)).validUntil;
    },
    /**
     * WP-2423 DEC-COGNITO-STORE-STAFF: the current verification and how this sign-in confirms it is
     * the person: the authenticator code here ("Code", also when the server does not say) or a
     * fresh sign-in with password and authenticator app ("SignIn").
     */
    stepUpState,
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
      const raw = record(await body(response), [
        "observedAt",
        "canApprove",
        "soleOperator",
        "entries",
      ]);
      if (
        (raw.soleOperator !== null &&
          raw.soleOperator !== "Effective" &&
          raw.soleOperator !== "NotSet" &&
          raw.soleOperator !== "OtherApprovers") ||
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
        soleOperator: raw.soleOperator as SoleOperatorStatus | null,
        entries: Object.freeze(entries),
      });
    },
    /**
     * Approve in person and send at once. Retry with the same approval reference after an unknown
     * result: the server reuses the same approval, operation and send, so it never refunds twice.
     */
    async approve(
      command: {
        orderReference: string;
        requestReference: string;
        approvalReference: string;
        /** WP-2423 Q19: the Owner confirms they approve their own request as sole operator. */
        soleOperator?: boolean;
      },
      csrf: string,
      signal?: AbortSignal,
    ) {
      const payload = JSON.stringify({
        orderReference: ref(command.orderReference),
        requestReference: ref(command.requestReference),
        approvalReference: ref(command.approvalReference),
        ...(command.soleOperator === true ? { approvalMode: "SoleOperator" } : {}),
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
                if (
                  payment.state !== "SendRecorded" &&
                  payment.state !== "Sending" &&
                  payment.state !== "ResultUnknown" &&
                  // WP-2423 item 4: approved; staff refund it on the store's card machine.
                  payment.state !== "RecordOnCardMachine"
                )
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
      return refusal(response.status, data);
    },
    /** WP-2423 Q5: decline a refund nothing was prepared for. Retry with the same operation. */
    async decline(
      command: {
        orderReference: string;
        requestReference: string;
        operationReference: string;
        reasonCode: DeclineReason;
        /** WP-2423 Q19: the Owner withdraws their own request as sole operator. */
        soleOperator?: boolean;
      },
      csrf: string,
      signal?: AbortSignal,
    ) {
      if (!declineReasons.includes(command.reasonCode) || !csrfPattern.test(csrf))
        throw new RefundApprovalClientError("Unavailable");
      const payload = JSON.stringify({
        orderReference: ref(command.orderReference),
        requestReference: ref(command.requestReference),
        operationReference: ref(command.operationReference),
        reasonCode: command.reasonCode,
        ...(command.soleOperator === true ? { declineMode: "SoleOperator" } : {}),
      });
      let response: Response;
      try {
        response = await request(
          "/merchant/payments/refunds/decline",
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
      if (response.status === 200) {
        try {
          const raw = record(data, ["status", "declinedAt", "replayed"]);
          if (raw.status !== "Declined" || typeof raw.replayed !== "boolean") return invalid();
          return Object.freeze({ declinedAt: instant(raw.declinedAt), replayed: raw.replayed });
        } catch {
          throw new RefundApprovalClientError("OutcomeUnknown");
        }
      }
      return refusal(response.status, data);
    },
  });
}

/** An approval or decline the server refused, named without internal detail. */
function refusal(status: number, data: unknown): never {
  const error = errorCode(data);
  if (isFullSignInRequired(status, data))
    throw new RefundApprovalClientError(FULL_SIGN_IN_REQUIRED);
  if (status === 422 && error === "same_person") throw new RefundApprovalClientError("SamePerson");
  if (status === 409 && error === "needs_reverification") {
    const party =
      data && typeof data === "object" && "party" in data ? (data.party as unknown) : null;
    throw new RefundApprovalClientError(
      "NeedsReverification",
      party === "Requester" || party === "Approver" || party === "Both" ? party : "Both",
    );
  }
  if (status === 403 && error === "refund_role_required")
    throw new RefundApprovalClientError("NotPermitted");
  if (status === 409 && error === "requester_not_eligible")
    throw new RefundApprovalClientError("RequesterNotEligible");
  if (status === 409 && error === "refund_already_prepared")
    throw new RefundApprovalClientError("AlreadyPrepared");
  if (status === 409 && error === "refund_already_declined")
    throw new RefundApprovalClientError("AlreadyDeclined");
  if (status === 409 && error === "sole_operator_not_in_effect")
    throw new RefundApprovalClientError("SoleOperatorNotInEffect");
  if (status === 409) throw new RefundApprovalClientError("Changed");
  if (status === 401 || status === 403) throw new RefundApprovalClientError("Denied");
  throw new RefundApprovalClientError("OutcomeUnknown");
}
