import { v7 as uuidv7 } from "uuid";
import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

/**
 * WP-2423 Q28 DEC-DINING-STAFF-CALL: a guest seated at a table asks staff to come over, with a
 * reason and no free text. The browser never names a table or Session; the server uses this
 * browser's own joined Guest Session.
 */
export const diningStaffCallReasons = ["Question", "TableNeeds", "OrderProblem"] as const;
export type DiningStaffCallReason = (typeof diningStaffCallReasons)[number];

export interface DiningStaffCallView {
  readonly open: {
    readonly callReference: string;
    readonly reason: DiningStaffCallReason;
    readonly calledAt: string;
  } | null;
  readonly recentlyClosed: {
    readonly kind: "Answered" | "Withdrawn";
    readonly closedAt: string;
  } | null;
  readonly nextCallAt: string | null;
}

export type DiningStaffCallOutcome =
  | { readonly status: "Called" | "AlreadyOpen"; readonly view: DiningStaffCallView }
  | { readonly status: "TooMany"; readonly retryAt: string | null };

export interface DiningStaffCallClient {
  read(signal?: AbortSignal): Promise<DiningStaffCallView>;
  /** One request per tap; repeat the same `operationReference` only to recover an unknown result. */
  call(operationReference: string, reason: DiningStaffCallReason): Promise<DiningStaffCallOutcome>;
  withdraw(
    operationReference: string,
    callReference: string,
  ): Promise<"Withdrawn" | "AlreadyClosed" | "NotFound">;
  newOperationReference(): string;
}

export class DiningStaffCallClientError extends Error {
  constructor(readonly code: "not-joined" | "unavailable") {
    super("dining staff call " + code);
    this.name = "DiningStaffCallClientError";
  }
}

const route = "/api/v1/dine-in/staff-call";
const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

const unavailable = (): never => {
  throw new DiningStaffCallClientError("unavailable");
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return unavailable();
  return value as Record<string, unknown>;
}
const at = (value: unknown) =>
  typeof value === "string" && instant.test(value) ? value : unavailable();

/** Reads the server's answer strictly: anything unexpected is "unavailable", never guessed. */
export function parseDiningStaffCallView(value: unknown): DiningStaffCallView {
  const raw = record(value, ["open", "recentlyClosed", "nextCallAt"]);
  const open =
    raw.open === null
      ? null
      : (() => {
          const call = record(raw.open, ["callReference", "reason", "calledAt"]);
          if (
            typeof call.callReference !== "string" ||
            !reference.test(call.callReference) ||
            !diningStaffCallReasons.includes(call.reason as DiningStaffCallReason)
          )
            return unavailable();
          return Object.freeze({
            callReference: call.callReference,
            reason: call.reason as DiningStaffCallReason,
            calledAt: at(call.calledAt),
          });
        })();
  const recentlyClosed =
    raw.recentlyClosed === null
      ? null
      : (() => {
          const closed = record(raw.recentlyClosed, ["kind", "closedAt"]);
          if (closed.kind !== "Answered" && closed.kind !== "Withdrawn") return unavailable();
          return Object.freeze({ kind: closed.kind, closedAt: at(closed.closedAt) });
        })();
  return Object.freeze({
    open,
    recentlyClosed,
    nextCallAt: raw.nextCallAt === null ? null : at(raw.nextCallAt),
  });
}

export function createHttpDiningStaffCallClient(
  request: typeof globalThis.fetch = globalThis.fetch,
  newOperationReference: () => string = uuidv7,
): DiningStaffCallClient {
  const send = async (path: string, init: RequestInit & { headers: Record<string, string> }) => {
    const csrf = getCustomerCsrfCredential();
    const current = captureCustomerCsrfContext();
    if (csrf === null || !credential.test(csrf)) throw new DiningStaffCallClientError("not-joined");
    let response: Response;
    try {
      response = await boundedFetch(request, path, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", "x-csrf-token": csrf, ...init.headers },
      });
    } catch {
      return unavailable();
    }
    if (!current()) throw new DiningStaffCallClientError("not-joined");
    if (response.status === 404 || response.status === 401)
      throw new DiningStaffCallClientError("not-joined");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  };
  const post = (path: string, operationReference: string, body: unknown) =>
    send(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "idempotency-key": operationReference },
    });
  return Object.freeze({
    newOperationReference,
    async read(signal?: AbortSignal) {
      const { status, payload } = await send(route, {
        method: "GET",
        headers: {},
        ...(signal === undefined ? {} : { signal }),
      });
      if (status !== 200) return unavailable();
      const body = record(payload, ["schemaVersion", "staffCall"]);
      if (body.schemaVersion !== 1) return unavailable();
      return parseDiningStaffCallView(body.staffCall);
    },
    async call(operationReference: string, reason: DiningStaffCallReason) {
      const { status, payload } = await post(route, operationReference, { reason });
      if (status === 201 || status === 200) {
        const body = record(payload, ["schemaVersion", "status", "staffCall"]);
        if (body.schemaVersion !== 1 || (body.status !== "Called" && body.status !== "AlreadyOpen"))
          return unavailable();
        return Object.freeze({
          status: body.status,
          view: parseDiningStaffCallView(body.staffCall),
        });
      }
      if (status === 429) {
        const retryAt = (payload as { retryAt?: unknown } | null)?.retryAt;
        return Object.freeze({
          status: "TooMany" as const,
          retryAt: typeof retryAt === "string" && instant.test(retryAt) ? retryAt : null,
        });
      }
      return unavailable();
    },
    async withdraw(operationReference: string, callReference: string) {
      const { status, payload } = await post(route + "/withdraw", operationReference, {
        callReference,
      });
      if (status !== 200) return unavailable();
      const body = record(payload, ["schemaVersion", "status"]);
      if (
        body.schemaVersion !== 1 ||
        (body.status !== "Withdrawn" &&
          body.status !== "AlreadyClosed" &&
          body.status !== "NotFound")
      )
        return unavailable();
      return body.status;
    },
  });
}
