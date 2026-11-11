import { t } from "./i18n/i18n.js";
import { useEffect, useId, useRef, useState } from "react";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { orderMoney } from "./order-money.js";
import { CashTenderFields, cashTender } from "./CashTenderFields.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  CounterOrderClientError,
  createCounterOrderClient,
  type RecordedCardPayment,
} from "./staff-order-entry.js";
import {
  paidAtDayNote,
  paidAtInstant,
  paidAtRefusal,
  paidNoteText,
  paperAlreadyRecordedText,
  paperPaymentProblem,
  payErrorText,
  paymentWindowNotice,
} from "./counter-payment.js";
import { cashTotalMinor } from "./table-checkout-client.js";

const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

/**
 * WP-2423 (v15 fabf0261 F3): what staff do first, a whole sentence for an order or a round (the
 * Chinese text never takes the English word for what is charged).
 */
export function chargeFirstText(
  amountMinor: string,
  subject: "round" | "order",
  paper = false,
): string {
  // WP-2423 M96: a paper order entered after an outage was already paid; it is recorded, never
  // charged a second time.
  if (paper)
    return t(
      "Already paid on paper. Enter what the slip or cash record shows, then record it. Don't charge again.",
    );
  return subject === "order"
    ? t(
        "Charge {amount} on the card machine first, then record it here. The kitchen starts this order once it is recorded.",
        { amount: cad(amountMinor) },
      )
    : t(
        "Charge {amount} on the card machine first, then record it here. The kitchen starts this round once it is recorded.",
        { amount: cad(amountMinor) },
      );
}

/**
 * WP-2423 D5 (DEC-STAFF-DINE-IN-ROUND decision 4): a round staff entered for a table and not yet
 * paid can be recorded as paid on the card machine from Orders too — the order entry screen it was
 * sent from may be closed or on another device. Same server record as on that screen (the amount
 * is checked against the round's total, one record per round); the server then sends the round to
 * the kitchen. A paper round entered after an outage asks for the time it was actually paid.
 *
 * The Orders list (polled by every tablet) does not rebuild each unpaid round's amount; when it is
 * not given, the amount is read for this one order when staff open the form.
 *
 * WP-2423 (v15 751dd768): a counter pickup order sent and not paid yet is charged the same way, from
 * Orders and from the Counter order page after a reload (`subject` "order"), with the time left
 * before it is released shown in the form.
 */
export function StaffRoundPaymentAction({
  csrf,
  fetcher,
  orderReference,
  orderBatchReference,
  amountDueMinor,
  loadAmountDue,
  recordedAfterOutage,
  timeZone,
  onRecorded,
  subject = "round",
  payBy = null,
  label,
}: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  /** What to charge, or null when it is read on opening (`loadAmountDue`). */
  readonly amountDueMinor: string | null;
  /** Reads what to charge now; null when the round no longer waits for this payment. */
  readonly loadAmountDue?: ((signal: AbortSignal) => Promise<string | null>) | undefined;
  readonly recordedAfterOutage: boolean;
  readonly timeZone?: string | undefined;
  /** The recorded payment, or nothing when the order no longer waits for one. */
  readonly onRecorded: (recorded?: RecordedCardPayment) => void;
  /** What staff are charging for: a table round (default) or a counter order. */
  readonly subject?: "round" | "order";
  /** When it is released or cancelled if not recorded (warned in the form), when known. */
  readonly payBy?: string | null;
  /** The button text before the amount (default "Record card-machine payment"). */
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [slip, setSlip] = useState("");
  // WP-2423 M52: a counter order (not a table round) may be paid in cash, by the table's rules.
  const [tender, setTender] = useState<"CardMachine" | "Cash">("CardMachine");
  const [received, setReceived] = useState("");
  const [largeChangeConfirmed, setLargeChangeConfirmed] = useState(false);
  // WP-2423 M52: a cash Record that got no answer keeps the cash received as sent until it is
  // answered, so recording again is the same payment (never a new one the server calls paid).
  const [cashUnanswered, setCashUnanswered] = useState(false);
  const [paidAt, setPaidAt] = useState("");
  const [amount, setAmount] = useState(amountDueMinor);
  const [reading, setReading] = useState<"Idle" | "Reading" | "Failed" | "NotDue">("Idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // WP-2423 (v15 fabf0261): the server refused the paid-at itself; staff correct it in its field.
  const [paidAtRefused, setPaidAtRefused] = useState(false);
  const [focusPaidAt, setFocusPaidAt] = useState(0);
  const paidAtInput = useRef<HTMLInputElement>(null);
  const refusalId = useId();
  // One operation per payment as staff entered it (as at table checkout): a retry after no answer
  // with the same details is the same command (never counted twice), and a corrected paid-at or
  // slip is a new one rather than a conflict with the first.
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const read = useRef<AbortController | null>(null);
  useEffect(() => () => read.current?.abort(), []);
  useEffect(() => {
    if (focusPaidAt === 0) return;
    paidAtInput.current?.focus();
    paidAtInput.current?.select?.();
  }, [focusPaidAt]);
  const paperInstant = recordedAfterOutage ? paidAtInstant(paidAt, Date.now(), timeZone) : null;
  const readAmount = () => {
    if (loadAmountDue === undefined) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setReading("Reading");
    loadAmountDue(controller.signal)
      .then((due) => {
        if (controller.signal.aborted) return;
        if (due === null) setReading("NotDue");
        else {
          setAmount(due);
          setReading("Idle");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setReading("Failed");
      });
  };
  if (!open)
    return (
      <div className="card-actions">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (amount === null) readAmount();
          }}
        >
          {amount === null
            ? (label ?? t("Record card-machine payment"))
            : `${label ?? t("Record card-machine payment")} · ${cad(amount)}`}
        </button>
      </div>
    );
  if (amount === null)
    return (
      <div className="staff-round-payment" role="status">
        <p>
          {reading === "NotDue"
            ? recordedAfterOutage
              ? // DEC-PAPER-ORDER-PAID-AT-SEND: a paper order is recorded or taken off, never charged.
                t(
                  "This paper order's payment is no longer waiting to be recorded (already recorded, or it was entered again). The list will update.",
                )
              : subject === "order"
                ? t(
                    "This order is no longer waiting for a card-machine payment (paid or released). The list will update.",
                  )
                : t(
                    "This round is no longer waiting for a card-machine payment. The order list will update.",
                  )
            : reading === "Failed" || loadAmountDue === undefined
              ? t("Couldn't read the amount to charge. Try again.")
              : t("Reading the amount to charge…")}
        </p>
        <div className="card-actions">
          {reading === "Failed" ? (
            <button type="button" onClick={readAmount}>
              {t("Try again")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              read.current?.abort();
              setReading("Idle");
              setOpen(false);
              if (reading === "NotDue") onRecorded();
            }}
          >
            {reading === "NotDue" ? t("Close") : t("Cancel")}
          </button>
        </div>
      </div>
    );
  const inCash = subject === "order" && tender === "Cash";
  // DEC-PAPER-ORDER-PAID-AT-SEND decision 2: a paper order's cash was taken, and its change given,
  // during the outage. Its cash total is what is recorded (no cash received to type, no change),
  // the same as when it is recorded with the send or on the counter's own step.
  const paperCash = inCash && recordedAfterOutage;
  const cash =
    inCash && !paperCash ? cashTender(BigInt(amount), received, largeChangeConfirmed) : null;
  const paperCashMinor = paperCash ? cashTotalMinor(BigInt(amount)).toString() : null;
  const ready =
    (cash !== null ? cash.ready : paperCash || validSlipReference(slip.trim())) &&
    (!recordedAfterOutage || paperInstant !== null);
  const record = async () => {
    if (busy || amount === null || !ready) return;
    const tenderedMinor = paperCashMinor ?? cash?.receivedMinor?.toString() ?? null;
    const intent = JSON.stringify([
      orderBatchReference,
      amount,
      inCash ? "" : slip.trim(),
      paperInstant,
      tenderedMinor,
    ]);
    if (operation.current?.key !== intent)
      operation.current = { key: intent, reference: serviceOperationReference() };
    setBusy(true);
    setMessage(null);
    setPaidAtRefused(false);
    try {
      const result = await createCounterOrderClient(csrf, fetcher ?? fetch).recordPayment({
        operationReference: operation.current.reference,
        orderReference,
        orderBatchReference,
        expectedTotalMinor: amount,
        slipReference: inCash || slip.trim() === "" ? null : slip.trim(),
        takenAt: recordedAfterOutage ? paperInstant : null,
        ...(tenderedMinor === null ? {} : { tenderedMinor }),
      });
      setMessage(
        result.cash !== null || recordedAfterOutage
          ? paidNoteText({
              tableMode: subject === "round",
              recordedAfterOutage,
              acceptance: result.acceptance,
              cash: result.cash,
            })
          : result.acceptance === "Accepted"
            ? t("Paid and sent to the kitchen.")
            : t("Paid, but not sent to the kitchen yet. Accept it on this order now."),
      );
      setCashUnanswered(false);
      onRecorded(result);
    } catch (error) {
      const failure =
        error instanceof CounterOrderClientError
          ? error
          : new CounterOrderClientError("Unavailable");
      if (failure.code !== "OutcomeUnknown") operation.current = null;
      setCashUnanswered(cash !== null && failure.code === "OutcomeUnknown");
      if (failure.code === "AmountChanged" && failure.totalMinor !== null)
        setAmount(failure.totalMinor);
      if (recordedAfterOutage && failure.code === "AlreadyPaid") {
        // A paper order's payment already recorded (another tablet, or an earlier try): the sale
        // is in the day's takings, so staff are never sent to think about charging.
        setMessage(paperAlreadyRecordedText());
        onRecorded();
        return;
      }
      // A cash Record with no answer says so beside the cash received it keeps.
      setMessage(
        recordedAfterOutage
          ? paperPaymentProblem(failure, inCash)
          : cash !== null && failure.code === "OutcomeUnknown"
            ? null
            : payErrorText(failure, inCash),
      );
      if (recordedAfterOutage && paidAtRefusal(failure)) {
        setPaidAtRefused(true);
        setFocusPaidAt((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="staff-round-payment"
      aria-label={
        recordedAfterOutage
          ? t("Record the paper order's payment")
          : t("Record card-machine payment")
      }
      onSubmit={(event) => {
        event.preventDefault();
        void record();
      }}
    >
      <p>
        {cash !== null && !recordedAfterOutage
          ? t(
              "Take {amount} in cash (rounded to 5 cents), count it, then record it here. The kitchen starts this order once it is recorded.",
              { amount: cad(cash.cashDueMinor.toString()) },
            )
          : chargeFirstText(amount, subject, recordedAfterOutage)}
      </p>
      {payBy !== null
        ? (() => {
            const notice = paymentWindowNotice({
              payBy,
              now: Date.now(),
              tableMode: subject === "round",
              timeZone,
              paper: recordedAfterOutage,
            });
            return (
              <p
                className="order-accept-by"
                data-tier={notice.tier}
                role={notice.tier === "urgent" ? "alert" : "note"}
              >
                {notice.text}
              </p>
            );
          })()
        : null}
      {subject === "order" ? (
        <fieldset className="counter-order__tender" disabled={busy || cashUnanswered}>
          <legend>
            {recordedAfterOutage ? t("How it was paid during the outage") : t("How the guest pays")}
          </legend>
          <label>
            <input
              type="radio"
              name={"tender-" + orderBatchReference}
              checked={tender === "CardMachine"}
              onChange={() => setTender("CardMachine")}
            />
            {t("Card machine")}
          </label>
          <label>
            <input
              type="radio"
              name={"tender-" + orderBatchReference}
              checked={tender === "Cash"}
              onChange={() => setTender("Cash")}
            />
            {t("Cash")}
          </label>
        </fieldset>
      ) : null}
      {paperCashMinor !== null ? (
        <p className="field-hint">
          {t("Paid in cash during the outage: {amount}. Its change was given then.", {
            amount: cad(paperCashMinor),
          })}
        </p>
      ) : cash !== null ? (
        <CashTenderFields
          idPrefix={"cash-" + orderBatchReference}
          dueMinor={BigInt(amount)}
          received={received}
          onReceived={(value) => {
            setReceived(value);
            setMessage(null);
          }}
          largeChangeConfirmed={largeChangeConfirmed}
          onLargeChangeConfirmed={setLargeChangeConfirmed}
          unanswered={cashUnanswered}
          disabled={busy}
        />
      ) : (
        <label>
          {t("Slip reference (optional)")}
          <input
            value={slip}
            maxLength={40}
            autoComplete="off"
            aria-invalid={!validSlipReference(slip.trim())}
            onChange={(event) => setSlip(event.currentTarget.value)}
          />
        </label>
      )}
      {recordedAfterOutage ? (
        <>
          <label>
            {t("Paid at (store time)")}
            <input
              ref={paidAtInput}
              type="datetime-local"
              value={paidAt}
              aria-invalid={paperInstant === null || paidAtRefused}
              aria-describedby={paidAtRefused ? refusalId : undefined}
              onChange={(event) => {
                setPaidAt(event.currentTarget.value);
                if (paidAtRefused) {
                  setPaidAtRefused(false);
                  setMessage(null);
                }
              }}
            />
          </label>
          {paidAtRefused && message !== null ? (
            <p id={refusalId} role="alert">
              {message}
            </p>
          ) : null}
          {paidAtDayNote(paperInstant, Date.now(), timeZone) !== null ? (
            <p className="order-accept-by" data-tier="warning" role="note">
              {paidAtDayNote(paperInstant, Date.now(), timeZone)}
            </p>
          ) : null}
        </>
      ) : null}
      {message !== null && !paidAtRefused ? <p role="status">{message}</p> : null}
      <div className="card-actions">
        <button type="submit" disabled={busy || !ready}>
          {busy
            ? t("Recording…")
            : recordedAfterOutage
              ? t("Record paper payment · {amount}", { amount: cad(paperCashMinor ?? amount) })
              : cash !== null
                ? t("Cash received · {amount}", { amount: cad(cash.cashDueMinor.toString()) })
                : t("Paid on card machine · {amount}", { amount: cad(amount) })}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
