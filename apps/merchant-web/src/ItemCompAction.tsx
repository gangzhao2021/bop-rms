import { useEffect, useRef, useState } from "react";
import { listSeparator, t } from "./i18n/i18n.js";
import type { CurrentOrderLine, CurrentOrderQueue } from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, isFullSignInRequired } from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
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
type Failure =
  | "FullSignInRequired"
  | "Denied"
  | "AlreadyPaid"
  | "GuestPaying"
  | "NotStarted"
  | "AlreadyComped"
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<number | null>(null);
  if (preselect !== undefined && preselect.nonce !== opened) {
    setOpened(preselect.nonce);
    setOpen(true);
    setSelected(new Set(preselect.items));
  }
  const [choice, setChoice] = useState<Choice>("Comp");
  const [percent, setPercent] = useState("");
  const [amountOff, setAmountOff] = useState("");
  const [reason, setReason] = useState<CompReason | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<{ key: string; reference: string } | null>(null);
  const [preview, setPreview] = useState<{
    readonly key: string;
    readonly totalMinor: string | null;
    readonly failure: Failure | null;
  } | null>(null);
  const [previewRun, setPreviewRun] = useState(0);
  const compable = new Set(order.batches.flatMap((batch) => batch.compableItems));
  const offered = lines.filter((line) => compable.has(line.orderItemReference));
  const chosen = offered.filter((line) => selected.has(line.orderItemReference));
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
  const asked = {
    orderReference: order.orderReference,
    orderItemReferences: chosen.map((line) => line.orderItemReference).sort(),
    kind: choice,
    percent: choice === "Percent" ? percentValue : null,
    amountOffMinor: choice === "Amount" ? String(amountOffMinor) : null,
  };
  const previewKey = valid ? JSON.stringify(asked) : null;
  // v15 b16 (DEC-COMP-BILL-CENT): the server works out what really comes off the bill (the bill's
  // tax is worked out once over the whole bill, so it can differ by a cent from the dishes' own).
  const total =
    preview !== null && preview.key === previewKey && preview.totalMinor !== null
      ? BigInt(preview.totalMinor)
      : null;
  const previewFailure = preview !== null && preview.key === previewKey ? preview.failure : null;
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
          } | null;
          if (abort.signal.aborted) return;
          if (response.ok && typeof payload?.totalMinor === "string")
            setPreview({ key: previewKey, totalMinor: payload.totalMinor, failure: null });
          else
            setPreview({
              key: previewKey,
              totalMinor: null,
              failure: response.ok ? "Unknown" : failureOf(response.status, payload),
            });
        } catch {
          if (!abort.signal.aborted)
            setPreview({ key: previewKey, totalMinor: null, failure: "Unknown" });
        }
      })();
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [open, previewKey, csrf, fetcher, previewRun]);
  if (offered.length === 0) return null;
  const ready = total !== null && reason !== "" && !busy;
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
        setOpen(false);
        setSelected(new Set());
        setReason("");
        onSettled();
        return;
      }
      const next = failureOf(response.status, payload);
      if (next !== "FullSignInRequired" && next !== "Unknown") attempt.current = null;
      setFailure(next);
      if (next !== "FullSignInRequired" && next !== "Unknown" && next !== "Denied") onSettled();
    } catch {
      setFailure("Unknown");
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" data-variant="destructive" onClick={() => setOpen(true)}>
        {t("Comp or discount")}
      </button>
    );
  return (
    <div role="group" aria-label={t("Comp or discount")} className="item-comp order-cancel-actions">
      <p>{compIntroText()}</p>
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
              {line.quantity} × {line.name} · {orderMoney(line.total)}
            </label>
          </li>
        ))}
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
          <label key={code}>
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
      <button
        type="button"
        className="table-checkout__primary"
        disabled={previewFailure !== null ? busy : !ready}
        onClick={() => {
          if (previewFailure !== null) {
            setPreview(null);
            setPreviewRun((value) => value + 1);
            return;
          }
          void send();
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
      <button type="button" disabled={busy} onClick={() => setOpen(false)}>
        {t("Cancel")}
      </button>
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

/** What came off the table's dishes so far, in staff words. */
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
  if (comp.reasonCode === "POINTS_REDEMPTION") return t("Points used");
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
  return parts.join(" · ");
}

export function compedText(kind: "Comp" | "Percent" | "Amount", percent: number | null) {
  return kind === "Comp"
    ? t("Comped")
    : kind === "Percent"
      ? t("{percent}% off", { percent: String(percent) })
      : t("Discounted");
}
