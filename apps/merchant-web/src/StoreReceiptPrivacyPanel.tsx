import { t } from "./i18n/i18n.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createStoreReceiptProfileClient,
  StoreReceiptProfileClientError,
  type StoreReceiptProfileView,
} from "./store-receipt-profile-client.js";
import { ReceiptSetupNotice } from "./StoreTaxReviewPage.js";
import { SourceTime } from "./StoreTime.js";

/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): Store setup → "Receipts and privacy". The Owner
 * enters the sales-tax registration numbers printed on customer receipts and the link to the
 * Store's privacy notice shown at checkout and on receipts. Staff who can open Store setup see what
 * is entered and what is missing. Only the Owner's own facts are used; nothing is filled in.
 */
interface Fields {
  gstHstNumber: string;
  qstNumber: string;
  pstNumber: string;
  privacyNoticeUrl: string;
}
const empty: Fields = { gstHstNumber: "", qstNumber: "", pstNumber: "", privacyNoticeUrl: "" };
const fieldsOf = (view: StoreReceiptProfileView): Fields => ({
  gstHstNumber: view.details.gstHstNumber ?? "",
  qstNumber: view.details.qstNumber ?? "",
  pstNumber: view.details.pstNumber ?? "",
  privacyNoticeUrl: view.details.privacyNoticeUrl ?? "",
});

/** The same shapes the server enforces, so mistakes are shown next to the field. */
export function receiptPrivacyFieldErrors(fields: Fields): Partial<Record<keyof Fields, string>> {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const compact = (value: string) => value.trim().toUpperCase().replace(/\s/gu, "");
  if (
    fields.gstHstNumber.trim() !== "" &&
    !/^[0-9]{9}RT[0-9]{4}$/u.test(compact(fields.gstHstNumber))
  )
    errors.gstHstNumber = t(
      "Enter the 15-character number from the Canada Revenue Agency: 9 digits, RT, 4 digits (for example 123456789RT0001).",
    );
  if (fields.qstNumber.trim() !== "" && !/^[0-9]{10}TQ[0-9]{4}$/u.test(compact(fields.qstNumber)))
    errors.qstNumber = t(
      "Enter the 16-character number from Revenu Québec: 10 digits, TQ, 4 digits (for example 1234567890TQ0001).",
    );
  if (
    fields.pstNumber.trim() !== "" &&
    !/^[A-Z0-9][A-Z0-9 -]{2,30}[A-Z0-9]$/u.test(
      fields.pstNumber.trim().toUpperCase().replace(/\s+/gu, " "),
    )
  )
    errors.pstNumber = t(
      "Enter the provincial number exactly as issued (letters, digits, hyphens).",
    );
  const url = fields.privacyNoticeUrl.trim();
  if (url !== "") {
    let ok: boolean;
    try {
      const parsed = new URL(url);
      ok =
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.hostname.includes(".") &&
        url.length <= 500 &&
        !/[\s<>"]/u.test(url);
    } catch {
      ok = false;
    }
    if (!ok)
      errors.privacyNoticeUrl = t(
        "Enter the full web address of your privacy notice, starting with https://",
      );
  }
  return errors;
}

export function StoreReceiptPrivacyPanel({
  csrf,
  client: injected,
}: {
  readonly csrf: string;
  readonly client?: ReturnType<typeof createStoreReceiptProfileClient>;
}) {
  const client = useMemo(
    () => injected ?? createStoreReceiptProfileClient({ csrf }),
    [injected, csrf],
  );
  const [view, setView] = useState<StoreReceiptProfileView | null>(null);
  const [status, setStatus] = useState<"Loading" | "Ready" | "Hidden" | "Unavailable">("Loading");
  const [fields, setFields] = useState<Fields>(empty);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  // One operation per intended save: a lost answer is retried as the same save.
  const operation = useRef<{ reference: string; fields: Fields } | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await client.load();
      setView(next);
      setFields(fieldsOf(next));
      setStatus("Ready");
    } catch (error) {
      setStatus(
        error instanceof StoreReceiptProfileClientError && error.code === "PermissionDenied"
          ? "Hidden"
          : "Unavailable",
      );
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  if (status === "Hidden") return null;
  if (status === "Loading")
    return (
      <section id="receipts-and-privacy" className="receipt-privacy" aria-busy="true">
        <h3>{t("Receipts and privacy")}</h3>
        <p role="status">{t("Loading receipt and privacy details…")}</p>
      </section>
    );
  if (status === "Unavailable" || view === null)
    return (
      <section
        id="receipts-and-privacy"
        className="receipt-privacy"
        aria-labelledby="receipt-privacy-heading"
      >
        <h3 id="receipt-privacy-heading">{t("Receipts and privacy")}</h3>
        <StatePanel
          heading={t("Receipt and privacy details could not be loaded")}
          tone="error"
          status
        >
          <p>{t("Check your connection, then try again.")}</p>
          <button type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </StatePanel>
      </section>
    );
  const errors = receiptPrivacyFieldErrors(fields);
  const invalid = Object.keys(errors).length > 0;
  const submit = async () => {
    if (busy) return;
    setShowErrors(true);
    if (invalid) return;
    const same =
      operation.current !== null &&
      (Object.keys(fields) as (keyof Fields)[]).every(
        (key) => operation.current?.fields[key] === fields[key],
      );
    if (!same) operation.current = { reference: serviceOperationReference(), fields };
    const pending = operation.current;
    if (pending === null) return;
    setBusy(true);
    setMessage(null);
    const value = (text: string) => (text.trim() === "" ? null : text.trim());
    try {
      await client.save({
        expectedVersion: view.version,
        operationReference: pending.reference,
        details: {
          gstHstNumber: value(fields.gstHstNumber),
          qstNumber: value(fields.qstNumber),
          pstNumber: value(fields.pstNumber),
          privacyNoticeUrl: value(fields.privacyNoticeUrl),
        },
      });
      operation.current = null;
      setShowErrors(false);
      setMessage({
        tone: "status",
        text: t(
          "Saved. Receipts issued from now on show these details; receipts already issued are not changed.",
        ),
      });
      await load();
    } catch (error) {
      const code = error instanceof StoreReceiptProfileClientError ? error.code : "OutcomeUnknown";
      if (code !== "OutcomeUnknown") operation.current = null;
      setMessage({
        tone: "alert",
        text:
          code === "Invalid"
            ? t("Check the highlighted details and try again.")
            : code === "Conflict"
              ? t(
                  "Someone changed these details since you opened this page. They have been reloaded — check them and save again.",
                )
              : code === "NoChange"
                ? t("Nothing changed — these details are already saved.")
                : code === "PermissionDenied"
                  ? t(
                      "Only the Owner can change these details. Sign in again if your session ended.",
                    )
                  : code === "OutcomeUnknown"
                    ? t("We could not confirm the save. Try again — it is recorded once.")
                    : t("The details could not be saved. Check your connection and try again."),
      });
      if (code === "Conflict") await load();
    } finally {
      setBusy(false);
    }
  };
  const field = (
    key: keyof Fields,
    label: string,
    hint: string,
    options: { type?: string; inputMode?: "text" | "url"; autoComplete?: string } = {},
  ) => {
    const error = showErrors ? errors[key] : undefined;
    const id = "receipt-privacy-" + key;
    return (
      <div className="receipt-privacy__field">
        <label htmlFor={id}>{label}</label>
        <p id={id + "-hint"} className="receipt-privacy__hint">
          {hint}
        </p>
        <input
          id={id}
          type={options.type ?? "text"}
          inputMode={options.inputMode ?? "text"}
          autoComplete="off"
          spellCheck={false}
          value={fields[key]}
          readOnly={!view.canChange}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={id + "-hint" + (error ? " " + id + "-error" : "")}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setFields((current) => ({ ...current, [key]: next }));
          }}
        />
        {error ? (
          <p id={id + "-error"} className="receipt-privacy__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  };
  return (
    <section
      id="receipts-and-privacy"
      className="receipt-privacy"
      aria-labelledby="receipt-privacy-heading"
    >
      <h3 id="receipt-privacy-heading">{t("Receipts and privacy")}</h3>
      <p>
        {t(
          "Customer receipts show your business name, the store address, each tax with its rate, and the registration numbers below. Customers see your privacy notice link where they enter their contact details and on their receipt. Enter only your own registered numbers and notice; leave a number empty if the business is not registered for that tax.",
        )}
      </p>
      <ReceiptSetupNotice gaps={view.gaps} />
      {view.recordedAt !== null ? (
        <p className="receipt-privacy__hint">
          {t("Last saved")} <SourceTime instant={view.recordedAt} />
        </p>
      ) : null}
      {!view.canChange ? <p role="note">{t("Only the Owner can change these details.")}</p> : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {field(
          "gstHstNumber",
          t("GST/HST registration number"),
          t("From the Canada Revenue Agency, e.g. 123456789RT0001."),
        )}
        {field(
          "qstNumber",
          t("QST registration number (Québec only)"),
          t("From Revenu Québec, e.g. 1234567890TQ0001. Leave empty outside Québec."),
        )}
        {field(
          "pstNumber",
          t("PST registration number (BC, Saskatchewan or Manitoba only)"),
          t("As issued by the province. Leave empty if you do not charge PST."),
        )}
        {field(
          "privacyNoticeUrl",
          t("Privacy notice link"),
          t(
            "The web address of your own privacy notice (how you use and delete customer contact details).",
          ),
          { type: "url", inputMode: "url" },
        )}
        {view.canChange ? (
          <div className="card-actions">
            <button type="submit" data-variant="primary" disabled={busy}>
              {busy ? t("Saving…") : t("Save receipt and privacy details")}
            </button>
          </div>
        ) : null}
      </form>
      {message ? <p role={message.tone === "alert" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}
