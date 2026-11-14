import type { MenuJourneyContext } from "../menu/types.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
  setCustomerSessionRestoreUnavailable,
  isCustomerSessionRestoreUnavailable,
  setCheckoutSessionReference,
  setEndedVisitReceiptAccess,
  setMovedTableLabel,
  setSettledTable,
} from "./customer-transaction-context.js";
function menuContext(value: unknown): MenuJourneyContext | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "publicStoreReference",
    "channel",
    "locale",
    "brandDisplayName",
    "storeDisplayName",
  ];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => typeof raw[key] !== "string"))
    return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      String(raw.publicStoreReference),
    ) ||
    !["DineIn", "Pickup"].includes(String(raw.channel)) ||
    !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u.test(String(raw.locale)) ||
    [raw.brandDisplayName, raw.storeDisplayName].some(
      (name) => typeof name !== "string" || !name.trim() || name.length > 200,
    )
  )
    return null;
  return Object.freeze(raw) as unknown as MenuJourneyContext;
}
/** WP-2423 Q10: the order this browser's Guest Session placed, for "continue your order". */
export interface CustomerCurrentOrder {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  /** M104 (B.2): this visit's earlier orders on this phone, newest first (absent: none). */
  readonly earlier?: readonly CustomerCurrentOrder[];
}
function currentOrder(value: unknown): CustomerCurrentOrder | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ["orderReference", "orderNumber", "orderType"];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !(key in raw))) return null;
  if (
    typeof raw.orderReference !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      raw.orderReference,
    ) ||
    typeof raw.orderNumber !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(raw.orderNumber) ||
    (raw.orderType !== "Pickup" && raw.orderType !== "DineIn")
  )
    return null;
  return Object.freeze({
    orderReference: raw.orderReference,
    orderNumber: raw.orderNumber,
    orderType: raw.orderType,
  });
}
/** WP-2423 (v15 3cd0f8dd M5): the ended visit's receipt access, or null when malformed. */
function endedVisit(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ["csrfToken", "order", "receiptAvailableUntil"];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !(key in raw))) return null;
  const order = currentOrder(raw.order);
  if (
    order === null ||
    typeof raw.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(raw.csrfToken) ||
    typeof raw.receiptAvailableUntil !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.receiptAvailableUntil) ||
    Number.isNaN(Date.parse(raw.receiptAvailableUntil))
  )
    return null;
  return Object.freeze({
    csrfToken: raw.csrfToken,
    ...order,
    receiptAvailableUntil: raw.receiptAvailableUntil,
  });
}
/** M02: a restored dine-in Session's table, and whether this phone joined the party there. */
export interface CustomerRestoredVisit {
  readonly publicTableReference: string;
  readonly joined: boolean;
}
function restoredVisit(value: unknown): CustomerRestoredVisit | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 2 ||
    typeof raw.joined !== "boolean" ||
    typeof raw.publicTableReference !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      raw.publicTableReference,
    )
  )
    return null;
  return Object.freeze({ publicTableReference: raw.publicTableReference, joined: raw.joined });
}
/**
 * The Store's answer said nothing about the visit: busy (503, 429), another server failure, or no
 * answer at all. 204 (no visit), 400/401/403/404 and every 200 are answers.
 */
function unanswered(status: number): boolean {
  return status === 429 || status >= 500 || status === 0;
}
/** The first restore waits this long, so a page opened in a rush still paints in time. */
const firstRestoreTimeoutMs = 5000;
/**
 * A restore asked again because the first one had no answer waits as long as the Store may take
 * to answer a read in a rush (it answers busy by 13 s), inside the 15 s a phone waits.
 */
export const customerSessionRecoveryTimeoutMs = 14_000;
/** Restore foreground CSRF and current public menu context in memory only. */
export async function restoreCustomerSession(
  fetcher: typeof fetch = fetch,
  onMenuContext?: (context: MenuJourneyContext) => void,
  onCurrentOrder?: (order: CustomerCurrentOrder) => void,
  onVisit?: (visit: CustomerRestoredVisit) => void,
  options: { readonly timeoutMs?: number } = {},
): Promise<boolean> {
  if (getCustomerCsrfCredential() !== null) return true;
  const current = captureCustomerCsrfContext();
  // WP-2423 (rush-reads-and-orders-changes): whether the Store answered at all. A restore that
  // got no usable answer leaves the page not knowing whether its visit goes on (see
  // setCustomerSessionRestoreUnavailable); a real answer ("no visit", "this visit") settles it.
  const settle = (unavailable: boolean) => {
    if (current()) setCustomerSessionRestoreUnavailable(unavailable);
  };
  try {
    const response = await fetcher("/api/v1/customer/session/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "x-bop-session-bootstrap": "1" },
      signal: AbortSignal.timeout(options.timeoutMs ?? firstRestoreTimeoutMs),
    });
    settle(unanswered(response.status));
    // 204: this browser has no Guest Session yet (a first visit), or its visit ended or expired;
    // there is nothing to restore and no token is issued.
    if (
      !current() ||
      response.status !== 200 ||
      response.redirected ||
      !response.headers
        .get("cache-control")
        ?.split(",")
        .some((v) => v.trim().toLowerCase() === "no-store") ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
      !response.body
    )
      return false;
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (!current()) return false;
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) return false;
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    // WP-2423 (v15 3cd0f8dd M5): the visit ended but placed an order; its receipt stays readable
    // here for a while. Nothing else is restored (no menu, cart or checkout).
    if (
      current() &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "endedVisit" in value
    ) {
      const ended = endedVisit(value.endedVisit);
      if (ended !== null) setEndedVisitReceiptAccess(ended);
      return false;
    }
    // Coordinator 2026-10-30: the table was settled while this guest sat at it, with the ended
    // visit's value that reads that table's receipt. Nothing to order or pay with is restored.
    if (
      current() &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "settledTable" in value
    ) {
      const settled = value.settledTable;
      if (
        settled !== null &&
        typeof settled === "object" &&
        !Array.isArray(settled) &&
        Object.keys(settled).length === 2 &&
        "tableLabel" in settled &&
        typeof settled.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(settled.tableLabel) &&
        "csrfToken" in settled &&
        typeof settled.csrfToken === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(settled.csrfToken)
      )
        setSettledTable({ tableLabel: settled.tableLabel, csrfToken: settled.csrfToken });
      return false;
    }
    // v15 2026-10-30: staff moved the party after this phone joined: only where it sits now.
    if (
      current() &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "movedTable" in value
    ) {
      const moved = value.movedTable;
      if (
        moved !== null &&
        typeof moved === "object" &&
        !Array.isArray(moved) &&
        Object.keys(moved).length === ("merged" in moved ? 2 : 1) &&
        (!("merged" in moved) || moved.merged === true) &&
        "tableLabel" in moved &&
        typeof moved.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(moved.tableLabel)
      )
        setMovedTableLabel(moved.tableLabel, "merged" in moved);
      return false;
    }
    if (
      !current() ||
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !==
        2 +
          ("menuContext" in value ? 1 : 0) +
          ("checkoutSessionReference" in value ? 1 : 0) +
          ("currentOrder" in value ? 1 : 0) +
          ("earlierOrders" in value ? 1 : 0) +
          ("visit" in value ? 1 : 0) ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("csrfToken" in value) ||
      typeof value.csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken)
    )
      return false;
    const context = "menuContext" in value ? menuContext(value.menuContext) : undefined;
    if (context === null) return false;
    const latest = "currentOrder" in value ? currentOrder(value.currentOrder) : undefined;
    if (latest === null) return false;
    // M104 (B.2): the visit's earlier orders, shown under the latest one.
    const rawEarlier = "earlierOrders" in value ? value.earlierOrders : undefined;
    const earlier =
      rawEarlier === undefined
        ? undefined
        : Array.isArray(rawEarlier) &&
            latest !== undefined &&
            rawEarlier.length >= 1 &&
            rawEarlier.length <= 4
          ? rawEarlier.map(currentOrder)
          : null;
    if (earlier === null || earlier?.some((entry) => entry === null)) return false;
    const order =
      latest === undefined || earlier === undefined
        ? latest
        : Object.freeze({
            ...latest,
            earlier: Object.freeze(earlier as CustomerCurrentOrder[]),
          });
    const visit = "visit" in value ? restoredVisit(value.visit) : undefined;
    if (visit === null || (visit !== undefined && context?.channel !== "DineIn")) return false;
    const checkout =
      "checkoutSessionReference" in value ? value.checkoutSessionReference : undefined;
    if (
      checkout !== undefined &&
      (typeof checkout !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(checkout))
    )
      return false;
    setCustomerCsrfCredential(value.csrfToken);
    if (typeof checkout === "string") setCheckoutSessionReference(checkout);
    if (context) onMenuContext?.(context);
    if (order) onCurrentOrder?.(order);
    if (visit) onVisit?.(visit);
    return true;
  } catch {
    // No answer in time, or the connection failed: whether the visit goes on is not known.
    settle(true);
    return false;
  }
}

let recovery: Promise<void> | null = null;
/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): a page that has no credential because
 * the Store could not answer its restore asks for the visit again (one request at a time). Does
 * nothing when the page has its credential or the Store already said there is no visit.
 */
export function recoverCustomerSession(fetcher: typeof fetch = fetch): Promise<void> {
  if (getCustomerCsrfCredential() !== null || !isCustomerSessionRestoreUnavailable())
    return Promise.resolve();
  recovery ??= restoreCustomerSession(fetcher, undefined, undefined, undefined, {
    timeoutMs: customerSessionRecoveryTimeoutMs,
  })
    .then(() => undefined)
    .finally(() => {
      recovery = null;
    });
  return recovery;
}

/** How long the page waits before it asks for its visit again, as the Store's Retry-After says. */
export const customerSessionRetryAfterMs = 5000;
/**
 * WP-2423 (rush-reads-and-orders-changes review): every guest page (the entry, the menu, the cart,
 * checkout, the table, an order) starts from what the Store says about this browser's visit. When
 * the Store could not answer (busy, no answer in time, no network), the page does not start as if
 * there were no visit ("Scan the location QR code"): it says the system is busy, asks again by
 * itself every 5 s (or at once on Try again), and starts only with the Store's real answer, so the
 * menu, the current order and the table it restores reach every page.
 */
export async function restoreCustomerSessionUntilAnswered(options: {
  /** One restore, waiting this long for the answer (the restored facts go to its callbacks). */
  readonly restore: (timeoutMs: number) => Promise<unknown>;
  /** The Store has not answered yet: show busy; `retryNow` asks again at once. */
  readonly onBusy: (retryNow: () => void) => void;
  readonly sleep?: (milliseconds: number, wake: Promise<void>) => Promise<void>;
}): Promise<void> {
  const sleep =
    options.sleep ??
    ((milliseconds: number, wake: Promise<void>) =>
      Promise.race([
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }),
        wake,
      ]));
  await options.restore(firstRestoreTimeoutMs).catch(() => undefined);
  while (getCustomerCsrfCredential() === null && isCustomerSessionRestoreUnavailable()) {
    let retryNow: () => void = () => undefined;
    const wake = new Promise<void>((resolve) => {
      retryNow = resolve;
    });
    options.onBusy(() => {
      retryNow();
    });
    await sleep(customerSessionRetryAfterMs, wake);
    await options.restore(customerSessionRecoveryTimeoutMs).catch(() => undefined);
  }
}
