import { systemText, t } from "./i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { StepUpVerification } from "./StepUpVerification.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createSoleOperatorClient,
  SoleOperatorClientError,
  soleOperatorEarlierChangeCount,
  soleOperatorReasonLabel,
  soleOperatorReasons,
  type SoleOperatorReason,
  type SoleOperatorView,
} from "./sole-operator-client.js";

const others = (view: SoleOperatorView) => {
  const names = view.refundApproval.otherApprovers.map(
    (person) => person.displayName ?? t("Another staff member"),
  );
  return names.length <= 1
    ? (names[0] ?? t("Another staff member"))
    : names.slice(0, -1).join(", ") + " and " + names.at(-1);
};

/** One recorded change in plain words: "Turned off by you · Someone else can now approve · <time>". */
function soleOperatorChangeText(entry: SoleOperatorView["history"][number]) {
  return (
    <>
      {t("Turned {value} by {value2} · {value3} ·", {
        value: entry.state === "On" ? t("on") : t("off"),
        value2: entry.changedByYou ? t("you") : (entry.changedByName ?? t("the brand owner")),
        value3: soleOperatorReasonLabel[entry.reasonCode],
      })}{" "}
      <SourceTime instant={entry.recordedAt} />
    </>
  );
}

/** Why sole operator is (or isn't) letting the Owner approve their own refunds right now. */
function effectText(view: SoleOperatorView): string {
  if (view.state === "Off")
    return t("Off. Refunds that need approval are approved by a second owner or finance member.");
  if (!view.refundApproval.youHoldApproval)
    return t("On, but you don't hold refund approval at this store, so it has no effect for you.");
  if (view.refundApproval.status === "Effective")
    return t(
      "On and in effect: you are the only person who can approve refunds at this store, so you may approve your own after confirming it is you.",
    );
  const named = others(view);
  return t(
    "On, but not in effect: {named} also {value} refund approval at this store, so a second person is required.",
    { named: named, value: view.refundApproval.otherApprovers.length === 1 ? "holds" : "hold" },
  );
}

/**
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the Brand Owner's sole-operator setting, shown on the
 * Approvals page (Section 88 APPROVAL-INBOX) to the Brand Owner only. Turning it on or off needs a
 * reason and an authenticator check in the last 15 minutes; each change is recorded and audited.
 * Staff who are not the Brand Owner see nothing here.
 */
export function SoleOperatorSection({
  csrf,
  fetcher,
  onChanged,
  verifiedUntil,
  onVerified,
}: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
  /** The signed-in member's verification, shared with the rest of the page. */
  readonly verifiedUntil: string | null;
  readonly onVerified: (validUntil: string) => void;
  /** The approval list depends on the setting; refresh it after a change. */
  readonly onChanged?: () => void;
}) {
  const client = useRef(createSoleOperatorClient(fetcher ?? fetch));
  const [view, setView] = useState<SoleOperatorView | null>(null);
  const [status, setStatus] = useState<"Loading" | "Ready" | "Hidden" | "Unavailable">("Loading");
  const [refresh, setRefresh] = useState(0);
  const [reason, setReason] = useState<SoleOperatorReason | "">("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  // A PIN sign-in was refused: show the "Verify it's you" step; the retry keeps the same change.
  const [fullSignIn, setFullSignIn] = useState(false);
  // One identity per intended change: a retry after an unknown result is recorded once.
  const operation = useRef(serviceOperationReference());
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void client.current
      .read(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value === null) {
          setStatus("Hidden");
          return;
        }
        setView(value);
        if (value.verifiedUntil !== null) onVerified(value.verifiedUntil);
        setStatus("Ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus(
          error instanceof SoleOperatorClientError && error.code === "Denied"
            ? "Hidden"
            : "Unavailable",
        );
      });
    return () => controller.abort();
    // onVerified only shares a newer verification; the read follows refresh alone.
  }, [refresh]);
  if (status === "Hidden" || status === "Loading") return null;
  if (status === "Unavailable" || view === null)
    return (
      <section aria-labelledby="sole-operator-heading" className="sole-operator">
        <h2 id="sole-operator-heading">{t("Sole operator")}</h2>
        <StatePanel heading={t("Setting could not be loaded")} tone="error" status>
          <p>{t("Check your connection, then refresh.")}</p>
        </StatePanel>
      </section>
    );
  const target = view.state === "On" ? "Off" : "On";
  const shownChanges = 5;
  const earlierChanges = soleOperatorEarlierChangeCount(view, shownChanges);
  const verified = verifiedUntil !== null && Date.parse(verifiedUntil) > Date.now();
  const submit = async () => {
    if (busy || reason === "" || !verified) return;
    setBusy(true);
    setMessage(null);
    setFullSignIn(false);
    try {
      const result = await client.current.change(
        {
          state: target,
          reasonCode: reason,
          expectedVersion: view.version,
          operationReference: operation.current,
        },
        csrf,
      );
      operation.current = serviceOperationReference();
      setReason("");
      setMessage({
        tone: "status",
        text:
          result.state === "On" ? t("Sole operator turned on.") : t("Sole operator turned off."),
      });
      reload();
      onChanged?.();
    } catch (error) {
      const code = error instanceof SoleOperatorClientError ? error.code : "OutcomeUnknown";
      if (code === "FullSignInRequired") {
        // Nothing was recorded; keep the same change so "Try again" after verifying sends it once.
        setFullSignIn(true);
        return;
      }
      if (code !== "OutcomeUnknown") operation.current = serviceOperationReference();
      setMessage({
        tone: "alert",
        text:
          code === "NeedsReverification"
            ? t("Confirm it is you with your authenticator code, then try again.")
            : code === "Changed" || code === "NoChange"
              ? t(
                  "The setting changed since it was shown. It has been refreshed — check it and try again.",
                )
              : code === "Denied"
                ? t(
                    "Only the brand owner can change this setting. Sign in again if your session ended.",
                  )
                : code === "OutcomeUnknown"
                  ? t("Result unknown. Try again — the change is recorded once.")
                  : t("The change could not be sent. Check your connection and try again."),
      });
      if (code === "Changed" || code === "NoChange") reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="sole-operator-heading" className="sole-operator">
      <h2 id="sole-operator-heading">{t("Sole operator")}</h2>
      <p>
        {t(
          "For a business run by one owner with no one else who can approve. When it is on and you are the only person who can approve, you may approve your own changes: refunds that need approval (over $100, from an earlier business day or more than 24 hours after payment), new prices (price books and option prices), menus, recipes (including option recipes) and the allergen list, and the Store’s configuration (Store setup, opening hours and the receipt template) before you publish it. You still confirm with your authenticator code, every approval is recorded as approved by you alone, and the day-end settlement shows your own refund approvals for your review.",
        )}
      </p>
      <dl>
        <div>
          <dt>{t("Sole operator")}</dt>
          <dd>
            <strong>{systemText(view.state)}</strong>
            {view.version > 0 ? t(" · setting change {version}", { version: view.version }) : ""}
          </dd>
        </div>
        <div>
          <dt>{t("Refund approval")}</dt>
          <dd>{effectText(view)}</dd>
        </div>
      </dl>
      {/* WP-2423 (2026-10-16 v15): who turned it on or off, when and why — newest first. */}
      {view.history.length > 0 ? (
        <section aria-labelledby="sole-operator-history-heading" className="sole-operator-history">
          <h3 id="sole-operator-history-heading">{t("Recent changes")}</h3>
          <ol>
            {view.history.slice(0, shownChanges).map((entry) => (
              <li key={entry.version}>
                {t("Change")} {entry.version}: {soleOperatorChangeText(entry)}
              </li>
            ))}
          </ol>
          {earlierChanges > 0 ? (
            <p>
              {t("{earlierChanges} earlier {value} kept in the record.", {
                earlierChanges: earlierChanges,
                value: earlierChanges === 1 ? t("change is") : t("changes are"),
              })}
            </p>
          ) : null}
        </section>
      ) : null}
      {/* Not a form: the verification dialog holds its own form and must not nest in one. */}
      <div className="card-actions">
        <label htmlFor="sole-operator-reason">
          {t("Reason for turning it {value}", { value: target === "On" ? t("on") : t("off") })}
        </label>
        <select
          id="sole-operator-reason"
          required
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.currentTarget.value as SoleOperatorReason | "")}
        >
          <option value="">{t("Select a reason")}</option>
          {soleOperatorReasons[target].map((code) => (
            <option key={code} value={code}>
              {soleOperatorReasonLabel[code]}
            </option>
          ))}
        </select>
        <StepUpVerification
          purpose="SoleOperatorSetting"
          csrf={csrf}
          verifiedUntil={verifiedUntil}
          onVerified={onVerified}
          loadServerStatus={false}
          label={t("Verify to turn it {value}", { value: target === "On" ? t("on") : t("off") })}
          fetcher={fetcher}
        />
        <button
          type="button"
          onClick={() => void submit()}
          data-variant={target === "On" ? "primary" : undefined}
          disabled={busy || reason === "" || !verified}
        >
          {busy
            ? t("Saving…")
            : target === "On"
              ? t("Turn on sole operator")
              : t("Turn off sole operator")}
        </button>
      </div>
      {fullSignIn ? <FullSignInPrompt csrf={csrf} fetcher={fetcher} /> : null}
      {message ? <p role={message.tone === "alert" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}
