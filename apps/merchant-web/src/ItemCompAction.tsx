import { useEffect, useRef, useState } from "react";
import { focusOpenerSelector, useSettledFocus } from "./settled-focus.js";
import { listSeparator, t } from "./i18n/i18n.js";
import type { CurrentOrderLine, CurrentOrderQueue } from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, isFullSignInRequired } from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { payLaterRemoveDishText } from "./PayLaterItemRemoveAction.js";
import { dollarsToMinor } from "./TableCheckout.js";
import { storeTime } from "./StoreTime.js";

type Order = CurrentOrderQueue["items"][number];
export type CompReason = "QUALITY" | "WRONG_DISH" | "LONG_WAIT" | "GOODWILL";
export const compReasons: readonly CompReason[] = [
  "QUALITY",
  "WRONG_DISH",
  "LONG_WAIT",
  "GOODWILL",
];
export const compReasonLabel: Readonly<Record<CompReason, string>> = {
  QUALITY: t("Food quality"),
  WRONG_DISH: t("Wrong dish served"),
  LONG_WAIT: t("Waited too long"),
  GOODWILL: t("Goodwill"),
};
type Choice = "Comp" | "Percent" | "Amount";
/** How long the comp panel waits after a change before asking what it takes off (ms). */
export const COMP_PREVIEW_WAIT_MS = 200;
type Failure =
  | "FullSignInRequired"
  | "Denied"
  | "AlreadyPaid"
  | "GuestPaying"
  | "NotStarted"
  | "AlreadyComped"
  | "NotThatMany"
  | "Changed"
  | "Unknown";

export function itemCompFailureText(failure: Failure) {
  switch (failure) {
    case "FullSignInRequired":
      return FULL_SIGN_IN_REQUIRED_TEXT;
    case "Denied":
      return t("Only a manager can comp or discount dishes.");
    case "AlreadyPaid":
      return t("This table has paid. Give the guest money back from its payment instead.");
    case "GuestPaying":
      return t("A guest is paying the table on their phone. Wait for it, or stop it first.");
    case "NotStarted":
      return t(
        "One of these dishes hasn't reached the kitchen yet. Take it off the bill instead, so it isn't made.",
      );
    case "AlreadyComped":
      return t("One of these dishes already has a comp or discount. Refresh the table.");
    case "NotThatMany":
      return t(
        "Fewer of these dishes are left to comp than you chose. Refresh the table, then choose again.",
      );
    case "Changed":
      return t("This table changed since it was shown. Refresh it, then try again.");
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
      : error === "guest_paying"
        ? "GuestPaying"
        : error === "not_started"
          ? "NotStarted"
          : error === "already_comped"
            ? "AlreadyComped"
            : error === "not_that_many"
              ? "NotThatMany"
              : "Changed";
  return "Unknown";
};

/**
 * The money a choice takes off one dish — net off its price, tax and fee in proportion, half up to
 * the cent — the rule the server and the database apply to the dish's own share. v15 b16: the
 * button names the server's preview instead (the whole bill's tax cent included); this says only
 * whether the choice is one the server takes.
 */
export function compAmountMinor(
  line: Pick<CurrentOrderLine, "subtotal" | "discount" | "tax" | "fee">,
  choice: Choice,
  percent: number | null,
  amountOffMinor: bigint | null,
): bigint | null {
  const whole = BigInt(line.subtotal.amountMinor) - BigInt(line.discount.amountMinor);
  if (whole <= 0n) return null;
  const net =
    choice === "Comp"
      ? whole
      : choice === "Percent"
        ? percent !== null && percent >= 1 && percent <= 99
          ? (whole * BigInt(percent) + 50n) / 100n
          : null
        : amountOffMinor;
  if (net === null || net < 1n || net > whole || (choice === "Amount" && net >= whole)) return null;
  const share = (value: string) =>
    net === whole ? BigInt(value) : (BigInt(value) * net * 2n + whole) / (2n * whole);
  return net + share(line.tax.amountMinor) + share(line.fee.amountMinor);
}

/**
 * b23 (DEC-TAX-WHOLE-RECEIPT, DEC-COMP-BILL-CENT): what the bill goes down by for a dish in the
 * comp panel, the take-off panel's way. A ticked dish says its part of the ticked dishes' preview
 * (the whole bill's tax cent included), so the ticked dishes add up to the button; any other dish
 * says what the bill goes down by when it alone gets this choice (the server's preview for it).
 * Absent (undefined) while that is being worked out; null when it can't be (an older server, a
 * refusal, or no amount or percent chosen yet): the dish then says its own price, as its price —
 * never "price $7.07" beside "Comp $7.06".
 */
export function compDishBillDownMinor(
  line: Pick<CurrentOrderLine, "orderItemReference">,
  ticked: boolean,
  previewLines: ReadonlyMap<string, string> | null,
  alone: string | null | undefined,
): string | null | undefined {
  const together = ticked ? previewLines?.get(line.orderItemReference) : undefined;
  return together ?? alone;
}

/**
 * Batch 60 (v15 b59 live): how many of a line's dishes are still left to comp, from the comps the
 * round has (each says how many dishes of how many it covers; an older server: the whole line).
 */
export function compDishesLeft(
  line: Pick<CurrentOrderLine, "orderItemReference" | "quantity">,
  comps: readonly {
    readonly orderItemReference: string;
    readonly compedQuantity?: number | null;
  }[],
): number {
  const own = comps.filter((comp) => comp.orderItemReference === line.orderItemReference);
  if (own.some((comp) => comp.compedQuantity === null || comp.compedQuantity === undefined))
    return 0;
  return Math.max(
    0,
    line.quantity - own.reduce((sum, comp) => sum + (comp.compedQuantity ?? 0), 0),
  );
}

/**
 * WP-2423 item 8 ① segment 2 (Owner decision 2, Figma 45:315; DEC-KITCHEN-ONE-TAP): a manager comps
 * or discounts any dish that reached the kitchen, before the table pays; the kitchen still makes it. Money, so it is confirmed:
 * the dishes, how much (shown exactly), and a reason; recorded as a compensating record that stays
 * in the reports. On a shared tablet the manager confirms with a full sign-in.
 */
export function ItemCompAction({
  order,
  lines,
  csrf,
  onSettled,
  preselect,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly lines: readonly CurrentOrderLine[];
  readonly csrf: string;
  readonly onSettled: () => void;
  /**
   * Coordinator 2026-10-30: dishes that couldn't be taken off the bill (already made or served):
   * the comp opens with them ticked. A new request (`nonce`) opens it again.
   */
  readonly preselect?: { readonly items: readonly string[]; readonly nonce: number } | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  // b23: opening moves the focus into the panel (the opener is replaced by it); Cancel gives it
  // back to the opener, so a keyboard or screen-reader user never lands on the page itself.
  const focusTo = useRef<"panel" | "opener" | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Batch 60: how many of a line's dishes to comp (absent: every dish left on it).
  const [quantities, setQuantities] = useState<ReadonlyMap<string, number>>(new Map());
  const [opened, setOpened] = useState<number | null>(null);
  if (preselect !== undefined && preselect.nonce !== opened) {
    setOpened(preselect.nonce);
    setOpen(true);
    focusTo.current = "panel";
    setSelected(new Set(preselect.items));
  }
  const [choice, setChoice] = useState<Choice>("Comp");
  const [percent, setPercent] = useState("");
  const [amountOff, setAmountOff] = useState("");
  const [reason, setReason] = useState<CompReason | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // b63 (F36): what the confirm step shows, by what would be recorded (null: not confirming).
  const [reviewing, setReviewing] = useState<string | null>(null);
  const attempt = useRef<{ key: string; reference: string } | null>(null);
  const [preview, setPreview] = useState<{
    readonly key: string;
    readonly totalMinor: string | null;
    readonly lines: ReadonlyMap<string, string> | null;
    readonly failure: Failure | null;
  } | null>(null);
  const [previewRun, setPreviewRun] = useState(0);
  // b23: what the bill goes down by for each dish alone with this choice (null: couldn't say), by
  // the Order's version and what was asked (nothing is recorded by asking).
  const [dishPreviews, setDishPreviews] = useState<ReadonlyMap<string, string | null>>(new Map());
  const compable = new Set(order.batches.flatMap((batch) => batch.compableItems));
  const comps = order.batches.flatMap((batch) => batch.compedItems);
  const offered = lines.filter(
    (line) => compable.has(line.orderItemReference) && compDishesLeft(line, comps) > 0,
  );
  const leftOf = (line: CurrentOrderLine) => compDishesLeft(line, comps);
  // Batch 60 review: the rest of a line comped in part can only be comped too (a percentage or an
  // amount off is for a whole line), so under those choices it isn't offered and a note says why.
  const partlyComped = (line: CurrentOrderLine) => leftOf(line) < line.quantity;
  const listed = choice === "Comp" ? offered : offered.filter((line) => !partlyComped(line));
  const compOnly = choice === "Comp" ? [] : offered.filter(partlyComped);
  const chosen = listed.filter((line) => selected.has(line.orderItemReference));
  // Batch 60: a comp of fewer dishes than are left on a line names them; the rest goes as before.
  const compQuantitiesFor = (items: readonly CurrentOrderLine[]) =>
    choice !== "Comp"
      ? []
      : items
          .flatMap((line) => {
            const quantity = quantities.get(line.orderItemReference);
            return quantity !== undefined && quantity < leftOf(line)
              ? [{ orderItemReference: line.orderItemReference, quantity }]
              : [];
          })
          .sort((a, b) => (a.orderItemReference < b.orderItemReference ? -1 : 1));
  const openerKey = "comp:" + order.orderReference;
  // b23 review: the last dish comped leaves no button to give the focus back to: it goes to the
  // button again when the table still offers it, else to the comps the table now has.
  const settledFocus = useSettledFocus(
    [focusOpenerSelector(openerKey), ".table-order-rounds__comps"],
    offered.length === 0,
  );
  // A dish that can still come off the bill (the kitchen has not marked it started) can't once it
  // is comped or discounted: say so before, while taking it off is still the better choice.
  const removable = new Set(order.batches.flatMap((batch) => batch.unpaidRemovableItems));
  const stillRemovable = chosen.filter((line) => removable.has(line.orderItemReference));
  const percentValue = /^[1-9][0-9]?$/u.test(percent.trim()) ? Number(percent.trim()) : null;
  const amountOffMinor = dollarsToMinor(amountOff);
  const amounts = chosen.map((line) =>
    compAmountMinor(line, choice, percentValue, choice === "Amount" ? amountOffMinor : null),
  );
  const valid =
    chosen.length > 0 &&
    amounts.every((value) => value !== null) &&
    (choice !== "Amount" || chosen.length === 1);
  const currencyCode = offered[0]?.total.currencyCode ?? "CAD";
  const askedFor = (items: readonly CurrentOrderLine[]) => {
    const compQuantities = compQuantitiesFor(items);
    return {
      orderReference: order.orderReference,
      orderItemReferences: items.map((line) => line.orderItemReference).sort(),
      kind: choice,
      percent: choice === "Percent" ? percentValue : null,
      amountOffMinor: choice === "Amount" ? String(amountOffMinor) : null,
      ...(compQuantities.length > 0 ? { compQuantities } : {}),
    };
  };
  const asked = askedFor(chosen);
  const previewKey = valid ? JSON.stringify(asked) : null;
  // b23: the same choice for one dish alone (an amount off is per dish, so any one dish can ask).
  const choiceKnown =
    choice === "Comp" ||
    (choice === "Percent" && percentValue !== null) ||
    (choice === "Amount" && amountOffMinor !== null);
  const dishKeyFor = (line: CurrentOrderLine) =>
    (order.currentVersion ?? "") + "|" + JSON.stringify(askedFor([line]));
  const dishKeys = open && choiceKnown ? listed.map((line) => dishKeyFor(line)) : [];
  const dishKeysText = JSON.stringify(dishKeys);
  // v15 b16 (DEC-COMP-BILL-CENT): the server works out what really comes off the bill (the bill's
  // tax is worked out once over the whole bill, so it can differ by a cent from the dishes' own).
  const total =
    preview !== null && preview.key === previewKey && preview.totalMinor !== null
      ? BigInt(preview.totalMinor)
      : null;
  const previewFailure = preview !== null && preview.key === previewKey ? preview.failure : null;
  const previewLines =
    preview !== null && preview.key === previewKey && preview.totalMinor !== null
      ? preview.lines
      : null;
  useEffect(() => {
    if (!open || previewKey === null) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetcher("/merchant/orders/comp-items/preview", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: abort.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-BOP-CSRF": csrf,
            },
            body: previewKey,
          });
          const payload = (await response.json().catch(() => null)) as {
            totalMinor?: unknown;
            lines?: unknown;
          } | null;
          if (abort.signal.aborted) return;
          if (response.ok && typeof payload?.totalMinor === "string")
            setPreview({
              key: previewKey,
              totalMinor: payload.totalMinor,
              lines: previewLineAmounts(payload.lines),
              failure: null,
            });
          else
            setPreview({
              key: previewKey,
              totalMinor: null,
              lines: null,
              failure: response.ok ? "Unknown" : failureOf(response.status, payload),
            });
        } catch {
          if (!abort.signal.aborted)
            setPreview({ key: previewKey, totalMinor: null, lines: null, failure: "Unknown" });
        }
      })();
    }, COMP_PREVIEW_WAIT_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [open, previewKey, csrf, fetcher, previewRun]);
  // b23: each dish's own figure, asked one at a time while the panel is open (a table has a few
  // dishes; an answer already known is not asked again).
  const known = useRef(dishPreviews);
  known.current = dishPreviews;
  useEffect(() => {
    const keys = (JSON.parse(dishKeysText) as string[]).filter((key) => !known.current.has(key));
    if (keys.length === 0) return;
    const abort = new AbortController();
    // b23 review: typed Percent or Amount waits as the button's preview does, so a keystroke asks
    // nothing; a newer run cancels this one (its wait, or the dish it is asking about).
    const ask = async () => {
      for (const key of keys) {
        if (abort.signal.aborted) return;
        let minor: string | null = null;
        try {
          const response = await fetcher("/merchant/orders/comp-items/preview", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: abort.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-BOP-CSRF": csrf,
            },
            body: key.slice(key.indexOf("|") + 1),
          });
          const payload = (await response.json().catch(() => null)) as {
            totalMinor?: unknown;
          } | null;
          minor =
            response.ok &&
            typeof payload?.totalMinor === "string" &&
            /^(0|[1-9][0-9]{0,17})$/u.test(payload.totalMinor)
              ? payload.totalMinor
              : null;
        } catch {
          minor = null;
        }
        if (abort.signal.aborted) return;
        setDishPreviews((current) => new Map(current).set(key, minor));
      }
    };
    const timer = setTimeout(() => void ask(), COMP_PREVIEW_WAIT_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // previewRun: the table changed (a refused confirm): the figures are asked again.
  }, [dishKeysText, csrf, fetcher, previewRun]);
  useEffect(() => {
    if (open && focusTo.current === "panel") panel.current?.focus();
    else if (!open && focusTo.current === "opener")
      // b24: on Tables the panel is locked (and may be drawn again) while the floor is reread.
      settledFocus.toOpener(openerKey, opener.current);
    else return;
    focusTo.current = null;
  }, [open]);
  if (offered.length === 0) return null;
  const ready = total !== null && reason !== "" && !busy;
  // b63 (F36, v15 D62DW B): a comp was recorded on one tap although it can't be deleted. Like the
  // cash payment, the first press shows what is recorded (dish, what the bill goes down by, why)
  // and Confirm records it. Anything changed after that asks again.
  const reviewKey = ready ? JSON.stringify([asked, reason, String(total)]) : null;
  const chosenNames = chosen
    .map((line) => {
      const count = choice === "Comp" ? quantities.get(line.orderItemReference) : undefined;
      return count !== undefined && count < leftOf(line)
        ? t("{comped} of {quantity} × {dish}", {
            comped: String(count),
            quantity: String(leftOf(line)),
            dish: line.name,
          })
        : line.name;
    })
    .join(listSeparator());
  const confirming = reviewing !== null && reviewing === reviewKey;
  const send = async () => {
    if (!ready) return;
    const body = {
      ...asked,
      reasonCode: reason,
      expectedTotalMinor: String(total),
    };
    const key = JSON.stringify(body);
    if (attempt.current?.key !== key)
      attempt.current = { key, reference: serviceOperationReference() };
    // b25: from this press on, a tap or key press by staff keeps the focus where they put it.
    settledFocus.confirming();
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetcher("/merchant/orders/comp-items", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify({ ...body, operationReference: attempt.current.reference }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        attempt.current = null;
        setReviewing(null);
        setDishPreviews(new Map());
        settledFocus.settled(panel.current);
        focusTo.current = "opener";
        setOpen(false);
        setSelected(new Set());
        setQuantities(new Map());
        setReason("");
        onSettled();
        return;
      }
      const next = failureOf(response.status, payload);
      // b63 (F36): a refusal ends the confirm step (Cancel is there again); a lost answer keeps it,
      // so Confirm goes again with the same request.
      if (next !== "Unknown" && next !== "FullSignInRequired") setReviewing(null);
      settledFocus.failed(panel.current);
      if (next !== "FullSignInRequired" && next !== "Unknown") attempt.current = null;
      setFailure(next);
      // v15 b16: the amount may have changed with the table: work it out again before the
      // manager can confirm, never the old button amount.
      if (next === "Changed") {
        setReviewing(null);
        setDishPreviews(new Map());
        setPreview(null);
        setPreviewRun((value) => value + 1);
      }
      if (next !== "FullSignInRequired" && next !== "Unknown" && next !== "Denied") onSettled();
    } catch {
      settledFocus.failed(panel.current);
      setFailure("Unknown");
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button
        ref={opener}
        type="button"
        data-variant="destructive"
        data-focus-opener={openerKey}
        onClick={() => {
          settledFocus.reset();
          focusTo.current = "panel";
          setOpen(true);
        }}
      >
        {t("Comp or discount")}
      </button>
    );
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={t("Comp or discount")}
      className="item-comp order-cancel-actions"
    >
      <p>{compIntroText()}</p>
      <ul className="pay-later-remove__lines">
        {listed.map((line) => {
          const left = leftOf(line);
          const ticked = selected.has(line.orderItemReference);
          const billDown = choiceKnown
            ? compDishBillDownMinor(line, ticked, previewLines, dishPreviews.get(dishKeyFor(line)))
            : null;
          return (
            <li key={line.orderItemReference}>
              <label>
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={busy}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.currentTarget.checked) next.add(line.orderItemReference);
                    else next.delete(line.orderItemReference);
                    setSelected(next);
                  }}
                />{" "}
                {/* b23: what the bill goes down by for this dish, as the button and take-off say.
                    Batch 60: a line comped in part says the dishes left on it, and its own price
                    no longer (only the server's figure). */}
                {payLaterRemoveDishText({
                  quantity: left,
                  name:
                    left < line.quantity
                      ? t("{dish} ({count} comped already)", {
                          dish: line.name,
                          count: String(line.quantity - left),
                        })
                      : line.name,
                  billDownMinor: left < line.quantity && billDown === null ? undefined : billDown,
                  total: line.total,
                  // Batch 61: the count chosen in "Dishes to comp" below.
                  chosen:
                    ticked && choice === "Comp"
                      ? quantities.get(line.orderItemReference)
                      : undefined,
                })}
              </label>
              {/* Batch 60 (v15 b59 live): one bowl of two was wrong or came late: comp it alone. */}
              {ticked && choice === "Comp" && left > 1 ? (
                <label className="item-comp__quantity">
                  {t("Dishes to comp")}{" "}
                  <select
                    value={String(quantities.get(line.orderItemReference) ?? left)}
                    disabled={busy}
                    onChange={(event) => {
                      const next = new Map(quantities);
                      next.set(line.orderItemReference, Number(event.currentTarget.value));
                      setQuantities(next);
                    }}
                  >
                    {Array.from({ length: left }, (_, index) => left - index).map((count) => (
                      <option key={count} value={String(count)}>
                        {t("{comped} of {quantity}", {
                          comped: String(count),
                          quantity: String(left),
                        })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </li>
          );
        })}
      </ul>
      <fieldset className="table-checkout__method" disabled={busy}>
        <legend>{t("How much")}</legend>
        {(
          [
            ["Comp", t("Comp (free)")],
            ["Percent", t("Percent off")],
            ["Amount", t("Amount off (one dish)")],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="item-comp-choice"
              checked={choice === value}
              onChange={() => setChoice(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {compOnly.length > 0 ? (
        <p role="note">
          {t("{dishes}: comped in part already, so the rest can only be comped (free).", {
            dishes: compOnly.map((line) => line.name).join(listSeparator()),
          })}
        </p>
      ) : null}
      {choice === "Percent" ? (
        <label className="table-checkout__field">
          {t("Percent off (1–99)")}
          <input
            inputMode="numeric"
            value={percent}
            aria-invalid={percent !== "" && percentValue === null}
            onChange={(event) => setPercent(event.currentTarget.value)}
          />
        </label>
      ) : choice === "Amount" ? (
        <label className="table-checkout__field">
          {t("Amount off before tax")}
          <input
            inputMode="decimal"
            value={amountOff}
            aria-invalid={amountOff !== "" && amountOffMinor === null}
            onChange={(event) => setAmountOff(event.currentTarget.value)}
          />
          <small>{t("Tax comes off in proportion.")}</small>
        </label>
      ) : null}
      <fieldset className="table-checkout__method" disabled={busy}>
        <legend>{t("Reason")}</legend>
        {compReasons.map((code) => (
          <label key={code} data-choice={compReasonLabel[code]}>
            <input
              type="radio"
              name="item-comp-reason"
              checked={reason === code}
              onChange={() => setReason(code)}
            />
            {compReasonLabel[code]}
          </label>
        ))}
      </fieldset>
      {stillRemovable.length > 0 ? (
        <p role="note">
          {t(
            "The kitchen hasn't marked {dishes} started. Once comped or discounted, a dish can't come off the bill. If the guests may not want it, take it off the bill instead, so the kitchen stops it.",
            { dishes: stillRemovable.map((line) => line.name).join(listSeparator()) },
          )}
        </p>
      ) : null}
      {choice === "Amount" && chosen.length > 1 ? (
        <p role="note">{t("An amount off is for one dish at a time.")}</p>
      ) : null}
      <p className="item-comp__note">
        {t("Recorded with your name and reason. It can't be deleted.")}
      </p>
      {confirming && total !== null ? (
        <div
          role="alertdialog"
          aria-labelledby="item-comp-confirm"
          className="table-checkout__confirm item-comp__confirm"
        >
          <p id="item-comp-confirm">
            {t("{what} · bill goes down {amount} · {reason}", {
              what:
                choice === "Comp"
                  ? t("Comp {dishes}", { dishes: chosenNames })
                  : choice === "Percent" && percentValue !== null
                    ? t("{percent}% off {dishes}", {
                        percent: String(percentValue),
                        dishes: chosenNames,
                      })
                    : t("Discount {dishes}", { dishes: chosenNames }),
              amount: orderMoney({ amountMinor: String(total), currencyCode }),
              reason: reason === "" ? "" : compReasonLabel[reason],
            })}
          </p>
          <div className="table-checkout__confirm-actions">
            <button type="button" disabled={busy} onClick={() => setReviewing(null)}>
              {t("Back")}
            </button>
            <button
              type="button"
              className="table-checkout__primary"
              data-confirm=""
              disabled={!ready}
              onClick={() => void send()}
            >
              {busy ? t("Recording…") : t("Confirm")}
            </button>
            {failure !== null ? (
              // After an outage staff may leave without recording; Confirm still goes again.
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReviewing(null);
                  focusTo.current = "opener";
                  setOpen(false);
                }}
              >
                {t("Cancel")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="table-checkout__primary"
            data-confirm=""
            disabled={previewFailure !== null ? busy : !ready}
            onClick={() => {
              if (previewFailure !== null) {
                setPreview(null);
                setPreviewRun((value) => value + 1);
                return;
              }
              if (reviewKey !== null) setReviewing(reviewKey);
            }}
          >
            {busy
              ? t("Recording…")
              : previewFailure !== null
                ? t("Work out the amount again")
                : !valid
                  ? t("Choose dishes, an amount and a reason")
                  : total === null
                    ? t("Working out the amount…")
                    : choice === "Comp"
                      ? t("Comp {amount}", {
                          amount: orderMoney({ amountMinor: String(total), currencyCode }),
                        })
                      : t("Take {amount} off", {
                          amount: orderMoney({ amountMinor: String(total), currencyCode }),
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
        </>
      )}
      {previewFailure !== null && failure === null ? (
        <p role="alert">
          {previewFailure === "Unknown"
            ? t("We couldn't work out the amount. Check the connection, then try again.")
            : itemCompFailureText(previewFailure)}
        </p>
      ) : null}
      {failure === "FullSignInRequired" ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : failure !== null ? (
        <p role="alert">{itemCompFailureText(failure)}</p>
      ) : null}
    </div>
  );
}

/** The preview's amount per dish, or null when the answer doesn't name them (an older server). */
function previewLineAmounts(value: unknown): ReadonlyMap<string, string> | null {
  if (!Array.isArray(value)) return null;
  const amounts = new Map<string, string>();
  for (const entry of value as unknown[]) {
    const { orderItemReference, amountMinor } = (entry ?? {}) as {
      orderItemReference?: unknown;
      amountMinor?: unknown;
    };
    if (typeof orderItemReference !== "string" || typeof amountMinor !== "string") return null;
    if (!/^(0|[1-9][0-9]*)$/u.test(amountMinor)) return null;
    amounts.set(orderItemReference, amountMinor);
  }
  return amounts;
}

/**
 * WP-2423 live minor 10: what the panel is for. Any dish still on the table's bill is offered
 * (one the kitchen hasn't started with its own warning), so the intro names no kitchen state.
 */
export function compIntroText() {
  return t(
    "Comp or discount dishes on this table's bill. It comes off the bill before the table pays and stays in the reports.",
  );
}

/**
 * v15 M87/M161: a comp, discount or points line as staff read it after the fact: what, why, who
 * and when ("Comped · Food quality · by Li, 21:14"; "Points used"). Points are the guest's own.
 */
export function compRecordText(
  comp: {
    readonly kind: "Comp" | "Percent" | "Amount";
    readonly percent: number | null;
    readonly reasonCode?: string;
    readonly decidedAt?: string;
    readonly byLabel?: string | null;
  },
  timeZone: string | undefined,
): string {
  return compRecordParts(comp, timeZone).join(" · ");
}
function compRecordParts(
  comp: Parameters<typeof compRecordText>[0],
  timeZone: string | undefined,
): string[] {
  if (comp.reasonCode === "POINTS_REDEMPTION") return [t("Points used")];
  const parts = [compedText(comp.kind, comp.percent)];
  const reason = compReasonLabel[comp.reasonCode as CompReason] as string | undefined;
  if (reason !== undefined) parts.push(reason);
  if (comp.decidedAt !== undefined)
    parts.push(
      comp.byLabel === null || comp.byLabel === undefined
        ? storeTime(comp.decidedAt, timeZone)
        : t("by {person}, {time}", {
            person: comp.byLabel === "You" ? t("You") : comp.byLabel,
            time: storeTime(comp.decidedAt, timeZone),
          }),
    );
  return parts;
}

/**
 * Batch 60: a comp of some of a line's dishes as staff read it after the fact, its dish named in
 * the same words: "1 of 2 × Beef noodles comped · Goodwill · by Li, 21:14" (zh "牛肉面 · 免单 2 份中的
 * 1 份 · …"). A comp of the whole line (or any other reduction) reads as before: "Beef noodles ·
 * Comped · …". The dish and its comp both stay on the record; nothing is hidden.
 */
export function compRecordLabel(
  name: string,
  comp: Parameters<typeof compRecordText>[0] & {
    readonly compedQuantity?: number | null;
    readonly lineQuantity?: number;
  },
  timeZone: string | undefined,
): string {
  const partly =
    comp.kind === "Comp" &&
    comp.reasonCode !== "POINTS_REDEMPTION" &&
    typeof comp.compedQuantity === "number" &&
    typeof comp.lineQuantity === "number" &&
    comp.compedQuantity < comp.lineQuantity;
  if (!partly) return name + " · " + compRecordText(comp, timeZone);
  return [
    t("{comped} of {quantity} × {dish} comped", {
      comped: String(comp.compedQuantity),
      quantity: String(comp.lineQuantity),
      dish: name,
    }),
    ...compRecordParts(comp, timeZone).slice(1),
  ].join(" · ");
}

/** Batch 60: a bill line whose comps cover some of its dishes ("1 of 2 comped"). */
export function partCompedText(comped: number, quantity: number) {
  return t("{comped} of {quantity} comped", {
    comped: String(comped),
    quantity: String(quantity),
  });
}

export function compedText(kind: "Comp" | "Percent" | "Amount", percent: number | null) {
  return kind === "Comp"
    ? t("Comped")
    : kind === "Percent"
      ? t("{percent}% off", { percent: String(percent) })
      : t("Discounted");
}
