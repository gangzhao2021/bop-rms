import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { requestCheckoutMutation } from "./checkout-client.js";
import {
  CheckoutDetailsClientError,
  parseCheckoutDetailsDraft,
  type CheckoutDetailsDraft,
  type DetailsFailure,
} from "./details-client.js";

export interface CheckoutDetailsReadSelection {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly orderType: "DineIn" | "Pickup";
}
export interface CheckoutDetailsCurrentView extends CheckoutDetailsReadSelection {
  readonly details:
    | (Omit<CheckoutDetailsDraft, "expectedVersion" | "orderType"> &
        Readonly<{ detailsVersion: number; recordedAt: string }>)
    | null;
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
    throw new Error("invalid current details");
  return value as Record<string, unknown>;
}
export function createCheckoutDetailsReadClient() {
  return Object.freeze({
    async read(selection: CheckoutDetailsReadSelection): Promise<CheckoutDetailsCurrentView> {
      if (
        !uuid.test(selection.cartReference) ||
        !Number.isSafeInteger(selection.cartVersion) ||
        selection.cartVersion < 1 ||
        selection.cartVersion > 2147483647 ||
        !["DineIn", "Pickup"].includes(selection.orderType)
      )
        throw new CheckoutDetailsClientError("invalid");
      const expected = Object.freeze({
        cartReference: selection.cartReference,
        cartVersion: selection.cartVersion,
        orderType: selection.orderType,
      });
      const current = captureCustomerCsrfContext(),
        csrf = getCustomerCsrfCredential();
      if (csrf === null) throw new CheckoutDetailsClientError("denied");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new CheckoutDetailsClientError("invalid");
      let failure: DetailsFailure = "unknown";
      try {
        const { response, payload } = await requestCheckoutMutation(
          "/bff/customer/checkout-details/current",
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": csrf },
            body: JSON.stringify({
              cartReference: expected.cartReference,
              cartVersion: expected.cartVersion,
            }),
          },
          current,
        );
        if (!current()) throw new Error("replaced context");
        if (response.status !== 200) {
          const root = exact(payload, ["schemaVersion", "error"]),
            error = exact(root.error, ["code", "messageKey"]);
          const errors: Record<string, readonly [number, DetailsFailure]> = {
            details_request_invalid: [400, "invalid"],
            details_not_found: [404, "denied"],
            details_version_conflict: [409, "conflict"],
            details_service_unavailable: [503, "unknown"],
          };
          const code = typeof error.code === "string" ? error.code : "";
          const found = errors[code];
          if (
            root.schemaVersion === 1 &&
            found?.[0] === response.status &&
            error.messageKey === "customer.checkout." + code.slice(8)
          )
            failure = found[1];
          throw new Error("read refused");
        }
        const root = exact(payload, ["schemaVersion", "checkout"]);
        const view = exact(root.checkout, ["cartReference", "cartVersion", "orderType", "details"]);
        if (
          root.schemaVersion !== 1 ||
          view.cartReference !== expected.cartReference ||
          view.cartVersion !== expected.cartVersion ||
          view.orderType !== expected.orderType
        )
          throw new Error("changed context");
        if (view.details === null) return Object.freeze({ ...expected, details: null });
        const raw = exact(view.details, [
          "detailsReference",
          "detailsVersion",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "quoteVersion",
          "pickupContact",
          "receipt",
          "policies",
          "recordedAt",
        ]);
        const { detailsVersion, recordedAt, ...values } = raw;
        if (
          !Number.isSafeInteger(detailsVersion) ||
          Number(detailsVersion) < 1 ||
          Number(detailsVersion) > 2147483647 ||
          typeof recordedAt !== "string" ||
          !Number.isFinite(Date.parse(recordedAt)) ||
          new Date(recordedAt).toISOString() !== recordedAt
        )
          throw new Error("invalid history");
        const draft = parseCheckoutDetailsDraft({
          ...values,
          expectedVersion: Number(detailsVersion) - 1,
          orderType: expected.orderType,
        } as unknown as CheckoutDetailsDraft);
        if (
          draft.cartReference !== expected.cartReference ||
          draft.cartVersion > expected.cartVersion
        )
          throw new Error("foreign or future history");
        const { expectedVersion: _version, orderType: _type, ...saved } = draft;
        void _version;
        void _type;
        return Object.freeze({
          ...expected,
          details: Object.freeze({ ...saved, detailsVersion: Number(detailsVersion), recordedAt }),
        });
      } catch {
        throw new CheckoutDetailsClientError(failure);
      }
    },
  });
}
