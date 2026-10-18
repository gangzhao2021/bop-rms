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
  createPostgresDiningGuestInvitationStore,
  parseDiningGuestInvitationCommand,
  parseDiningReference,
  type DiningCredentialPort,
  type DiningGuestInvitationCommand,
} from "@rms/dining";
import type { RequestHandler, Response } from "express";

/**
 * WP-2423 DEC-DINING-GUEST-INVITATION (Handoff 6.11, 87.4.1): the table's Host invites the next
 * guest from their own phone. GET says whether this guest may invite (only the Host sees the
 * control); POST issues the table's next one-time six-digit code. The browser never names a table,
 * Session or participant: everything comes from the guest's own current, bound Guest Session.
 */
export const customerDiningInvitationRoute = "/api/v1/dine-in/invitation";

export class CustomerDiningInvitationError extends Error {
  constructor(readonly code: "NotJoined" | "Unavailable" | "Invalid") {
    super("dining invitation " + code);
    this.name = "CustomerDiningInvitationError";
  }
}

export type CustomerDiningInvitationResult =
  | { readonly status: "Issued"; readonly code: string; readonly expiresAt: string }
  /** The same request was already answered; the code is never stored, so it cannot be repeated. */
  | { readonly status: "AlreadyIssued" }
  | { readonly status: "NotHost" }
  | { readonly status: "TableChanged" }
  | { readonly status: "TooManyInvitations"; readonly retryAt: string };

export interface CustomerDiningInvitationOptions {
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
  readonly dining: {
    readonly credentials: Pick<
      DiningCredentialPort,
      | "generateReference"
      | "generateJoinCredential"
      | "hashJoinCredential"
      | "hashOperationIntent"
      | "equals"
    >;
    readonly pepperVersion: number;
  };
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  newReference(): string;
  now(): string;
}

interface Credentials {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
}

function bound(guest: GuestSession, scope: CustomerDiningInvitationOptions["scope"]) {
  if (
    String(guest.brandReference) !== scope.brandReference ||
    String(guest.storeReference) !== scope.storeReference ||
    guest.channel !== "DineIn" ||
    guest.diningState !== "DiningBound" ||
    guest.diningSessionReference === null ||
    guest.diningParticipantReference === null
  )
    throw new CustomerDiningInvitationError("NotJoined");
  return Object.freeze({
    guestSessionReference: String(guest.sessionReference),
    diningSessionReference: String(guest.diningSessionReference),
    participantReference: String(guest.diningParticipantReference),
  });
}

export function createCustomerDiningInvitation(options: CustomerDiningInvitationOptions) {
  const scope = Object.freeze({
    tenantReference: String(parseDiningReference(options.scope.tenantReference)),
    brandReference: String(parseDiningReference(options.scope.brandReference)),
    storeReference: String(parseDiningReference(options.scope.storeReference)),
  });
  const parse = (value: unknown, keys: readonly string[]) => {
    try {
      const raw = readClosedRecord(value, keys);
      return {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        operationReference:
          raw.operationReference === undefined
            ? null
            : String(parseDiningReference(raw.operationReference)),
      };
    } catch {
      throw new CustomerDiningInvitationError("Invalid");
    }
  };
  /** One transaction: current Guest identity and binding, then the Dining owner store. */
  async function run<T>(
    credentials: Credentials,
    operationReference: string,
    fenced: boolean,
    work: (
      store: ReturnType<typeof createPostgresDiningGuestInvitationStore>,
      command: DiningGuestInvitationCommand,
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
          // Issuing locks the Guest Session row first (Guest -> Dining lock order); reading does not.
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
          const at = parseCanonicalInstant(options.now());
          // Identity takes a closed record: only the two credentials (v15 8c4480dd H1: spreading
          // the parsed request also passed `operationReference`, so every read and issue was
          // refused as invalid and reported "not joined").
          const guest = await identity.authorize({
            sessionCredential: credentials.sessionCredential,
            csrfCredential: credentials.csrfCredential,
            observedAt: at,
          });
          const checked = parseCanonicalInstant(options.now());
          assertGuestSessionUsable(guest, checked);
          if ((await binding.validate(guest, checked)) !== "Current")
            throw new CustomerDiningInvitationError("NotJoined");
          return { guest, member: bound(guest, scope) };
        };
        const first = await authorize();
        const fingerprint = JSON.stringify(first.guest);
        const observedAt = String(parseCanonicalInstant(options.now()));
        const command = parseDiningGuestInvitationCommand({
          operationReference,
          ...scope,
          diningSessionReference: first.member.diningSessionReference,
          participantReference: first.member.participantReference,
          observedAt,
        });
        const store = createPostgresDiningGuestInvitationStore(runner, {
          scope,
          credentials: options.dining.credentials,
          pepperVersion: options.dining.pepperVersion,
          now: options.now,
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
          audit: (input) => ({
            auditId: options.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "DINING_JOIN_INVITATION_ISSUE",
            targetType: "DiningTable",
            targetId: input.tableReference,
            reasonCode: "HOST_INVITED_GUEST",
            correlationId: String(input.command.operationReference),
            occurredAt: String(input.command.observedAt),
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          }),
        });
        return work(store, command);
      });
    } catch (error) {
      if (error instanceof CustomerDiningInvitationError) throw error;
      if (
        error instanceof GuestSessionError ||
        (error instanceof DiningSessionError && error.code === "DINING_SESSION_PERMISSION_DENIED")
      )
        throw new CustomerDiningInvitationError("NotJoined");
      throw new CustomerDiningInvitationError("Unavailable");
    }
  }
  return Object.freeze({
    async read(value: unknown): Promise<{ readonly canInvite: boolean }> {
      const input = parse(value, ["sessionCredential", "csrfCredential"]);
      // A read carries no operation; the reference only fills the closed command shape.
      return run(input, options.newReference(), false, async (store, command) =>
        Object.freeze({ canInvite: (await store.eligibility(command)) === "Allowed" }),
      );
    },
    async issue(value: unknown): Promise<CustomerDiningInvitationResult> {
      const input = parse(value, ["sessionCredential", "csrfCredential", "operationReference"]);
      if (input.operationReference === null) throw new CustomerDiningInvitationError("Invalid");
      return run(input, input.operationReference, true, async (store, command) => {
        const result = await store.issue(command);
        if (result.status === "Issued") {
          const code = String(result.joinCredential);
          if (result.capability.kind !== "HumanCode" || !/^[0-9]{6}$/u.test(code))
            throw new CustomerDiningInvitationError("Unavailable");
          return Object.freeze({
            status: "Issued" as const,
            code,
            expiresAt: String(result.capability.expiresAt),
          });
        }
        if (result.status === "AlreadyApplied")
          return Object.freeze({ status: "AlreadyIssued" as const });
        if (result.reason === "TooManyInvitations") {
          if (result.retryAt === null) throw new CustomerDiningInvitationError("Unavailable");
          return Object.freeze({
            status: "TooManyInvitations" as const,
            retryAt: String(result.retryAt),
          });
        }
        return Object.freeze({ status: result.reason });
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
function reject(response: Response, status: 400 | 404 | 503) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400 ? "request_invalid" : status === 404 ? "not_joined" : "service_unavailable";
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "dining_invitation_" + code, messageKey: "customer.dining.invitation." + code },
  });
}
function refuse(response: Response, status: 403 | 409 | 429, code: string) {
  protect(response);
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "dining_invitation_" + code, messageKey: "customer.dining.invitation." + code },
  });
}

export class CustomerDiningInvitationHandler {
  readonly #origin: string;
  readonly #port: ReturnType<typeof createCustomerDiningInvitation>;
  constructor(options: {
    allowedOrigin: string;
    port: ReturnType<typeof createCustomerDiningInvitation>;
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  #credentials(request: Parameters<RequestHandler>[0], mutation: boolean): Credentials {
    const origin = request.get("origin");
    if (
      (mutation ? origin !== this.#origin : origin !== undefined && origin !== this.#origin) ||
      request.get("sec-fetch-site") !== "same-origin" ||
      Object.keys(request.query).length !== 0
    )
      throw new Error("invalid request");
    readClosedRecord(request.body ?? {}, []);
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
    return { sessionCredential: entries[0]?.[1] as string, csrfCredential: csrf };
  }
  #failure(response: Response, error: unknown) {
    reject(
      response,
      error instanceof CustomerDiningInvitationError && error.code === "NotJoined"
        ? 404
        : error instanceof CustomerDiningInvitationError && error.code === "Invalid"
          ? 400
          : 503,
    );
  }
  read(): RequestHandler {
    return async (request, response) => {
      let input: Credentials;
      try {
        input = this.#credentials(request, false);
      } catch {
        reject(response, 400);
        return;
      }
      try {
        const result = await this.#port.read(input);
        protect(response);
        response
          .status(200)
          .json({ schemaVersion: 1, invitation: { canInvite: result.canInvite === true } });
      } catch (error) {
        this.#failure(response, error);
      }
    };
  }
  issue(): RequestHandler {
    return async (request, response) => {
      let input: Credentials & { operationReference: string };
      try {
        const key = request.get("idempotency-key");
        if (typeof key !== "string" || !reference.test(key)) throw new Error("invalid key");
        input = { ...this.#credentials(request, true), operationReference: key };
      } catch {
        reject(response, 400);
        return;
      }
      try {
        const result = await this.#port.issue(input);
        if (result.status === "Issued") {
          protect(response);
          response.status(201).json({
            schemaVersion: 1,
            invitation: { status: "Issued", code: result.code, expiresAt: result.expiresAt },
          });
          return;
        }
        if (result.status === "AlreadyIssued") {
          protect(response);
          response.status(200).json({ schemaVersion: 1, invitation: { status: "AlreadyIssued" } });
          return;
        }
        if (result.status === "NotHost") return refuse(response, 403, "not_host");
        if (result.status === "TableChanged") return refuse(response, 409, "table_changed");
        const seconds = Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000));
        response.setHeader("Retry-After", String(seconds));
        protect(response);
        response.status(429).json({
          schemaVersion: 1,
          error: {
            code: "dining_invitation_rate_limited",
            messageKey: "customer.dining.invitation.rate_limited",
          },
          retryAt: result.retryAt,
        });
      } catch (error) {
        this.#failure(response, error);
      }
    };
  }
}

export const unavailableCustomerDiningInvitationHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
