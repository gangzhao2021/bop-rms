import { useCallback, useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { t } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
import { paymentConfiguration } from "../payment/payment-configuration.js";
import { StripeCardForm } from "../payment/StripeCardForm.js";
import {
  createTablePaymentClient,
  TablePaymentClientError,
  type TablePaymentView,
  type TableTip,
} from "./table-payment-client.js";

const money = (amountMinor: string) => formatMoney(amountMinor, "CAD");
type TipChoice = "0" | "10" | "15" | "18";
const tipOf = (choice: TipChoice): TableTip =>
  choice === "0" ? { kind: "None" } : { kind: "Percent", percent: Number(choice) as 10 | 15 | 18 };
const tipMinor = (choice: TipChoice, subtotalMinor: string) =>
  ((BigInt(subtotalMinor) * BigInt(choice) + 50n) / 100n).toString();

function problemText(error: unknown) {
  const code = error instanceof TablePaymentClientError ? error.code : "unavailable";
  switch (code) {
    case "not-checking-out":
      return t("Ask a staff member for the bill first; then you can pay it here.");
    case "already-paid":
      return t("This table has already been paid.");
    case "bill-changed":
      return t("The bill just changed. It has been read again: check it and pay again.");
    case "another-guest-paying":
      return t("Someone else at your table is paying the bill right now.");
    case "processing":
      return t("Your payment is still being processed. Check again in a moment.");
    case "not-found":
      return t("This phone isn’t part of the table any more. Ask a staff member for help.");
    default:
      return t("We couldn’t reach the payment service. Check your connection and try again.");
  }
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4: the guest pays the whole table here once staff started
 * checkout — the bill as it stands, the tip chosen once, one card payment. A declined card is
 * tried again; coming back finds the same payment; the receipt is the whole table's.
 */
/** What the table page needs to know: checking out (no more rounds), and paid in full. */
export interface TablePayStatus {
  readonly checkingOut: boolean;
  readonly paid: boolean;
}
// The guest's tip choice during this checkout, kept in this tab so a reload keeps it. Only the
// option chosen is kept (no table, bill or amount); it is cleared once the table is paid or no
// longer checking out. A per-tab convenience: the server never relies on it.
const TIP_KEY = "bop-table-tip-choice";
const savedTip = (): TipChoice | null => {
  try {
    const value = window.sessionStorage.getItem(TIP_KEY);
    return value === "0" || value === "10" || value === "15" || value === "18" ? value : null;
  } catch {
    return null;
  }
};
const saveTip = (choice: TipChoice | null) => {
  try {
    if (choice === null) window.sessionStorage.removeItem(TIP_KEY);
    else window.sessionStorage.setItem(TIP_KEY, choice);
  } catch {
    /* A private window may refuse storage; the guest just chooses again after a reload. */
  }
};

export function TablePayPanel({
  client: provided,
  onStatus,
}: {
  readonly client?: ReturnType<typeof createTablePaymentClient>;
  /** Called when checkout or payment changes, so the table page reads itself again. */
  readonly onStatus?: (status: TablePayStatus) => void;
}) {
  const [client] = useState(() => provided ?? createTablePaymentClient());
  const [view, setView] = useState<TablePaymentView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // AGENTS.md (customer respect): no tip is chosen for the guest; every option, "No tip"
  // included, is offered alike and the guest chooses before paying.
  const [tip, setTip] = useState<TipChoice | null>(null);
  // WP-2423 item 8 ④: the part of a split bill this guest pays (null: the next one to pay).
  const [part, setPart] = useState<number | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const configuration = paymentConfiguration();

  const read = useCallback(async () => {
    try {
      setView(await client.read());
      setProblem(null);
    } catch (error) {
      setProblem(problemText(error));
    }
  }, [client]);
  useEffect(() => {
    void read();
  }, [read]);
  // A reload keeps the tip the guest chose for this bill.
  useEffect(() => {
    if (view === null) return;
    if (!view.checkingOut || view.state === "Paid" || view.state === "Closed") {
      saveTip(null);
      return;
    }
    if (tip === null) {
      const saved = savedTip();
      if (saved !== null) setTip(saved);
    }
  }, [view, tip]);
  // The table page (its total, its "order more") follows checkout and payment.
  const status =
    view === null ? null : { checkingOut: view.checkingOut, paid: view.state === "Paid" };
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (status === null) return;
    const key = JSON.stringify(status);
    if (reported.current === key) return;
    reported.current = key;
    onStatus?.(status);
  }, [status, onStatus]);
  // After the card was submitted (or while another guest pays), the result is read again.
  useEffect(() => {
    if (view?.state !== "Paying" && view?.state !== "AnotherGuestPaying") return;
    if (view.state === "Paying" && !submitted && configuration?.mode !== "simulation") return;
    const timer = window.setInterval(() => void read(), 3000);
    return () => window.clearInterval(timer);
  }, [view?.state, submitted, configuration?.mode, read]);
  // The secure card form's one-time value, once this guest's payment is open (Stripe only).
  useEffect(() => {
    if (view?.state !== "Paying" || configuration?.mode !== "stripe" || clientSecret !== null)
      return;
    client
      .handoff()
      .then(setClientSecret)
      .catch((error: unknown) => setProblem(problemText(error)));
  }, [view?.state, configuration?.mode, clientSecret, client]);

  if (view === null) return problem ? <p role="alert">{problem}</p> : null;
  if (!view.checkingOut && view.state !== "Paid") return null;

  const toPay = view.split?.parts.filter((entry) => entry.status === "ToPay") ?? [];
  const chosen =
    view.split === null
      ? null
      : (toPay.find((entry) => entry.partNumber === part) ?? toPay[0] ?? null);
  const pay = async () => {
    if (busy || tip === null || (view.split !== null && chosen === null)) return;
    const key = `${tip}:${chosen?.partNumber ?? "table"}`;
    // A failed payment is followed by a new one; a lost answer is retried with the same one.
    if (operation.current?.key !== key || view.state === "Failed")
      operation.current = { key, reference: uuidv7() };
    setBusy(true);
    setProblem(null);
    setSubmitted(false);
    setClientSecret(null);
    try {
      setView(
        await client.start(operation.current.reference, tipOf(tip), chosen?.partNumber ?? null),
      );
    } catch (error) {
      setProblem(problemText(error));
      if (error instanceof TablePaymentClientError && error.code !== "unavailable") void read();
    } finally {
      setBusy(false);
    }
  };
  const simulate = async (outcome: "approve" | "decline") => {
    setBusy(true);
    try {
      setView(await client.simulate(outcome));
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  if (view.state === "Paid" && view.receipt !== null) {
    const receipt = view.receipt;
    return (
      <section
        className="order-status__card dining-session__receipt"
        aria-labelledby="table-receipt"
      >
        <h2 id="table-receipt">{t("Receipt")}</h2>
        <dl className="order-status__money">
          <div>
            <dt>{t("Your table’s order")}</dt>
            <dd>{money(receipt.roundsMinor)}</dd>
          </div>
          {receipt.tipMinor !== "0" ? (
            <div>
              <dt>{t("Tip")}</dt>
              <dd>{money(receipt.tipMinor)}</dd>
            </div>
          ) : null}
          {receipt.roundingMinor !== "0" ? (
            <div>
              <dt>{t("Cash rounding")}</dt>
              <dd>{money(receipt.roundingMinor)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t("Total paid")}</dt>
            <dd>{money(receipt.totalMinor)}</dd>
          </div>
          <div>
            <dt>{t("Paid by")}</dt>
            <dd>
              {receipt.method === "Online"
                ? t("Card on a guest’s phone")
                : receipt.method === "Cash"
                  ? t("Cash")
                  : t("Card at the table")}
            </dd>
          </div>
        </dl>
        <p>{t("Thank you! Your table is paid in full.")}</p>
      </section>
    );
  }
  if (view.state === "Closed") return null;
  // WP-2423 item 8 ④: a split bill paid part by part — every part is paid.
  if (view.state === "Paid" && view.split !== null)
    return (
      <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
        <h2 id="table-pay">{t("Pay the bill")}</h2>
        <p role="status">
          {t("Every part of the bill is paid ({count} parts). Thank you!", {
            count: String(view.split.parts.length),
          })}
        </p>
      </section>
    );

  // A split bill: the chosen part's own amount, and its tip on its own share before tax.
  const subtotal = chosen ? chosen.subtotalMinor : view.owed.subtotalMinor;
  const amountDue = chosen ? chosen.amountMinor : view.owed.totalMinor;
  const total =
    tip === null ? null : (BigInt(amountDue) + BigInt(tipMinor(tip, subtotal))).toString();
  return (
    <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
      <h2 id="table-pay">{t("Pay the bill")}</h2>
      {view.state === "AnotherGuestPaying" ? (
        <p role="status">{t("Someone else at your table is paying the bill right now.")}</p>
      ) : view.state === "Paying" && view.attempt !== null ? (
        <>
          <p>
            {view.attempt.partNumber === null
              ? t("Paying {amount} for the whole table, tip included.", {
                  amount: money(view.attempt.totalMinor),
                })
              : t("Paying {amount} for part {number}, tip included.", {
                  amount: money(view.attempt.totalMinor),
                  number: String(view.attempt.partNumber),
                })}
          </p>
          {configuration?.mode === "simulation" ? (
            <div className="payment-retry__simulated">
              <button type="button" disabled={busy} onClick={() => void simulate("approve")}>
                {t("Confirm simulated payment")}
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => void simulate("decline")}>
                {t("Decline simulated payment")}
              </button>
            </div>
          ) : configuration?.mode === "stripe" && clientSecret !== null ? (
            submitted ? (
              <p role="status">{t("Confirming your payment…")}</p>
            ) : (
              <StripeCardForm
                publishableKey={configuration.publishableKey}
                returnUrl={configuration.returnUrl}
                clientSecret={clientSecret}
                wallets={configuration.wallets}
                onSubmitted={() => setSubmitted(true)}
              />
            )
          ) : configuration === null ? (
            <p role="alert">
              {t(
                "Card payment isn’t available on this phone. Ask a staff member to take the payment.",
              )}
            </p>
          ) : (
            <p role="status">{t("Preparing the secure card form…")}</p>
          )}
        </>
      ) : (
        <>
          {view.state === "Failed" ? (
            <p role="alert">
              {t("The payment didn’t go through. You can try again with another card.")}
            </p>
          ) : null}
          {view.split !== null ? (
            <div className="dining-session__split">
              <p>
                {view.split.mode === "Even"
                  ? t("Your table split the bill evenly in {count} parts.", {
                      count: String(view.split.parts.length),
                    })
                  : t("Your table split the bill by rounds, in {count} parts.", {
                      count: String(view.split.parts.length),
                    })}{" "}
                {t("Pay one part; you can pay another one after it.")}
              </p>
              <fieldset>
                <legend>{t("Which part you pay")}</legend>
                {view.split.parts.map((entry) => (
                  <label key={entry.partNumber} data-status={entry.status}>
                    <input
                      type="radio"
                      name="table-part"
                      disabled={entry.status !== "ToPay"}
                      checked={chosen?.partNumber === entry.partNumber}
                      onChange={() => setPart(entry.partNumber)}
                    />{" "}
                    {t("Part {number} · {amount}", {
                      number: String(entry.partNumber),
                      amount: money(entry.amountMinor),
                    })}
                    {entry.status === "Paid"
                      ? ` · ${t("paid")}`
                      : entry.status === "Paying" || entry.status === "Mine"
                        ? ` · ${t("being paid")}`
                        : ""}
                  </label>
                ))}
              </fieldset>
              <p>
                {t("{paid} of {count} parts paid · {amount} to go", {
                  paid: String(view.split.paidParts),
                  count: String(view.split.parts.length),
                  amount: money(view.split.remainingMinor),
                })}
              </p>
            </div>
          ) : (
            <dl className="order-status__money">
              <div>
                <dt>{t("Subtotal")}</dt>
                <dd>{money(view.owed.subtotalMinor)}</dd>
              </div>
              <div>
                <dt>{t("Tax")}</dt>
                <dd>{money(view.owed.taxMinor)}</dd>
              </div>
            </dl>
          )}
          <fieldset className="dining-session__tip">
            <legend>
              {view.split !== null
                ? t("Tip (for your part)")
                : t("Tip (once, for the whole table)")}
            </legend>
            {(["0", "10", "15", "18"] as const).map((choice) => (
              <label key={choice}>
                <input
                  type="radio"
                  name="table-tip"
                  value={choice}
                  checked={tip === choice}
                  onChange={() => {
                    setTip(choice);
                    saveTip(choice);
                  }}
                />{" "}
                {choice === "0"
                  ? t("No tip")
                  : t("{percent}% · {amount}", {
                      percent: choice,
                      amount: money(tipMinor(choice, subtotal)),
                    })}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="dining-session__pay-button"
            disabled={
              busy ||
              tip === null ||
              !view.consistent ||
              view.owed.totalMinor === "0" ||
              (view.split !== null && chosen === null)
            }
            onClick={() => void pay()}
          >
            {busy
              ? t("Starting your payment…")
              : total === null
                ? t("Choose a tip to pay")
                : t("Pay {amount}", { amount: money(total) })}
          </button>
        </>
      )}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
