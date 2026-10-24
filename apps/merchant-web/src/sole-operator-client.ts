import { t } from "./i18n/i18n.js";
/**
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the Brand Owner's "sole operator" setting — whether
 * one Owner running the Brand alone may approve their own refunds — read and turned on or off.
 * Only the Brand Owner can read it; others get Denied and the section is not shown.
 */
import { FULL_SIGN_IN_REQUIRED, isFullSignInRequired } from "./full-sign-in.js";

export type SoleOperatorState = "On" | "Off";
export type SoleOperatorRefundStatus = "Effective" | "NotSet" | "OtherApprovers";
export const soleOperatorReasons = {
  On: ["OWNER_RUNS_STORE_ALONE"],
  Off: ["SECOND_APPROVER_AVAILABLE", "OWNER_CHOICE", "ENTERED_IN_ERROR"],
} as const;
export type SoleOperatorReason =
  (typeof soleOperatorReasons.On)[number] | (typeof soleOperatorReasons.Off)[number];
export const soleOperatorReasonLabel: Readonly<Record<SoleOperatorReason, string>> = {
  OWNER_RUNS_STORE_ALONE: t("I run this business on my own"),
  SECOND_APPROVER_AVAILABLE: t("Someone else can now approve"),
  OWNER_CHOICE: t("I want a second person to approve"),
  ENTERED_IN_ERROR: t("Turned on by mistake"),
};
export interface SoleOperatorView {
  readonly observedAt: string;
  readonly state: SoleOperatorState;
  readonly version: number;
  /** Every change in the record, including those not listed in `history` (which is capped). */
  readonly changeCount: number;
  readonly history: readonly {
    readonly version: number;
    readonly state: SoleOperatorState;
    readonly reasonCode: SoleOperatorReason;
    readonly recordedAt: string;
    readonly changedByYou: boolean;
    readonly changedByName: string | null;
  }[];
  readonly refundApproval: {
    readonly status: SoleOperatorRefundStatus;
    readonly youHoldApproval: boolean;
    readonly otherApprovers: readonly { readonly displayName: string | null }[];
  };
  readonly verifiedUntil: string | null;
}
export type SoleOperatorFailure =
  | "Denied"
  | typeof FULL_SIGN_IN_REQUIRED
  | "NeedsReverification"
  | "Changed"
  | "NoChange"
  | "Unavailable"
  | "OutcomeUnknown";
export class SoleOperatorClientError extends Error {
  constructor(readonly code: SoleOperatorFailure) {
    super(t("Sole operator setting could not be confirmed"));
    this.name = "SoleOperatorClientError";
  }
}
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/u;
const invalid = (): never => {
  throw new SoleOperatorClientError("Unavailable");
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
const instant = (value: unknown) =>
  typeof value === "string" && instantPattern.test(value) && new Date(value).toISOString() === value
    ? value
    : invalid();
const state = (value: unknown): SoleOperatorState =>
  value === "On" || value === "Off" ? value : invalid();
const version = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const name = (value: unknown) =>
  value === null
    ? null
    : typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= 80 &&
        !/[\p{Cc}\p{Cf}]/u.test(value)
      ? value
      : invalid();
const reason = (value: unknown): SoleOperatorReason =>
  typeof value === "string" && Object.hasOwn(soleOperatorReasonLabel, value)
    ? (value as SoleOperatorReason)
    : invalid();
async function body(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.toLowerCase().startsWith("application/json") !== true)
    return null;
  const raw = await response.text();
  if (raw.length > 100_000) return null;
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
/** Changes kept in the record beyond the `shown` most recent ones listed on the page. */
export function soleOperatorEarlierChangeCount(
  view: Pick<SoleOperatorView, "changeCount" | "history">,
  shown: number,
): number {
  return Math.max(0, view.changeCount - Math.min(shown, view.history.length));
}
export function parseSoleOperatorView(value: unknown): SoleOperatorView {
  const raw = record(value, [
    "observedAt",
    "state",
    "version",
    "changeCount",
    "history",
    "refundApproval",
    "verifiedUntil",
    "reasons",
  ]);
  const approval = record(raw.refundApproval, ["status", "youHoldApproval", "otherApprovers"]);
  if (
    (approval.status !== "Effective" &&
      approval.status !== "NotSet" &&
      approval.status !== "OtherApprovers") ||
    typeof approval.youHoldApproval !== "boolean" ||
    !Array.isArray(approval.otherApprovers) ||
    approval.otherApprovers.length > 100 ||
    !Array.isArray(raw.history) ||
    raw.history.length > 50
  )
    return invalid();
  const changeCount = version(raw.changeCount);
  if (changeCount < raw.history.length) return invalid();
  return Object.freeze({
    observedAt: instant(raw.observedAt),
    state: state(raw.state),
    version: version(raw.version),
    changeCount,
    history: Object.freeze(
      raw.history.map((value) => {
        const entry = record(value, [
          "version",
          "state",
          "reasonCode",
          "recordedAt",
          "changedByYou",
          "changedByName",
        ]);
        if (typeof entry.changedByYou !== "boolean") return invalid();
        return Object.freeze({
          version: version(entry.version),
          state: state(entry.state),
          reasonCode: reason(entry.reasonCode),
          recordedAt: instant(entry.recordedAt),
          changedByYou: entry.changedByYou,
          changedByName: name(entry.changedByName),
        });
      }),
    ),
    refundApproval: Object.freeze({
      status: approval.status,
      youHoldApproval: approval.youHoldApproval,
      otherApprovers: Object.freeze(
        approval.otherApprovers.map((value) =>
          Object.freeze({ displayName: name(record(value, ["displayName"]).displayName) }),
        ),
      ),
    }),
    verifiedUntil: raw.verifiedUntil === null ? null : instant(raw.verifiedUntil),
  });
}

export function createSoleOperatorClient(fetcher: typeof fetch = fetch) {
  const request = async (init: RequestInit, signal?: AbortSignal) => {
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    try {
      return await fetcher("/merchant/organization/sole-operator", {
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
    /** Null: the signed-in member is not the Brand Owner, so there is nothing to show them. */
    async read(signal?: AbortSignal): Promise<SoleOperatorView | null> {
      let response: Response;
      try {
        response = await request(
          { method: "GET", headers: { Accept: "application/json" } },
          signal,
        );
      } catch {
        throw new SoleOperatorClientError("Unavailable");
      }
      if (response.status === 401 || response.status === 403)
        throw new SoleOperatorClientError("Denied");
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
        throw new SoleOperatorClientError("Unavailable");
      const value = await body(response);
      if (
        value !== null &&
        typeof value === "object" &&
        Reflect.ownKeys(value).length === 1 &&
        (value as Record<string, unknown>).brandOwner === false
      )
        return null;
      return parseSoleOperatorView(value);
    },
    /** Retry with the same operation reference after an unknown result: it is recorded once. */
    async change(
      command: {
        state: SoleOperatorState;
        reasonCode: SoleOperatorReason;
        expectedVersion: number;
        operationReference: string;
      },
      csrf: string,
      signal?: AbortSignal,
    ) {
      const allowed: readonly string[] = soleOperatorReasons[command.state];
      if (
        !allowed.includes(command.reasonCode) ||
        !uuid.test(command.operationReference) ||
        !Number.isSafeInteger(command.expectedVersion) ||
        command.expectedVersion < 0 ||
        !csrfPattern.test(csrf)
      )
        throw new SoleOperatorClientError("Unavailable");
      let response: Response;
      try {
        response = await request(
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": csrf,
            },
            body: JSON.stringify(command),
          },
          signal,
        );
      } catch {
        throw new SoleOperatorClientError("OutcomeUnknown");
      }
      const data = await body(response);
      if (response.status === 200) {
        try {
          const raw = record(data, ["status", "state", "version", "recordedAt"]);
          if (raw.status !== "Created" && raw.status !== "AlreadyCommitted") return invalid();
          return Object.freeze({
            state: state(raw.state),
            version: version(raw.version),
            recordedAt: instant(raw.recordedAt),
          });
        } catch {
          throw new SoleOperatorClientError("OutcomeUnknown");
        }
      }
      const error = errorCode(data);
      if (response.status === 409 && error === "needs_reverification")
        throw new SoleOperatorClientError("NeedsReverification");
      if (response.status === 409 && error === "setting_changed")
        throw new SoleOperatorClientError("Changed");
      if (response.status === 409 && error === "no_change")
        throw new SoleOperatorClientError("NoChange");
      // A PIN sign-in that has not been confirmed: the same person may go ahead after verifying.
      if (isFullSignInRequired(response.status, data))
        throw new SoleOperatorClientError(FULL_SIGN_IN_REQUIRED);
      if (response.status === 401 || response.status === 403)
        throw new SoleOperatorClientError("Denied");
      if (response.status === 422) throw new SoleOperatorClientError("Unavailable");
      throw new SoleOperatorClientError("OutcomeUnknown");
    },
  });
}
