import { useSyncExternalStore } from "react";
import { getCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import type { DiningSessionView } from "./dining-session-client.js";

/**
 * Batch 48 (v15 b47 live, guest-open-page-after-close leftOpen (d)): once staff start a table's
 * checkout, Dining admits no new round and the Store refuses every cart change and the cart read
 * itself (409 cart_table_checking_out: checkout started, partly paid, or paid in full and not
 * closed yet; only staff's Cancel checkout, while nothing is paid, reopens it). A joined guest's
 * Menu and dish pages still offered + and Add to cart, and each tap ended in a refusal. This is
 * what the Store last said for this visit: any cart answer says whether the table is checking out,
 * and the table read says whether its bill is paid. Memory only, for this visit's credential.
 */
export interface TableCheckout {
  /** The table owes nothing more (its bill is paid); null until the table has been read. */
  readonly paid: boolean | null;
  /** The table pays at the end, so Your table holds its receipt once paid. */
  readonly payLater: boolean | null;
}

let state: { readonly credential: string; readonly checkout: TableCheckout } | null = null;
/**
 * The table read last made for this visit. Cart's own cart answer, which says the table is checking
 * out, often lands after it (it reads participation, selection and catalog), and a paid table must
 * say so at once, not one table read (15 s) later.
 */
let lastView: { readonly credential: string; readonly checkout: TableCheckout } | null = null;
const listeners = new Set<() => void>();

function publish(next: typeof state) {
  if (
    next?.credential === state?.credential &&
    next?.checkout.paid === state?.checkout.paid &&
    next?.checkout.payLater === state?.checkout.payLater
  )
    return;
  state = next;
  for (const listener of listeners) listener();
}

/** A cart answer for this visit: refused because the table is checking out, or answered. */
export function noteTableCheckingOut(checkingOut: boolean): void {
  const credential = getCustomerCsrfCredential();
  if (credential === null || !checkingOut) {
    if (state !== null && (credential === null || state.credential === credential)) publish(null);
    return;
  }
  if (state?.credential === credential) return;
  publish({
    credential,
    checkout:
      lastView?.credential === credential
        ? lastView.checkout
        : Object.freeze({ paid: null, payLater: null }),
  });
}

/** A table read for this visit: whether anything is still owed, shown while checking out. */
export function noteTableView(view: DiningSessionView): void {
  const credential = getCustomerCsrfCredential();
  if (credential === null) return;
  const paid =
    view.rounds.length > 0 && view.summary !== null && /^0+$/u.test(view.summary.due.amountMinor);
  const checkout = Object.freeze({ paid, payLater: view.paymentTiming === "PayLater" });
  lastView = { credential, checkout };
  if (state !== null && state.credential === credential) publish({ credential, checkout });
}

export function getTableCheckout(): TableCheckout | null {
  const credential = getCustomerCsrfCredential();
  return state !== null && state.credential === credential ? state.checkout : null;
}

export function subscribeTableCheckout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests start each case with no table checking out. */
export function resetTableCheckout(): void {
  lastView = null;
  publish(null);
}

export function useTableCheckout(enabled: boolean): TableCheckout | null {
  const checkout = useSyncExternalStore(subscribeTableCheckout, getTableCheckout, getTableCheckout);
  return enabled ? checkout : null;
}
