import { v7 as uuidv7 } from "uuid";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { requestCheckoutMutation } from "./checkout-client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface CheckoutDetailsDraft {
  readonly detailsReference: string;
  readonly expectedVersion: number;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly orderType: "DineIn" | "Pickup";
  readonly pickupContact: Readonly<{
    name: string;
    channel: "Phone" | "Email";
    value: string;
  }> | null;
  readonly receipt:
    | Readonly<{ choice: "InSession"; email: null }>
    | Readonly<{ choice: "TransactionalEmail"; email: string }>;
  readonly policies: readonly Readonly<{
    documentReference: string;
    documentVersion: number;
    documentDigest: string;
    purposeCode: string;
  }>[];
}
export interface CheckoutDetailsAcknowledgement {
  readonly operationReference: string;
  readonly detailsReference: string;
  readonly detailsVersion: number;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly orderType: "DineIn" | "Pickup";
  readonly receiptChoice: "InSession" | "TransactionalEmail";
  readonly recordedAt: string;
}
export type DetailsFailure = "unknown" | "denied" | "conflict" | "requote" | "policy" | "invalid";
export class CheckoutDetailsClientError extends Error {
  constructor(readonly code: DetailsFailure) {
    super(code);
  }
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new CheckoutDetailsClientError("invalid");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new CheckoutDetailsClientError("invalid");
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new CheckoutDetailsClientError("invalid");
    result[field] = descriptor.value;
  }
  return result;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.trim() !== value ||
    /[<>\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new CheckoutDetailsClientError("invalid");
  return value;
}
function reference(value: unknown) {
  const result = text(value, 36);
  if (!uuid.test(result)) throw new CheckoutDetailsClientError("invalid");
  return result;
}
function version(value: unknown, min = 1, max = 2147483647) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new CheckoutDetailsClientError("invalid");
  return Number(value);
}
function email(value: unknown) {
  const result = text(value, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) throw new CheckoutDetailsClientError("invalid");
  return result;
}
export function parseCheckoutDetailsDraft(value: CheckoutDetailsDraft): CheckoutDetailsDraft {
  const raw = exact(value, [
    "detailsReference",
    "expectedVersion",
    "cartReference",
    "cartVersion",
    "quoteReference",
    "quoteVersion",
    "orderType",
    "pickupContact",
    "receipt",
    "policies",
  ]);
  if (
    (raw.orderType !== "DineIn" && raw.orderType !== "Pickup") ||
    (raw.quoteVersion !== 1 && raw.quoteVersion !== 2)
  )
    throw new CheckoutDetailsClientError("invalid");
  let pickupContact: CheckoutDetailsDraft["pickupContact"] = null;
  if (raw.pickupContact !== null) {
    const contact = exact(raw.pickupContact, ["name", "channel", "value"]);
    if (contact.channel !== "Phone" && contact.channel !== "Email")
      throw new CheckoutDetailsClientError("invalid");
    const value = contact.channel === "Email" ? email(contact.value) : text(contact.value, 16);
    if (contact.channel === "Phone" && !/^\+[1-9][0-9]{6,14}$/u.test(value))
      throw new CheckoutDetailsClientError("invalid");
    pickupContact = Object.freeze({
      name: text(contact.name, 120),
      channel: contact.channel,
      value,
    });
  }
  if ((raw.orderType === "Pickup") !== (pickupContact !== null))
    throw new CheckoutDetailsClientError("invalid");
  const r = exact(raw.receipt, ["choice", "email"]);
  let receipt: CheckoutDetailsDraft["receipt"];
  if (r.choice === "InSession" && r.email === null)
    receipt = Object.freeze({ choice: "InSession", email: null });
  else if (r.choice === "TransactionalEmail")
    receipt = Object.freeze({ choice: "TransactionalEmail", email: email(r.email) });
  else throw new CheckoutDetailsClientError("invalid");
  if (!Array.isArray(raw.policies) || raw.policies.length > 20)
    throw new CheckoutDetailsClientError("invalid");
  const policies = raw.policies.map((value: unknown) => {
    const p = exact(value, [
      "documentReference",
      "documentVersion",
      "documentDigest",
      "purposeCode",
    ]);
    const digest = text(p.documentDigest, 71),
      purposeCode = text(p.purposeCode, 64);
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(purposeCode))
      throw new CheckoutDetailsClientError("invalid");
    return Object.freeze({
      documentReference: reference(p.documentReference),
      documentVersion: version(p.documentVersion),
      documentDigest: digest,
      purposeCode,
    });
  });
  if (new Set(policies.map((p) => p.documentReference)).size !== policies.length)
    throw new CheckoutDetailsClientError("invalid");
  return Object.freeze({
    detailsReference: reference(raw.detailsReference),
    expectedVersion: version(raw.expectedVersion, 0, 2147483646),
    cartReference: reference(raw.cartReference),
    cartVersion: version(raw.cartVersion),
    quoteReference: reference(raw.quoteReference),
    quoteVersion: raw.quoteVersion,
    orderType: raw.orderType,
    pickupContact,
    receipt,
    policies: Object.freeze(policies),
  });
}
export interface CheckoutDetailsClient {
  save(
    draft: CheckoutDetailsDraft,
    operationReference: string,
  ): Promise<CheckoutDetailsAcknowledgement>;
}
export function createCheckoutDetailsClient(): CheckoutDetailsClient {
  return Object.freeze({
    async save(value: CheckoutDetailsDraft, operationValue: string) {
      const draft = parseCheckoutDetailsDraft(value),
        operationReference = reference(operationValue);
      const current = captureCustomerCsrfContext(),
        csrf = getCustomerCsrfCredential();
      if (csrf === null) throw new CheckoutDetailsClientError("denied");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new CheckoutDetailsClientError("invalid");
      let terminal: DetailsFailure | undefined;
      try {
        const { orderType: _orderType, ...body } = draft;
        void _orderType;
        const { response, payload } = await requestCheckoutMutation(
          "/bff/customer/checkout-details",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrf,
              "idempotency-key": operationReference,
            },
            body: JSON.stringify(body),
          },
          current,
        );
        if (!current()) throw new CheckoutDetailsClientError("unknown");
        if (response.status === 200 || response.status === 201) {
          const root = exact(payload, ["schemaVersion", "details"]);
          const d = exact(root.details, [
            "operationReference",
            "detailsReference",
            "detailsVersion",
            "cartReference",
            "cartVersion",
            "quoteReference",
            "quoteVersion",
            "orderType",
            "receiptChoice",
            "recordedAt",
          ]);
          if (
            root.schemaVersion !== 1 ||
            d.operationReference !== operationReference ||
            d.detailsReference !== draft.detailsReference ||
            d.detailsVersion !== draft.expectedVersion + 1 ||
            d.cartReference !== draft.cartReference ||
            d.cartVersion !== draft.cartVersion ||
            d.quoteReference !== draft.quoteReference ||
            d.quoteVersion !== draft.quoteVersion ||
            d.orderType !== draft.orderType ||
            d.receiptChoice !== draft.receipt.choice ||
            typeof d.recordedAt !== "string" ||
            !Number.isFinite(Date.parse(d.recordedAt)) ||
            new Date(d.recordedAt).toISOString() !== d.recordedAt
          )
            throw new Error("invalid acknowledgement");
          return Object.freeze({
            operationReference,
            detailsReference: draft.detailsReference,
            detailsVersion: draft.expectedVersion + 1,
            cartReference: draft.cartReference,
            cartVersion: draft.cartVersion,
            quoteReference: draft.quoteReference,
            quoteVersion: draft.quoteVersion,
            orderType: draft.orderType,
            receiptChoice: draft.receipt.choice,
            recordedAt: d.recordedAt,
          });
        }
        const root = exact(payload, ["schemaVersion", "error"]),
          error = exact(root.error, ["code", "messageKey"]);
        const outcomes: Record<string, readonly [number, DetailsFailure]> = {
          details_request_invalid: [400, "invalid"],
          details_not_found: [404, "denied"],
          details_version_conflict: [409, "conflict"],
          details_idempotency_conflict: [409, "conflict"],
          details_requote_required: [422, "requote"],
          details_policy_changed: [422, "policy"],
          details_validation_failed: [422, "invalid"],
          details_service_unavailable: [503, "unknown"],
        };
        const code = typeof error.code === "string" ? error.code : "";
        const outcome = outcomes[code];
        if (
          root.schemaVersion !== 1 ||
          outcome === undefined ||
          outcome[0] !== response.status ||
          error.messageKey !== "customer.checkout." + code.slice(8)
        )
          throw new Error("invalid response");
        terminal = outcome[1];
        throw new CheckoutDetailsClientError(terminal);
      } catch {
        // Only a validated terminal response proves rejection; malformed responses stay unknown.
        throw new CheckoutDetailsClientError(terminal ?? "unknown");
      }
    },
  });
}
export type CheckoutDetailsState =
  | Readonly<{ status: "idle" | "pending" }>
  | Readonly<{ status: "saved"; acknowledgement: CheckoutDetailsAcknowledgement }>
  | Readonly<{ status: DetailsFailure | "offline"; canRetry: boolean }>;
export function createCheckoutDetailsController(
  client: CheckoutDetailsClient,
  keyFactory: () => string = uuidv7,
) {
  let state: CheckoutDetailsState = { status: "idle" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let plan: { draft: CheckoutDetailsDraft; key: string; current: () => boolean } | null = null;
  let context: (() => boolean) | null = null;
  let flight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (value: CheckoutDetailsState) => {
    state = Object.freeze(value);
    listeners.forEach((listener) => listener());
  };
  const execute = (): Promise<void> => {
    if (flight !== null) return flight;
    if (plan === null) return Promise.resolve();
    if (!plan.current()) {
      plan = null;
      publish({ status: "denied", canRetry: false });
      return Promise.resolve();
    }
    if (!online) {
      publish({ status: "offline", canRetry: true });
      return Promise.resolve();
    }
    const attempt = plan;
    publish({ status: "pending" });
    flight = Promise.resolve().then(async () => {
      try {
        const acknowledgement = await client.save(attempt.draft, attempt.key);
        if (!attempt.current()) {
          plan = null;
          publish({ status: "denied", canRetry: false });
        } else if (!online) publish({ status: "offline", canRetry: true });
        else {
          plan = null;
          publish({ status: "saved", acknowledgement });
        }
      } catch (error) {
        const status = !attempt.current()
          ? "denied"
          : !online
            ? "offline"
            : error instanceof CheckoutDetailsClientError
              ? error.code
              : "unknown";
        const canRetry = attempt.current() && (status === "unknown" || status === "offline");
        if (!canRetry) plan = null;
        publish({ status, canRetry });
      } finally {
        flight = null;
      }
    });
    return flight;
  };
  return Object.freeze({
    getState: (): CheckoutDetailsState => {
      if (context !== null && !context() && state.status !== "denied") {
        plan = null;
        state = Object.freeze({ status: "denied", canRetry: false });
      }
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    save(input: CheckoutDetailsDraft): Promise<void> {
      if (plan !== null || flight !== null) return execute();
      if (!online) {
        publish({ status: "offline", canRetry: false });
        return Promise.resolve();
      }
      try {
        const draft = parseCheckoutDetailsDraft(input),
          key = reference(keyFactory());
        context = captureCustomerCsrfContext();
        plan = { draft, key, current: context };
      } catch {
        publish({ status: "invalid", canRetry: false });
        return Promise.resolve();
      }
      return execute();
    },
    retry() {
      return "canRetry" in state && state.canRetry ? execute() : Promise.resolve();
    },
    setOnline(value: boolean) {
      online = value;
      if (!value && state.status !== "saved")
        publish({ status: "offline", canRetry: plan !== null && plan.current() });
    },
  });
}
