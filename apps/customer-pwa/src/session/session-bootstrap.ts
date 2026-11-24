import type { MenuJourneyContext } from "../menu/types.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
  setCustomerSessionRestoreUnavailable,
  isCustomerSessionRestoreUnavailable,
  setCheckoutSessionReference,
  setEndedVisitReceiptAccess,
  setEmptyTable,
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
/** Batch 44: the settled table's Store, by its names only (null when malformed). */
function settledStore(
  value: unknown,
): Readonly<{ brandDisplayName: string; storeDisplayName: string }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ["brandDisplayName", "storeDisplayName"];
  if (
    Object.keys(raw).length !== keys.length ||
    keys.some(
      (key) =>
        typeof raw[key] !== "string" ||
        !(raw[key] as string).trim() ||
        (raw[key] as string).length > 200,
    )
  )
    return null;
  return Object.freeze({
    brandDisplayName: raw.brandDisplayName as string,
    storeDisplayName: raw.storeDisplayName as string,
  });
}
/**
 * Batch 56: what this phone paid on a bill staff closed (on this phone, in minor units) and the
 * ended visit's read-only value for that payment's receipt; null when malformed.
 */
function ownPaymentOf(
  value: unknown,
  csrfToken: unknown,
): Readonly<{ amountMinor: string; csrfToken: string }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 2 ||
    raw.method !== "Online" ||
    typeof raw.amountMinor !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.amountMinor) ||
    typeof csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken)
  )
    return null;
  return Object.freeze({ amountMinor: raw.amountMinor, csrfToken });
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
  options: {
    readonly timeoutMs?: number;
    /**
     * Batch 47: asked by a page that still holds a visit (a background read or an action was
     * refused): only a table's ended answer (settled, empty, moved or merged) is taken, and it
     * ends the visit on this page; any other answer changes nothing.
     */
    readonly endedOnly?: boolean;
  } = {},
): Promise<boolean> {
  const endedOnly = options.endedOnly === true;
  if (!endedOnly && getCustomerCsrfCredential() !== null) return true;
  // Batch 47: an ended-table check still counts when another refusal dropped this page's
  // credential meanwhile (the cart read and the table read are refused at the same moment); a
  // new visit's credential (a join, a round placed) makes its answer out of date.
  const asked = getCustomerCsrfCredential();
  const context = captureCustomerCsrfContext();
  const current = endedOnly
    ? () => {
        const now = getCustomerCsrfCredential();
        return now === null || now === asked;
      }
    : context;
  /** The table's visit ended: this page has no visit any more (every listener is told). */
  const tableEnded = () => {
    if (endedOnly) setCustomerCsrfCredential(null);
    return endedOnly;
  };
  // WP-2423 (rush-reads-and-orders-changes): whether the Store answered at all. A restore that
  // got no usable answer leaves the page not knowing whether its visit goes on (see
  // setCustomerSessionRestoreUnavailable); a real answer ("no visit", "this visit") settles it.
  const settle = (unavailable: boolean) => {
    if (!endedOnly && current()) setCustomerSessionRestoreUnavailable(unavailable);
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
      if (ended !== null && !endedOnly) setEndedVisitReceiptAccess(ended);
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
      // Batch 44: a newer server names the Store too (for the header); an older one doesn't.
      const store =
        settled !== null && typeof settled === "object" && "store" in settled
          ? settledStore(settled.store)
          : undefined;
      if (
        settled !== null &&
        typeof settled === "object" &&
        !Array.isArray(settled) &&
        store !== null &&
        Object.keys(settled).length === (store === undefined ? 2 : 3) &&
        "tableLabel" in settled &&
        typeof settled.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(settled.tableLabel) &&
        "csrfToken" in settled &&
        typeof settled.csrfToken === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(settled.csrfToken)
      ) {
        setSettledTable({
          tableLabel: settled.tableLabel,
          csrfToken: settled.csrfToken,
          ...(store === undefined ? {} : { store }),
        });
        return tableEnded();
      }
      return false;
    }
    // Batch 45 (v15 b44 live): the table closed with nothing ordered (nothing was charged, no
    // receipt): which table, and its Store for the header. Nothing to order or pay with.
    if (
      current() &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "emptyTable" in value
    ) {
      const empty = value.emptyTable;
      const store =
        empty !== null && typeof empty === "object" && "store" in empty
          ? settledStore(empty.store)
          : undefined;
      if (
        empty !== null &&
        typeof empty === "object" &&
        !Array.isArray(empty) &&
        store !== null &&
        Object.keys(empty).length === (store === undefined ? 1 : 2) &&
        "tableLabel" in empty &&
        typeof empty.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(empty.tableLabel)
      ) {
        setEmptyTable({ tableLabel: empty.tableLabel, ...(store === undefined ? {} : { store }) });
        return tableEnded();
      }
      return false;
    }
    // Batch 55 review (v15 b54): staff closed the bill when the guests left, then the table.
    // There is no receipt: which table, whether anything was paid first, and its Store.
    if (
      current() &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "closedTable" in value
    ) {
      const closed = value.closedTable;
      const store =
        closed !== null && typeof closed === "object" && "store" in closed
          ? settledStore(closed.store)
          : undefined;
      // Batch 56 (v15 b55 live): the phone that paid part of it is told what it paid, with the
      // ended visit's read-only value for its own payment's receipt (an older server: neither).
      const yours =
        closed !== null && typeof closed === "object" && "yourPayment" in closed
          ? ownPaymentOf(closed.yourPayment, "csrfToken" in closed ? closed.csrfToken : undefined)
          : undefined;
      if (
        closed !== null &&
        typeof closed === "object" &&
        !Array.isArray(closed) &&
        store !== null &&
        yours !== null &&
        Object.keys(closed).length ===
          (store === undefined ? 2 : 3) + (yours === undefined ? 0 : 2) &&
        "tableLabel" in closed &&
        typeof closed.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(closed.tableLabel) &&
        "paid" in closed &&
        (closed.paid === "Some" || (closed.paid === "Nothing" && yours === undefined))
      ) {
        setEmptyTable({
          tableLabel: closed.tableLabel,
          closedByStaff: closed.paid,
          ...(store === undefined ? {} : { store }),
          ...(yours === undefined ? {} : { yourPayment: yours }),
        });
        return tableEnded();
      }
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
      // Batch 45: a newer server names the Store too (for the header).
      const store =
        moved !== null && typeof moved === "object" && "store" in moved
          ? settledStore(moved.store)
          : undefined;
      if (
        moved !== null &&
        typeof moved === "object" &&
        !Array.isArray(moved) &&
        store !== null &&
        Object.keys(moved).length ===
          1 +
            ("merged" in moved ? 1 : 0) +
            ("nothingOrdered" in moved ? 1 : 0) +
            (store === undefined ? 0 : 1) &&
        (!("merged" in moved) || moved.merged === true) &&
        // Batch 46: the party had ordered nothing at its own table (a newer server says so).
        (!("nothingOrdered" in moved) || moved.nothingOrdered === true) &&
        "tableLabel" in moved &&
        typeof moved.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(moved.tableLabel)
      ) {
        setMovedTableLabel(
          moved.tableLabel,
          "merged" in moved,
          store ?? null,
          "nothingOrdered" in moved,
        );
        return tableEnded();
      }
      return false;
    }
    // Batch 47: the visit goes on (or the answer is not one this page knows): nothing changes.
    if (endedOnly) return false;
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

let endedCheck: Promise<boolean> | null = null;
/**
 * Batch 47 (v15 b46 live): a page with a dine-in visit was refused (401, or "your place at the
 * table ended") or its table read said the phone is no longer at a table. The restore read is
 * asked once (one at a time): when it says the table's visit ended (settled, closed empty, moved
 * or merged), this page's visit ends here and every tab shows the same card a reload shows,
 * never "your session expired, scan the QR code again". True when that happened.
 */
export function settleEndedTableVisit(fetcher: typeof fetch = fetch): Promise<boolean> {
  endedCheck ??= restoreCustomerSession(fetcher, undefined, undefined, undefined, {
    endedOnly: true,
  })
    .catch(() => false)
    .finally(() => {
      endedCheck = null;
    });
  return endedCheck;
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
