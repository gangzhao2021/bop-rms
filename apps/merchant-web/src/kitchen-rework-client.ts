/**
 * WP-2423 Q26 (Handoff Section 26.6): the Kitchen board's remakes. A finished dish that was made
 * wrong, dropped, sent back or failed a quality check is made again as a new rework; a dish marked
 * done by mistake goes back in progress (within two minutes). The original keeps its result.
 */
export const kitchenReworkReasons = [
  "WRONG_ITEM",
  "DROPPED",
  "CUSTOMER_RETURNED",
  "QUALITY_ISSUE",
  "NOT_READY",
  "OTHER",
] as const;
export type KitchenReworkReason = (typeof kitchenReworkReasons)[number];
export type KitchenReworkStatus = "Queued" | "In Progress" | "Completed";

/** Staff words for each reason (never the internal code). */
export const kitchenReworkReasonLabels: Readonly<Record<KitchenReworkReason, string>> =
  Object.freeze({
    WRONG_ITEM: "Made wrong",
    DROPPED: "Dropped",
    CUSTOMER_RETURNED: "Guest sent it back",
    QUALITY_ISSUE: "Quality problem",
    NOT_READY: "Not ready yet — marked done by mistake",
    OTHER: "Other reason",
  });
/** Badge on the remade ticket. */
export function kitchenReworkBadge(reason: KitchenReworkReason): string {
  return reason === "NOT_READY"
    ? "Back in progress · Marked done too early"
    : "Remake · " + kitchenReworkReasonLabels[reason];
}
export const kitchenReworkNotReadyWindowMs = 120_000;

export interface KitchenReworkView {
  readonly reworkReference: string;
  readonly originalWorkItemReference: string;
  readonly orderReference: string;
  readonly orderItemReference: string;
  readonly reasonCode: KitchenReworkReason;
  readonly note: string | null;
  readonly quantity: number;
  readonly wasteApplies: boolean;
  readonly status: KitchenReworkStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly displayName: string;
  readonly selectedOptions: readonly { readonly displayName: string; readonly quantity: number }[];
  readonly orderLabel: {
    readonly orderNumber: string;
    readonly orderType: "Pickup" | "DineIn";
    readonly tableLabel: string | null;
  } | null;
  readonly customerNote: string | null;
}
export interface KitchenReworkBoard {
  readonly canRework: boolean;
  readonly observedAt: string;
  readonly items: readonly KitchenReworkView[];
}

export class KitchenReworkClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "PreconditionFailed"
      | "WindowClosed"
      | "Invalid"
      | "NotOffered"
      | "OutcomeUnknown",
  ) {
    super("Kitchen remake could not be confirmed");
    this.name = "KitchenReworkClientError";
  }
}
const fail = (code: KitchenReworkClientError["code"]): never => {
  throw new KitchenReworkClientError(code);
};
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,240}$/u;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("OutcomeUnknown");
const reference = (value: unknown) =>
  typeof value === "string" && UUID_V7.test(value) ? value : fail("OutcomeUnknown");
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT.test(value) ? value : fail("OutcomeUnknown");
const optionalInstant = (value: unknown) => (value === null ? null : instant(value));
const optionalText = (value: unknown) =>
  value === null
    ? null
    : typeof value === "string" && SAFE_TEXT.test(value)
      ? value
      : fail("OutcomeUnknown");

function parseView(value: unknown): KitchenReworkView {
  const raw = record(value);
  if (
    !kitchenReworkReasons.includes(raw.reasonCode as KitchenReworkReason) ||
    !["Queued", "In Progress", "Completed"].includes(String(raw.status)) ||
    !Number.isSafeInteger(raw.quantity) ||
    !Number.isSafeInteger(raw.version) ||
    typeof raw.wasteApplies !== "boolean" ||
    !Array.isArray(raw.selectedOptions)
  )
    return fail("OutcomeUnknown");
  const label = raw.orderLabel === null ? null : record(raw.orderLabel);
  return Object.freeze({
    reworkReference: reference(raw.reworkReference),
    originalWorkItemReference: reference(raw.originalWorkItemReference),
    orderReference: reference(raw.orderReference),
    orderItemReference: reference(raw.orderItemReference),
    reasonCode: raw.reasonCode as KitchenReworkReason,
    note: optionalText(raw.note),
    quantity: Number(raw.quantity),
    wasteApplies: raw.wasteApplies,
    status: raw.status as KitchenReworkStatus,
    version: Number(raw.version),
    createdAt: instant(raw.createdAt),
    startedAt: optionalInstant(raw.startedAt),
    completedAt: optionalInstant(raw.completedAt),
    displayName: optionalText(raw.displayName) ?? "Dish",
    selectedOptions: raw.selectedOptions.map((option: unknown) => {
      const entry = record(option);
      return Object.freeze({
        displayName: optionalText(entry.displayName) ?? "Option",
        quantity: Number.isSafeInteger(entry.quantity) ? Number(entry.quantity) : 1,
      });
    }),
    orderLabel:
      label === null
        ? null
        : Object.freeze({
            orderNumber: optionalText(label.orderNumber) ?? "",
            orderType: label.orderType === "DineIn" ? "DineIn" : "Pickup",
            tableLabel: optionalText(label.tableLabel),
          }),
    customerNote: optionalText(raw.customerNote),
  });
}

async function post(
  fetcher: typeof fetch,
  path: string,
  csrf: string,
  body: unknown,
  signal?: AbortSignal,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(csrf)) return fail("Invalid");
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-BOP-CSRF": csrf,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
    if (response.status === 404) return fail("NotFound");
    if (response.status === 409) return fail("Conflict");
    if (response.status === 400) return fail("Invalid");
    if (response.status === 422) {
      const error = await response.json().catch(() => null);
      return fail(
        error && (error as { error?: unknown }).error === "KITCHEN_REWORK_WINDOW_CLOSED"
          ? "WindowClosed"
          : "PreconditionFailed",
      );
    }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json"))
      return fail("OutcomeUnknown");
    const text = await response.text();
    if (text.length > 1048576) return fail("OutcomeUnknown");
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof KitchenReworkClientError) throw error;
    return fail("OutcomeUnknown");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export type KitchenReworkCommandBody =
  | {
      readonly action: "CreateKitchenRework";
      readonly idempotencyKey: string;
      readonly originalWorkItemReference: string;
      readonly reasonCode: KitchenReworkReason;
      readonly note: string | null;
      readonly quantity: number;
      readonly correlationReference: string;
    }
  | {
      readonly action: "StartKitchenRework" | "CompleteKitchenRework";
      readonly idempotencyKey: string;
      readonly reworkReference: string;
      readonly expectedVersion: number;
      readonly correlationReference: string;
    };

/** No browser storage; one immutable body per intent so a lost answer is retried as the same operation. */
export function createKitchenReworkClient(options: {
  readonly csrf: string;
  readonly storeReference: string;
  readonly fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  return Object.freeze({
    async load(): Promise<KitchenReworkBoard> {
      let raw: Record<string, unknown>;
      try {
        raw = await post(fetcher, "/merchant/kitchen/rework/query", options.csrf, {});
      } catch (error) {
        // Not offered by this source (no route): the board hides remakes instead of a dead control.
        if (error instanceof KitchenReworkClientError && error.code === "NotFound")
          return fail("NotOffered");
        throw error;
      }
      if (raw.storeReference !== options.storeReference) return fail("PermissionDenied");
      if (typeof raw.canRework !== "boolean" || !Array.isArray(raw.items) || raw.items.length > 100)
        return fail("OutcomeUnknown");
      return Object.freeze({
        canRework: raw.canRework,
        observedAt: instant(raw.observedAt),
        items: Object.freeze(raw.items.map(parseView)),
      });
    },
    async execute(body: KitchenReworkCommandBody, signal?: AbortSignal) {
      const raw = await post(
        fetcher,
        "/merchant/kitchen/rework/command",
        options.csrf,
        body,
        signal,
      );
      if (raw.action !== body.action || !["Applied", "AlreadyApplied"].includes(String(raw.status)))
        return fail("OutcomeUnknown");
      return parseView({ ...record(raw.rework), displayName: null, selectedOptions: [] });
    },
  });
}
