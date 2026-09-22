import { useEffect, useRef, useState } from "react";
import {
  createCompensationReconciliationClient,
  type CompensationView,
} from "./compensation-reconciliation-client.js";
import { serviceOperationReference } from "./service-control-client.js";
const client = createCompensationReconciliationClient();
export function CompensationReconciliationAction({
  orderReference,
  caseReference,
  csrf,
  readOnly,
}: {
  orderReference: string;
  caseReference: string;
  csrf: string;
  readOnly: boolean;
}) {
  const [view, setView] = useState<CompensationView | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [unknown, setUnknown] = useState(false),
    [recorded, setRecorded] = useState(false),
    [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const pending = useRef<AbortController | null>(null),
    intent = useRef<ReturnType<typeof client.prepare> | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      pending.current?.abort();
    };
  }, []);
  async function load() {
    if (pending.current || unknown || !online) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setView(null);
    setConfirmed(false);
    setMessage("");
    try {
      const result = await client.query({ orderReference, caseReference }, csrf, controller.signal);
      if (!controller.signal.aborted) {
        setView(result);
        setRecorded(result.acknowledgmentRecorded);
        intent.current = null;
      }
    } catch {
      if (!controller.signal.aborted)
        setMessage(
          "Confirmed refund unavailable. Refresh when the refund is confirmed and your access is current.",
        );
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function submit() {
    if (pending.current || !view || !confirmed || readOnly || !online || recorded) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      intent.current ??= client.prepare({
        orderReference,
        caseReference,
        receiptReference: serviceOperationReference(),
        auditReference: serviceOperationReference(),
        expectedCaseVersion: view.caseVersion,
      });
      await intent.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setUnknown(false);
        setRecorded(true);
        setMessage(
          "Operations reconciliation recorded. Refresh the workbench to check case closure.",
        );
      }
    } catch {
      if (!controller.signal.aborted) {
        setUnknown(true);
        setMessage(
          "Result unknown. Keep this page open and retry the same acknowledgment after restoring your connection and access.",
        );
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const amount = view
    ? "CAD " +
      (BigInt(view.refund.amountMinor) / 100n).toString() +
      "." +
      (BigInt(view.refund.amountMinor) % 100n).toString().padStart(2, "0")
    : "";
  return (
    <section aria-label="Compensation reconciliation">
      <button disabled={busy || unknown || !online} onClick={() => void load()}>
        Review confirmed refund
      </button>
      {!online ? <p role="status">Offline — reconciliation is read-only.</p> : null}
      {view ? (
        <>
          <p>
            Confirmed refund: {amount} · {view.refund.confirmedAt}
          </p>
          <p>Case: {view.caseState}</p>
          {recorded ? (
            <p role="status">
              Operator acknowledgment recorded. Case closure is checked separately.
            </p>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || unknown || readOnly || !online}
                  onChange={(e) => setConfirmed(e.currentTarget.checked)}
                />
                I have reviewed this confirmed refund and reconciled this case
              </label>
              <button
                disabled={busy || !confirmed || readOnly || !online}
                onClick={() => void submit()}
              >
                {unknown ? "Retry same acknowledgment" : "Record operations reconciliation"}
              </button>
            </>
          )}
        </>
      ) : null}
      {busy ? <p role="status">Reading or recording current reconciliation…</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
