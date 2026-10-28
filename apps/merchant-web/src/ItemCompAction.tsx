import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderLine, CurrentOrderQueue } from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, isFullSignInRequired } from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { dollarsToMinor } from "./TableCheckout.js";

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
        "The kitchen hasn't started one of these dishes. Take it off the bill instead, so the kitchen stops it.",
      );
    case "AlreadyComped":
      return t("One of these dishes already has a comp or discount. Refresh the table.");
    case "Changed":
      return t("This table changed since it was shown. Refresh it, then try again.");
    case "Unknown":
      return t(
        "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.",
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
 * the cent — the rule the server and the database apply (shown before it is recorded).
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
 * WP-2423 item 8 ① segment 2 (Owner decision 2, Figma 45:315): a manager comps or discounts dishes
 * the kitchen started or the table was served, before the table pays. Money, so it is confirmed:
 * the dishes, how much (shown exactly), and a reason; recorded as a compensating record that stays
 * in the reports. On a shared tablet the manager confirms with a full sign-in.
 */
export function ItemCompAction({
  order,
  lines,
  csrf,
  onSettled,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly lines: readonly CurrentOrderLine[];
  readonly csrf: string;
  readonly onSettled: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [choice, setChoice] = useState<Choice>("Comp");
  const [percent, setPercent] = useState("");
  const [amountOff, setAmountOff] = useState("");
  const [reason, setReason] = useState<CompReason | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<{ key: string; reference: string } | null>(null);
  const compable = new Set(order.batches.flatMap((batch) => batch.compableItems));
  const offered = lines.filter((line) => compable.has(line.orderItemReference));
  if (offered.length === 0) return null;
  const chosen = offered.filter((line) => selected.has(line.orderItemReference));
  const percentValue = /^[1-9][0-9]?$/u.test(percent.trim()) ? Number(percent.trim()) : null;
  const amountOffMinor = dollarsToMinor(amountOff);
  const amounts = chosen.map((line) =>
    compAmountMinor(line, choice, percentValue, choice === "Amount" ? amountOffMinor : null),
  );
  const total =
    chosen.length > 0 && amounts.every((value) => value !== null)
      ? amounts.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n)
      : null;
  const currencyCode = offered[0]?.total.currencyCode ?? "CAD";
  const ready =
    total !== null && reason !== "" && (choice !== "Amount" || chosen.length === 1) && !busy;
  const send = async () => {
    if (!ready) return;
    const items = chosen.map((line) => line.orderItemReference).sort();
    const body = {
      orderReference: order.orderReference,
      orderItemReferences: items,
      kind: choice,
      percent: choice === "Percent" ? percentValue : null,
      amountOffMinor: choice === "Amount" ? String(amountOffMinor) : null,
      reasonCode: reason,
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
      <p>
        {t(
          "For dishes the kitchen started or the table was served. It comes off the bill before the table pays and stays in the reports.",
        )}
      </p>
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
      {choice === "Amount" && chosen.length > 1 ? (
        <p role="note">{t("An amount off is for one dish at a time.")}</p>
      ) : null}
      <p className="item-comp__note">
        {t("Recorded with your name and reason. It can't be deleted.")}
      </p>
      <button
        type="button"
        className="table-checkout__primary"
        disabled={!ready}
        onClick={() => void send()}
      >
        {busy
          ? t("Recording…")
          : total === null
            ? t("Choose dishes, an amount and a reason")
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
      {failure === "FullSignInRequired" ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : failure !== null ? (
        <p role="alert">{itemCompFailureText(failure)}</p>
      ) : null}
    </div>
  );
}

/** What came off the table's dishes so far, in staff words. */
export function compedText(kind: "Comp" | "Percent" | "Amount", percent: number | null) {
  return kind === "Comp"
    ? t("Comped")
    : kind === "Percent"
      ? t("{percent}% off", { percent: String(percent) })
      : t("Discounted");
}
