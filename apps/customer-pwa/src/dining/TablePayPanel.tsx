import { useCallback, useEffect, useRef, useState } from "react";
import { MemberJoinPanel } from "../member/MemberJoinPanel.js";
import { MemberPointsAtTable } from "../member/MemberPointsAtTable.js";
import { v7 as uuidv7 } from "uuid";
import { t } from "../i18n/i18n.js";
import { parseTipAmount } from "../checkout/tip-amount.js";
import { customTipCheck } from "../checkout/checkout-decisions.js";
import { formatMoney } from "../journey/format.js";
import { SlowWaitNote } from "../journey/SlowWaitNote.js";
import { paymentConfiguration } from "../payment/payment-configuration.js";
import { cardFormNotLoadedText, StripeCardForm } from "../payment/StripeCardForm.js";
import {
  createTablePaymentClient,
  TablePaymentClientError,
  type TablePaymentView,
  type TableTip,
} from "./table-payment-client.js";

const money = (amountMinor: string) => formatMoney(amountMinor, "CAD");
/** "0": no tip; "other": an amount the guest types; otherwise one of the Store's percentages. */
type TipChoice = string;
const OTHER = "other";
/** WP-2423 item 2: a payment still confirming after this long gets advice, not a longer wait. */
const confirmingTooLongMs = 60_000;
const tipOf = (choice: TipChoice, typedMinor: string | null): TableTip =>
  choice === "0"
    ? { kind: "None" }
    : choice === OTHER
      ? { kind: "Amount", amountMinor: typedMinor ?? "0" }
      : { kind: "Percent", percent: Number(choice) };
const tipMinor = (choice: TipChoice, subtotalMinor: string) =>
  ((BigInt(subtotalMinor) * BigInt(choice) + 50n) / 100n).toString();

/**
 * WP-2423 item 2: the guest's own tap on Pay failed. No card was offered for this start, so it can say
 * this payment wasn't charged (never "you": they may have paid for something else). What a failed read
 * says stays about the connection only.
 */
function startProblemText(error: unknown) {
  const code = error instanceof TablePaymentClientError ? error.code : "unavailable";
  return code === "unavailable"
    ? t(
        "We couldn’t start the payment just now. This payment hasn’t been charged. Try again, or ask a staff member to take payment.",
      )
    : problemText(error);
}

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
    case "tips-off":
      return t(
        "The restaurant has just stopped taking tips. Check the bill and pay it without a tip.",
      );
    case "tip-choices-changed":
      return t("The tip choices just changed. Choose a tip again to pay.");
    case "rounds-waiting":
      return t(
        "Some of your table’s dishes are waiting for staff to confirm them. Ask staff to confirm them, then pay.",
      );
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
    return value !== null && /^(0|[1-9][0-9]?)$/u.test(value) ? value : null;
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
  readKey,
  onBillChanged,
}: {
  readonly client?: ReturnType<typeof createTablePaymentClient>;
  /** Called when checkout or payment changes, so the table page reads itself again. */
  readonly onStatus?: (status: TablePayStatus) => void;
  /** A new value reads the table's payment state again. */
  readonly readKey?: number | undefined;
  /** v15 2026-11-02: the bill changed here (points used): the table's page reads it at once too. */
  readonly onBillChanged?: () => void;
}) {
  const [client] = useState(() => provided ?? createTablePaymentClient());
  const [view, setView] = useState<TablePaymentView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Owner 2026-11-03: the page says payment is paused while offline, so the button agrees.
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  // AGENTS.md (customer respect): no tip is chosen for the guest; every option, "No tip"
  // included, is offered alike and the guest chooses before paying.
  const [tip, setTip] = useState<TipChoice | null>(null);
  // WP-2423 item 8 ⑦: the amount typed for "Other amount" (never kept across a reload).
  const [typed, setTyped] = useState("");
  /** WP-2423 M132: the large typed tip the guest confirmed (its amount). */
  const [confirmedTip, setConfirmedTip] = useState<string | null>(null);
  // WP-2423 item 8 ④: the part of a split bill this guest pays (null: the next one to pay).
  const [part, setPart] = useState<number | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // WP-2423 item 2: the card form's one-time value couldn't be read; the guest asks again.
  const [handoffFailed, setHandoffFailed] = useState(false);
  const [handoffAttempt, setHandoffAttempt] = useState(0);
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
  }, [read, readKey]);
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
    let stopped = false;
    setHandoffFailed(false);
    client
      .handoff()
      .then((secret) => {
        if (!stopped) setClientSecret(secret);
      })
      .catch(() => {
        if (!stopped) setHandoffFailed(true);
      });
    return () => {
      stopped = true;
    };
  }, [view?.state, configuration?.mode, clientSecret, client, handoffAttempt]);

  if (view === null) return problem ? <p role="alert">{problem}</p> : null;
  if (!view.checkingOut && view.state !== "Paid") return null;

  // WP-2423 item 8 ⑦: the Store's own tip percentages; with tips off the guest pays no tip and is
  // asked nothing. A choice the Store no longer offers counts as not chosen.
  const tipOptions = view.tips.enabled ? ["0", ...view.tips.tierPercents.map(String), OTHER] : [];
  const chosenTip: TipChoice | null = !view.tips.enabled
    ? "0"
    : tip !== null && tipOptions.includes(tip)
      ? tip
      : null;

  const toPay = view.split?.parts.filter((entry) => entry.status === "ToPay") ?? [];
  const chosen =
    view.split === null
      ? null
      : (toPay.find((entry) => entry.partNumber === part) ?? toPay[0] ?? null);
  // A split bill: the chosen part's own amount, and its tip on its own share before tax.
  const subtotal = chosen ? chosen.subtotalMinor : view.owed.subtotalMinor;
  const amountDue = chosen ? chosen.amountMinor : view.owed.totalMinor;
  // A typed tip is whole cents, and never more than the bill before tax (the server agrees).
  const typedMinor = chosenTip === OTHER ? parseTipAmount(typed.trim()) : null;
  const typedTooHigh = typedMinor !== null && BigInt(typedMinor) > BigInt(subtotal);
  // WP-2423 M132: a typed tip above 30 % of the bill before tax is confirmed before paying.
  const largeTip =
    chosenTip === OTHER &&
    typedMinor !== null &&
    !typedTooHigh &&
    customTipCheck(typedMinor, subtotal) === "confirm";
  const chosenTipMinor =
    chosenTip === null
      ? null
      : chosenTip === OTHER
        ? typedMinor === null || typedTooHigh || (largeTip && confirmedTip !== typedMinor)
          ? null
          : typedMinor
        : tipMinor(chosenTip, subtotal);
  const pay = async () => {
    if (busy || chosenTipMinor === null || chosenTip === null) return;
    if (view.split !== null && chosen === null) return;
    const key = `${chosenTip}:${chosenTipMinor}:${chosen?.partNumber ?? "table"}`;
    // A failed payment is followed by a new one; a lost answer is retried with the same one.
    if (operation.current?.key !== key || view.state === "Failed")
      operation.current = { key, reference: uuidv7() };
    setBusy(true);
    setProblem(null);
    setSubmitted(false);
    setClientSecret(null);
    try {
      setView(
        await client.start(
          operation.current.reference,
          tipOf(chosenTip, typedMinor),
          chosen?.partNumber ?? null,
        ),
      );
    } catch (error) {
      setProblem(startProblemText(error));
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
          {receipt.pointsUsedMinor !== "0" ? (
            <div>
              <dt>{t("Points used (already taken off)")}</dt>
              <dd>{money(receipt.pointsUsedMinor)}</dd>
            </div>
          ) : null}
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
          {view.refundedMinor !== "0" ? (
            <div>
              <dt>{t("Refunded")}</dt>
              <dd>−{money(view.refundedMinor)}</dd>
            </div>
          ) : null}
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
        <MemberJoinPanel />
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
        <MemberJoinPanel />
      </section>
    );

  const total =
    chosenTipMinor === null ? null : (BigInt(amountDue) + BigInt(chosenTipMinor)).toString();
  return (
    <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
      <h2 id="table-pay">{t("Pay the bill")}</h2>
      {view.state === "AnotherGuestPaying" ? (
        <p role="status">{t("Someone else at your table is paying the bill right now.")}</p>
      ) : view.state === "Paying" && view.attempt !== null ? (
        <>
          <p>
            {view.attempt.partNumber === null
              ? view.attempt.tipMinor === "0"
                ? t("Paying {amount} for the whole table.", {
                    amount: money(view.attempt.totalMinor),
                  })
                : t("Paying {amount} for the whole table, tip included.", {
                    amount: money(view.attempt.totalMinor),
                  })
              : view.attempt.tipMinor === "0"
                ? t("Paying {amount} for part {number}.", {
                    amount: money(view.attempt.totalMinor),
                    number: String(view.attempt.partNumber),
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
              <>
                <p role="status">{t("Confirming your payment…")}</p>
                <SlowWaitNote active afterMs={confirmingTooLongMs}>
                  {t(
                    "This is taking longer than usual. Don’t pay again: ask a staff member to check this payment.",
                  )}
                </SlowWaitNote>
              </>
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
          ) : handoffFailed ? (
            // A reload loses "submitted": a card may be confirming, so nothing is said about money.
            <div role="alert">
              <p>{cardFormNotLoadedText()}</p>
              <button
                type="button"
                disabled={!online}
                onClick={() => {
                  setHandoffFailed(false);
                  setHandoffAttempt((count) => count + 1);
                }}
              >
                {t("Try again")}
              </button>
            </div>
          ) : (
            <p role="status">{t("Preparing the secure card form…")}</p>
          )}
        </>
      ) : (
        <>
          <MemberPointsAtTable
            onBillChanged={() => {
              void read();
              onBillChanged?.();
            }}
          />
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
                  : view.split.mode === "ByItems"
                    ? t("Your table split the bill by dish, in {count} parts.", {
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
                    {entry.dishes.length === 0 ? null : (
                      <small className="dining-session__split-dishes">
                        {entry.dishes
                          .map(
                            (dish) =>
                              (dish.quantity > 1 ? `${dish.quantity} × ` : "") +
                              dish.displayName +
                              (dish.shared ? ` (${t("shared")})` : ""),
                          )
                          .join(", ")}
                      </small>
                    )}
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
                <dd>
                  {money(
                    (BigInt(view.owed.taxMinor) - BigInt(view.owed.taxRoundingMinor)).toString(),
                  )}
                </dd>
              </div>
              {/* WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax is rounded once. */}
              {view.owed.taxRoundingMinor !== "0" ? (
                <div>
                  <dt>{t("Tax rounding")}</dt>
                  <dd>{money(view.owed.taxRoundingMinor)}</dd>
                </div>
              ) : null}
            </dl>
          )}
          {tipOptions.length === 0 ? null : (
            <fieldset className="dining-session__tip">
              <legend>
                {view.split !== null
                  ? t("Tip (for your part)")
                  : t("Tip (once, for the whole table)")}
              </legend>
              {tipOptions.map((choice) => (
                <label key={choice}>
                  <input
                    type="radio"
                    name="table-tip"
                    value={choice}
                    checked={chosenTip === choice}
                    onChange={() => {
                      setTip(choice);
                      // The typed amount is not kept: after a reload the guest types it again.
                      saveTip(choice === OTHER ? null : choice);
                    }}
                  />{" "}
                  {choice === "0"
                    ? t("No tip")
                    : choice === OTHER
                      ? t("Other amount")
                      : t("{percent}% · {amount}", {
                          percent: choice,
                          amount: money(tipMinor(choice, subtotal)),
                        })}
                </label>
              ))}
              {chosenTip === OTHER ? (
                <div className="dining-session__tip-amount">
                  <label htmlFor="table-tip-amount">{t("Tip ({symbol})", { symbol: "$" })}</label>
                  <input
                    id="table-tip-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    aria-invalid={typed.trim() !== "" && chosenTipMinor === null}
                    aria-describedby="table-tip-amount-help"
                  />
                  {largeTip && typedMinor !== null ? (
                    <div role="alert" className="checkout-tip__confirm">
                      <p>
                        {t("Tip {tip} on a {subtotal} order?", {
                          tip: money(typedMinor),
                          subtotal: money(subtotal),
                        })}
                      </p>
                      <button
                        type="button"
                        aria-pressed={confirmedTip === typedMinor}
                        onClick={() => setConfirmedTip(typedMinor)}
                      >
                        {t("Yes, tip {tip}", { tip: money(typedMinor) })}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmedTip(null);
                          document.getElementById("table-tip-amount")?.focus();
                        }}
                      >
                        {t("Change tip")}
                      </button>
                    </div>
                  ) : null}
                  <p id="table-tip-amount-help">
                    {typedTooHigh
                      ? t("A tip can be at most the bill before tax ({amount}).", {
                          amount: money(subtotal),
                        })
                      : typed.trim() !== "" && typedMinor === null
                        ? t("Enter a valid amount with up to two decimal places.")
                        : t("Enter an amount in dollars.")}
                  </p>
                </div>
              ) : null}
            </fieldset>
          )}
          <button
            type="button"
            className="dining-session__pay-button"
            disabled={
              busy ||
              !online ||
              chosenTipMinor === null ||
              !view.consistent ||
              view.owed.totalMinor === "0" ||
              (view.split !== null && chosen === null)
            }
            onClick={() => void pay()}
          >
            {busy
              ? t("Starting your payment…")
              : total === null
                ? chosenTip === OTHER
                  ? t("Enter the tip to pay")
                  : t("Choose a tip to pay")
                : t("Pay {amount}", { amount: money(total) })}
          </button>
        </>
      )}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
