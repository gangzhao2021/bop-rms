import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createDiningSessionCloseClient,
  DiningSessionCloseClientError,
} from "./dining-session-close-client.js";
import { createDiningProgressClient } from "./dining-progress-client.js";
import { paidAtInstant } from "./counter-payment.js";
import {
  cashTotalMinor,
  createTableCheckoutClient,
  TableCheckoutError,
  type TableBill,
} from "./table-checkout-client.js";
import type { StaffDiningTable, StaffDiningTableSession } from "./dining-session-client.js";
import { compedText } from "./ItemCompAction.js";
import { TableSplitControls } from "./TableSplit.js";

const cad = (minor: string | bigint) =>
  orderMoney({ amountMinor: String(minor), currencyCode: "CAD" });
/** "0": no tip; one of the Store's percentages, as text; or an amount typed in. */
type Tip = string;
/** "12.50" → 1250; null when it isn't an amount of money. */
export function dollarsToMinor(value: string): bigint | null {
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,2}))?$/u.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1] as string) * 100n + BigInt((match[2] ?? "0").padEnd(2, "0"));
}

function errorText(error: unknown): string {
  const code =
    error instanceof TableCheckoutError
      ? error.code
      : error instanceof DiningSessionCloseClientError
        ? error.code === "Conflict"
          ? "SessionChanged"
          : error.code === "Unavailable"
            ? "Unavailable"
            : error.code
        : "OutcomeUnknown";
  switch (code) {
    case "PermissionDenied":
      return t("Your access doesn't allow this. Ask an Owner or Store Manager.");
    case "NotStarted":
      return t("Start checkout first, so no more rounds are sent from this table.");
    case "NothingOwed":
      return t("This table owes nothing.");
    case "TipsOff":
      return t(
        "Tips are turned off for this store, so nothing was recorded. The bill has been read again: take the payment with no tip.",
      );
    case "TipChoicesChanged":
      return t(
        "The store's tip choices just changed, so nothing was recorded. The bill has been read again: choose the tip again.",
      );
    case "BillChanged":
      return t(
        "The bill changed (a round is still being sent, or something was changed). It has been read again: check it and try again.",
      );
    case "TenderShort":
      return t("The cash received is less than the cash total.");
    case "AlreadyPaid":
      return t("This table has already paid.");
    case "GuestPaying":
      return t(
        "A guest is paying the whole table on their phone right now. Wait for it, or stop the phone payment if they gave up.",
      );
    case "NotReady":
      return t("Every dish must be served or cancelled first.");
    case "SessionChanged":
      return t("This table changed since it was shown. It has been read again: try again.");
    case "OutcomeUnknown":
      return t(
        "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.",
      );
    default:
      return t("This couldn't be done right now. Try again.");
  }
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (DIN-FLOOR-BOARD): a pay-later table pays once at the end. Staff
 * start checkout (no more rounds), read the bill, choose the tip, and record the table's payment —
 * on the card machine after it approved, or in cash (rounded to 5 cents, with the change). A manager
 * can record that the guests left without paying. The table is then closed as usual.
 */
export function TableCheckout({
  table,
  session,
  csrf,
  locked,
  canStart,
  canWriteOff = false,
  onChanged,
  fetcher,
  timeZone,
}: {
  /** WP-2423 item 8 ①: may record that the guests left without paying (a manager). */
  readonly canWriteOff?: boolean;
  /** The Store's time zone (a paper payment's time is Store time). */
  readonly timeZone?: string | undefined;
  readonly table: StaffDiningTable;
  readonly session: StaffDiningTableSession;
  readonly csrf: string;
  readonly locked: boolean;
  /** Whether this person may start checkout (stop the table's ordering). */
  readonly canStart: boolean;
  readonly onChanged: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createTableCheckoutClient(fetcher), [fetcher]);
  const sessionReference = table.currentDiningSessionReference as string;
  const [bill, setBill] = useState<TableBill | null>(null);
  const [reload, setReload] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // WP-2423 item 8 ① (Owner 2026-10-27): no tip is chosen for the guests; staff ask and choose.
  const [tip, setTip] = useState<Tip | null>(null);
  // Money is confirmed: the amounts are shown once more before the payment is recorded.
  const [reviewing, setReviewing] = useState(false);
  const [otherTip, setOtherTip] = useState("");
  const [method, setMethod] = useState<"CardMachine" | "Cash">("CardMachine");
  const [slip, setSlip] = useState("");
  const [received, setReceived] = useState("");
  const [leaving, setLeaving] = useState(false);
  // Operating continuity: a table paid while the system was down is entered afterwards from paper.
  const [paper, setPaper] = useState(false);
  // WP-2423 item 8 ④: the part of a split bill being collected (null: the whole table).
  const [part, setPart] = useState<number | null>(null);
  const [paidAt, setPaidAt] = useState("");
  const paperInstant = paper ? paidAtInstant(paidAt, Date.now(), timeZone) : null;
  // One operation per intent: a lost answer is resent with the same one.
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const beginOperation = useRef<string | null>(null);
  const guestPaid = useRef(false);

  useEffect(() => {
    if (session.phase !== "Closing") {
      setBill(null);
      return;
    }
    const controller = new AbortController();
    client
      .bill(csrf, sessionReference, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setBill(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem(errorText(error));
      });
    return () => controller.abort();
  }, [client, csrf, sessionReference, session.phase, session.version, reload]);

  // S4: while a guest pays on their phone, the bill is read again until it ends.
  const guestPaying = bill?.onlinePayment?.status === "InProgress";
  useEffect(() => {
    if (!guestPaying) return;
    const timer = window.setInterval(() => setReload((value) => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, [guestPaying]);
  // …and once it is paid, the table's close check reads again.
  const paidNow = bill?.settlement != null;
  const notified = useRef(false);
  useEffect(() => {
    if (paidNow && guestPaid.current && !notified.current) {
      notified.current = true;
      onChanged();
    }
    guestPaid.current = guestPaying;
  }, [paidNow, guestPaying, onChanged]);

  const selected = bill?.split?.parts.find((entry) => entry.partNumber === part) ?? null;
  // A part's own share before tax (its tip) and its amount; otherwise what the table owes.
  const subtotal = selected
    ? BigInt(selected.subtotalMinor)
    : bill
      ? BigInt(bill.owed.subtotalMinor)
      : 0n;
  const owed = selected ? BigInt(selected.amountMinor) : bill ? BigInt(bill.owed.totalMinor) : 0n;
  // WP-2423 item 8 ⑦ (Owner decision 11): the Store's own percentages; with tips off, staff are
  // asked nothing and no tip is taken. A percentage the Store no longer offers is chosen again.
  const tipOptions =
    bill === null || !bill.tips.enabled ? [] : ["0", ...bill.tips.tierPercents.map(String)];
  const chosenTip: Tip | null =
    bill !== null && !bill.tips.enabled
      ? "0"
      : tip !== null && (tip === "Other" || tipOptions.includes(tip))
        ? tip
        : null;
  const tipMinor =
    chosenTip === null
      ? null
      : chosenTip === "Other"
        ? dollarsToMinor(otherTip)
        : (subtotal * BigInt(chosenTip) + 50n) / 100n;
  const due = tipMinor === null ? null : owed + tipMinor;
  const cashDue = due === null ? null : cashTotalMinor(due);
  const receivedMinor = dollarsToMinor(received);
  const change = cashDue !== null && receivedMinor !== null ? receivedMinor - cashDue : null;
  const slipValid = slip.trim() === "" || /^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(slip.trim());
  const canPay =
    bill !== null &&
    bill.settlement === null &&
    bill.consistent &&
    (bill.split === null ||
      (selected !== null && selected.payment === null && !selected.guestPaying)) &&
    owed > 0n &&
    due !== null &&
    !busy &&
    !locked &&
    (method === "CardMachine" ? slipValid : change !== null && change >= 0n) &&
    (!paper || paperInstant !== null);

  const start = async () => {
    if (busy || locked) return;
    setBusy(true);
    setProblem(null);
    beginOperation.current ??= serviceOperationReference();
    try {
      await createDiningSessionCloseClient(fetcher)
        .prepare({
          operationReference: beginOperation.current,
          diningSessionReference: sessionReference,
          action: "Begin",
          expectedSessionVersion: session.version,
        })
        .execute(csrf);
      beginOperation.current = null;
      onChanged();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  // DEC-DINE-IN-PAY-LATER (rule 3): the guests want more after asking for the bill — back to
  // ordering, recorded with who did it. Only while nothing is paid.
  const cancelOperation = useRef<string | null>(null);
  const cancelCheckout = async () => {
    if (busy || locked) return;
    setBusy(true);
    setProblem(null);
    cancelOperation.current ??= serviceOperationReference();
    try {
      await createDiningSessionCloseClient(fetcher)
        .prepare({
          operationReference: cancelOperation.current,
          diningSessionReference: sessionReference,
          action: "Cancel",
          expectedSessionVersion: session.version,
        })
        .execute(csrf);
      cancelOperation.current = null;
      onChanged();
    } catch (error) {
      if (!(error instanceof DiningSessionCloseClientError && error.code === "OutcomeUnknown"))
        cancelOperation.current = null;
      setProblem(errorText(error));
      if (error instanceof DiningSessionCloseClientError && error.code !== "OutcomeUnknown")
        onChanged();
    } finally {
      setBusy(false);
    }
  };

  // S4: stop a phone payment the guest gave up on (the Provider is asked first).
  const stopPhone = async () => {
    if (busy || locked) return;
    setBusy(true);
    setProblem(null);
    try {
      setBill(await client.stopOnlinePayment(csrf, sessionReference));
      onChanged();
    } catch (error) {
      setProblem(errorText(error));
      setReload((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    if (!canPay || bill === null || tipMinor === null) return;
    setReviewing(false);
    const intent = JSON.stringify([
      part,
      method,
      chosenTip,
      tipMinor.toString(),
      received,
      slip.trim(),
      paperInstant,
    ]);
    if (operation.current?.key !== intent)
      operation.current = { key: intent, reference: serviceOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const result = await client.settle(csrf, {
        operationReference: operation.current.reference,
        diningSessionReference: sessionReference,
        method,
        tip:
          chosenTip === "0" || chosenTip === null
            ? { kind: "None" }
            : chosenTip === "Other"
              ? { kind: "Amount", amountMinor: tipMinor.toString() }
              : { kind: "Percent", percent: Number(chosenTip) },
        tenderedMinor: method === "Cash" ? String(receivedMinor) : null,
        slipReference: method === "CardMachine" && slip.trim() !== "" ? slip.trim() : null,
        takenAt: paper ? paperInstant : null,
        partNumber: bill.split === null ? null : part,
      });
      operation.current = null;
      setPart(null);
      setTip(null);
      setReceived("");
      setBill(result.bill);
      onChanged();
    } catch (error) {
      if (!(error instanceof TableCheckoutError) || error.code !== "OutcomeUnknown")
        operation.current = null;
      setProblem(errorText(error));
      if (
        error instanceof TableCheckoutError &&
        (error.code === "BillChanged" ||
          error.code === "TipsOff" ||
          error.code === "TipChoicesChanged")
      )
        setReload((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  const leftWithoutPaying = async () => {
    if (busy || locked || session.orderReference === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const progress = await createDiningProgressClient(fetcher).load(session.orderReference, csrf);
      operation.current ??= { key: "left", reference: serviceOperationReference() };
      await client.leftWithoutPaying(csrf, {
        orderReference: session.orderReference,
        operationReference: operation.current.reference,
        expectedOrderVersion: progress.currentOrderVersion,
        expectedClosureVersion: progress.closureVersion,
      });
      operation.current = null;
      setLeaving(false);
      // The table's session is unchanged by a write-off: read the bill again here as well.
      setReload((value) => value + 1);
      onChanged();
    } catch (error) {
      if (!(error instanceof TableCheckoutError) || error.code !== "OutcomeUnknown")
        operation.current = null;
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (session.phase === "Active")
    return (
      <section aria-label={t("Checkout")} className="table-checkout">
        <h3 id="table-checkout-title">{t("Checkout")}</h3>
        <p>
          {t(
            "This table pays once at the end. When the guests ask for the bill, start checkout: no more rounds can be sent from the table.",
          )}
        </p>
        {canStart ? (
          <button
            type="button"
            className="table-checkout__primary"
            disabled={busy || locked}
            onClick={() => void start()}
          >
            {busy ? t("Starting checkout…") : t("Start checkout")}
          </button>
        ) : (
          <p role="note">{t("An Owner or Store Manager starts checkout.")}</p>
        )}
        {problem ? <p role="alert">{problem}</p> : null}
      </section>
    );
  if (session.phase !== "Closing") return null;
  return (
    <section aria-label={t("Checkout")} className="table-checkout">
      <h3 id="table-checkout-title">
        {bill?.writeOff
          ? t("Written off")
          : bill?.settlement || (bill?.split && bill.split.paidParts === bill.split.parts.length)
            ? t("Paid")
            : t("Checkout")}
      </h3>
      {bill === null ? (
        problem ? null : (
          <p role="status">{t("Reading the bill…")}</p>
        )
      ) : (
        <>
          <ol className="table-checkout__rounds">
            {bill.rounds.map((round) => (
              <li key={round.roundNumber}>
                <span>{t("Round {number}", { number: String(round.roundNumber) })}</span>
                <span>{cad(round.totalMinor)}</span>
                <ul>
                  {round.items.map((item, index) => (
                    <li key={index}>
                      <span>
                        {item.displayName}
                        {item.reduction ? (
                          // WP-2423 item 8 ① segment 2: what a manager took off this dish.
                          <span className="table-checkout__comp">
                            {" · "}
                            {compedText(item.reduction.kind, item.reduction.percent)} −
                            {cad(item.reduction.amountMinor)}
                          </span>
                        ) : null}
                      </span>
                      <span>{cad(item.subtotalMinor)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {bill.writeOff === null && bill.onlinePayment?.status === "InProgress" ? (
            // DEC-DINE-IN-PAY-LATER S4: a guest is paying on their phone; nothing else is taken.
            <div className="table-checkout__phone-payment" role="status">
              <p>
                {t("A guest is paying the whole table on their phone: {amount}.", {
                  amount: cad(bill.onlinePayment.totalMinor),
                })}
              </p>
              <p>
                {t(
                  "If the guest gave up, stop the phone payment to take it here. A payment they did finish is kept.",
                )}
              </p>
              <button type="button" disabled={busy || locked} onClick={() => void stopPhone()}>
                {busy ? t("Checking…") : t("Stop the phone payment")}
              </button>
            </div>
          ) : bill.writeOff !== null ? (
            // DEC-DINE-IN-PAY-LATER (rule 14): the guests left without paying; nothing to take.
            <div className="table-checkout__written-off" role="status">
              <p>
                {t(
                  "The guests left without paying. A manager wrote off {amount}; it stays in the day's sales.",
                  { amount: cad(bill.writeOff.amountMinor) },
                )}
              </p>
              <p>{t("Close the table when it has been cleared.")}</p>
            </div>
          ) : bill.settlement === null ? (
            <>
              <TableSplitControls
                bill={bill}
                csrf={csrf}
                client={client}
                disabled={busy || locked}
                selectedPart={part}
                onSelectPart={(value) => {
                  setPart(value);
                  setTip(null);
                  setReceived("");
                  setReviewing(false);
                }}
                onBill={setBill}
                onProblem={setProblem}
              />
              {bill.split !== null && selected === null ? null : (
                <>
                  {selected ? (
                    <h4 className="table-checkout__part-title">
                      {t("Collect part {number} of {count}", {
                        number: String(selected.partNumber),
                        count: String(bill.split?.parts.length ?? 0),
                      })}
                    </h4>
                  ) : null}
                  <dl className="table-checkout__totals">
                    <div>
                      <dt>{t("Subtotal")}</dt>
                      <dd>{cad(selected ? selected.subtotalMinor : bill.owed.subtotalMinor)}</dd>
                    </div>
                    <div>
                      <dt>{t("Tax")}</dt>
                      <dd>{cad(selected ? selected.taxMinor : bill.owed.taxMinor)}</dd>
                    </div>
                    <div>
                      <dt>{selected ? t("This part with tax") : t("Total with tax")}</dt>
                      <dd>{cad(selected ? selected.amountMinor : bill.owed.totalMinor)}</dd>
                    </div>
                  </dl>
                  {!bill.consistent ? (
                    <p role="alert">
                      {t(
                        "A round is still being sent or was just changed. Wait a moment and read the bill again.",
                      )}{" "}
                      <button type="button" onClick={() => setReload((value) => value + 1)}>
                        {t("Read the bill again")}
                      </button>
                    </p>
                  ) : null}
                  {tipOptions.length === 0 ? null : (
                    <fieldset className="table-checkout__tip" disabled={busy || locked}>
                      <legend>{t("Tip")}</legend>
                      {tipOptions.map((value) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name="table-tip"
                            checked={chosenTip === value}
                            onChange={() => setTip(value)}
                          />
                          {value === "0"
                            ? t("No tip")
                            : `${value}% · ${cad((subtotal * BigInt(value) + 50n) / 100n)}`}
                        </label>
                      ))}
                      <label>
                        <input
                          type="radio"
                          name="table-tip"
                          checked={chosenTip === "Other"}
                          onChange={() => setTip("Other")}
                        />
                        {t("Other amount")}
                      </label>
                      {chosenTip === "Other" ? (
                        <input
                          aria-label={t("Tip amount")}
                          inputMode="decimal"
                          value={otherTip}
                          aria-invalid={dollarsToMinor(otherTip) === null}
                          onChange={(event) => setOtherTip(event.currentTarget.value)}
                        />
                      ) : null}
                    </fieldset>
                  )}
                  <fieldset className="table-checkout__method" disabled={busy || locked}>
                    <legend>{t("How the table pays")}</legend>
                    <label>
                      <input
                        type="radio"
                        name="table-method"
                        checked={method === "CardMachine"}
                        onChange={() => setMethod("CardMachine")}
                      />
                      {t("Card machine")}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="table-method"
                        checked={method === "Cash"}
                        onChange={() => setMethod("Cash")}
                      />
                      {t("Cash")}
                    </label>
                  </fieldset>
                  {method === "CardMachine" ? (
                    <label className="table-checkout__field">
                      {t("Slip reference (optional)")}
                      <input
                        value={slip}
                        maxLength={40}
                        autoComplete="off"
                        aria-invalid={!slipValid}
                        onChange={(event) => setSlip(event.currentTarget.value)}
                      />
                      <small>
                        {t(
                          "The approval or reference code on the card machine slip. Never the card number.",
                        )}
                      </small>
                    </label>
                  ) : (
                    <>
                      <p className="table-checkout__cash-due">
                        {cashDue === null
                          ? null
                          : t("Cash total {amount} (rounded to 5 cents)", { amount: cad(cashDue) })}
                      </p>
                      <label className="table-checkout__field">
                        {t("Cash received")}
                        <input
                          inputMode="decimal"
                          value={received}
                          aria-invalid={received !== "" && receivedMinor === null}
                          onChange={(event) => setReceived(event.currentTarget.value)}
                        />
                      </label>
                      {change !== null ? (
                        <p className="table-checkout__change" aria-live="polite">
                          {change >= 0n
                            ? t("Change {amount}", { amount: cad(change) })
                            : t("{amount} short", { amount: cad(-change) })}
                        </p>
                      ) : null}
                    </>
                  )}
                  <fieldset className="table-checkout__paper" disabled={busy || locked}>
                    <legend>{t("Paper payment")}</legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={paper}
                        onChange={(event) => setPaper(event.currentTarget.checked)}
                      />
                      {t("Paid while the system was down (enter it from paper now)")}
                    </label>
                    {paper ? (
                      <label className="table-checkout__field">
                        {t("Paid at (store time)")}
                        <input
                          type="datetime-local"
                          value={paidAt}
                          aria-invalid={paperInstant === null}
                          onChange={(event) => setPaidAt(event.currentTarget.value)}
                        />
                        <small>
                          {t("Within the last 3 days. It counts on the day it was paid.")}
                        </small>
                      </label>
                    ) : null}
                  </fieldset>
                  {reviewing && canPay && due !== null && tipMinor !== null ? (
                    // Money is confirmed (Owner decision 2): the amounts once more, then record.
                    <div
                      role="alertdialog"
                      aria-labelledby="table-checkout-confirm"
                      className="table-checkout__confirm"
                    >
                      <h4 id="table-checkout-confirm">{t("Confirm the payment")}</h4>
                      <dl className="table-checkout__totals">
                        <div>
                          <dt>{t("Table {table}", { table: table.stableLabel })}</dt>
                          <dd>{method === "Cash" ? t("Cash") : t("Card machine")}</dd>
                        </div>
                        <div>
                          <dt>{t("Bill")}</dt>
                          <dd>{cad(owed)}</dd>
                        </div>
                        <div>
                          <dt>{t("Tip")}</dt>
                          <dd>{cad(tipMinor)}</dd>
                        </div>
                        {method === "Cash" && cashDue !== null && change !== null ? (
                          <>
                            <div className="table-checkout__total">
                              <dt>{t("Cash due (rounded to 5 cents)")}</dt>
                              <dd>{cad(cashDue)}</dd>
                            </div>
                            <div>
                              <dt>{t("Cash received")}</dt>
                              <dd>{cad(receivedMinor ?? 0n)}</dd>
                            </div>
                            <div className="table-checkout__total">
                              <dt>{t("Change to give")}</dt>
                              <dd>{cad(change)}</dd>
                            </div>
                          </>
                        ) : (
                          <div className="table-checkout__total">
                            <dt>{t("Charged on the card machine")}</dt>
                            <dd>{cad(due)}</dd>
                          </div>
                        )}
                      </dl>
                      <p>
                        {method === "Cash"
                          ? t("Count the cash first. Once recorded, only a manager can refund it.")
                          : t(
                              "Check the card machine shows Approved first. Once recorded, only a manager can refund it.",
                            )}
                      </p>
                      <div className="table-checkout__confirm-actions">
                        <button type="button" onClick={() => setReviewing(false)}>
                          {t("Back")}
                        </button>
                        <button
                          type="button"
                          className="table-checkout__primary"
                          disabled={!canPay}
                          onClick={() => void pay()}
                        >
                          {method === "Cash"
                            ? t("Confirm {amount} cash received", { amount: cad(cashDue ?? due) })
                            : t("Confirm {amount} paid", { amount: cad(due) })}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="table-checkout__primary"
                      disabled={!canPay}
                      onClick={() => setReviewing(true)}
                    >
                      {busy
                        ? t("Recording…")
                        : chosenTip === null
                          ? t("Choose a tip to take payment")
                          : due === null
                            ? t("Record payment")
                            : method === "Cash"
                              ? t("Cash received · {amount}", { amount: cad(cashDue ?? due) })
                              : t("Paid on card machine · {amount}", { amount: cad(due) })}
                    </button>
                  )}
                </>
              )}
              {/* v15 2026-10-28 b: only while something is unpaid — for a split bill, the parts
                  still unpaid, and it says so. */}
              {canWriteOff &&
              (bill.split === null || bill.split.paidParts < bill.split.parts.length) ? (
                leaving ? (
                  <div
                    role="group"
                    aria-label={t("Guests left without paying")}
                    className="table-checkout__leaving"
                  >
                    <p>
                      {bill.split !== null && bill.split.paidParts > 0
                        ? t(
                            "Record that the guests at table {table} left without paying the {count} parts still unpaid ({amount})? The parts already paid stay paid. A manager decides this. It stays in the reports as written off.",
                            {
                              table: table.stableLabel,
                              count: String(bill.split.parts.length - bill.split.paidParts),
                              amount: cad(bill.owed.totalMinor),
                            },
                          )
                        : t(
                            "Record that the guests at table {table} left without paying {amount}? A manager decides this. It stays in the reports as written off.",
                            {
                              table: table.stableLabel,
                              amount: cad(bill.owed.totalMinor),
                            },
                          )}
                    </p>
                    <button
                      type="button"
                      disabled={busy || locked}
                      onClick={() => void leftWithoutPaying()}
                    >
                      {t("Yes, they left without paying")}
                    </button>{" "}
                    <button type="button" disabled={busy} onClick={() => setLeaving(false)}>
                      {t("Cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="table-checkout__secondary"
                    disabled={busy || locked || BigInt(bill.owed.totalMinor) === 0n}
                    onClick={() => setLeaving(true)}
                  >
                    {bill.split !== null && bill.split.paidParts > 0
                      ? t("Guests left without paying the rest")
                      : t("Guests left without paying")}
                  </button>
                )
              ) : null}
            </>
          ) : (
            <TableReceipt bill={bill} tableLabel={table.stableLabel} />
          )}
        </>
      )}
      {canStart &&
      bill !== null &&
      bill.settlement === null &&
      bill.writeOff === null &&
      bill.onlinePayment?.status !== "InProgress" &&
      // v15 2026-10-28: a split table that paid (or is paying) a part can't go back either; the
      // server refuses it too.
      (bill.split === null ||
        (bill.split.paidParts === 0 && !bill.split.parts.some((part) => part.guestPaying))) ? (
        // DEC-DINE-IN-PAY-LATER (rule 3): the guests want to order more — back to ordering.
        <p className="table-checkout__cancel">
          <button type="button" disabled={busy || locked} onClick={() => void cancelCheckout()}>
            {t("Cancel checkout")}
          </button>{" "}
          <small>{t("The table can order again; checkout is started again later.")}</small>
        </p>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}

/**
 * DEC-DINE-IN-PAY-LATER rule 5: one receipt for the whole table — every round's dishes, tax, tip,
 * cash rounding, total and how it was paid — never split by round.
 */
function TableReceipt({
  bill,
  tableLabel,
}: {
  readonly bill: TableBill;
  readonly tableLabel: string;
}) {
  const paid = bill.settlement;
  if (paid === null) return null;
  const subtotal = bill.rounds.reduce((sum, round) => sum + BigInt(round.subtotalMinor), 0n);
  const tax = bill.rounds.reduce((sum, round) => sum + BigInt(round.taxMinor), 0n);
  return (
    <div
      className="table-receipt"
      aria-label={t("Receipt for table {table}", { table: tableLabel })}
    >
      <dl className="table-checkout__totals">
        <div>
          <dt>{t("Subtotal")}</dt>
          <dd>{cad(subtotal)}</dd>
        </div>
        <div>
          <dt>{t("Tax")}</dt>
          <dd>{cad(tax)}</dd>
        </div>
        <div>
          <dt>{t("Tip")}</dt>
          <dd>{cad(paid.tipMinor)}</dd>
        </div>
        {paid.roundingMinor !== "0" ? (
          <div>
            <dt>{t("Cash rounding")}</dt>
            <dd>{cad(paid.roundingMinor)}</dd>
          </div>
        ) : null}
        <div className="table-checkout__total">
          <dt>{t("Total paid")}</dt>
          <dd>{cad(paid.totalMinor)}</dd>
        </div>
        <div>
          <dt>{t("Paid by")}</dt>
          <dd>
            {paid.method === "Cash"
              ? t("Cash")
              : paid.method === "Online"
                ? t("Guest's phone")
                : t("Card machine")}
          </dd>
        </div>
        {paid.tenderedMinor !== null ? (
          <div>
            <dt>{t("Cash received")}</dt>
            <dd>{cad(paid.tenderedMinor)}</dd>
          </div>
        ) : null}
        {paid.changeMinor !== null ? (
          <div>
            <dt>{t("Change")}</dt>
            <dd>{cad(paid.changeMinor)}</dd>
          </div>
        ) : null}
      </dl>
      <p role="status">{t("Paid in full. Close the table when the guests have left.")}</p>
      <button type="button" onClick={() => window.print()}>
        {t("Print receipt")}
      </button>
    </div>
  );
}
