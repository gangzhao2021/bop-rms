import { useEffect, useRef } from "react";
import {
  createHttpDiningSessionClient,
  DiningSessionClientError,
  type DiningSessionClient,
} from "../dining/dining-session-client.js";
import {
  getCustomerCsrfCredential,
  subscribeCustomerCsrfContext,
} from "./customer-transaction-context.js";
import { settleEndedTableVisit } from "./session-bootstrap.js";

/** As often as Your table reads the table (DiningSessionPage's poll). */
export const tableVisitWatchMs = 15_000;
/** A tab opened (a dish, the cart, search) reads at once unless it read this recently. */
export const tableVisitWatchOnOpenMs = 3_000;

/** The table read says this phone is no longer seated there (closed, moved, merged, or never). */
const notAtTable = new Set(["not-joined", "moved", "settled", "ended-empty"]);

/**
 * Batch 47 (v15 b46 live): Menu, search, a dish page and Cart left open while staff close, move or
 * merge the table found out only on a reload, and offered + and Add to cart until then. While this
 * phone has a dine-in visit, these tabs read the table as Your table does (every 15 s while shown,
 * when shown again, and when the guest opens another of them). When it says the phone is no longer
 * at a table, the restore read says how the visit ended and the page shows that card. A phone that
 * never joined a table (it only looks at the menu) is read once per visit, not every 15 s.
 */
export function useTableVisitEndWatch({
  active,
  pathname,
  client: provided,
}: {
  readonly active: boolean;
  readonly pathname: string;
  readonly client?: DiningSessionClient | undefined;
}): void {
  const fallback = useRef<DiningSessionClient | null>(null);
  const check = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) return;
    const reader =
      provided ??
      (fallback.current ??= createHttpDiningSessionClient(globalThis.fetch, {
        learnsTiming: false,
      }));
    let stopped = false;
    let pending: AbortController | null = null;
    let lastAt = Number.NEGATIVE_INFINITY;
    // This visit's credential was read as not seated at a table and its restore went on.
    let neverSeated: string | null = null;
    const read = async () => {
      const credential = getCustomerCsrfCredential();
      if (
        stopped ||
        pending !== null ||
        credential === null ||
        credential === neverSeated ||
        (typeof document !== "undefined" && document.visibilityState === "hidden")
      )
        return;
      const controller = new AbortController();
      pending = controller;
      lastAt = Date.now();
      try {
        await reader.load(controller.signal);
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        if (!(error instanceof DiningSessionClientError) || !notAtTable.has(error.code)) return;
        const ended = await settleEndedTableVisit();
        if (!ended && !stopped && error.code === "not-joined") neverSeated = credential;
      } finally {
        if (pending === controller) pending = null;
      }
    };
    check.current = () => {
      if (Date.now() - lastAt >= tableVisitWatchOnOpenMs) void read();
    };
    const tick = () => void read();
    const timer = window.setInterval(tick, tableVisitWatchMs);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    // A new visit (a join, a round placed) is read again, even after a "never seated" answer.
    const unsubscribe = subscribeCustomerCsrfContext(() => {
      if (getCustomerCsrfCredential() !== neverSeated) neverSeated = null;
    });
    return () => {
      stopped = true;
      check.current = null;
      pending?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      unsubscribe();
    };
  }, [active, provided]);
  useEffect(() => {
    check.current?.();
  }, [active, provided, pathname]);
}
