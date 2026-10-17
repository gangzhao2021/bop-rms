import { v7 as uuidv7 } from "uuid";
import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

/**
 * WP-2423 DEC-DINING-GUEST-INVITATION: the table's Host makes a one-time six-digit code on their
 * phone for the next person joining. The browser never names a table or Session; the server uses
 * this browser's own joined Guest Session.
 */
export type DiningInvitationIssue =
  | { readonly status: "Issued"; readonly code: string; readonly expiresAt: string }
  /** The same request was answered before; its code can't be shown again, make a new one. */
  | { readonly status: "Lost" }
  | { readonly status: "NotHost" }
  | { readonly status: "TableChanged" }
  | { readonly status: "TooMany"; readonly retryAt: string | null };

export interface DiningInvitationClient {
  canInvite(signal?: AbortSignal): Promise<boolean>;
  /** One request per tap; repeat the same `operationReference` only to recover an unknown result. */
  issue(operationReference: string): Promise<DiningInvitationIssue>;
  newOperationReference(): string;
}

export class DiningInvitationClientError extends Error {
  constructor(readonly code: "not-joined" | "unavailable") {
    super("dining invitation " + code);
    this.name = "DiningInvitationClientError";
  }
}

const route = "/api/v1/dine-in/invitation";
const credential = /^[A-Za-z0-9_-]{43}$/u;
const instant = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DiningInvitationClientError("unavailable");
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key)))
    throw new DiningInvitationClientError("unavailable");
  return value as Record<string, unknown>;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DiningInvitationClientError("unavailable");
  }
}

function errorCode(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function createHttpDiningInvitationClient(
  request: typeof globalThis.fetch = globalThis.fetch,
  newOperationReference: () => string = uuidv7,
): DiningInvitationClient {
  const send = async (init: RequestInit & { headers: Record<string, string> }) => {
    const csrf = getCustomerCsrfCredential();
    const current = captureCustomerCsrfContext();
    if (csrf === null || !credential.test(csrf))
      throw new DiningInvitationClientError("not-joined");
    let response: Response;
    try {
      response = await boundedFetch(request, route, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", "x-csrf-token": csrf, ...init.headers },
      });
    } catch {
      throw new DiningInvitationClientError("unavailable");
    }
    if (!current()) throw new DiningInvitationClientError("not-joined");
    if (response.status === 404 || response.status === 401)
      throw new DiningInvitationClientError("not-joined");
    return response;
  };
  return Object.freeze({
    newOperationReference,
    async canInvite(signal?: AbortSignal) {
      const response = await send({
        method: "GET",
        headers: {},
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) throw new DiningInvitationClientError("unavailable");
      const body = record(await json(response), ["schemaVersion", "invitation"]);
      const invitation = record(body.invitation, ["canInvite"]);
      if (body.schemaVersion !== 1 || typeof invitation.canInvite !== "boolean")
        throw new DiningInvitationClientError("unavailable");
      return invitation.canInvite;
    },
    async issue(operationReference: string): Promise<DiningInvitationIssue> {
      const response = await send({
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "idempotency-key": operationReference },
      });
      const payload = await json(response);
      if (response.status === 201) {
        const body = record(payload, ["schemaVersion", "invitation"]);
        const invitation = record(body.invitation, ["status", "code", "expiresAt"]);
        if (
          body.schemaVersion !== 1 ||
          invitation.status !== "Issued" ||
          typeof invitation.code !== "string" ||
          !/^[0-9]{6}$/u.test(invitation.code) ||
          typeof invitation.expiresAt !== "string" ||
          !instant.test(invitation.expiresAt)
        )
          throw new DiningInvitationClientError("unavailable");
        return Object.freeze({
          status: "Issued",
          code: invitation.code,
          expiresAt: invitation.expiresAt,
        });
      }
      if (response.status === 200) return Object.freeze({ status: "Lost" });
      const code = errorCode(payload);
      if (response.status === 403 && code === "dining_invitation_not_host")
        return Object.freeze({ status: "NotHost" });
      if (response.status === 409 && code === "dining_invitation_table_changed")
        return Object.freeze({ status: "TableChanged" });
      if (response.status === 429) {
        const retryAt = (payload as { retryAt?: unknown } | null)?.retryAt;
        return Object.freeze({
          status: "TooMany",
          retryAt: typeof retryAt === "string" && instant.test(retryAt) ? retryAt : null,
        });
      }
      throw new DiningInvitationClientError("unavailable");
    },
  });
}
