import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionError,
  GuestSessionService,
  assertGuestSessionUsable,
  createPostgresGuestSessionEntryStore,
  findGuestSessionContinuity,
  issueGuestSessionContinuity,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  rotateGuestSessionByContinuity,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  DiningReadmissionError,
  createPostgresDiningGuestBindingStore,
  parseDiningInstant,
  parseDiningReference,
  recordDiningParticipantReadmission,
} from "@rms/dining";
import { carryDiningCheckoutScopeToSession } from "@rms/ordering";
import type { RequestHandler, Response } from "express";
import type { CustomerEntryPresentedTable } from "./customer-entry.js";
import {
  diningSeatOf,
  type CustomerEntryPresentedAnswer,
} from "./customer-entry-presented-table.js";

/**
 * WP-2423 shared-table-checkout (b), lost cookie (DEC-DINING-CHECKOUT-SCOPE: 换浏览器或丢了 cookie 的
 * 同一部手机重新扫码). A seated phone keeps a continuity token in its page storage (never a URL or
 * log). When the cookie is gone and the guest scans the table code again, the token finds the
 * phone's old session: if it is still live and seated, and the scan is of the same Store, table and
 * current code version, the old session is rotated into a new one for the same participant (one
 * transaction: Identity's rotation, the token's single use, Dining's readmission record and a fresh
 * token), and the entry answers "You're already at this table." with the new cookie. "Only what I
 * added" then still finds that phone's dishes. Anything else (a removed phone, a closed table, a
 * replaced code, another Store, a used token) is an ordinary entry, with its pause. Dining that can't
 * be read is a retry, never a join. No login, no contact.
 */
export const customerDiningContinuityRoute = "/api/v1/dine-in/continuity";

export interface CustomerDiningContinuityOptions {
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
  newReference(): string;
  now(): string;
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export class CustomerDiningContinuityError extends Error {
  constructor(readonly code: "NotJoined" | "Invalid" | "Unavailable") {
    super("dining continuity " + code);
    this.name = "CustomerDiningContinuityError";
  }
}

export function createCustomerDiningContinuity(options: CustomerDiningContinuityOptions) {
  const scope = Object.freeze({
    tenantReference: String(parseDiningReference(options.scope.tenantReference)),
    brandReference: String(parseDiningReference(options.scope.brandReference)),
    storeReference: String(parseDiningReference(options.scope.storeReference)),
  });
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const freshToken = () => String(options.credentials.generateCredential("Session"));
  /** A token for this live, seated session; given once, only its digest kept. */
  async function issueFor(tx: ConsumerTransaction, guestSessionReference: string, at: string) {
    const token = freshToken();
    await issueGuestSessionContinuity(tx as never, owner, {
      continuityReference: options.newReference(),
      operationReference: options.newReference(),
      guestSessionReference,
      tokenHash: digest(token),
      observedAt: at,
    });
    return token;
  }
  return Object.freeze({
    /** The phone's own bound, current Guest Session asks for its token. */
    async issue(value: unknown): Promise<{ readonly continuityToken: string }> {
      let credentials: { sessionCredential: string; csrfCredential: string };
      try {
        const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential"]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
      } catch {
        throw new CustomerDiningContinuityError("Invalid");
      }
      try {
        return await options.transactions.run(async (tx) => {
          const binding = options.binding(tx);
          const identity = new GuestSessionService({
            credentials: options.credentials,
            binding,
            store: createPostgresGuestSessionEntryStore(
              { run: <R>(next: (t: ConsumerTransaction) => Promise<R>) => next(tx) },
              owner,
            ),
            admission: { consume: async () => null },
            now: options.now,
          });
          const guest = await identity.authorize({
            ...credentials,
            observedAt: parseCanonicalInstant(options.now()),
          });
          const checked = parseCanonicalInstant(options.now());
          assertGuestSessionUsable(guest, checked);
          if (
            guest.channel !== "DineIn" ||
            guest.diningState !== "DiningBound" ||
            String(guest.brandReference) !== scope.brandReference ||
            String(guest.storeReference) !== scope.storeReference ||
            (await binding.validate(guest, checked)) !== "Current"
          )
            throw new CustomerDiningContinuityError("NotJoined");
          return Object.freeze({
            continuityToken: await issueFor(tx, String(guest.sessionReference), options.now()),
          });
        });
      } catch (error) {
        if (error instanceof CustomerDiningContinuityError) throw error;
        if (error instanceof GuestSessionError)
          throw new CustomerDiningContinuityError("NotJoined");
        throw new CustomerDiningContinuityError("Unavailable");
      }
    },
    /**
     * Where the token's phone is seated now, read only: the table (Dining says its participant is
     * at it), null (no such live seated session, or Dining says it is not seated), or unconfirmed
     * (Dining could not be read: an outage, never "not seated").
     */
    async table(token: unknown, observedAt: string): Promise<CustomerEntryPresentedAnswer> {
      if (typeof token !== "string" || !tokenPattern.test(token)) return null;
      const seat = await options.transactions.run((tx) =>
        findGuestSessionContinuity(tx as never, owner, { tokenHash: digest(token), observedAt }),
      );
      if (seat === null) return null;
      const table: CustomerEntryPresentedTable = Object.freeze({
        publicStoreReference: seat.publicStoreReference,
        publicTableReference: seat.publicTableReference,
        qrReference: seat.qrReference,
        qrRevocationVersion: seat.qrRevocationVersion,
      });
      const seated = await options.transactions
        .run((tx) =>
          createPostgresDiningGuestBindingStore(
            { run: (work) => work(tx as never) },
            scope,
          ).readCurrent({
            brandReference: parseDiningReference(scope.brandReference),
            storeReference: parseDiningReference(scope.storeReference),
            diningSessionReference: parseDiningReference(seat.diningSessionReference),
            participantReference: parseDiningReference(seat.participantReference),
            observedAt: parseDiningInstant(observedAt),
          }),
        )
        .then(
          (snapshot) => diningSeatOf(snapshot),
          () => "Unknown" as const,
        );
      if (seated === "Unknown") return Object.freeze({ unconfirmed: table });
      return seated === "Seated" ? table : null;
    },
    /**
     * The same phone back: in one transaction the old session is rotated into a new one at the same
     * seat, the token used, Dining's readmission recorded and a fresh token issued. Null (nothing
     * written) when the token no longer finds a live seated session or Dining refuses (the guest
     * left, the table closed): the caller makes it an ordinary entry. Rejects on an outage.
     */
    async readmit(
      token: unknown,
      operationReference: string,
      observedAt: string,
    ): Promise<{
      readonly sessionCredential: string;
      readonly continuityToken: string;
    } | null> {
      if (typeof token !== "string" || !tokenPattern.test(token)) return null;
      // The page recovers its CSRF from the cookie (session bootstrap); without that, no readmission.
      const derive = options.credentials.deriveForegroundCsrf;
      if (derive === undefined) return null;
      const sessionCredential = options.credentials.generateCredential("Session");
      const csrf = derive.call(options.credentials, sessionCredential);
      try {
        return await options.transactions.run(async (tx) => {
          const successor = String(options.credentials.generateSessionReference());
          const rotated = await rotateGuestSessionByContinuity(tx as never, owner, {
            tokenHash: digest(token),
            operationReference,
            observedAt,
            successor: {
              guestSessionReference: successor,
              sessionSelectorHash: String(
                options.credentials.hashCredential("Session", sessionCredential),
              ),
              csrfSelectorHash: String(options.credentials.hashCredential("Csrf", csrf)),
              operationIntentHash: String(
                options.credentials.hashOperationIntent(
                  "GuestContinuity:" + JSON.stringify({ operationReference, successor }),
                ),
              ),
            },
          });
          if (rotated === null) return null;
          await recordDiningParticipantReadmission(tx as never, scope, {
            readmissionReference: options.newReference(),
            operationReference,
            diningSessionReference: rotated.from.diningSessionReference,
            participantReference: rotated.from.participantReference,
            fromGuestSessionReference: rotated.from.guestSessionReference,
            toGuestSessionReference: rotated.toGuestSessionReference,
            observedAt,
            audit: {
              auditId: options.newReference(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "DINING_PARTICIPANT_READMITTED",
              targetType: "DiningParticipant",
              targetId: rotated.from.participantReference,
              reasonCode: "GUEST_CONTINUITY",
              correlationId: operationReference,
              occurredAt: observedAt,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            },
          });
          // A payer whose choice of dishes is still live keeps paying from the new session.
          await carryDiningCheckoutScopeToSession(tx as never, owner, {
            operationReference,
            diningSessionReference: rotated.from.diningSessionReference,
            participantReference: rotated.from.participantReference,
            fromGuestSessionReference: rotated.from.guestSessionReference,
            toGuestSessionReference: rotated.toGuestSessionReference,
            observedAt,
          });
          return Object.freeze({
            sessionCredential: String(sessionCredential),
            continuityToken: await issueFor(tx, rotated.toGuestSessionReference, observedAt),
          });
        });
      } catch (error) {
        // The rotation rolled back with it. Dining refused (the guest left, the table closed) or
        // the token was just used by a scan racing this one: an ordinary entry follows. Anything
        // else is an outage: the caller answers a retry, never a new seat.
        if (readmissionRefused(error)) return null;
        throw error;
      }
    },
  });
}

/** Dining's refusal of this readmission, or the token's single use taken by a racing scan. */
export function readmissionRefused(error: unknown): boolean {
  if (error instanceof DiningReadmissionError) return error.code === "DINING_READMISSION_REFUSED";
  return (
    error !== null && typeof error === "object" && (error as { code?: unknown }).code === "23505"
  );
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}
function fail(response: Response, status: 400 | 404 | 503) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400
      ? "continuity_request_invalid"
      : status === 404
        ? "dining_not_joined"
        : "continuity_unavailable";
  response.status(status).json({ schemaVersion: 1, error: { code } });
}

/** POST (no body): the seated phone's continuity token, for its page storage only. */
export class CustomerDiningContinuityHandler {
  readonly #origin: string;
  readonly #port: ReturnType<typeof createCustomerDiningContinuity>;
  constructor(options: {
    allowedOrigin: string;
    port: ReturnType<typeof createCustomerDiningContinuity>;
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      let input: Record<string, unknown>;
      try {
        if (
          request.get("origin") !== this.#origin ||
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
        input = { sessionCredential: entries[0]?.[1], csrfCredential: csrf };
      } catch {
        fail(response, 400);
        return;
      }
      try {
        const issued = await this.#port.issue(input);
        protect(response);
        response.status(200).json({ schemaVersion: 1, continuityToken: issued.continuityToken });
      } catch (error) {
        fail(
          response,
          error instanceof CustomerDiningContinuityError && error.code === "NotJoined"
            ? 404
            : error instanceof CustomerDiningContinuityError && error.code === "Invalid"
              ? 400
              : 503,
        );
      }
    };
  }
}

export const unavailableCustomerDiningContinuityHandler: RequestHandler = (_request, response) =>
  fail(response, 503);
