import { useContext, useRef, useState } from "react";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { needsFullSignIn } from "./full-sign-in.js";
import { currentLanguage, t } from "./i18n/i18n.js";
import { createOrdinaryRefundClient, OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { paidAtInstant } from "./counter-payment.js";
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
  /** WP-2423 M52: the payment was cash (it went back from the drawer). */
  inCash = false,
): string {
  if (inCash)
    return t("Cash given back recorded: {amount} at {time}.", {
      amount: orderMoney({ amountMinor: result.amountMinor, currencyCode: "CAD" }),
      time: storeTime(result.refundedAt, timeZone, true),
    });
  const amount =
    result.amountMinor === requestedMinor
      ? amountLabel
      : orderMoney({ amountMinor: result.amountMinor, currencyCode: "CAD" });
  return (
    t("Card-machine refund recorded: {amount} refunded on the card machine at {time}.", {
      amount,
      time: storeTime(result.refundedAt, timeZone, true),
    }) +
    // Chinese sentences follow each other with no space.
    (currentLanguage() === "zh-Hans" ? "" : " ") +
    (result.receipt === "Issued"
      ? t("The customer's digital receipt now shows the refund.")
      : result.receipt === "NotIssued"
        ? t(
            "The digital receipt could not be updated yet; record it again later to retry (the refund is not counted twice).",
          )
        : t("The card machine's refund slip is the customer's receipt."))
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
  cashMinor = null,
  client = defaultClient,
}: {
  readonly orderReference: string;
  readonly requestReference: string;
  readonly amountMinor: string;
  /**
   * WP-2423 M52/M131: the payment was cash at the counter — what to hand back from the drawer
   * (whole nickels, the server's amount). Null for the card machine.
   */
  readonly cashMinor?: string | null;
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
  const inCash = cashMinor !== null;
  const cash = orderMoney({ amountMinor: cashMinor ?? "0", currencyCode: "CAD" });
  const ready =
    outcome !== "Pending" &&
    (inCash || validSlipReference(slip.trim())) &&
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
          slipReference: inCash || slip.trim() === "" ? null : slip.trim(),
          refundedAt: earlier ? madeAtInstant : null,
        },
        csrf,
      );
      operation.current = null;
      setOutcome("Idle");
      const confirmation = cardMachineRefundRecordedText(
        result,
        amount,
        amountMinor,
        timeZone,
        inCash,
      );
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
          {inCash
            ? t(
                "The guest paid in cash. Hand back {cash} from the drawer (the refund of {amount}, in whole nickels), then record it here.",
                { cash, amount },
              )
            : t(
                "Refund {amount} on the store's card machine to the card the customer paid with, then record it here.",
                { amount },
              )}
        </p>
        {inCash ? null : (
          <>
            <label>
              {t("Slip reference (optional)")}
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
              {t(
                "The approval or reference code printed on the refund slip. Never the card number.",
              )}
            </p>
          </>
        )}
        <label>
          <input
            type="checkbox"
            checked={earlier}
            onChange={(event) => {
              operation.current = null;
              setEarlier(event.currentTarget.checked);
            }}
          />
          {inCash
            ? t("Given back earlier, while the system was unreachable")
            : t("Refunded earlier, while the system was unreachable")}
        </label>
        {earlier ? (
          <label>
            {t("Refunded at (store time, from the slip)")}
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
            {t(
              "Within the last 3 days, after the refund was requested. It counts on the day it was made.",
            )}
          </p>
        ) : null}
        {outcome === "Pending" ? <p role="status">{t("Recording…")}</p> : null}
        {outcome === "Conflict" ? (
          <p role="alert">
            {t(
              "Not recorded: this refund needs an owner's approval first, or it was already recorded. Refresh the requests to see where it stands.",
            )}
          </p>
        ) : null}
        {outcome === "Denied" ? (
          <p role="alert">
            {t(
              "Only a store manager or an owner can record this refund. Ask them to record it after the refund on the card machine.",
            )}
          </p>
        ) : null}
        {outcome === "Unknown" ? (
          <p role="alert">
            {t("Result unknown. Record it again; the same refund is never counted twice.")}
          </p>
        ) : null}
        <button type="submit" className="refund-primary" disabled={!ready}>
          {outcome === "Pending"
            ? t("Recording…")
            : inCash
              ? t("Gave back {amount} in cash", { amount: cash })
              : t("Refunded {amount} on card machine", { amount })}
        </button>
      </form>
      {/* Outside the form: the verification step has its own form. */}
      {outcome === "SignIn" ? <FullSignInPrompt csrf={csrf} /> : null}
    </div>
  );
}
