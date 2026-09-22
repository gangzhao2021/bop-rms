import { RefundExecutionAction } from "./RefundExecutionAction.js";
import {
  createOrdinaryRefundPreparationClient,
  OrdinaryRefundPreparationClientError,
} from "./ordinary-refund-preparation-client.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { AppFrame } from "@bop-rms/ui";
import { createOrdinaryRefundClient, OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { serviceOperationReference } from "./service-control-client.js";
const client = createOrdinaryRefundClient();
type Context = Awaited<ReturnType<typeof client.context>>;
type Items = Awaited<ReturnType<typeof client.items>>;
type Intent = ReturnType<typeof client.prepareRequest>;
type Preview = Awaited<ReturnType<Intent["preview"]>>;
const amount = (value: string | null) =>
  value === null
    ? "Unavailable"
    : "CAD " +
      (BigInt(value) / 100n).toString() +
      "." +
      (BigInt(value) % 100n).toString().padStart(2, "0");
const errorMessage = (error: unknown) =>
  error instanceof OrdinaryRefundClientError && error.code === "Denied"
    ? "Your current permissions do not allow this refund workflow."
    : error instanceof OrdinaryRefundClientError && error.code === "Conflict"
      ? "The payment or refund selection changed. Refresh before trying again."
      : "Unable to refresh this information. Check your connection and try again.";
export function OrderPaymentLinks({
  orderReference,
  csrf,
}: {
  readonly orderReference: string;
  readonly csrf: string;
}) {
  const [links, setLinks] = useState<readonly string[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const result = await client.items(orderReference, csrf, controller.signal);
      if (!controller.signal.aborted) {
        const ids = [
          ...new Set(
            result.items.flatMap((item) =>
              item.paymentIntentReference === null ? [] : [item.paymentIntentReference],
            ),
          ),
        ];
        setLinks(ids);
        if (!ids.length) setMessage("No captured payment is available for this order.");
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section aria-label="Order payments">
      <button disabled={busy} onClick={() => void load()}>
        View payments and refunds
      </button>
      <p role="status">{message}</p>
      {links.map((reference, index) => (
        <p key={reference}>
          <Link to={"/app/operations/payments/" + reference}>Open payment {index + 1}</Link>
        </p>
      ))}
    </section>
  );
}
const preparationClient = createOrdinaryRefundPreparationClient();
function RefundPreparationAction({
  orderReference,
  requestReference,
  paymentAttemptReference,
  csrf,
  onPending,
}: {
  orderReference: string;
  requestReference: string;
  paymentAttemptReference: string;
  csrf: string;
  onPending: (pending: boolean) => void;
}) {
  const [state, setState] = useState<"Idle" | "Busy" | "Unknown" | "Recorded">("Idle"),
    [message, setMessage] = useState("");
  const intent = useRef<ReturnType<typeof preparationClient.prepare> | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    if (state === "Busy" || state === "Unknown") window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);
  const prepare = async () => {
    if (pending.current || state === "Recorded") return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    onPending(true);
    try {
      intent.current ??= preparationClient.prepare({
        orderReference,
        requestReference,
        paymentAttemptReference,
        operationReference: serviceOperationReference(),
        auditReference: serviceOperationReference(),
        approvalReference: null,
      });
      const result = await intent.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setState("Recorded");
        onPending(false);
        setMessage(
          (result.replayed ? "Original preparation recovered. " : "Preparation recorded. ") +
            "Check execution status for updates. No completed refund is confirmed here.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (
          error instanceof OrdinaryRefundPreparationClientError &&
          error.code !== "OutcomeUnknown"
        ) {
          setState("Idle");
          onPending(false);
          intent.current = null;
          setMessage(
            error.code === "Unavailable"
              ? "Refund preparation is not configured for this store. Contact the pilot operator."
              : error.code === "PermissionDenied"
                ? "Preparation was denied. Current execution permission and any required independent approval must be satisfied."
                : "The refund changed. Check execution status before preparing again.",
          );
        } else {
          setState("Unknown");
          setMessage(
            "Preparation result unknown. Keep this page open and retry the same preparation.",
          );
        }
      }
    } finally {
      pending.current = null;
    }
  };
  return (
    <div>
      <p>
        The server rechecks execution permission, balance and any required independent approval
        before recording preparation.
      </p>
      <button disabled={state === "Busy" || state === "Recorded"} onClick={() => void prepare()}>
        {state === "Unknown" ? "Retry same refund preparation" : "Prepare refund execution"}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
function RecordedRequestStatus({
  orderReference,
  entry,
  csrf,
  onFinancialChange,
  onPending,
}: {
  orderReference: string;
  entry: Items["recentRequests"][number];
  csrf: string;
  onFinancialChange: () => void;
  onPending: (paymentReference: string, active: boolean) => void;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.status>> | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    setResult(null);
    try {
      const value = await client.status(
        orderReference,
        entry.operationReference,
        csrf,
        controller.signal,
      );
      if (
        value.requestReference !== entry.requestReference ||
        value.amountMinor !== entry.amountMinor
      )
        throw new OrdinaryRefundClientError("Unavailable");
      if (!controller.signal.aborted) {
        setResult(value);
        onFinancialChange();
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div>
      <button disabled={busy || preparing.size > 0} onClick={() => void load()}>
        Check execution status for request {entry.claimVersion}
      </button>
      {message ? <p role="status">{message}</p> : null}
      {result ? (
        <section aria-label={"Execution status for request " + entry.claimVersion}>
          <p>
            Last checked: <time dateTime={result.observedAt}>{result.observedAt}</time>
          </p>
          <ul>
            {result.payments.map((payment, index) => (
              <li key={payment.paymentAttemptReference}>
                Payment {index + 1}:{" "}
                {payment.state === "Confirmed"
                  ? "Refund confirmed"
                  : payment.state === "Prepared"
                    ? "Preparation recorded; awaiting dispatch"
                    : payment.state === "NotDispatched"
                      ? "Not dispatched"
                      : "Needs reconciliation"}
                . Requested {amount(payment.amountMinor)}; confirmed{" "}
                {amount(payment.confirmedMinor)}; pending {amount(payment.pendingMinor)}.
                {payment.state !== "NotDispatched" && payment.executionOperationReference ? (
                  <RefundExecutionAction
                    onFinancialChange={onFinancialChange}
                    key={payment.executionOperationReference + ":" + payment.state}
                    orderReference={orderReference}
                    requestReference={entry.requestReference}
                    operationReference={payment.executionOperationReference}
                    phase={payment.state}
                    amountLabel={amount(payment.amountMinor)}
                    csrf={csrf}
                    onPending={(active) => {
                      onPending(payment.paymentAttemptReference, active);
                      setPreparing((prior) => {
                        const next = new Set(prior);
                        if (active) next.add(payment.paymentAttemptReference);
                        else next.delete(payment.paymentAttemptReference);
                        return next;
                      });
                    }}
                  />
                ) : null}
                {payment.state === "NotDispatched" ? (
                  <RefundPreparationAction
                    orderReference={orderReference}
                    requestReference={entry.requestReference}
                    paymentAttemptReference={payment.paymentAttemptReference}
                    csrf={csrf}
                    onPending={(active) => {
                      onPending(payment.paymentAttemptReference, active);
                      setPreparing((prior) => {
                        const next = new Set(prior);
                        if (active) next.add(payment.paymentAttemptReference);
                        else next.delete(payment.paymentAttemptReference);
                        return next;
                      });
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <p>
            Pending amounts remain reserved. Approval and refund receipt availability are separate.
          </p>
        </section>
      ) : null}
    </div>
  );
}
function RefundWizard({
  orderReference,
  csrf,
  onFinancialChange,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly onFinancialChange: () => void;
}) {
  const [items, setItems] = useState<Items | null>(null),
    [quantities, setQuantities] = useState<Record<string, number>>({}),
    [reason, setReason] = useState("CUSTOMER_REQUEST"),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState(""),
    [state, setState] = useState<"Idle" | "Busy" | "Unknown" | "Recorded">("Idle");
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
  const operationReference = useRef<string | null>(null);
  const operation = useRef<Intent | null>(null),
    pending = useRef<AbortController | null>(null),
    status = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (message) status.current?.focus();
  }, [message]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    if (state === "Unknown" || state === "Busy") window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);
  const locked = state !== "Idle" || preparing.size > 0;
  const clearPreview = () => {
    setPreview(null);
    setConfirmed(false);
    operation.current = null;
    operationReference.current = null;
  };
  const load = async () => {
    if (pending.current || preparing.size > 0 || state === "Busy") return;
    const wasUnknown = state === "Unknown";
    const wasRecorded = state === "Recorded";
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    if (!wasUnknown && !wasRecorded) clearPreview();
    try {
      const result = await client.items(orderReference, csrf, controller.signal);
      if (!controller.signal.aborted) {
        setItems(result);
        if (wasUnknown) {
          const recovered = result.recentRequests.find(
            (entry) => entry.operationReference === operationReference.current,
          );
          setState(recovered ? "Recorded" : "Unknown");
          setMessage(
            recovered
              ? "Original request recovered. No completed refund is confirmed here."
              : "The original request is not confirmed by this history. Its result remains unknown; retry the same request.",
          );
        } else if (wasRecorded) {
          setState("Recorded");
          onFinancialChange();
          setMessage(
            "Request remains recorded. Updated records are shown below; no completed refund is confirmed here.",
          );
        } else {
          setQuantities({});
          setState("Idle");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(errorMessage(error));
        setState(wasUnknown ? "Unknown" : wasRecorded ? "Recorded" : "Idle");
      }
    } finally {
      pending.current = null;
    }
  };
  const calculate = async () => {
    if (!items || locked || pending.current) return;
    const selection = items.items
      .filter((item) => (quantities[item.orderItemReference] ?? 0) > 0)
      .map((item) => ({
        orderBatchReference: item.orderBatchReference,
        orderItemReference: item.orderItemReference,
        quantity: quantities[item.orderItemReference] ?? 0,
      }));
    if (!selection.length) {
      setMessage("Select at least one item quantity.");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    clearPreview();
    try {
      operationReference.current = serviceOperationReference();
      const intent = client.prepareRequest({
        orderReference,
        requestReference: serviceOperationReference(),
        operationReference: operationReference.current,
        expectedClaimVersion: items.claimVersion,
        reasonCode: reason,
        items: selection,
      });
      operation.current = intent;
      const result = await intent.preview(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setPreview(result);
        setState("Idle");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        clearPreview();
        setMessage(errorMessage(error));
        setState("Idle");
      }
    } finally {
      pending.current = null;
    }
  };
  const submit = async () => {
    if (
      !operation.current ||
      !preview ||
      (!confirmed && state !== "Unknown") ||
      pending.current ||
      state === "Recorded"
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    try {
      const result = await operation.current.submit(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setState("Recorded");
        onFinancialChange();
        setMessage(
          (result.replayed ? "Original request recovered. " : "Request recorded. ") +
            "Refund amount: " +
            amount(result.amountMinor) +
            ". Approval and execution are separate. No completed refund is confirmed here.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OrdinaryRefundClientError && error.code === "OutcomeUnknown") {
          setState("Unknown");
          setMessage(
            "Request result unknown. Keep this page open and retry the same request; do not start another refund.",
          );
        } else {
          setState("Idle");
          clearPreview();
          setMessage(errorMessage(error));
        }
      }
    } finally {
      pending.current = null;
    }
  };
  return (
    <section aria-labelledby="refund-heading" data-screen-id="PAY-REFUND-WIZARD">
      <h2 id="refund-heading">Request a refund</h2>
      <p>
        Select items from the paid batches of this order. The server checks remaining quantity and
        balance when calculating and submitting.
      </p>
      <button disabled={state === "Busy" || preparing.size > 0} onClick={() => void load()}>
        {state === "Unknown"
          ? "Check recorded requests"
          : state === "Recorded"
            ? "Refresh recorded requests"
            : "Load refundable items"}
      </button>
      {items ? (
        <section aria-label="Recorded refund requests">
          <h3>Recorded refund requests</h3>
          <p>
            Latest {items.recentRequests.length} of {items.claimVersion} recorded requests for this
            order. These records do not confirm approval or completed refunds. An absent request
            does not rule out a submission still in progress.
          </p>
          {items.recentRequests.length === 0 ? (
            <p>No recorded requests in this snapshot.</p>
          ) : (
            <ol>
              {items.recentRequests.map((entry) => (
                <li key={entry.requestReference}>
                  Request {entry.claimVersion}: {amount(entry.amountMinor)} · {entry.reasonCode} ·{" "}
                  <time dateTime={entry.requestedAt}>{entry.requestedAt}</time>
                  <RecordedRequestStatus
                    onFinancialChange={onFinancialChange}
                    orderReference={orderReference}
                    entry={entry}
                    csrf={csrf}
                    onPending={(paymentReference, active) =>
                      setPreparing((prior) => {
                        const next = new Set(prior);
                        const key = entry.requestReference + ":" + paymentReference;
                        if (active) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
      <fieldset disabled={locked}>
        <legend>Refund selection</legend>
        {items?.items.map((item, index) => (
          <div className="form-field" key={item.orderItemReference}>
            <label htmlFor={"refund-quantity-" + index}>
              {item.label} · line {index + 1} ({item.unclaimedQuantity} unclaimed of {item.quantity}
              )
            </label>
            <input
              id={"refund-quantity-" + index}
              type="number"
              inputMode="numeric"
              min={0}
              max={item.unclaimedQuantity}
              step={1}
              value={quantities[item.orderItemReference] ?? 0}
              disabled={!item.paymentCaptured || item.unclaimedQuantity === 0}
              onChange={(event) => {
                const quantity = Number(event.target.value);
                if (
                  Number.isSafeInteger(quantity) &&
                  quantity >= 0 &&
                  quantity <= item.unclaimedQuantity
                ) {
                  setQuantities((prior) => ({ ...prior, [item.orderItemReference]: quantity }));
                  clearPreview();
                }
              }}
            />
          </div>
        ))}
        {items?.items.length === 0 ? <p>No items are available.</p> : null}
        <label htmlFor="refund-reason">Reason</label>
        <select
          id="refund-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            clearPreview();
          }}
        >
          <option value="CUSTOMER_REQUEST">Customer request</option>
        </select>
        <button disabled={!items} onClick={() => void calculate()}>
          Calculate refund
        </button>
      </fieldset>
      {preview ? (
        <section aria-label="Refund calculation">
          <h3>Confirm refund amount</h3>
          <dl>
            {[
              ["Items", "netAmountMinor"],
              ["Tax", "taxAmountMinor"],
              ["Tip", "tipAmountMinor"],
              ["Service charge", "serviceChargeAmountMinor"],
              ["Service charge tax", "serviceChargeTaxAmountMinor"],
            ].map(([label, key]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{amount(preview.components[key ?? ""] ?? null)}</dd>
              </div>
            ))}
            <div>
              <dt>Total</dt>
              <dd>{amount(preview.amountMinor)}</dd>
            </div>
          </dl>
          <p>
            {preview.paymentAttemptReferences.length} original payment(s). Recording a request does
            not issue a refund.
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm the selected quantities, reason and {amount(preview.amountMinor)} request.
          </label>
          <button disabled={!confirmed || locked} onClick={() => void submit()}>
            Record refund request
          </button>
        </section>
      ) : null}
      {state === "Unknown" ? (
        <button onClick={() => void submit()}>Retry same refund request</button>
      ) : null}
      <p ref={status} tabIndex={-1} role="status">
        {state === "Busy" ? "Working…" : message}
      </p>
    </section>
  );
}
function PaymentFinancialSummary({
  initial,
  csrf,
  revision,
}: {
  initial: Context;
  csrf: string;
  revision: number;
}) {
  const [context, setContext] = useState<Context | null>(initial);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (revision === 0 && refresh === 0) return;
    const controller = new AbortController();
    setBusy(true);
    setContext(null);
    setMessage("Refreshing payment amounts…");
    void client
      .context(initial.paymentIntentReference, csrf, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setContext(value);
          setMessage("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [initial.paymentIntentReference, csrf, revision, refresh]);
  return (
    <>
      <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh payment amounts
      </button>
      <p role="status">{message}</p>
      {context ? (
        <section aria-label="Payment financial summary" data-screen-id="PAY-PAYMENT-DETAIL">
          <h2>Payment financial summary</h2>
          <p>Payment state: {context.paymentState}</p>
          <dl>
            <div>
              <dt>Captured</dt>
              <dd>{amount(context.capturedAmountMinor)}</dd>
            </div>
            <div>
              <dt>Confirmed refunds</dt>
              <dd>{amount(context.confirmedRefundMinor)}</dd>
            </div>
            <div>
              <dt>Pending refunds</dt>
              <dd>{amount(context.pendingRefundMinor)}</dd>
            </div>
          </dl>
          <p>
            Last checked: <time dateTime={context.observedAt}>{context.observedAt}</time>
          </p>
          <p>Reconciliation and audit timeline are not available in this view.</p>
        </section>
      ) : (
        <p>Payment amounts are unavailable until refreshed.</p>
      )}
    </>
  );
}
function PaymentContent({
  paymentIntentReference,
  csrf,
  storeLabel,
  wizard,
}: {
  readonly paymentIntentReference: string;
  readonly csrf: string;
  readonly storeLabel: string;
  readonly wizard: boolean;
}) {
  const [financialRevision, setFinancialRevision] = useState(0);
  const refreshFinancial = useCallback(() => setFinancialRevision((value) => value + 1), []);
  const [context, setContext] = useState<Context | null>(null),
    [message, setMessage] = useState("Loading payment…"),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContext(null);
    setMessage("Loading payment…");
    void client
      .context(paymentIntentReference, csrf, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setContext(result);
          setMessage("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(errorMessage(error));
      });
    return () => controller.abort();
  }, [paymentIntentReference, csrf, refresh]);
  return (
    <AppFrame title="Payment details" description={storeLabel}>
      <p role="status">{message}</p>
      {!context ? (
        <button onClick={() => setRefresh((value) => value + 1)}>Refresh payment</button>
      ) : (
        <>
          <PaymentFinancialSummary initial={context} csrf={csrf} revision={financialRevision} />
          {context.paymentState === "Captured" ? (
            wizard ? (
              <RefundWizard
                onFinancialChange={refreshFinancial}
                key={context.orderReference}
                orderReference={context.orderReference}
                csrf={csrf}
              />
            ) : (
              <Link to={"/app/operations/payments/" + paymentIntentReference + "/refund"}>
                Start refund request
              </Link>
            )
          ) : (
            <p>A captured payment is required before starting a refund request.</p>
          )}
        </>
      )}
    </AppFrame>
  );
}
export function RefundPaymentPage({
  csrf,
  storeLabel,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
}) {
  const { id = "" } = useParams(),
    location = useLocation();
  return (
    <PaymentContent
      key={id}
      paymentIntentReference={id}
      csrf={csrf}
      storeLabel={storeLabel}
      wizard={location.pathname.endsWith("/refund")}
    />
  );
}
