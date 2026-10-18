import { useEffect, useRef, useState } from "react";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { CounterOrderClientError, createCounterOrderClient } from "./staff-order-entry.js";
import { paidAtInstant, payErrorText } from "./counter-payment.js";

const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

/**
 * WP-2423 D5 (DEC-STAFF-DINE-IN-ROUND decision 4): a round staff entered for a table and not yet
 * paid can be recorded as paid on the card machine from Orders too — the order entry screen it was
 * sent from may be closed or on another device. Same server record as on that screen (the amount
 * is checked against the round's total, one record per round); the server then sends the round to
 * the kitchen. A paper round entered after an outage asks for the time it was actually paid.
 *
 * The Orders list (polled by every tablet) does not rebuild each unpaid round's amount; when it is
 * not given, the amount is read for this one order when staff open the form.
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
  readonly onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [slip, setSlip] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [amount, setAmount] = useState(amountDueMinor);
  const [reading, setReading] = useState<"Idle" | "Reading" | "Failed" | "NotDue">("Idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const operation = useRef<string | null>(null);
  const read = useRef<AbortController | null>(null);
  useEffect(() => () => read.current?.abort(), []);
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
            ? "Record card-machine payment"
            : `Record card-machine payment · ${cad(amount)}`}
        </button>
      </div>
    );
  if (amount === null)
    return (
      <div className="staff-round-payment" role="status">
        <p>
          {reading === "NotDue"
            ? "This round is no longer waiting for a card-machine payment. The order list will update."
            : reading === "Failed" || loadAmountDue === undefined
              ? "Couldn't read the amount to charge. Check the connection and try again."
              : "Reading the amount to charge…"}
        </p>
        <div className="card-actions">
          {reading === "Failed" ? (
            <button type="button" onClick={readAmount}>
              Try again
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
            {reading === "NotDue" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    );
  const record = async () => {
    if (busy || amount === null || !validSlipReference(slip.trim())) return;
    if (recordedAfterOutage && paperInstant === null) return;
    operation.current ??= serviceOperationReference();
    setBusy(true);
    setMessage(null);
    try {
      const result = await createCounterOrderClient(csrf, fetcher ?? fetch).recordPayment({
        operationReference: operation.current,
        orderReference,
        orderBatchReference,
        expectedTotalMinor: amount,
        slipReference: slip.trim() === "" ? null : slip.trim(),
        takenAt: recordedAfterOutage ? paperInstant : null,
      });
      setMessage(
        result.acceptance === "Accepted"
          ? "Paid and sent to the kitchen."
          : "Paid, but not sent to the kitchen yet. Accept it on this order now.",
      );
      onRecorded();
    } catch (error) {
      const failure =
        error instanceof CounterOrderClientError
          ? error
          : new CounterOrderClientError("Unavailable");
      if (failure.code !== "OutcomeUnknown") operation.current = null;
      if (failure.code === "AmountChanged" && failure.totalMinor !== null)
        setAmount(failure.totalMinor);
      setMessage(payErrorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="staff-round-payment"
      aria-label="Record card-machine payment"
      onSubmit={(event) => {
        event.preventDefault();
        void record();
      }}
    >
      <p>
        Charge {cad(amount)} on the card machine first, then record it here. The kitchen starts this
        round once it is recorded.
      </p>
      <label>
        Slip reference (optional)
        <input
          value={slip}
          maxLength={40}
          autoComplete="off"
          aria-invalid={!validSlipReference(slip.trim())}
          onChange={(event) => setSlip(event.currentTarget.value)}
        />
      </label>
      {recordedAfterOutage ? (
        <label>
          Paid at (store time)
          <input
            type="datetime-local"
            value={paidAt}
            onChange={(event) => setPaidAt(event.currentTarget.value)}
          />
        </label>
      ) : null}
      {message !== null ? <p role="status">{message}</p> : null}
      <div className="card-actions">
        <button
          type="submit"
          disabled={
            busy ||
            !validSlipReference(slip.trim()) ||
            (recordedAfterOutage && paperInstant === null)
          }
        >
          {busy ? "Recording…" : `Paid on card machine · ${cad(amount)}`}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
