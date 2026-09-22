import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { requestCheckoutMutation } from "./checkout-client.js";
import { CheckoutDetailsClientError, type DetailsFailure } from "./details-client.js";
import type { CheckoutDetailsReadSelection } from "./details-read-client.js";

export interface CheckoutPolicyDocument {
  readonly documentReference: string;
  readonly documentVersion: number;
  readonly documentDigest: string;
  readonly purposeCode: string;
  readonly title: string;
  readonly bodyText: string;
}
export interface CheckoutPolicyView extends CheckoutDetailsReadSelection {
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly documents: readonly CheckoutPolicyDocument[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error("invalid policy");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maximum ||
    value.trim() !== value
  )
    throw new Error("invalid policy text");
  return value;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("invalid policy time");
  return value;
}
export function createCheckoutPolicyClient(now: () => number = Date.now) {
  return Object.freeze({
    async read(input: CheckoutDetailsReadSelection): Promise<CheckoutPolicyView> {
      if (
        !uuid.test(input.cartReference) ||
        !Number.isSafeInteger(input.cartVersion) ||
        input.cartVersion < 1 ||
        input.cartVersion > 2147483647 ||
        !["DineIn", "Pickup"].includes(input.orderType)
      )
        throw new CheckoutDetailsClientError("invalid");
      const selected = Object.freeze({
        cartReference: input.cartReference,
        cartVersion: input.cartVersion,
        orderType: input.orderType,
      });
      const current = captureCustomerCsrfContext(),
        csrf = getCustomerCsrfCredential();
      if (csrf === null) throw new CheckoutDetailsClientError("denied");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new CheckoutDetailsClientError("invalid");
      let failure: DetailsFailure = "unknown";
      try {
        const { response, payload } = await requestCheckoutMutation(
          "/bff/customer/checkout-details/policy",
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": csrf },
            body: JSON.stringify({
              cartReference: selected.cartReference,
              cartVersion: selected.cartVersion,
            }),
          },
          current,
        );
        if (!current()) throw new Error("changed context");
        if (response.status !== 200) {
          const root = exact(payload, ["schemaVersion", "error"]),
            error = exact(root.error, ["code", "messageKey"]);
          const outcomes: Record<string, readonly [number, DetailsFailure]> = {
            details_request_invalid: [400, "invalid"],
            details_not_found: [404, "denied"],
            details_version_conflict: [409, "conflict"],
            details_service_unavailable: [503, "unknown"],
          };
          const code = typeof error.code === "string" ? error.code : "";
          const outcome = outcomes[code];
          if (
            root.schemaVersion === 1 &&
            outcome?.[0] === response.status &&
            error.messageKey === "customer.checkout." + code.slice(8)
          )
            failure = outcome[1];
          throw new Error("policy unavailable");
        }
        const root = exact(payload, ["schemaVersion", "policy"]);
        const view = exact(root.policy, [
          "cartReference",
          "cartVersion",
          "orderType",
          "checkedAt",
          "validUntil",
          "documents",
        ]);
        const checkedAt = instant(view.checkedAt),
          validUntil = instant(view.validUntil);
        const observed = now();
        if (
          root.schemaVersion !== 1 ||
          view.cartReference !== selected.cartReference ||
          view.cartVersion !== selected.cartVersion ||
          view.orderType !== selected.orderType ||
          !Number.isFinite(observed) ||
          Date.parse(checkedAt) > observed ||
          Date.parse(validUntil) <= observed ||
          !Array.isArray(view.documents) ||
          view.documents.length > 20
        )
          throw new Error("stale policy");
        const documents = view.documents.map((value: unknown) => {
          const d = exact(value, [
            "documentReference",
            "documentVersion",
            "documentDigest",
            "purposeCode",
            "title",
            "bodyText",
          ]);
          const documentReference = text(d.documentReference, 36),
            documentDigest = text(d.documentDigest, 71);
          const purposeCode = text(d.purposeCode, 64),
            title = text(d.title, 200),
            bodyText = text(d.bodyText, 20000);
          if (
            !uuid.test(documentReference) ||
            !Number.isSafeInteger(d.documentVersion) ||
            Number(d.documentVersion) < 1 ||
            Number(d.documentVersion) > 2147483647 ||
            !/^sha256:[0-9a-f]{64}$/u.test(documentDigest) ||
            !/^[A-Z][A-Z0-9_]{0,63}$/u.test(purposeCode) ||
            /[\p{Cc}\p{Cf}]/u.test(title) ||
            /\p{Cf}/u.test(bodyText) ||
            Array.from(bodyText).some((c) => {
              const code = c.charCodeAt(0);
              return (code < 32 && code !== 9 && code !== 10) || code === 127;
            })
          )
            throw new Error("invalid policy document");
          return Object.freeze({
            documentReference,
            documentVersion: Number(d.documentVersion),
            documentDigest,
            purposeCode,
            title,
            bodyText,
          });
        });
        if (new Set(documents.map((d) => d.documentReference)).size !== documents.length)
          throw new Error("duplicate policy");
        return Object.freeze({
          ...selected,
          checkedAt,
          validUntil,
          documents: Object.freeze(documents),
        });
      } catch {
        throw new CheckoutDetailsClientError(failure);
      }
    },
  });
}
