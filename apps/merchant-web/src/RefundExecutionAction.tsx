import { useEffect, useMemo, useRef, useState } from "react";
import {
  createOrdinaryRefundExecutionClient,
  OrdinaryRefundExecutionError,
} from "./ordinary-refund-execution-client.js";
import { createOrdinaryRefundPreparationClient } from "./ordinary-refund-preparation-client.js";
import { createOrdinaryRefundClient } from "./ordinary-refund-client.js";
import {
  createRefundRun,
  RefundRunError,
  refundRunFailureText,
  refundRunProgressText,
  refundRunRetryLabel,
  refundRunUncertain,
  type RefundRun,
  type RefundRunRequest,
  type RefundRunStep,
} from "./ordinary-refund-run.js";
import { serviceOperationReference } from "./service-control-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { needsFullSignIn } from "./full-sign-in.js";
const client = createOrdinaryRefundExecutionClient();
const preparation = createOrdinaryRefundPreparationClient();
const requests = createOrdinaryRefundClient();

/** The ports of a refund run over the existing owner commands (shared with the refund wizard). */
export function refundRunPorts<R extends RefundRunRequest>(
  orderReference: string,
  csrf: string,
  request?: (signal: AbortSignal) => Promise<R>,
) {
  return {
    ...(request ? { request } : {}),
    prepare: (command: Parameters<typeof preparation.prepare>[0], signal: AbortSignal) =>
      preparation.prepare(command).execute(csrf, signal),
    send: (command: Parameters<typeof client.prepareSend>[0], signal: AbortSignal) =>
      client.prepareSend(command).execute(csrf, signal),
    check: (command: Parameters<typeof client.prepareReconciliation>[0], signal: AbortSignal) =>
      client.prepareReconciliation(command).execute(csrf, signal),
    status: async (operationReference: string, signal: AbortSignal) =>
      (await requests.status(orderReference, operationReference, csrf, signal)).payments,
  };
}

/**
 * WP-2423 item 6: send one payment's refund of a recorded request (not sent yet) with one
 * confirmation: prepare it if needed, send it to the card provider, then check its answer. A
 * retry resumes at the step reached with the same references, so nothing is sent twice.
 */
export function RefundSendAction({
  orderReference,
  requestReference,
  requestOperationReference,
  paymentAttemptReference,
  preparedOperationReference,
  approvalReference,
  amountLabel,
  csrf,
  onPending,
  onDone,
}: {
  orderReference: string;
  requestReference: string;
  requestOperationReference: string;
  paymentAttemptReference: string;
  /** The prepared operation when this payment's refund was already prepared (null: not yet). */
  preparedOperationReference: string | null;
  /** WP-2423 Q5: the independent approval the prepared operation is bound to (null: none). */
  approvalReference: string | null;
  amountLabel: string;
  csrf: string;
  onPending: (pending: boolean) => void;
  /** The refund was sent (and its answer checked): show this and reread where it stands. */
  onDone: (confirmation: string) => void;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [active, setActive] = useState<RefundRunStep | null>(null),
    [failure, setFailure] = useState<RefundRunError | null>(null),
    [signIn, setSignIn] = useState(false);
  const run = useRef<RefundRun<RefundRunRequest> | null>(null),
    pending = useRef<AbortController | null>(null);
  const ports = useMemo(() => refundRunPorts(orderReference, csrf), [orderReference, csrf]);
  useEffect(() => () => pending.current?.abort(), []);
  const uncertain = failure !== null && refundRunUncertain(failure);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    if (active || uncertain) window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, uncertain]);
  const execute = async () => {
    if (pending.current || (!confirmed && failure === null)) return;
    const controller = new AbortController();
    pending.current = controller;
    setFailure(null);
    setSignIn(false);
    onPending(true);
    try {
      run.current ??= createRefundRun<RefundRunRequest>({
        orderReference,
        newReference: serviceOperationReference,
        sendAfterRequest: true,
        ports,
        recorded: {
          requestReference,
          operationReference: requestOperationReference,
          legs: [{ paymentAttemptReference, preparedOperationReference, approvalReference }],
        },
      });
      const outcome = await run.current.run(controller.signal, setActive);
      if (!controller.signal.aborted) {
        onPending(false);
        onDone(
          outcome.kind === "Refunded"
            ? `Refunded ${amountLabel} to the customer's original payment method.`
            : `Sent — waiting for the card provider's answer. The ${amountLabel} stays set aside until it answers; check again later.`,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const stopped = error instanceof RefundRunError ? error : new RefundRunError("Send", error);
        setFailure(stopped);
        setSignIn(needsFullSignIn(stopped.cause));
        // An unconfirmed send keeps the page busy: only the same retry may follow.
        onPending(refundRunUncertain(stopped) && run.current?.mayHaveSent === true);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setActive(null);
    }
  };
  return (
    <section aria-label="Send refund">
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={active !== null || failure !== null}
          onChange={(e) => setConfirmed(e.currentTarget.checked)}
        />
        I confirm sending this {amountLabel} refund to the customer&apos;s original payment method
      </label>
      <button
        disabled={active !== null || (!confirmed && failure === null)}
        onClick={() => void execute()}
      >
        {failure !== null ? refundRunRetryLabel(failure.step) : "Send refund"}
      </button>
      {active ? <p role="status">{refundRunProgressText(active)}</p> : null}
      {failure !== null ? <p role="status">{refundRunFailureText(failure)}</p> : null}
      {signIn ? <FullSignInPrompt csrf={csrf} /> : null}
    </section>
  );
}

/**
 * Check the answer for a refund already sent (or confirmed) and record its receipt. A retry after
 * an unknown result reuses the same check, so it is recorded once.
 */
export function RefundExecutionAction({
  orderReference,
  operationReference,
  csrf,
  onPending,
  onFinancialChange,
}: {
  orderReference: string;
  operationReference: string;
  csrf: string;
  onPending: (pending: boolean) => void;
  onFinancialChange: () => void;
}) {
  const [message, setMessage] = useState(""),
    // WP-2423: refused on an unconfirmed PIN sign-in; the same check is retried after.
    [signIn, setSignIn] = useState(false),
    [active, setActive] = useState(false),
    [unknown, setUnknown] = useState(false);
  const reconcile = useRef<ReturnType<typeof client.prepareReconciliation> | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    if (active || unknown) window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, unknown]);
  async function execute() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setActive(true);
    setMessage("");
    setSignIn(false);
    onPending(true);
    try {
      reconcile.current ??= client.prepareReconciliation({
        operationReference,
        orderReference,
        observationReference: serviceOperationReference(),
        auditReference: serviceOperationReference(),
      });
      const outcome = await reconcile.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setUnknown(false);
        onFinancialChange();
        onPending(false);
        reconcile.current = null;
        setMessage(
          outcome.receipt
            ? outcome.receipt.status === "Created"
              ? `Answer checked. Refund receipt version ${outcome.receipt.version} created. Check execution status to see the refunded amount.`
              : `Answer checked. The receipt on file stays version ${outcome.receipt.version} (${outcome.receipt.kind}); no new receipt was created. Check execution status to see the refunded amount.`
            : "Answer checked. Check execution status to see the refunded amount.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const uncertain =
          !(error instanceof OrdinaryRefundExecutionError) || error.code === "OutcomeUnknown";
        setUnknown(uncertain);
        onPending(uncertain);
        setSignIn(needsFullSignIn(error));
        setMessage(
          needsFullSignIn(error)
            ? ""
            : uncertain
              ? "The check did not finish. Keep this page open and retry the same check."
              : error instanceof OrdinaryRefundExecutionError && error.code === "PermissionDenied"
                ? "Your session or permissions do not allow this check. Sign in again, then retry."
                : "Checking refunds is not set up for this store. Contact the pilot operator.",
        );
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setActive(false);
    }
  }
  return (
    <section aria-label="Refund result">
      <button disabled={active} onClick={() => void execute()}>
        {unknown ? "Retry the same check" : "Check refund result and receipt"}
      </button>
      {active ? <p role="status">Checking the card provider&apos;s answer…</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {signIn ? <FullSignInPrompt csrf={csrf} /> : null}
    </section>
  );
}
