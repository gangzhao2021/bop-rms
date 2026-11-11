import { t } from "./i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import {
  createPickupHandoffClient,
  PickupHandoffClientError,
  pickupLineToHandOver,
  type PickupCodeNotShownCause,
} from "./pickup-handoff-client.js";
import type { PickupVerification } from "./pickup-proof-client.js";
import { pickupItemLabel, type PickupQueueItem, type PickupWorkstation } from "./pickup.js";
import { serviceOperationReference } from "./service-control-client.js";
import { browserOffline } from "./stale-read.js";
import {
  readPickupIdentityCheck,
  type PickupIdentityOutcome,
} from "./pickup-identity-check-client.js";
const defaultClient = createPickupHandoffClient();
/** WP-2423: what staff choose when a customer cannot show a still-valid pickup code. */
const codeNotShownChoices: readonly (readonly [PickupCodeNotShownCause, string])[] = [
  ["PhoneUnavailable", t("Phone is dead, lost or left behind")],
  ["CodeNotReceived", t("Customer never got the pickup code")],
  ["OrderPageLost", t("Order page was closed or lost")],
];

/**
 * WP-2423: what staff compare in person: the name on the order and the phone's last four digits
 * (the rest of the phone is never sent to this device). Shown only in the open dialog.
 */
export function PickupIdentityDetails({
  details,
  onRetry,
}: {
  readonly details: PickupIdentityOutcome | "Loading" | null;
  readonly onRetry: () => void;
}) {
  if (details === null) return null;
  if (details === "Loading")
    return <p role="status">{t("Loading the name and phone on the order…")}</p>;
  if (details.status === "Available")
    return (
      <dl className="pickup-identity" aria-label={t("Details on the order")}>
        <div>
          <dt>{t("Name on the order")}</dt>
          <dd>{details.name}</dd>
        </div>
        <div>
          <dt>{t("Phone ends in")}</dt>
          <dd>
            {details.phoneLast4 === null ? (
              t("No phone on the order")
            ) : (
              <>
                <span aria-hidden="true">•••• </span>
                <span className="pickup-identity__digits">{details.phoneLast4}</span>
              </>
            )}
          </dd>
        </div>
      </dl>
    );
  if (details.status === "Removed" || details.status === "NotGiven")
    return (
      <p role="status">
        {t(
          "{value} Check the order number and ask the customer what they ordered. If you are not sure, ask a manager before handing it over.",
          {
            value:
              details.status === "Removed"
                ? t("The customer's name and phone were deleted after the retention period.")
                : t("The customer did not leave a name or phone for this order."),
          },
        )}
      </p>
    );
  if (details.status === "NotEligible")
    return (
      <p role="status">
        {t("This order changed. Close this and refresh the list before handing over.")}
      </p>
    );
  return (
    <p role="status">
      {t("The name and phone on the order can't be shown right now.")}{" "}
      <button type="button" onClick={onRetry}>
        {t("Try again")}
      </button>
    </p>
  );
}
export function PickupHandoffForm({
  item,
  verification,
  workstation,
  csrf,
  storeReference,
  paused = false,
  codeNotShown = false,
  onRecorded,
  fetcher,
}: {
  /** Tests only: the network the handover is sent through. */
  readonly fetcher?: typeof fetch;
  /**
   * WP-2423: the customer's code is still valid but they cannot show it (phone dead, code never
   * received, order page lost). A deliberate secondary action beside the code check: staff choose
   * why, then check the customer in person; the reason and the staff member are recorded.
   */
  readonly codeNotShown?: boolean;
  /**
   * WP-2423: called once the handover is recorded; the queue closes this dialog, re-reads at once
   * so the order leaves Waiting, and says so plainly.
   */
  readonly onRecorded?: (() => void) | undefined;
  /** IDR-0039: offline or stale; nothing is sent and nothing is queued for later. */
  readonly paused?: boolean;
  readonly item: PickupQueueItem;
  /** Null when staff verify the customer in person (the pickup code expired or was never sent). */
  readonly verification: PickupVerification | null;
  readonly workstation: PickupWorkstation;
  readonly csrf: string;
  readonly storeReference: string;
}) {
  const [client] = useState(() =>
    fetcher === undefined ? defaultClient : createPickupHandoffClient(fetcher),
  );
  const dialog = useRef<HTMLDialogElement>(null),
    resultAnnouncement = useRef<HTMLParagraphElement>(null),
    controller = useRef<AbortController | null>(null);
  const intent = useRef<ReturnType<typeof defaultClient.prepare> | null>(null);
  const [status, setStatus] = useState<
    "Idle" | "Pending" | "Unknown" | "Rejected" | "Completed" | "InProgress"
  >("Idle");
  const inPerson = verification === null;
  // WP-2423: taken at the counter: no pickup code was ever sent and the walk-up customer left no
  // contact (counter orders carry no name), so staff call the order number and hand it over.
  const counter = inPerson && item.takenAtCounter === true && item.proofReadiness === "NotIssued";
  const [cause, setCause] = useState<"" | PickupCodeNotShownCause>("");
  const [identityCheck, setIdentityCheck] = useState<
    "" | "OrderNumberAndName" | "OrderNumberAndPhoneLast4" | "OrderNumberCalled"
  >("");
  // WP-2423 M21: the ordinary handover is one tap — after the code matched, or for a counter order
  // whose number was called — to the customer themselves. Someone else collecting, a code the guest
  // can't show and an expired or locked code keep the full form.
  const quick = !codeNotShown && (verification !== null || counter);
  const [recipient, setRecipient] = useState<"" | "Customer" | "Delegate">(""),
    [mask, setMask] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const locked = status === "Pending" || status === "Unknown";
  // WP-2423: the name and phone digits to compare, read when the in-person dialog opens and
  // dropped when it closes.
  const [details, setDetails] = useState<PickupIdentityOutcome | "Loading" | null>(null);
  const detailsRequest = useRef<AbortController | null>(null);
  const loadDetails = (chosen: "" | PickupCodeNotShownCause = cause) => {
    // A still-valid code: the name and phone are read only once staff said why it can't be shown.
    if (!inPerson || counter || (codeNotShown && !chosen) || browserOffline()) return;
    detailsRequest.current?.abort();
    const active = new AbortController();
    detailsRequest.current = active;
    setDetails("Loading");
    void readPickupIdentityCheck({
      item,
      storeReference,
      csrf,
      signal: active.signal,
      ...(codeNotShown && chosen ? { codeNotShownCause: chosen } : {}),
    }).then((result) => {
      if (!active.signal.aborted) setDetails(result);
    });
  };
  // No phone on the order to compare: only the name check can be chosen.
  const phoneUnavailable =
    counter ||
    (details !== null &&
      details !== "Loading" &&
      (details.status === "Removed" ||
        details.status === "NotGiven" ||
        (details.status === "Available" && details.phoneLast4 === null)));
  useEffect(
    () => () => {
      controller.current?.abort();
      detailsRequest.current?.abort();
      intent.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);
  const submit = async (retry: boolean, oneTap = false) => {
    if (
      paused ||
      browserOffline() ||
      controller.current ||
      (!retry &&
        (status !== "Idle" ||
          (!oneTap &&
            (!confirmed ||
              !recipient ||
              !mask ||
              (inPerson && !identityCheck) ||
              (codeNotShown && !cause)))))
    )
      return;
    try {
      if (!retry) {
        if (intent.current || (!oneTap && !recipient)) return;
        const check = oneTap ? (counter ? "OrderNumberCalled" : "") : identityCheck;
        intent.current = client.prepare({
          item,
          verification,
          ...(check ? { identityCheck: check } : {}),
          ...(codeNotShown && cause ? { codeNotShownCause: cause } : {}),
          workstation,
          storeReference,
          recipientType: oneTap ? "Customer" : recipient || "Customer",
          recipientDisplayMask: oneTap ? null : mask,
          idempotencyReference: serviceOperationReference(),
          correlationReference: serviceOperationReference(),
        });
        setMask("");
      }
      if (!intent.current) return;
      const active = new AbortController();
      controller.current = active;
      setStatus("Pending");
      try {
        const result = await intent.current.execute(csrf, active.signal);
        if (!active.signal.aborted) {
          setStatus(result.nextPhase);
          if (onRecorded) {
            dialog.current?.close();
            onRecorded();
          }
        }
      } catch (error) {
        if (!active.signal.aborted)
          setStatus(
            error instanceof PickupHandoffClientError && error.code === "OutcomeUnknown"
              ? "Unknown"
              : "Rejected",
          );
      } finally {
        if (controller.current === active) controller.current = null;
      }
    } catch {
      setMask("");
      setStatus("Rejected");
    }
  };
  // WP-2423 M10: units refunded and not to be handed over are left out of what staff hand over.
  const toHandOver = pickupLineToHandOver;
  const lines = item.execution?.items.filter((line) => toHandOver(line) > 0) ?? [];
  const orderNumber =
    item.publicOrderNumber ?? item.execution?.publicOrderReference ?? t("reference unavailable");
  return (
    <>
      {quick ? (
        <div className="pickup-handoff__quick">
          <ul className="pickup-handoff__quick-items">
            {lines.map((line, index) => (
              <li key={line.fulfillmentItemReference}>
                {t("{line}: {value} to hand over", {
                  line: pickupItemLabel(line, index),
                  value: toHandOver(line),
                })}
              </li>
            ))}
          </ul>
          <p className="bop-muted">
            {counter
              ? t(
                  "Taken at the counter, so no pickup code was sent. Call the order number and check every item before you tap.",
                )
              : t("Check every item before you tap")}
          </p>
          <button
            type="button"
            data-variant="primary"
            disabled={status !== "Idle" || paused || lines.length === 0}
            onClick={() => void submit(false, true)}
          >
            {counter
              ? t("Called and handed over · Order {orderNumber}", { orderNumber })
              : t("Hand over to customer · Order {orderNumber}", { orderNumber })}
          </button>
          {status === "Pending" ? <p role="status">{t("Recording handoff…")}</p> : null}
          {status === "Unknown" ? (
            <p role="status">
              {t(
                "The handover could not be confirmed. Do not hand anything over again; try confirming the same handover again.",
              )}{" "}
              <button type="button" disabled={paused} onClick={() => void submit(true)}>
                {t("Try confirming again")}
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        disabled={status !== "Idle" || paused}
        className={
          codeNotShown ? "pickup-handoff__no-code" : quick ? "pickup-handoff__other" : undefined
        }
        onClick={() => {
          // Opened as "Someone else is collecting": they are the one collecting.
          if (quick && !recipient) setRecipient("Delegate");
          dialog.current?.showModal();
          loadDetails();
        }}
      >
        {codeNotShown
          ? t("Guest can’t show the code")
          : quick
            ? t("Someone else is collecting")
            : inPerson
              ? t("Hand over after checking in person")
              : t("Review pickup handoff")}
      </button>
      {status === "Completed" || status === "InProgress" ? (
        <p ref={resultAnnouncement} role="status" tabIndex={-1}>
          {t("Handed over. The list is updating.")}
        </p>
      ) : status === "Rejected" ? (
        <p ref={resultAnnouncement} role="status" tabIndex={-1}>
          {t("Handoff was not confirmed. Refresh the queue before another attempt.")}
        </p>
      ) : null}
      <dialog
        className="order-cancel-dialog pickup-handoff-dialog"
        ref={dialog}
        aria-labelledby={"handoff-" + item.fulfillmentReference}
        onClose={() => {
          detailsRequest.current?.abort();
          setDetails(null);
          if (status === "Rejected" || status === "Completed" || status === "InProgress")
            resultAnnouncement.current?.focus();
        }}
        onCancel={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <h2 id={"handoff-" + item.fulfillmentReference}>{t("Confirm pickup handoff")}</h2>
        <p>
          {t("Order {value}", {
            value:
              item.publicOrderNumber ??
              item.execution?.publicOrderReference ??
              t("reference unavailable"),
          })}
        </p>
        <ul>
          {lines.map((line, index) => (
            <li key={line.fulfillmentItemReference}>
              {t("{line}: {value} to hand over", {
                line: pickupItemLabel(line, index),
                value: toHandOver(line),
              })}
              {(line.refundedQuantity ?? 0) > 0
                ? " · " +
                  t("{count} refunded, not in the bag", { count: line.refundedQuantity ?? 0 })
                : ""}
            </li>
          ))}
        </ul>
        <p>{t("Match every item to the order ticket before handing it over.")}</p>
        {counter ? (
          <p>
            {t(
              "This order was taken at the counter, so no pickup code was sent. Call the order number and hand it over to the customer who answers.",
            )}
          </p>
        ) : codeNotShown ? (
          <p>
            {t(
              "The customer's pickup code is still valid. Use this only when they can't show it. Choose why, then ask for the order number and check it with the name or the last four digits of the phone on the order. Your name and the reason are kept with the handover.",
            )}
          </p>
        ) : inPerson ? (
          <p>
            {t(
              "{value} Ask for the order number and check it with the name or the last four digits of the phone on the order before handing over.",
              {
                value:
                  item.proofReadiness === "Expired"
                    ? t("The customer's pickup code has expired.")
                    : item.proofReadiness === "Locked"
                      ? t(
                          "Too many wrong pickup codes were entered for this order, so code checks are locked.",
                        )
                      : t("No pickup code was sent for this order."),
              },
            )}
          </p>
        ) : null}
        {codeNotShown && !cause && status === "Idle" ? (
          <p role="status">
            {t("Choose why first. The name and phone on the order then show here.")}
          </p>
        ) : null}
        {inPerson ? (
          <PickupIdentityDetails details={details} onRetry={() => loadDetails()} />
        ) : null}
        {status === "Idle" ? (
          <form
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            {codeNotShown ? (
              <label>
                {t("Why the code can't be shown")}
                <select
                  value={cause}
                  onChange={(event) => {
                    const chosen = event.currentTarget.value as typeof cause;
                    setCause(chosen);
                    if (chosen && details === null) loadDetails(chosen);
                  }}
                >
                  <option value="">{t("Choose why")}</option>
                  {codeNotShownChoices.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {inPerson ? (
              <label>
                {t("Checked in person")}
                <select
                  value={identityCheck}
                  onChange={(event) =>
                    setIdentityCheck(event.currentTarget.value as typeof identityCheck)
                  }
                >
                  <option value="">{t("Select what you checked")}</option>
                  {counter ? (
                    // WP-2423 M21: a called number is recorded as that, never as a name check.
                    <option value="OrderNumberCalled">
                      {t("Order number called at the counter")}
                    </option>
                  ) : (
                    <option value="OrderNumberAndName">
                      {t("Order number and name on the order")}
                    </option>
                  )}
                  <option value="OrderNumberAndPhoneLast4" disabled={phoneUnavailable}>
                    {t("Order number and last four digits of the phone")}
                  </option>
                </select>
              </label>
            ) : null}
            <label>
              {t("Collected by")}
              <select
                value={recipient}
                onChange={(event) => setRecipient(event.currentTarget.value as typeof recipient)}
              >
                <option value="">{t("Choose who collected it")}</option>
                <option value="Customer">{t("The customer")}</option>
                <option value="Delegate">{t("Someone collecting for them")}</option>
              </select>
            </label>
            <label>
              {t("Collector’s initial")}
              <input
                value={mask}
                maxLength={64}
                autoComplete="off"
                placeholder="S***"
                onChange={(event) => setMask(event.currentTarget.value)}
              />
            </label>
            <p>
              {t(
                "Enter only an initial, such as S***, so the record shows who collected it. Do not enter a full name, phone number or pickup code.",
              )}
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              {t("I matched this order, the person collecting it and every item shown")}
            </label>
            <button
              type="submit"
              data-variant="primary"
              disabled={
                paused ||
                !confirmed ||
                !recipient ||
                !mask ||
                (inPerson && !identityCheck) ||
                (codeNotShown && !cause)
              }
            >
              {t("Confirm and record handoff")}
            </button>
          </form>
        ) : null}
        {paused ? <p role="status">{t("Paused until the connection returns.")}</p> : null}
        <div role="status">
          {status === "Pending" ? t("Recording handoff…") : null}
          {status === "Unknown"
            ? t(
                "The handover could not be confirmed. Do not hand anything over again; try confirming the same handover again.",
              )
            : null}
          {status === "Rejected"
            ? t("Handoff was not confirmed. Close and refresh the queue before another attempt.")
            : null}
          {status === "Completed" || status === "InProgress" ? t("Handed over.") : null}
        </div>
        {status === "Unknown" ? (
          <button disabled={paused} onClick={() => void submit(true)}>
            {t("Try confirming again")}
          </button>
        ) : null}
        <button disabled={locked} onClick={() => dialog.current?.close()}>
          {t("Close handoff confirmation")}
        </button>
      </dialog>
    </>
  );
}
