import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { createDiningSessionCloseClient } from "./dining-session-close-client.js";
import { createDiningProgressClient } from "./dining-progress-client.js";
import {
  cashTotalMinor,
  createTableCheckoutClient,
  TableCheckoutError,
  type TableBill,
} from "./table-checkout-client.js";
import type { StaffDiningTable, StaffDiningTableSession } from "./dining-session-client.js";

const cad = (minor: string | bigint) =>
  orderMoney({ amountMinor: String(minor), currencyCode: "CAD" });
type Tip = "0" | "10" | "15" | "18" | "Other";
/** "12.50" → 1250; null when it isn't an amount of money. */
export function dollarsToMinor(value: string): bigint | null {
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,2}))?$/u.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1] as string) * 100n + BigInt((match[2] ?? "0").padEnd(2, "0"));
}

function errorText(error: unknown): string {
  const code = error instanceof TableCheckoutError ? error.code : "OutcomeUnknown";
  switch (code) {
    case "PermissionDenied":
      return t("Your access doesn't allow this. Ask an Owner or Store Manager.");
    case "NotStarted":
      return t("Start checkout first, so no more rounds are sent from this table.");
    case "NothingOwed":
      return t("This table owes nothing.");
    case "BillChanged":
      return t(
        "The bill changed (a round is still being sent, or something was changed). It has been read again: check it and try again.",
      );
    case "TenderShort":
      return t("The cash received is less than the cash total.");
    case "AlreadyPaid":
      return t("This table has already paid.");
    case "NotReady":
      return t("Every dish must be served or cancelled first.");
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
  onChanged,
  fetcher,
}: {
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
  const [tip, setTip] = useState<Tip>("0");
  const [otherTip, setOtherTip] = useState("");
  const [method, setMethod] = useState<"CardMachine" | "Cash">("CardMachine");
  const [slip, setSlip] = useState("");
  const [received, setReceived] = useState("");
  const [leaving, setLeaving] = useState(false);
  // One operation per intent: a lost answer is resent with the same one.
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const beginOperation = useRef<string | null>(null);

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

  const subtotal = bill ? BigInt(bill.owed.subtotalMinor) : 0n;
  const owed = bill ? BigInt(bill.owed.totalMinor) : 0n;
  const tipMinor =
    tip === "Other" ? dollarsToMinor(otherTip) : (subtotal * BigInt(tip) + 50n) / 100n;
  const due = tipMinor === null ? null : owed + tipMinor;
  const cashDue = due === null ? null : cashTotalMinor(due);
  const receivedMinor = dollarsToMinor(received);
  const change = cashDue !== null && receivedMinor !== null ? receivedMinor - cashDue : null;
  const slipValid = slip.trim() === "" || /^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(slip.trim());
  const canPay =
    bill !== null &&
    bill.settlement === null &&
    bill.consistent &&
    owed > 0n &&
    due !== null &&
    !busy &&
    !locked &&
    (method === "CardMachine" ? slipValid : change !== null && change >= 0n);

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

  const pay = async () => {
    if (!canPay || bill === null || tipMinor === null) return;
    const intent = JSON.stringify([method, tip, tipMinor.toString(), received, slip.trim()]);
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
          tip === "0"
            ? { kind: "None" }
            : tip === "Other"
              ? { kind: "Amount", amountMinor: tipMinor.toString() }
              : { kind: "Percent", percent: Number(tip) as 10 | 15 | 18 },
        tenderedMinor: method === "Cash" ? String(receivedMinor) : null,
        slipReference: method === "CardMachine" && slip.trim() !== "" ? slip.trim() : null,
      });
      operation.current = null;
      setBill(result.bill);
      onChanged();
    } catch (error) {
      if (!(error instanceof TableCheckoutError) || error.code !== "OutcomeUnknown")
        operation.current = null;
      setProblem(errorText(error));
      if (error instanceof TableCheckoutError && error.code === "BillChanged")
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
      <h3 id="table-checkout-title">{bill?.settlement ? t("Paid") : t("Checkout")}</h3>
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
                      <span>{item.displayName}</span>
                      <span>{cad(item.subtotalMinor)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {bill.settlement === null ? (
            <>
              <dl className="table-checkout__totals">
                <div>
                  <dt>{t("Subtotal")}</dt>
                  <dd>{cad(bill.owed.subtotalMinor)}</dd>
                </div>
                <div>
                  <dt>{t("Tax")}</dt>
                  <dd>{cad(bill.owed.taxMinor)}</dd>
                </div>
                <div>
                  <dt>{t("Total with tax")}</dt>
                  <dd>{cad(bill.owed.totalMinor)}</dd>
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
              <fieldset className="table-checkout__tip" disabled={busy || locked}>
                <legend>{t("Tip")}</legend>
                {(["0", "10", "15", "18"] as const).map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="table-tip"
                      checked={tip === value}
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
                    checked={tip === "Other"}
                    onChange={() => setTip("Other")}
                  />
                  {t("Other amount")}
                </label>
                {tip === "Other" ? (
                  <input
                    aria-label={t("Tip amount")}
                    inputMode="decimal"
                    value={otherTip}
                    aria-invalid={dollarsToMinor(otherTip) === null}
                    onChange={(event) => setOtherTip(event.currentTarget.value)}
                  />
                ) : null}
              </fieldset>
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
              <button
                type="button"
                className="table-checkout__primary"
                disabled={!canPay}
                onClick={() => void pay()}
              >
                {busy
                  ? t("Recording…")
                  : due === null
                    ? t("Record payment")
                    : method === "Cash"
                      ? t("Cash received · {amount}", { amount: cad(cashDue ?? due) })
                      : t("Paid on card machine · {amount}", { amount: cad(due) })}
              </button>
              {canStart ? (
                leaving ? (
                  <div
                    role="group"
                    aria-label={t("Guests left without paying")}
                    className="table-checkout__leaving"
                  >
                    <p>
                      {t(
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
                    disabled={busy || locked || owed === 0n}
                    onClick={() => setLeaving(true)}
                  >
                    {t("Guests left without paying")}
                  </button>
                )
              ) : null}
            </>
          ) : (
            <TableReceipt bill={bill} tableLabel={table.stableLabel} />
          )}
        </>
      )}
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
          <dd>{paid.method === "Cash" ? t("Cash") : t("Card machine")}</dd>
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
