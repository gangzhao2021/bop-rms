import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { useEffect, useRef, useState } from "react";
import {
  createCompensationReconciliationClient,
  type CompensationView,
} from "./compensation-reconciliation-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { SourceTime } from "./StoreTime.js";
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
  const actionButton = useRef<HTMLButtonElement | null>(null),
    completionAnnouncement = useRef<HTMLParagraphElement | null>(null),
    restoreRetryFocus = useRef(false);
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
  useEffect(() => {
    if (!unknown || busy || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    if (document.activeElement === document.body) actionButton.current?.focus();
  }, [busy, unknown]);
  useEffect(() => {
    if (!recorded || busy || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    if (document.activeElement === document.body) completionAnnouncement.current?.focus();
  }, [busy, recorded]);
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
          t(
            "The confirmed refund could not be read. Refresh once the refund is confirmed and your access is current.",
          ),
        );
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function submit() {
    if (pending.current || !view || !confirmed || readOnly || !online || recorded) return;
    restoreRetryFocus.current = document.activeElement === actionButton.current;
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
          t(
            "Your check of the refund is recorded. Refresh the page to see whether the case is closed.",
          ),
        );
      }
    } catch {
      if (!controller.signal.aborted) {
        setUnknown(true);
        setMessage(
          t(
            "Result unknown. Keep this page open and retry the same acknowledgment after restoring your connection and access.",
          ),
        );
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const amount = view
    ? orderMoney({ amountMinor: view.refund.amountMinor, currencyCode: "CAD" })
    : "";
  return (
    <section aria-label={t("Compensation reconciliation")}>
      <button disabled={busy || unknown || !online} onClick={() => void load()}>
        {t("Review confirmed refund")}
      </button>
      {!online ? <p role="status">{t("Offline — reconciliation is read-only.")}</p> : null}
      {view ? (
        <>
          <p>
            {t("Confirmed refund: {amount} ·", { amount: amount })}{" "}
            <SourceTime instant={view.refund.confirmedAt} />
          </p>
          <p>{t("Case: {caseState}", { caseState: view.caseState })}</p>
          {recorded ? (
            <p role="status">
              {t("Operator acknowledgment recorded. Case closure is checked separately.")}
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
                {t("I have reviewed this confirmed refund and reconciled this case")}
              </label>
              <button
                ref={actionButton}
                disabled={busy || !confirmed || readOnly || !online}
                onClick={() => void submit()}
              >
                {unknown ? t("Retry same acknowledgment") : t("Record operations reconciliation")}
              </button>
            </>
          )}
        </>
      ) : null}
      {busy ? <p role="status">{t("Reading or recording current reconciliation…")}</p> : null}
      {message ? (
        <p ref={completionAnnouncement} role="status" tabIndex={-1}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
