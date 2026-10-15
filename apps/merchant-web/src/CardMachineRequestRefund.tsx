import { useContext, useRef, useState } from "react";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { needsFullSignIn } from "./full-sign-in.js";
import { createOrdinaryRefundClient, OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { paidAtInstant } from "./StaffOrderEntryPage.js";
import { StoreTimeZoneContext, storeTime } from "./StoreTime.js";

const defaultClient = createOrdinaryRefundClient();
type Outcome = "Idle" | "Pending" | "Conflict" | "Denied" | "SignIn" | "Unknown";
type Recorded = Awaited<
  ReturnType<ReturnType<typeof createOrdinaryRefundClient>["recordCardMachineRefund"]>
>;

/** WP-2423 item 4: the confirmation staff see once the machine refund is recorded. */
export function cardMachineRefundRecordedText(
  result: Pick<Recorded, "amountMinor" | "refundedAt" | "receipt">,
  amountLabel: string,
  requestedMinor: string,
  /** The Store's time zone (UTC, labelled, when not known). */
  timeZone: string | undefined,
): string {
  const amount =
    result.amountMinor === requestedMinor
      ? amountLabel
      : orderMoney({ amountMinor: result.amountMinor, currencyCode: "CAD" });
  return (
    `Card-machine refund recorded: ${amount} refunded on the card machine at ${storeTime(result.refundedAt, timeZone, true)}.` +
    (result.receipt === "Issued"
      ? " The customer's digital receipt now shows the refund."
      : result.receipt === "NotIssued"
        ? " The digital receipt could not be updated yet; record it again later to retry (the refund is not counted twice)."
        : " The card machine's refund slip is the customer's receipt.")
  );
}

/**
 * WP-2423 item 4 (DEC-COUNTER-PAYMENT-RECORD, partial refunds): a recorded refund request of a
 * payment taken on the store's own card machine. Staff refund that exact amount on the machine
 * (to the card the customer paid with), then record it here with the slip reference. The amount is
 * the request's (server-calculated); a refund made earlier while the system was unreachable keeps
 * the time it was made. Retrying after an unknown result reuses the same operation.
 */
export function CardMachineRequestRefund({
  orderReference,
  requestReference,
  amountMinor,
  amountLabel,
  csrf,
  onRecorded,
  client = defaultClient,
}: {
  readonly orderReference: string;
  readonly requestReference: string;
  readonly amountMinor: string;
  /** The amount as the page around it writes it (one money style per page). */
  readonly amountLabel?: string;
  readonly csrf: string;
  /** Called with the confirmation once recorded; the page then rereads the request. */
  readonly onRecorded: (confirmation: string) => void;
  readonly client?: ReturnType<typeof createOrdinaryRefundClient>;
}) {
  const timeZone = useContext(StoreTimeZoneContext);
  const operation = useRef<string | null>(null);
  const [slip, setSlip] = useState("");
  const [earlier, setEarlier] = useState(false);
  const [madeAt, setMadeAt] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const [done, setDone] = useState<string | null>(null);
  const amount = amountLabel ?? orderMoney({ amountMinor, currencyCode: "CAD" });
  const madeAtInstant = earlier ? paidAtInstant(madeAt, Date.now(), timeZone) : null;
  const ready =
    outcome !== "Pending" &&
    validSlipReference(slip.trim()) &&
    (!earlier || madeAtInstant !== null);
  const id = "card-request-refund-" + requestReference;
  const submit = async () => {
    if (!ready) return;
    operation.current ??= serviceOperationReference();
    setOutcome("Pending");
    try {
      const result = await client.recordCardMachineRefund(
        {
          operationReference: operation.current,
          orderReference,
          requestReference,
          slipReference: slip.trim() === "" ? null : slip.trim(),
          refundedAt: earlier ? madeAtInstant : null,
        },
        csrf,
      );
      operation.current = null;
      setOutcome("Idle");
      const confirmation = cardMachineRefundRecordedText(result, amount, amountMinor, timeZone);
      setDone(confirmation);
      onRecorded(confirmation);
    } catch (error) {
      if (needsFullSignIn(error)) setOutcome("SignIn");
      else if (error instanceof OrdinaryRefundClientError && error.code === "Conflict") {
        operation.current = null;
        setOutcome("Conflict");
      } else if (error instanceof OrdinaryRefundClientError && error.code === "Denied") {
        operation.current = null;
        setOutcome("Denied");
      } else setOutcome("Unknown");
    }
  };
  if (done !== null) return <p role="status">{done}</p>;
  return (
    <div className="card-machine-request-refund">
      <form
        aria-labelledby={id + "-title"}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p id={id + "-title"}>
          Refund {amount} on the store&apos;s card machine to the card the customer paid with, then
          record it here.
        </p>
        <label>
          Slip reference (optional)
          <input
            value={slip}
            maxLength={40}
            autoComplete="off"
            aria-describedby={id + "-hint"}
            aria-invalid={!validSlipReference(slip.trim())}
            onChange={(event) => setSlip(event.currentTarget.value)}
          />
        </label>
        <p id={id + "-hint"} className="field-hint">
          The approval or reference code printed on the refund slip. Never the card number.
        </p>
        <label>
          <input
            type="checkbox"
            checked={earlier}
            onChange={(event) => {
              operation.current = null;
              setEarlier(event.currentTarget.checked);
            }}
          />
          Refunded earlier, while the system was unreachable
        </label>
        {earlier ? (
          <label>
            Refunded at (store time, from the slip)
            <input
              type="datetime-local"
              value={madeAt}
              aria-invalid={madeAtInstant === null}
              onChange={(event) => {
                operation.current = null;
                setMadeAt(event.currentTarget.value);
              }}
            />
          </label>
        ) : null}
        {earlier ? (
          <p className="field-hint">
            Within the last 3 days, after the refund was requested. It counts on the day it was
            made.
          </p>
        ) : null}
        {outcome === "Pending" ? <p role="status">Recording…</p> : null}
        {outcome === "Conflict" ? (
          <p role="alert">
            Not recorded: this refund needs an owner&apos;s approval first, or it was already
            recorded. Refresh the requests to see where it stands.
          </p>
        ) : null}
        {outcome === "Denied" ? (
          <p role="alert">
            Only a store manager or an owner can record this refund. Ask them to record it after the
            refund on the card machine.
          </p>
        ) : null}
        {outcome === "Unknown" ? (
          <p role="alert">
            Result unknown. Record it again; the same refund is never counted twice.
          </p>
        ) : null}
        <button type="submit" disabled={!ready}>
          {outcome === "Pending" ? "Recording…" : `Refunded ${amount} on card machine`}
        </button>
      </form>
      {/* Outside the form: the verification step has its own form. */}
      {outcome === "SignIn" ? <FullSignInPrompt csrf={csrf} /> : null}
    </div>
  );
}
