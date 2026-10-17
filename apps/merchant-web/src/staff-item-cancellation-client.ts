import type { StaffCancellationReason } from "./current-order-queue-client.js";
import { FULL_SIGN_IN_REQUIRED, isFullSignInRequired } from "./full-sign-in.js";
import { serviceOperationReference } from "./service-control-client.js";

/**
 * WP-2423 Q6 step 2: staff cancel single item lines of a paid batch before the kitchen starts them.
 * Preview, cancel and refund-check commands; every answer is parsed strictly and anything else is
 * treated as an unknown result.
 */
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const minor = /^(0|[1-9][0-9]{0,17})$/u;
class Invalid extends Error {}
const invalid = (): never => {
  throw new Invalid("invalid item cancellation answer");
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return invalid();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return invalid();
      return [key, d.value as unknown];
    }),
  );
}
const ref = (value: unknown) =>
  typeof value === "string" && reference.test(value) ? value : invalid();
const amount = (value: unknown) =>
  typeof value === "string" && minor.test(value) ? value : invalid();
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? value
    : invalid();

export type ItemCancelScope = "Items" | "Batch";

/** The items the staff member selected; the server decides eligibility and the refund. */
export interface ItemCancelSelection {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReferences: readonly string[];
  readonly expectedOrderVersion: number;
}

function selectionBody(selection: ItemCancelSelection) {
  const items = selection.orderItemReferences;
  if (
    !reference.test(selection.orderReference) ||
    !reference.test(selection.orderBatchReference) ||
    items.length < 1 ||
    items.length > 100 ||
    new Set(items).size !== items.length ||
    items.some((item) => !reference.test(item)) ||
    !Number.isInteger(selection.expectedOrderVersion) ||
    selection.expectedOrderVersion < 1
  )
    throw new Error("ITEM_CANCEL_SELECTION_INVALID");
  return {
    orderReference: selection.orderReference,
    orderBatchReference: selection.orderBatchReference,
    // Sorted so the same selection always reads the same preview and command.
    orderItemReferences: [...items].sort(),
    expectedOrderVersion: selection.expectedOrderVersion,
  };
}

/** POST /merchant/orders/cancel-items/preview answer. */
export function parseItemCancelPreview(value: unknown) {
  const raw = exact(value, ["scope", "refund"]);
  const refund = exact(raw.refund, [
    "amountMinor",
    "currencyCode",
    "includesTip",
    "netAmountMinor",
    "taxAmountMinor",
    "tipAmountMinor",
  ]);
  const amountMinor = amount(refund.amountMinor);
  const netAmountMinor = amount(refund.netAmountMinor);
  const taxAmountMinor = amount(refund.taxAmountMinor);
  const tipAmountMinor = amount(refund.tipAmountMinor);
  if (
    (raw.scope !== "Items" && raw.scope !== "Batch") ||
    refund.currencyCode !== "CAD" ||
    typeof refund.includesTip !== "boolean" ||
    // Items: exactly the selected items' net + tax and their share of the tip
    // (DEC-TIP-REFUND-PROPORTIONAL); Batch: the whole remaining payment.
    (raw.scope === "Items" &&
      (refund.includesTip !== BigInt(tipAmountMinor) > 0n ||
        BigInt(netAmountMinor) + BigInt(taxAmountMinor) + BigInt(tipAmountMinor) !==
          BigInt(amountMinor))) ||
    (raw.scope === "Batch" && tipAmountMinor !== "0")
  )
    return invalid();
  return Object.freeze({
    scope: raw.scope as ItemCancelScope,
    refund: Object.freeze({
      amountMinor,
      currencyCode: "CAD" as const,
      includesTip: refund.includesTip,
      netAmountMinor,
      taxAmountMinor,
      tipAmountMinor,
    }),
  });
}
export type ItemCancelPreview = ReturnType<typeof parseItemCancelPreview>;

/** POST /merchant/orders/cancel-items answer, checked against the command that was sent. */
export function parseItemCancelResult(value: unknown, sent: ReturnType<typeof selectionBody>) {
  const raw = exact(value, [
    "status",
    "scope",
    "orderReference",
    "orderBatchReference",
    "cancellationReference",
    "orderItemReferences",
    "cancelledAt",
    "refund",
  ]);
  const refund = exact(raw.refund, ["status", "amountMinor", "currencyCode", "includesTip"]);
  if (
    (raw.status !== "Cancelled" && raw.status !== "AlreadyCancelled") ||
    (raw.scope !== "Items" && raw.scope !== "Batch") ||
    raw.orderReference !== sent.orderReference ||
    raw.orderBatchReference !== sent.orderBatchReference ||
    !Array.isArray(raw.orderItemReferences) ||
    raw.orderItemReferences.length !== sent.orderItemReferences.length ||
    new Set(raw.orderItemReferences).size !== raw.orderItemReferences.length ||
    raw.orderItemReferences.some(
      (item: unknown) => !sent.orderItemReferences.includes(ref(item)),
    ) ||
    (refund.status !== "Pending" && refund.status !== "Refunded") ||
    refund.currencyCode !== "CAD" ||
    typeof refund.includesTip !== "boolean"
  )
    return invalid();
  return Object.freeze({
    status: raw.status as "Cancelled" | "AlreadyCancelled",
    scope: raw.scope as ItemCancelScope,
    cancellationReference: ref(raw.cancellationReference),
    cancelledAt: instant(raw.cancelledAt),
    refund: Object.freeze({
      status: refund.status as "Pending" | "Refunded",
      amountMinor: amount(refund.amountMinor),
      currencyCode: "CAD" as const,
      includesTip: refund.includesTip,
    }),
  });
}

/** POST /merchant/orders/cancel-items/refund answer. */
export function parseItemRefundCheck(value: unknown) {
  const refund = exact(exact(value, ["refund"]).refund, ["status", "amountMinor", "currencyCode"]);
  if (
    !["Pending", "Refunded", "Failed"].includes(String(refund.status)) ||
    refund.currencyCode !== "CAD"
  )
    return invalid();
  return Object.freeze({
    status: refund.status as "Pending" | "Refunded" | "Failed",
    amountMinor: amount(refund.amountMinor),
    currencyCode: "CAD" as const,
  });
}

/** How a preview or cancel request ended when it did not succeed. */
export type ItemCancelFailure =
  | "PreparationStarted"
  | "VersionConflict"
  | "LegacyStock"
  | "NotCancellable"
  | "Denied"
  /** Refused because the person signed in with a PIN; they confirm it is them and retry. */
  | typeof FULL_SIGN_IN_REQUIRED
  | "Unknown";

export function itemCancelFailure(status: number, error: string | null): ItemCancelFailure {
  if (isFullSignInRequired(status, { error })) return FULL_SIGN_IN_REQUIRED;
  if (status === 401 || status === 403) return "Denied";
  if (status === 409)
    return error === "order_preparation_started"
      ? "PreparationStarted"
      : error === "order_version_conflict"
        ? "VersionConflict"
        : error === "order_item_stock_legacy"
          ? "LegacyStock"
          : "NotCancellable";
  if (status === 400 || status === 404) return "NotCancellable";
  return "Unknown";
}

type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ItemCancelFailure };

async function post<T>(
  fetcher: typeof fetch,
  csrf: string,
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<Answer<T>> {
  try {
    const response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-bop-csrf": csrf },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      let error: string | null = null;
      try {
        const value = (await response.json()) as unknown;
        if (
          value &&
          typeof value === "object" &&
          "error" in value &&
          typeof value.error === "string"
        )
          error = value.error;
      } catch {
        error = null;
      }
      return { ok: false, failure: itemCancelFailure(response.status, error) };
    }
    const text = await response.text();
    if (text.length > 65536) return { ok: false, failure: "Unknown" };
    return { ok: true, value: parse(JSON.parse(text) as unknown) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, failure: "Unknown" };
  }
}

/** The settled intent of one cancellation attempt; reused unchanged when its result is unknown. */
export interface ItemCancelIntent {
  readonly operationReference: string;
  readonly reasonCode: StaffCancellationReason;
  readonly selection: ItemCancelSelection;
}

export function createStaffItemCancellationClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
  newOperationReference: () => string = serviceOperationReference,
) {
  let pending: ItemCancelIntent | null = null;
  return Object.freeze({
    /** The refund the server would make for this selection now. */
    preview(selection: ItemCancelSelection, signal?: AbortSignal) {
      return post(
        fetcher,
        csrf,
        "/merchant/orders/cancel-items/preview",
        selectionBody(selection),
        parseItemCancelPreview,
        signal,
      );
    },
    /** The intent a retry would send again, or null when the next submit starts a new one. */
    pendingIntent: () => pending,
    /**
     * Cancel the selected items. An unknown result, or a refusal until the person confirms their
     * PIN sign-in, keeps the same operation reference (and the same selection and reason) so the
     * retry recovers or completes the first attempt; any settled answer ends the intent.
     */
    async cancel(selection: ItemCancelSelection, reasonCode: StaffCancellationReason) {
      pending ??= Object.freeze({
        operationReference: newOperationReference(),
        reasonCode,
        selection: Object.freeze({
          ...selection,
          orderItemReferences: Object.freeze([...selection.orderItemReferences]),
        }),
      });
      const intent = pending;
      const sent = selectionBody(intent.selection);
      const answer = await post(
        fetcher,
        csrf,
        "/merchant/orders/cancel-items",
        { ...sent, operationReference: intent.operationReference, reasonCode: intent.reasonCode },
        (value) => parseItemCancelResult(value, sent),
      );
      if (answer.ok || (answer.failure !== "Unknown" && answer.failure !== FULL_SIGN_IN_REQUIRED))
        pending = null;
      return answer;
    },
    /** Ask for the refund status of an earlier item cancellation; never resends a refund. */
    checkRefund(orderReference: string, cancellationReference: string) {
      if (!reference.test(orderReference) || !reference.test(cancellationReference))
        throw new Error("ITEM_REFUND_CHECK_INVALID");
      return post(
        fetcher,
        csrf,
        "/merchant/orders/cancel-items/refund",
        { orderReference, cancellationReference },
        parseItemRefundCheck,
      );
    },
  });
}
export type StaffItemCancellationClient = ReturnType<typeof createStaffItemCancellationClient>;
