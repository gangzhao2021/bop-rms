import { t } from "./i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { StepUpVerification } from "./StepUpVerification.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createSoleOperatorClient,
  SoleOperatorClientError,
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
    return t("On, but it has no effect for you. You don't hold refund approval at this store.");
  if (view.refundApproval.status === "Effective")
    return t(
      "On and in effect. You are the only person who can approve refunds at this store, so you may approve your own after confirming it is you.",
    );
  const named = others(view);
  return t(
    "On, but not in effect. {named} also {value} refund approval at this store, so a second person is required.",
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
  onHidden,
}: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
  /** b18: told when this person isn't shown the setting (only the Brand Owner is). */
  readonly onHidden?: (() => void) | undefined;
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
  // b18: the newest changes show; "Show all" lists them, and earlier ones are read page by page
  // until the record's first change ("show all must reach every record").
  const [allChanges, setAllChanges] = useState(false);
  const [earlier, setEarlier] = useState<SoleOperatorView["history"]>([]);
  const [readingEarlier, setReadingEarlier] = useState<"idle" | "reading" | "failed">("idle");
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
        setEarlier([]);
        setReadingEarlier("idle");
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
  useEffect(() => {
    if (status === "Hidden") onHidden?.();
  }, [status, onHidden]);
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
  const loadedChanges = [...view.history, ...earlier];
  const listedChanges = allChanges ? loadedChanges : view.history.slice(0, shownChanges);
  const oldestLoaded = loadedChanges.at(-1)?.version ?? 1;
  const readEarlier = async () => {
    if (readingEarlier === "reading" || oldestLoaded <= 1) return;
    setReadingEarlier("reading");
    try {
      const page = await client.current.read(undefined, oldestLoaded);
      if (page === null) throw new SoleOperatorClientError("Denied");
      setEarlier((old) => [
        ...old,
        ...page.history.filter((entry) => entry.version < oldestLoaded),
      ]);
      setReadingEarlier("idle");
    } catch {
      setReadingEarlier("failed");
    }
  };
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
      {/* b18 polish (Owner 2026-11-14): one short lead, the full list behind "What this covers",
          and where the setting stands now as one sentence. */}
      <p>
        {t(
          "When it is on and there is no second person, you can approve your own refunds, prices, menus and other things that need approval.",
        )}
      </p>
      <details className="sole-operator__covers">
        <summary>{t("What this covers")}</summary>
        <p>
          {t(
            "For a business run by one owner with no one else who can approve. When it is on and you are the only person who can approve, you may approve your own changes: refunds that need approval (over $100, from an earlier business day or more than 24 hours after payment), new prices (price books and option prices), menus, recipes (including option recipes) and the allergen list, staff roles (giving someone a role), and the Store’s configuration (Store setup, opening hours and the receipt template) before you publish it. You still confirm with your authenticator code, every approval is recorded as approved by you alone, and the day-end settlement shows your own refund approvals for your review.",
          )}
        </p>
      </details>
      <p className="sole-operator__now">{t("Now: {status}", { status: effectText(view) })}</p>
      {/* WP-2423 (2026-10-16 v15): who turned it on or off, when and why — newest first. */}
      {view.history.length > 0 ? (
        <section aria-labelledby="sole-operator-history-heading" className="sole-operator-history">
          <h3 id="sole-operator-history-heading">{t("Recent changes")}</h3>
          <ol>
            {listedChanges.map((entry) => (
              <li key={entry.version}>{soleOperatorChangeText(entry)}</li>
            ))}
          </ol>
          {allChanges && listedChanges.length < view.changeCount ? (
            <p>
              {t("Showing {shown} of {count} changes.", {
                shown: listedChanges.length,
                count: view.changeCount,
              })}
            </p>
          ) : null}
          {readingEarlier === "failed" ? (
            <p role="status">{t("The earlier changes could not be read. Try again.")}</p>
          ) : null}
          {view.changeCount > shownChanges ? (
            <p className="card-actions">
              {allChanges && oldestLoaded > 1 ? (
                <button
                  type="button"
                  className="sole-operator-history__toggle"
                  disabled={readingEarlier === "reading"}
                  onClick={() => void readEarlier()}
                >
                  {readingEarlier === "reading" ? t("Loading…") : t("Show earlier changes")}
                </button>
              ) : null}
              <button
                type="button"
                className="sole-operator-history__toggle"
                aria-expanded={allChanges}
                onClick={() => setAllChanges((value) => !value)}
              >
                {allChanges
                  ? t("Show fewer")
                  : t("Show all {count} changes", { count: view.changeCount })}
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
      {/* Not a form: the verification dialog holds its own form and must not nest in one.
          b18 review (v3): one action at a time, on one line under the reason — "Verify to turn it
          on" until the authenticator code is confirmed, then the one solid button that does it. */}
      <div className="sole-operator__change">
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
        <div className="sole-operator__action">
          <StepUpVerification
            purpose="SoleOperatorSetting"
            csrf={csrf}
            verifiedUntil={verifiedUntil}
            onVerified={onVerified}
            loadServerStatus={false}
            label={t("Verify to turn it {value}", { value: target === "On" ? t("on") : t("off") })}
            fetcher={fetcher}
          />
          {verified ? (
            <button
              type="button"
              onClick={() => void submit()}
              data-variant="primary"
              disabled={busy || reason === ""}
            >
              {busy
                ? t("Saving…")
                : target === "On"
                  ? t("Turn on sole operator")
                  : t("Turn off sole operator")}
            </button>
          ) : null}
        </div>
      </div>
      {fullSignIn ? <FullSignInPrompt csrf={csrf} fetcher={fetcher} /> : null}
      {message ? <p role={message.tone === "alert" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}

/**
 * Owner 2026-10-25: the sole-operator setting sits with the Store's settings (Store setup), not on
 * the Approvals list. The panel keeps its own verification for the person signed in.
 */
export function StoreSoleOperatorPanel({
  csrf,
  fetcher,
  onHidden,
}: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
  readonly onHidden?: () => void;
}) {
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(null);
  return (
    <SoleOperatorSection
      csrf={csrf}
      fetcher={fetcher}
      verifiedUntil={verifiedUntil}
      onVerified={setVerifiedUntil}
      onHidden={onHidden}
    />
  );
}
