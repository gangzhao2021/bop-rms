import { useEffect, useRef, useState } from "react";
import {
  createOrdinaryRefundExecutionClient,
  OrdinaryRefundExecutionError,
} from "./ordinary-refund-execution-client.js";
import { serviceOperationReference } from "./service-control-client.js";
const client = createOrdinaryRefundExecutionClient();
export function RefundExecutionAction({
  orderReference,
  requestReference,
  operationReference,
  phase,
  amountLabel,
  csrf,
  onPending,
  onFinancialChange,
}: {
  orderReference: string;
  requestReference: string;
  operationReference: string;
  phase: "Prepared" | "NeedsReconciliation" | "Confirmed";
  amountLabel: string;
  csrf: string;
  onPending: (pending: boolean) => void;
  onFinancialChange: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState("");
  const [active, setActive] = useState<"send" | "reconcile" | null>(null),
    [unknown, setUnknown] = useState<"send" | "reconcile" | null>(null),
    [sent, setSent] = useState(phase !== "Prepared");
  const send = useRef<ReturnType<typeof client.prepareSend> | null>(null),
    reconcile = useRef<ReturnType<typeof client.prepareReconciliation> | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    if (active || unknown) window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, unknown]);
  async function execute(kind: "send" | "reconcile") {
    if (
      pending.current ||
      (unknown !== null && unknown !== kind) ||
      (kind === "send" && (!confirmed || sent))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setActive(kind);
    setMessage("");
    onPending(true);
    try {
      const intent =
        kind === "send"
          ? (send.current ??= client.prepareSend({
              operationReference,
              orderReference,
              requestReference,
              dispatchReference: serviceOperationReference(),
              auditReference: serviceOperationReference(),
              approvalReference: null,
            }))
          : (reconcile.current ??= client.prepareReconciliation({
              operationReference,
              orderReference,
              observationReference: serviceOperationReference(),
              auditReference: serviceOperationReference(),
            }));
      const outcome = await intent.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setUnknown(null);
        onFinancialChange();
        onPending(false);
        if (kind === "send") setSent(true);
        else reconcile.current = null;
        setMessage(
          kind === "send"
            ? "Dispatch recorded. Check the refund result before reporting completion."
            : "receipt" in outcome && outcome.receipt
              ? outcome.receipt.status === "Created"
                ? `Reconciliation recorded. Refund receipt version ${outcome.receipt.version} created. Refresh execution status to check the refund amount.`
                : `Reconciliation recorded. Existing receipt version ${outcome.receipt.version} (${outcome.receipt.kind}); no new receipt created. Refresh execution status to check the refund amount.`
              : "Reconciliation recorded. Refresh execution status.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const uncertain =
          !(error instanceof OrdinaryRefundExecutionError) || error.code === "OutcomeUnknown";
        setUnknown(uncertain ? kind : null);
        onPending(uncertain);
        setMessage(
          uncertain
            ? "Result unknown. Keep this page open and retry the same operation."
            : error instanceof OrdinaryRefundExecutionError && error.code === "PermissionDenied"
              ? "Current session or permission does not allow this action. Restore access before retrying."
              : "Refund execution is not configured. Contact the pilot operator.",
        );
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setActive(null);
    }
  }
  return (
    <section aria-label="Refund execution">
      {!sent ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={active !== null || unknown !== null}
              onChange={(e) => setConfirmed(e.currentTarget.checked)}
            />
            I confirm sending this {amountLabel} refund to the original payment method
          </label>
          <button
            disabled={active !== null || !confirmed || (unknown !== null && unknown !== "send")}
            onClick={() => void execute("send")}
          >
            {unknown === "send" ? "Retry same refund send" : "Send refund"}
          </button>
        </>
      ) : null}
      {sent ? (
        <button
          disabled={active !== null || (unknown !== null && unknown !== "reconcile")}
          onClick={() => void execute("reconcile")}
        >
          {unknown === "reconcile"
            ? "Retry same refund reconciliation"
            : "Check refund result and receipt"}
        </button>
      ) : null}
      {active ? (
        <p role="status">{active === "send" ? "Sending refund…" : "Checking refund result…"}</p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
