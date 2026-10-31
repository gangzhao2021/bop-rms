import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionError,
  GuestSessionService,
  assertGuestSessionUsable,
  createPostgresFencedGuestSessionEntryStore,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  DiningSessionError,
  createPostgresDiningStaffCallStore,
  diningStaffCallReasons,
  parseDiningReference,
  type DiningStaffCallReason,
  loadDiningServiceSetting,
} from "@rms/dining";
import type { RequestHandler, Response } from "express";

/**
 * WP-2423 Q28 DEC-DINING-STAFF-CALL: a seated guest asks staff to come to the table. GET says
 * whether staff have been asked (and when the next call is possible); POST asks, with a reason;
 * POST `/withdraw` says it is no longer needed. The browser never names a table, Session or
 * participant: everything comes from the guest's own current, bound Guest Session.
 */
export const customerDiningStaffCallRoute = "/api/v1/dine-in/staff-call";
export const customerDiningStaffCallWithdrawRoute = "/api/v1/dine-in/staff-call/withdraw";

export class CustomerDiningStaffCallError extends Error {
  /** NotOffered (WP-2423 item 8 ⑦): the Store has not turned calling staff on. */
  constructor(readonly code: "NotJoined" | "NotOffered" | "Unavailable" | "Invalid") {
    super("dining staff call " + code);
    this.name = "CustomerDiningStaffCallError";
  }
}

/** What the guest's phone shows; the call reference lets it withdraw the open call. */
export interface CustomerDiningStaffCallView {
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

export type CustomerDiningStaffCallResult =
  | { readonly status: "Called" | "AlreadyOpen"; readonly view: CustomerDiningStaffCallView }
  | { readonly status: "TooManyCalls"; readonly retryAt: string }
  | { readonly status: "NotSeated" };

export type CustomerDiningStaffCallWithdrawResult =
  "Withdrawn" | "AlreadyClosed" | "NotFound" | "NotSeated";

export interface CustomerDiningStaffCallOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly credentials: GuestSessionServiceOptions["credentials"];
  binding(transaction: ConsumerTransaction): GuestSessionServiceOptions["binding"];
  hashIntent(value: string): string;
  newReference(): string;
  now(): string;
}

interface Credentials {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
}

function bound(guest: GuestSession, scope: CustomerDiningStaffCallOptions["scope"]) {
  if (
    String(guest.brandReference) !== scope.brandReference ||
    String(guest.storeReference) !== scope.storeReference ||
    guest.channel !== "DineIn" ||
    guest.diningState !== "DiningBound" ||
    guest.diningSessionReference === null ||
    guest.diningParticipantReference === null
  )
    throw new CustomerDiningStaffCallError("NotJoined");
  return Object.freeze({
    diningSessionReference: String(guest.diningSessionReference),
    participantReference: String(guest.diningParticipantReference),
  });
}

export function createCustomerDiningStaffCall(options: CustomerDiningStaffCallOptions) {
  const scope = Object.freeze({
    tenantReference: String(parseDiningReference(options.scope.tenantReference)),
    brandReference: String(parseDiningReference(options.scope.brandReference)),
    storeReference: String(parseDiningReference(options.scope.storeReference)),
  });
  const credentialsOf = (value: unknown, keys: readonly string[]) => {
    try {
      const raw = readClosedRecord(value, keys);
      return {
        raw,
        credentials: {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        },
      };
    } catch {
      throw new CustomerDiningStaffCallError("Invalid");
    }
  };
  /** One transaction: current Guest identity and binding, then the Dining owner store. */
  async function run<T>(
    credentials: Credentials,
    operationReference: string,
    fenced: boolean,
    offered: "Required" | "Any",
    work: (
      store: ReturnType<typeof createPostgresDiningStaffCallStore>,
      command: Record<string, string>,
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await options.transactions.run(async (transaction) => {
        const runner = {
          run: <R>(next: (tx: ConsumerTransaction) => Promise<R>) => next(transaction),
        };
        const binding = options.binding(transaction);
        const identity = new GuestSessionService({
          credentials: options.credentials,
          binding,
          // Writes lock the Guest Session row first (Guest -> Dining lock order); reading does not.
          store: (fenced
            ? createPostgresFencedGuestSessionEntryStore
            : createPostgresGuestSessionEntryStore)(runner, {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          }),
          admission: { consume: async () => null },
          now: options.now,
        });
        const authorize = async () => {
          const guest = await identity.authorize({
            sessionCredential: credentials.sessionCredential,
            csrfCredential: credentials.csrfCredential,
            observedAt: parseCanonicalInstant(options.now()),
          });
          const checked = parseCanonicalInstant(options.now());
          assertGuestSessionUsable(guest, checked);
          if ((await binding.validate(guest, checked)) !== "Current")
            throw new CustomerDiningStaffCallError("NotJoined");
          return { guest, member: bound(guest, scope) };
        };
        const first = await authorize();
        // WP-2423 item 8 ⑦ (Owner decision 4): only while the Store offers calling staff; an open
        // call can still be withdrawn after it was turned off.
        if (
          offered === "Required" &&
          !(
            await loadDiningServiceSetting(
              transaction as unknown as Parameters<typeof loadDiningServiceSetting>[0],
              scope,
            )
          ).staffCall
        )
          throw new CustomerDiningStaffCallError("NotOffered");
        const fingerprint = JSON.stringify(first.guest);
        const command = {
          operationReference,
          ...scope,
          diningSessionReference: first.member.diningSessionReference,
          participantReference: first.member.participantReference,
          observedAt: String(parseCanonicalInstant(options.now())),
        };
        const store = createPostgresDiningStaffCallStore(runner, {
          scope,
          hashIntent: options.hashIntent,
          equals: (a, b) => a === b,
          authorize: async (tx, candidate) => {
            if (tx !== transaction) return false;
            try {
              const current = await authorize();
              return (
                JSON.stringify(current.guest) === fingerprint &&
                String(candidate.diningSessionReference) ===
                  current.member.diningSessionReference &&
                String(candidate.participantReference) === current.member.participantReference
              );
            } catch {
              return false;
            }
          },
        });
        return work(store, command);
      });
    } catch (error) {
      if (error instanceof CustomerDiningStaffCallError) throw error;
      if (
        error instanceof GuestSessionError ||
        (error instanceof DiningSessionError && error.code === "DINING_SESSION_PERMISSION_DENIED")
      )
        throw new CustomerDiningStaffCallError("NotJoined");
      if (error instanceof DiningSessionError && error.code === "DINING_SESSION_INPUT_INVALID")
        throw new CustomerDiningStaffCallError("Invalid");
      throw new CustomerDiningStaffCallError("Unavailable");
    }
  }
  const view = (status: {
    readonly open: {
      readonly callReference: string;
      readonly reason: DiningStaffCallReason;
      readonly calledAt: string;
    } | null;
    readonly recentlyClosed: CustomerDiningStaffCallView["recentlyClosed"];
    readonly nextCallAt: string | null;
  }): CustomerDiningStaffCallView =>
    Object.freeze({
      open:
        status.open === null
          ? null
          : Object.freeze({
              callReference: String(status.open.callReference),
              reason: status.open.reason,
              calledAt: String(status.open.calledAt),
            }),
      recentlyClosed:
        status.recentlyClosed === null
          ? null
          : Object.freeze({
              kind: status.recentlyClosed.kind,
              closedAt: String(status.recentlyClosed.closedAt),
            }),
      nextCallAt: status.nextCallAt === null ? null : String(status.nextCallAt),
    });
  return Object.freeze({
    async read(value: unknown): Promise<CustomerDiningStaffCallView> {
      const { credentials } = credentialsOf(value, ["sessionCredential", "csrfCredential"]);
      return run(credentials, options.newReference(), false, "Required", async (store, command) => {
        const status = await store.status(command);
        if (!status.seated) throw new CustomerDiningStaffCallError("NotJoined");
        return view(status);
      });
    },
    async call(value: unknown): Promise<CustomerDiningStaffCallResult> {
      const { raw, credentials } = credentialsOf(value, [
        "sessionCredential",
        "csrfCredential",
        "operationReference",
        "reason",
      ]);
      let operation: string;
      try {
        operation = String(parseDiningReference(raw.operationReference));
      } catch {
        throw new CustomerDiningStaffCallError("Invalid");
      }
      if (!diningStaffCallReasons.includes(raw.reason as DiningStaffCallReason))
        throw new CustomerDiningStaffCallError("Invalid");
      return run(credentials, operation, true, "Required", async (store, command) => {
        const result = await store.call(command, raw.reason);
        if (result.status === "Refused")
          return result.reason === "TooManyCalls" && result.retryAt !== null
            ? Object.freeze({ status: "TooManyCalls" as const, retryAt: String(result.retryAt) })
            : Object.freeze({ status: "NotSeated" as const });
        return Object.freeze({
          status: result.status === "Called" ? ("Called" as const) : ("AlreadyOpen" as const),
          view: view({ open: result.call, recentlyClosed: null, nextCallAt: null }),
        });
      });
    },
    async withdraw(value: unknown): Promise<CustomerDiningStaffCallWithdrawResult> {
      const { raw, credentials } = credentialsOf(value, [
        "sessionCredential",
        "csrfCredential",
        "operationReference",
        "callReference",
      ]);
      let operation: string, call: string;
      try {
        operation = String(parseDiningReference(raw.operationReference));
        call = String(parseDiningReference(raw.callReference));
      } catch {
        throw new CustomerDiningStaffCallError("Invalid");
      }
      return run(credentials, operation, true, "Any", async (store, command) => {
        const result = await store.withdraw(command, call);
        if (result.status === "Closed")
          return result.kind === "Withdrawn" ? "Withdrawn" : "AlreadyClosed";
        return result.status;
      });
    },
  });
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}
function fail(response: Response, status: 400 | 404 | 409 | 503) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400
      ? "request_invalid"
      : status === 404
        ? "not_joined"
        : status === 409
          ? "not_offered"
          : "service_unavailable";
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "dining_staff_call_" + code, messageKey: "customer.dining.staff_call." + code },
  });
}

export class CustomerDiningStaffCallHandler {
  readonly #origin: string;
  readonly #port: ReturnType<typeof createCustomerDiningStaffCall>;
  constructor(options: {
    allowedOrigin: string;
    port: ReturnType<typeof createCustomerDiningStaffCall>;
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  #credentials(
    request: Parameters<RequestHandler>[0],
    mutation: boolean,
    bodyKeys: readonly string[],
  ): Credentials & { readonly body: Record<string, unknown> } {
    const origin = request.get("origin");
    if (
      (mutation ? origin !== this.#origin : origin !== undefined && origin !== this.#origin) ||
      request.get("sec-fetch-site") !== "same-origin" ||
      Object.keys(request.query).length !== 0
    )
      throw new Error("invalid request");
    const body = readClosedRecord(request.body ?? {}, bodyKeys);
    const entries = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name === "__Host-bop-guest");
    const csrf = request.headers["x-csrf-token"];
    if (
      entries.length !== 1 ||
      entries[0]?.length !== 2 ||
      !credential.test(entries[0]?.[1] ?? "") ||
      typeof csrf !== "string" ||
      !credential.test(csrf)
    )
      throw new Error("invalid credentials");
    return { sessionCredential: entries[0]?.[1] as string, csrfCredential: csrf, body };
  }
  #key(request: Parameters<RequestHandler>[0]) {
    const key = request.get("idempotency-key");
    if (typeof key !== "string" || !reference.test(key)) throw new Error("invalid key");
    return key;
  }
  #failure(response: Response, error: unknown) {
    fail(
      response,
      error instanceof CustomerDiningStaffCallError && error.code === "NotJoined"
        ? 404
        : error instanceof CustomerDiningStaffCallError && error.code === "Invalid"
          ? 400
          : error instanceof CustomerDiningStaffCallError && error.code === "NotOffered"
            ? 409
            : 503,
    );
  }
  read(): RequestHandler {
    return async (request, response) => {
      let input: Credentials;
      try {
        const { sessionCredential, csrfCredential } = this.#credentials(request, false, []);
        input = { sessionCredential, csrfCredential };
      } catch {
        fail(response, 400);
        return;
      }
      try {
        const staffCall = await this.#port.read(input);
        protect(response);
        response.status(200).json({ schemaVersion: 1, staffCall });
      } catch (error) {
        this.#failure(response, error);
      }
    };
  }
  call(): RequestHandler {
    return async (request, response) => {
      let input: Credentials & { operationReference: string; reason: unknown };
      try {
        const { sessionCredential, csrfCredential, body } = this.#credentials(request, true, [
          "reason",
        ]);
        input = {
          sessionCredential,
          csrfCredential,
          operationReference: this.#key(request),
          reason: body.reason,
        };
      } catch {
        fail(response, 400);
        return;
      }
      try {
        const result = await this.#port.call(input);
        protect(response);
        if (result.status === "Called" || result.status === "AlreadyOpen") {
          response
            .status(result.status === "Called" ? 201 : 200)
            .json({ schemaVersion: 1, status: result.status, staffCall: result.view });
          return;
        }
        if (result.status !== "TooManyCalls") {
          fail(response, 404);
          return;
        }
        const seconds = Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000));
        response.setHeader("Retry-After", String(seconds));
        response.status(429).json({
          schemaVersion: 1,
          error: {
            code: "dining_staff_call_rate_limited",
            messageKey: "customer.dining.staff_call.rate_limited",
          },
          retryAt: result.retryAt,
        });
      } catch (error) {
        this.#failure(response, error);
      }
    };
  }
  withdraw(): RequestHandler {
    return async (request, response) => {
      let input: Credentials & { operationReference: string; callReference: unknown };
      try {
        const { sessionCredential, csrfCredential, body } = this.#credentials(request, true, [
          "callReference",
        ]);
        input = {
          sessionCredential,
          csrfCredential,
          operationReference: this.#key(request),
          callReference: body.callReference,
        };
      } catch {
        fail(response, 400);
        return;
      }
      try {
        const result = await this.#port.withdraw(input);
        if (result === "NotSeated") {
          fail(response, 404);
          return;
        }
        protect(response);
        response.status(200).json({ schemaVersion: 1, status: result });
      } catch (error) {
        this.#failure(response, error);
      }
    };
  }
}

export const unavailableCustomerDiningStaffCallHandler: RequestHandler = (_request, response) =>
  fail(response, 503);
