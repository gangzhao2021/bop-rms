import { isDeepStrictEqual } from "node:util";
import { GuestSessionError, readClosedRecord } from "@bop/identity";
import {
  CartError,
  CheckoutDetailsError,
  parseCheckoutDetailsSnapshot,
  type CheckoutDetailsSnapshot,
  type CheckoutPolicyPresentation,
} from "@rms/ordering";
import type { Request, RequestHandler, Response } from "express";

export const customerCheckoutDetailsRoute = "/bff/customer/checkout-details";
export const customerCheckoutDetailsCurrentRoute = "/bff/customer/checkout-details/current";
export const customerCheckoutPolicyRoute = "/bff/customer/checkout-details/policy";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;
export interface CustomerCheckoutDetailsCommand {
  readonly operationReference: string;
  readonly detailsReference: string;
  readonly expectedVersion: number;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly pickupContact: unknown;
  readonly receipt: unknown;
  readonly policies: readonly unknown[];
}
export interface CustomerCheckoutDetailsCurrent {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly orderType: "DineIn" | "Pickup";
  readonly details: CheckoutDetailsSnapshot | null;
}
export interface CustomerCheckoutDetailsPort {
  readonly quoteVersion: 1 | 2;
  policy?(
    input: Readonly<{
      sessionCredential: string;
      csrfCredential: string;
      query: Readonly<{ cartReference: string; cartVersion: number }>;
    }>,
  ): Promise<CheckoutPolicyPresentation>;
  read?(
    input: Readonly<{
      sessionCredential: string;
      csrfCredential: string;
      query: Readonly<{ cartReference: string; cartVersion: number }>;
    }>,
  ): Promise<CustomerCheckoutDetailsCurrent>;
  save(
    input: Readonly<{
      sessionCredential: string;
      csrfCredential: string;
      command: CustomerCheckoutDetailsCommand;
    }>,
  ): Promise<Readonly<{ status: "Saved" | "AlreadySaved"; snapshot: CheckoutDetailsSnapshot }>>;
}
const failures = {
  details_request_invalid: 400,
  details_not_found: 404,
  details_version_conflict: 409,
  details_idempotency_conflict: 409,
  details_requote_required: 422,
  details_policy_changed: 422,
  details_validation_failed: 422,
  details_service_unavailable: 503,
} as const;
type Failure = keyof typeof failures;
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function reject(response: Response, code: Failure) {
  if (code === "details_service_unavailable") response.setHeader("Retry-After", "5");
  response.status(failures[code]).json({
    schemaVersion: 1,
    error: { code, messageKey: "customer.checkout." + code.slice(8) },
  });
}
const reference = (value: unknown) => {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("invalid reference");
  return value;
};
const version = (value: unknown, minimum = 1) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 2147483647)
    throw new Error("invalid version");
  return Number(value);
};
function bounded(value: unknown, max: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw new Error("invalid text");
  return value;
}
function credentials(request: Request, origin: string) {
  if (
    request.get("origin") !== origin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json"
  )
    throw new Error("invalid request");
  const cookie = request.headers.cookie;
  if (typeof cookie !== "string") throw new Error("invalid credential");
  const parts = cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .filter(([name]) => name === "__Host-bop-guest");
  if (parts.length !== 1 || parts[0]?.length !== 2 || !credential.test(parts[0]?.[1] ?? ""))
    throw new Error("invalid credential");
  const csrf = request.headers["x-csrf-token"];
  if (typeof csrf !== "string" || !credential.test(csrf)) throw new Error("invalid credential");
  return Object.freeze({ sessionCredential: parts[0]?.[1] as string, csrfCredential: csrf });
}
function parseQuery(request: Request, origin: string) {
  const raw = readClosedRecord(request.body, ["cartReference", "cartVersion"]);
  return Object.freeze({
    ...credentials(request, origin),
    query: Object.freeze({
      cartReference: reference(raw.cartReference),
      cartVersion: version(raw.cartVersion),
    }),
  });
}
function parse(request: Request, origin: string, quoteVersion: 1 | 2) {
  if (
    request.get("origin") !== origin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json"
  )
    throw new Error("invalid request");
  const raw = readClosedRecord(request.body, [
    "detailsReference",
    "expectedVersion",
    "cartReference",
    "cartVersion",
    "quoteReference",
    "quoteVersion",
    "pickupContact",
    "receipt",
    "policies",
  ]);
  if (raw.quoteVersion !== quoteVersion) throw new Error("invalid quote version");
  const expectedVersion = version(raw.expectedVersion, 0);
  if (expectedVersion === 2147483647) throw new Error("invalid version");
  const contact =
    raw.pickupContact === null
      ? null
      : readClosedRecord(raw.pickupContact, ["name", "channel", "value"]);
  if (contact !== null) {
    bounded(contact.name, 120);
    bounded(contact.value, 254);
    if (!["Phone", "Email"].includes(String(contact.channel))) throw new Error("invalid contact");
  }
  const receipt = readClosedRecord(raw.receipt, ["choice", "email"]);
  if (receipt.choice === "InSession") {
    if (receipt.email !== null) throw new Error("invalid receipt");
  } else if (receipt.choice === "TransactionalEmail") bounded(receipt.email, 254);
  else throw new Error("invalid receipt");
  if (!Array.isArray(raw.policies) || raw.policies.length > 20) throw new Error("invalid policies");
  const policies = raw.policies.map((value: unknown) => {
    const policy = readClosedRecord(value, [
      "documentReference",
      "documentVersion",
      "documentDigest",
      "purposeCode",
    ]);
    reference(policy.documentReference);
    version(policy.documentVersion);
    if (
      typeof policy.documentDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(policy.documentDigest)
    )
      throw new Error("invalid policy digest");
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(bounded(policy.purposeCode, 64)))
      throw new Error("invalid purpose");
    return Object.freeze(policy);
  });
  return Object.freeze({
    ...credentials(request, origin),
    command: Object.freeze({
      operationReference: reference(request.headers["idempotency-key"]),
      detailsReference: reference(raw.detailsReference),
      expectedVersion,
      cartReference: reference(raw.cartReference),
      cartVersion: version(raw.cartVersion),
      quoteReference: reference(raw.quoteReference),
      quoteVersion,
      pickupContact: contact === null ? null : Object.freeze(contact),
      receipt: Object.freeze(receipt),
      policies: Object.freeze(policies),
    }),
  });
}
function failure(error: unknown): Failure {
  if (error instanceof GuestSessionError) return "details_not_found";
  if (error instanceof CheckoutDetailsError) return "details_validation_failed";
  if (!(error instanceof CartError)) return "details_service_unavailable";
  const codes: Partial<Record<CartError["code"], Failure>> = {
    CART_PERMISSION_DENIED: "details_not_found",
    CART_UNAVAILABLE: "details_not_found",
    CART_INPUT_INVALID: "details_request_invalid",
    CART_VERSION_CONFLICT: "details_version_conflict",
    CART_IDEMPOTENCY_CONFLICT: "details_idempotency_conflict",
    CART_SELECTION_INVALID: "details_policy_changed",
    CART_QUOTE_INVALID: "details_requote_required",
    CART_QUOTE_EXPIRED: "details_requote_required",
    CART_EXPIRED: "details_version_conflict",
    CART_ABANDONED: "details_version_conflict",
  };
  return codes[error.code] ?? "details_service_unavailable";
}
export class CustomerCheckoutDetailsHandler {
  readonly #port: CustomerCheckoutDetailsPort;
  readonly #origin: string;
  constructor(options: { port: CustomerCheckoutDetailsPort; allowedOrigin: string }) {
    this.#port = options.port;
    this.#origin = new URL(options.allowedOrigin).origin;
  }
  policy(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: ReturnType<typeof parseQuery>;
      try {
        input = parseQuery(request, this.#origin);
      } catch {
        reject(response, "details_request_invalid");
        return;
      }
      if (this.#port.policy === undefined) {
        reject(response, "details_service_unavailable");
        return;
      }
      let result: CheckoutPolicyPresentation;
      try {
        result = await this.#port.policy(input);
      } catch (error) {
        reject(response, failure(error));
        return;
      }
      try {
        const view = readClosedRecord(result, [
          "cartReference",
          "cartVersion",
          "orderType",
          "checkedAt",
          "validUntil",
          "documents",
        ]);
        const instant = (value: unknown) => {
          if (
            typeof value !== "string" ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString() !== value
          )
            throw new Error("invalid instant");
          return value;
        };
        const checkedAt = instant(view.checkedAt),
          validUntil = instant(view.validUntil);
        if (
          view.cartReference !== input.query.cartReference ||
          view.cartVersion !== input.query.cartVersion ||
          (view.orderType !== "DineIn" && view.orderType !== "Pickup") ||
          validUntil <= checkedAt ||
          !Array.isArray(view.documents) ||
          view.documents.length > 20
        )
          throw new Error("invalid policy view");
        const documents = view.documents.map((value: unknown) => {
          const document = readClosedRecord(value, [
            "documentReference",
            "documentVersion",
            "documentDigest",
            "purposeCode",
            "title",
            "bodyText",
          ]);
          const documentReference = reference(document.documentReference),
            documentVersion = version(document.documentVersion);
          const documentDigest = bounded(document.documentDigest, 71),
            purposeCode = bounded(document.purposeCode, 64);
          if (
            !/^sha256:[0-9a-f]{64}$/u.test(documentDigest) ||
            !/^[A-Z][A-Z0-9_]{0,63}$/u.test(purposeCode)
          )
            throw new Error("invalid policy identity");
          return {
            documentReference,
            documentVersion,
            documentDigest,
            purposeCode,
            title: bounded(document.title, 200),
            bodyText: bounded(document.bodyText, 20000),
          };
        });
        if (new Set(documents.map((d) => d.documentReference)).size !== documents.length)
          throw new Error("duplicate document");
        response.status(200).json({
          schemaVersion: 1,
          policy: {
            cartReference: view.cartReference,
            cartVersion: view.cartVersion,
            orderType: view.orderType,
            checkedAt,
            validUntil,
            documents,
          },
        });
      } catch {
        reject(response, "details_service_unavailable");
      }
    };
  }
  current(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: ReturnType<typeof parseQuery>;
      try {
        input = parseQuery(request, this.#origin);
      } catch {
        reject(response, "details_request_invalid");
        return;
      }
      if (this.#port.read === undefined) {
        reject(response, "details_service_unavailable");
        return;
      }
      let result: CustomerCheckoutDetailsCurrent;
      try {
        result = await this.#port.read(input);
      } catch (error) {
        reject(response, failure(error));
        return;
      }
      try {
        const current = readClosedRecord(result, [
          "cartReference",
          "cartVersion",
          "orderType",
          "details",
        ]);
        if (
          current.cartReference !== input.query.cartReference ||
          current.cartVersion !== input.query.cartVersion ||
          (current.orderType !== "DineIn" && current.orderType !== "Pickup")
        )
          throw new Error("invalid current context");
        const details =
          current.details === null ? null : parseCheckoutDetailsSnapshot(current.details);
        if (
          details !== null &&
          (details.cartReference !== current.cartReference ||
            details.cartVersion > input.query.cartVersion ||
            details.orderType !== current.orderType)
        )
          throw new Error("invalid current details");
        response.status(200).json({
          schemaVersion: 1,
          checkout: {
            cartReference: current.cartReference,
            cartVersion: current.cartVersion,
            orderType: current.orderType,
            details:
              details === null
                ? null
                : {
                    detailsReference: details.detailsReference,
                    detailsVersion: details.detailsVersion,
                    cartReference: details.cartReference,
                    cartVersion: details.cartVersion,
                    quoteReference: details.quoteReference,
                    quoteVersion: details.quoteVersion,
                    pickupContact: details.pickupContact,
                    receipt: details.receipt,
                    policies: details.policies,
                    recordedAt: details.recordedAt,
                  },
          },
        });
      } catch {
        reject(response, "details_service_unavailable");
      }
    };
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: ReturnType<typeof parse>;
      try {
        input = parse(request, this.#origin, this.#port.quoteVersion);
      } catch {
        reject(response, "details_request_invalid");
        return;
      }
      let result: Awaited<ReturnType<CustomerCheckoutDetailsPort["save"]>>;
      try {
        result = await this.#port.save(input);
      } catch (error) {
        reject(response, failure(error));
        return;
      }
      try {
        const raw = readClosedRecord(result, ["status", "snapshot"]);
        if (raw.status !== "Saved" && raw.status !== "AlreadySaved")
          throw new Error("invalid status");
        const snapshot = parseCheckoutDetailsSnapshot(raw.snapshot);
        const command = input.command;
        if (
          snapshot.detailsReference !== command.detailsReference ||
          snapshot.detailsVersion !== command.expectedVersion + 1 ||
          snapshot.cartReference !== command.cartReference ||
          snapshot.cartVersion !== command.cartVersion ||
          snapshot.quoteReference !== command.quoteReference ||
          snapshot.quoteVersion !== command.quoteVersion ||
          !isDeepStrictEqual(snapshot.pickupContact, command.pickupContact) ||
          !isDeepStrictEqual(snapshot.receipt, command.receipt) ||
          !isDeepStrictEqual(snapshot.policies, command.policies)
        )
          throw new Error("invalid acknowledgement");
        response.status(raw.status === "Saved" ? 201 : 200).json({
          schemaVersion: 1,
          details: {
            operationReference: command.operationReference,
            detailsReference: snapshot.detailsReference,
            detailsVersion: snapshot.detailsVersion,
            cartReference: snapshot.cartReference,
            cartVersion: snapshot.cartVersion,
            quoteReference: snapshot.quoteReference,
            quoteVersion: snapshot.quoteVersion,
            orderType: snapshot.orderType,
            receiptChoice: snapshot.receipt.choice,
            recordedAt: snapshot.recordedAt,
          },
        });
      } catch {
        reject(response, "details_service_unavailable");
      }
    };
  }
}
export const unavailableCustomerCheckoutDetailsHandler: RequestHandler = (_request, response) => {
  protect(response);
  reject(response, "details_service_unavailable");
};
