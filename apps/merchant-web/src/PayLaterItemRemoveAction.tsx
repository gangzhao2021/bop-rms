import { useEffect, useRef, useState } from "react";
import { focusOpenerSelector, useSettledFocus } from "./settled-focus.js";
import { KitchenMayHaveStartedNote } from "./kitchen-cancel-warning.js";
import { Link } from "react-router";
import { t } from "./i18n/i18n.js";
import {
  type CurrentOrderLine,
  type CurrentOrderQueue,
  type StaffCancellationReason,
} from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, isFullSignInRequired } from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  staffCancellationReasonLabel,
  staffCancellationReasonsFor,
} from "./StaffOrderCancelAction.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];
type Failure =
  | "FullSignInRequired"
  | "Denied"
  | "AlreadyPaid"
  | "Started"
  | "Changed"
  | "NotRemovable"
  | "Comped"
  | "Unknown";

export function payLaterRemoveFailureText(failure: Failure) {
  switch (failure) {
    case "FullSignInRequired":
      return FULL_SIGN_IN_REQUIRED_TEXT;
    case "Denied":
      return t("Taking dishes off the bill was refused. Ask a manager to do it.");
    case "AlreadyPaid":
      return t(
        "This table has paid, so dishes can't come off its bill. A manager gives the guest money back from the table's payment instead; it is recorded.",
      );
    case "Started":
      return t(
        "The kitchen has marked one of these dishes started, so it stays on the bill. To not charge the table for it, comp it with a reason instead; the comp is recorded.",
      );
    case "Changed":
      return t("This order changed since it was shown. Refresh it, then try again.");
    case "NotRemovable":
      return t(
        "These dishes were already made or served, so they stay on the bill. To not charge the table for them, comp them with a reason instead; the comp is recorded.",
      );
    case "Comped":
      return t(
        "A manager comped or discounted this dish, so it stays on the bill at that price and on the kitchen's board. If the guests don't want it, tell the kitchen. Once the table pays, a manager can give the money back from the payment; it is recorded.",
      );
    case "Unknown":
      return t(
        "We couldn't confirm the result. Press the button again: it is never recorded twice.",
      );
  }
}

const failureOf = (status: number, payload: unknown): Failure => {
  if (isFullSignInRequired(status, payload)) return "FullSignInRequired";
  if (status === 401 || status === 403) return "Denied";
  const error = (payload as { error?: unknown } | null)?.error;
  if (status === 409)
    return error === "already_paid"
      ? "AlreadyPaid"
      : error === "preparation_started"
        ? "Started"
        : error === "version_conflict"
          ? "Changed"
          : error === "comped"
            ? "Comped"
            : "NotRemovable";
  if (status === 400) return "NotRemovable";
  return "Unknown";
};

export interface PayLaterRemoveRefusal {
  readonly failure: "NotRemovable" | "Started" | "AlreadyPaid" | "Comped";
  readonly orderItemReferences: readonly string[];
}

/**
 * Coordinator 2026-10-30: why dishes couldn't come off the bill and what to do instead — comp them
 * with a reason (offered only for dishes the order lists as compable, which the server lists only to
 * people allowed to comp), or, on a paid table, a manager gives money back from its payment. Both
 * are recorded and attributed; nothing is deleted.
 */
export function PayLaterRemoveRefusalNotice({
  refusal,
  order,
  compInstead,
  compHref,
  refundHref,
  onDone,
}: {
  readonly refusal: PayLaterRemoveRefusal;
  readonly order: Order;
  /** Opens the recorded comp for these dishes on this page. */
  readonly compInstead?: ((orderItemReferences: readonly string[]) => void) | undefined;
  /** Where the comp is done when it isn't on this page (the table's page). */
  readonly compHref?: string | undefined;
  /** Where a manager gives money back from a paid table's payment (the order's page). */
  readonly refundHref?: string | undefined;
  readonly onDone: () => void;
}) {
  const compableNow = order.batches
    .flatMap((entry) => entry.compableItems)
    .filter((item) => refusal.orderItemReferences.includes(item));
  return (
    <div role="alert" className="pay-later-remove__instead">
      <p>{payLaterRemoveFailureText(refusal.failure)}</p>
      {refusal.failure === "Comped" ? null : refusal.failure === "AlreadyPaid" ? (
        refundHref !== undefined ? (
          <Link className="table-checkout__primary" to={refundHref}>
            {t("Give money back from the payment")}
          </Link>
        ) : null
      ) : compableNow.length > 0 && compInstead !== undefined ? (
        <button
          type="button"
          className="table-checkout__primary"
          onClick={() => {
            compInstead(compableNow);
            onDone();
          }}
        >
          {t("Comp these dishes")}
        </button>
      ) : compableNow.length > 0 && compHref !== undefined ? (
        <Link className="table-checkout__primary" to={compHref}>
          {t("Comp them on the table's page")}
        </Link>
      ) : (
        <p>{t("Ask a manager to comp them.")}</p>
      )}{" "}
      <button type="button" onClick={onDone}>
        {t("Close")}
      </button>
    </div>
  );
}

/**
 * v15 b20 (DEC-TAX-WHOLE-RECEIPT): what the take-off button says. The amount is what the bill goes
 * down by, from the server's preview (tax is worked out once over the whole bill, so it can be a
 * cent less than the dishes' own prices); while that is not known the button names no amount, and
 * taking the dishes off still works (it records no amount). b22: with nothing ticked it asks for
 * dishes of its round (it can't be pressed), never the older unnumbered name.
 */
export function payLaterRemoveButtonText(input: {
  readonly busy: boolean;
  readonly chosen: number;
  /**
   * b22: the ticked dishes are every dish of the round still on the bill. Not when a dish of it
   * stays (the kitchen started it, it was comped): ticking all that can come off is then not the
   * whole round, and the button never says so.
   */
  readonly wholeRound: boolean;
  readonly previewMinor: string | null;
  readonly currencyCode: string;
  readonly sequence: number;
}): string {
  if (input.busy) return t("Recording…");
  if (input.chosen === 0)
    return t("Choose dishes to take off round {sequence}", { sequence: input.sequence });
  const whole = input.wholeRound;
  if (input.previewMinor === null)
    return whole ? t("Take the whole round off") : t("Take these dishes off");
  const amount = orderMoney({ amountMinor: input.previewMinor, currencyCode: input.currencyCode });
  return whole
    ? t("Take the whole round off · {amount}", { amount })
    : t("Take off {amount}", { amount });
}

/**
 * b22 (DEC-TAX-WHOLE-RECEIPT): what a dish in the panel says — what the bill goes down by when it
 * alone comes off (the server's preview), so the dish and the button agree to the cent ($7.06,
 * never its own price $7.07 beside "Take off $7.06"). While that is being worked out the dish names
 * no amount; when it can't be (an older server, a refusal) the dish says its own price, as that.
 * It says "with tax", as the round above lists its dishes before tax.
 */
export function payLaterRemoveDishText(input: {
  readonly quantity: number;
  readonly name: string;
  /** The preview for this dish alone: a string, null when it couldn't be worked out, or absent. */
  readonly billDownMinor: string | null | undefined;
  readonly total: { readonly amountMinor: string; readonly currencyCode: string };
}): string {
  const dish = input.quantity + " × " + input.name;
  if (input.billDownMinor === undefined) return dish;
  return (
    dish +
    " · " +
    (input.billDownMinor === null
      ? t("price {amount}", { amount: orderMoney(input.total) })
      : t("bill goes down {amount} with tax", {
          amount: orderMoney({
            amountMinor: input.billDownMinor,
            currencyCode: input.total.currencyCode,
          }),
        }))
  );
}

/**
 * b22 (DEC-TAX-WHOLE-RECEIPT): taken off together, dishes can take a cent more or less off the bill
 * than their figures added up (or than the round's own figure when it all comes off), because the
 * bill's tax is worked out once. Then the panel says why the button's amount is what it is; null
 * when the figures agree, or when they are not all known.
 */
export function payLaterRemoveTogetherNote(input: {
  readonly previewMinor: string | null;
  readonly dishMinors: readonly (string | null | undefined)[];
  /** What the round reads on the bill, when the whole round is ticked. */
  readonly roundMinor?: string | undefined;
  readonly currencyCode: string;
}): string | null {
  if (input.previewMinor === null || input.dishMinors.length === 0) return null;
  const preview = BigInt(input.previewMinor);
  const known = input.dishMinors.every((minor) => typeof minor === "string");
  const dishes = known
    ? input.dishMinors.reduce((sum, minor) => sum + BigInt(minor as string), 0n)
    : null;
  const differs =
    (dishes !== null && dishes !== preview) ||
    (input.roundMinor !== undefined && BigInt(input.roundMinor) !== preview);
  if (!differs) return null;
  return t("Tax is worked out once on the whole bill, so the bill goes down {amount}.", {
    amount: orderMoney({ amountMinor: input.previewMinor, currencyCode: input.currencyCode }),
  });
}

/**
 * b22 (DEC-TAX-WHOLE-RECEIPT): whether the ticked dishes are the whole round as the bill reads it —
 * every dish of the round still on the bill (not taken off before, not cancelled), comped dishes and
 * dishes the kitchen started included. Only then do the button and the note speak of the round.
 */
export function payLaterChosenWholeRound(input: {
  readonly batch: Pick<Batch, "orderBatchReference" | "unpaidRemovedItems">;
  readonly lines: readonly Pick<
    CurrentOrderLine,
    "orderItemReference" | "orderBatchReference" | "cancellation"
  >[];
  readonly chosen: readonly string[];
}): boolean {
  const onBill = input.lines.filter(
    (line) =>
      line.orderBatchReference === input.batch.orderBatchReference &&
      line.cancellation === null &&
      !input.batch.unpaidRemovedItems.includes(line.orderItemReference),
  );
  return (
    input.chosen.length > 0 &&
    onBill.length === input.chosen.length &&
    onBill.every((line) => input.chosen.includes(line.orderItemReference))
  );
}

/** The preview's amount, or null when the answer is not one (an older server, a refusal). */
export function payLaterRemovePreviewMinor(payload: unknown): string | null {
  const total = (payload as { totalMinor?: unknown } | null)?.totalMinor;
  return typeof total === "string" && /^(0|[1-9][0-9]{0,17})$/u.test(total) ? total : null;
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (rule 2): take dishes — or the whole round — off the bill of a table
 * that pays at the end, before it pays and before the kitchen starts them. Staff tick the dishes
 * and give a reason; the server records who and why (PIN-confirmed) and the dishes are never
 * charged. One attempt keeps its operation reference, so a lost answer is retried safely.
 */
export function PayLaterItemRemoveAction({
  order,
  batch,
  lines,
  csrf,
  onSettled,
  onRefused,
  roundMinor,
  openOnArrival = false,
  onArrived,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  /** The order's item lines (from its detail); only this round's removable dishes are offered. */
  readonly lines: readonly CurrentOrderLine[];
  readonly csrf: string;
  readonly onSettled: () => void;
  /** The dishes couldn't come off the bill (made, served or paid): the page shows what to do. */
  readonly onRefused: (refusal: PayLaterRemoveRefusal) => void;
  /** b22: what the round reads on the bill (its heading), to say why the whole round differs. */
  readonly roundMinor?: string | undefined;
  /**
   * b22: staff came here from this round's "Take dishes off round N" on the Orders workbench: the
   * panel is open on arrival and has the focus, never a second button of the same name to press.
   */
  readonly openOnArrival?: boolean | undefined;
  readonly onArrived?: (() => void) | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [open, setOpen] = useState(openOnArrival);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState<StaffCancellationReason | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<{ key: string; reference: string } | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const arrived = useRef(openOnArrival);
  const opener = useRef<HTMLButtonElement | null>(null);
  // b23: opening in place moves the focus into the panel (the opener is replaced by it), as
  // arriving does; Cancel gives it back to the opener, so focus never drops to the page itself.
  const focusTo = useRef<"panel" | "opener" | null>(null);
  const openerKey = "take-off:" + batch.orderBatchReference;
  // v15 b20 / b22 (DEC-TAX-WHOLE-RECEIPT): what the bill goes down by, from the server, by the
  // dishes asked about (null: it couldn't be worked out).
  const [previews, setPreviews] = useState<ReadonlyMap<string, string | null>>(new Map());
  const offered = lines.filter(
    (line) =>
      line.orderBatchReference === batch.orderBatchReference &&
      batch.unpaidRemovableItems.includes(line.orderItemReference),
  );
  const chosen = offered.filter((line) => selected.has(line.orderItemReference));
  // b23 review: the whole round taken off leaves no button to give the focus back to: it goes to
  // the button again when the round still offers it, else to the round's heading.
  const settledFocus = useSettledFocus(
    [focusOpenerSelector(openerKey), ".order-round__head h3"],
    offered.length === 0 || order.currentVersion === null,
  );
  const currencyCode = offered[0]?.total.currencyCode ?? "CAD";
  const keyFor = (items: readonly string[]) =>
    order.currentVersion === null
      ? null
      : JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          orderItemReferences: [...items].sort(),
          expectedOrderVersion: order.currentVersion,
        });
  const previewKey =
    open && chosen.length > 0 ? keyFor(chosen.map((line) => line.orderItemReference)) : null;
  const previewMinor = previewKey === null ? null : (previews.get(previewKey) ?? null);
  const dishKeys =
    open && order.currentVersion !== null
      ? offered.map((line) => keyFor([line.orderItemReference]) as string)
      : [];
  const dishKeysText = JSON.stringify(dishKeys);
  const ask = async (key: string, signal: AbortSignal): Promise<string | null> => {
    try {
      const response = await fetcher("/merchant/orders/remove-unpaid-items/preview", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: key,
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      return response.ok ? payLaterRemovePreviewMinor(payload) : null;
    } catch {
      // No amount; taking the dishes off still works and says its own result.
      return null;
    }
  };
  const askRef = useRef(ask);
  askRef.current = ask;
  // b22: each dish says what the bill goes down by when it alone comes off, asked one at a time
  // when the panel opens (a round has a few dishes; nothing is recorded).
  useEffect(() => {
    const keys = JSON.parse(dishKeysText) as string[];
    if (keys.length === 0) return;
    const abort = new AbortController();
    void (async () => {
      for (const key of keys) {
        if (abort.signal.aborted) return;
        const minor = await askRef.current(key, abort.signal);
        if (abort.signal.aborted) return;
        setPreviews((current) => (current.has(key) ? current : new Map(current).set(key, minor)));
      }
    })();
    return () => abort.abort();
  }, [dishKeysText]);
  // v15 b20: the ticked dishes together, for the button (one dish: its own answer above).
  const known = previewKey !== null && previews.has(previewKey);
  useEffect(() => {
    if (previewKey === null || known) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void askRef.current(previewKey, abort.signal).then((minor) => {
        if (!abort.signal.aborted)
          setPreviews((current) => new Map(current).set(previewKey, minor));
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [previewKey, known]);
  // b22: arriving for this round, the open panel takes the focus (once).
  useEffect(() => {
    if (!open || !arrived.current) return;
    arrived.current = false;
    panel.current?.focus();
    panel.current?.scrollIntoView?.({ block: "nearest" });
    onArrived?.();
  }, [open, onArrived]);
  useEffect(() => {
    if (open && focusTo.current === "panel") panel.current?.focus();
    else if (!open && focusTo.current === "opener")
      // b24: on Tables the panel is locked (and may be drawn again) while the floor is reread.
      settledFocus.toOpener(openerKey, opener.current);
    else return;
    focusTo.current = null;
  }, [open]);
  if (offered.length === 0 || order.currentVersion === null) return null;
  const send = async () => {
    if (busy || chosen.length === 0 || reason === "") return;
    const items = chosen.map((line) => line.orderItemReference).sort();
    const key = [items.join(","), reason, order.currentVersion].join(":");
    if (attempt.current?.key !== key)
      attempt.current = { key, reference: serviceOperationReference() };
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetcher("/merchant/orders/remove-unpaid-items", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          orderItemReferences: items,
          expectedOrderVersion: order.currentVersion,
          operationReference: attempt.current.reference,
          reasonCode: reason,
        }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        attempt.current = null;
        settledFocus.settled(panel.current);
        focusTo.current = "opener";
        setOpen(false);
        setSelected(new Set());
        setReason("");
        onSettled();
        return;
      }
      const next = failureOf(response.status, payload);
      // A refusal that changed nothing keeps the attempt for the retry after signing in.
      if (next !== "FullSignInRequired" && next !== "Unknown") attempt.current = null;
      setFailure(next);
      // Made, served or paid: the page keeps the answer with what to do instead, even after the
      // refreshed order no longer offers these dishes here (never a silent failure).
      if (
        next === "NotRemovable" ||
        next === "Started" ||
        next === "AlreadyPaid" ||
        next === "Comped"
      )
        onRefused({ failure: next, orderItemReferences: items });
      // Read the order again: what changed (made, served, paid) decides what to offer instead.
      if (
        next === "AlreadyPaid" ||
        next === "Started" ||
        next === "Changed" ||
        next === "NotRemovable" ||
        next === "Comped"
      )
        onSettled();
    } catch {
      setFailure("Unknown");
    } finally {
      setBusy(false);
    }
  };
  // v15 b21: a table's rounds each have this action, so it names its round (as the round's own
  // heading does) and no two read the same.
  const title = t("Take dishes off round {sequence}", { sequence: batch.sequence });
  // b22: the round's own figure is compared only when every dish of it on the bill is ticked; a
  // round with a dish that stays reads more than what can come off, and that is not tax.
  const wholeRound = payLaterChosenWholeRound({
    batch,
    lines,
    chosen: chosen.map((line) => line.orderItemReference),
  });
  const together = payLaterRemoveTogetherNote({
    previewMinor,
    dishMinors: chosen.map((line) => previews.get(keyFor([line.orderItemReference]) as string)),
    roundMinor: wholeRound ? roundMinor : undefined,
    currencyCode,
  });
  if (!open)
    return (
      <button
        ref={opener}
        type="button"
        data-focus-opener={openerKey}
        onClick={() => {
          settledFocus.reset();
          focusTo.current = "panel";
          setOpen(true);
        }}
      >
        {title}
      </button>
    );
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={title}
      className="pay-later-remove order-cancel-actions"
    >
      <p>{t("Tick the dishes the table won't be charged for. The kitchen stops them.")}</p>
      <KitchenMayHaveStartedNote receivedAt={batch.kitchenReceivedAt} />
      <ul className="pay-later-remove__lines">
        {offered.map((line) => (
          <li key={line.orderItemReference}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(line.orderItemReference)}
                disabled={busy}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.currentTarget.checked) next.add(line.orderItemReference);
                  else next.delete(line.orderItemReference);
                  setSelected(next);
                }}
              />{" "}
              {/* b22: what the bill goes down by for this dish alone (the button's figure). */}
              {payLaterRemoveDishText({
                quantity: line.quantity,
                name: line.name,
                billDownMinor: previews.get(keyFor([line.orderItemReference]) as string),
                total: line.total,
              })}
            </label>
          </li>
        ))}
      </ul>
      <label className="table-checkout__field">
        {t("Reason")}
        <select
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.currentTarget.value as StaffCancellationReason | "")}
        >
          <option value="">{t("Choose a reason")}</option>
          {staffCancellationReasonsFor("DineIn").map((code) => (
            <option key={code} value={code}>
              {staffCancellationReasonLabel[code]}
            </option>
          ))}
        </select>
      </label>
      {together === null ? null : <p className="pay-later-remove__note">{together}</p>}
      <div className="pay-later-remove__actions">
        <button
          type="button"
          className="table-checkout__primary"
          disabled={busy || chosen.length === 0 || reason === ""}
          onClick={() => void send()}
        >
          {payLaterRemoveButtonText({
            busy,
            chosen: chosen.length,
            wholeRound,
            previewMinor,
            currencyCode,
            sequence: batch.sequence,
          })}
        </button>{" "}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            focusTo.current = "opener";
            setOpen(false);
          }}
        >
          {t("Cancel")}
        </button>
      </div>
      {failure === "FullSignInRequired" ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : failure !== null &&
        failure !== "NotRemovable" &&
        failure !== "Started" &&
        failure !== "AlreadyPaid" &&
        failure !== "Comped" ? (
        <p role="alert">{payLaterRemoveFailureText(failure)}</p>
      ) : null}
    </div>
  );
}
