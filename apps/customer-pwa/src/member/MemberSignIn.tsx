import { useState } from "react";
import { t, useLanguage } from "../i18n/i18n.js";
import { MemberClientError, type MemberClient } from "./member-client.js";

/** What went wrong with a code, in the guest's words. */
export function memberCodeProblem(error: unknown, until: string | null): string {
  const code = error instanceof MemberClientError ? error.code : "member_unavailable";
  const later =
    until === null
      ? null
      : t(
          "The points for this order are still yours. Open this receipt on this phone before {time} to finish.",
          {
            time: new Date(until).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          },
        );
  const withLater = (text: string) => (later === null ? text : text + " " + later);
  if (code === "member_phone_invalid") return t("Enter a 10-digit Canadian or US mobile number.");
  if (code === "member_code_wrong")
    return t("That code isn’t right. Check the text and try again.");
  if (code === "member_code_ended") return t("That code has ended. Ask for a new one.");
  if (code === "member_rate_limited") {
    const minutes =
      error instanceof MemberClientError && error.retryAfterSeconds !== null
        ? Math.max(1, Math.ceil(error.retryAfterSeconds / 60))
        : 60;
    return withLater(
      t("Too many tries for now. Try again in {minutes} min.", { minutes: String(minutes) }),
    );
  }
  if (code === "member_not_offered") return t("This restaurant doesn’t offer points right now.");
  if (code === "member_code_unavailable") return withLater(t("We can’t send a code right now."));
  return withLater(t("We couldn’t do that. Check your connection and try again."));
}

/**
 * A phone number and a text code. Why the number is wanted is said before it is asked for, and the
 * offers box is separate and starts unticked.
 */
export function MemberSignIn({
  client,
  until,
  askConsent,
  submitLabel,
  verify,
}: {
  readonly client: MemberClient;
  /** When the points for this order can still be claimed; null with no order in hand. */
  readonly until: string | null;
  readonly askConsent: boolean;
  readonly submitLabel: string;
  verify(input: { phone: string; code: string; marketingConsent: boolean }): Promise<void>;
}) {
  useLanguage();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await client.sendCode(phone);
      setSent(true);
    } catch (error) {
      setProblem(memberCodeProblem(error, until));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await verify({ phone, code, marketingConsent: consent });
    } catch (error) {
      if (error instanceof MemberClientError && error.code === "member_code_ended") {
        setSent(false);
        setCode("");
      }
      setProblem(memberCodeProblem(error, until));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="member-form"
      onSubmit={(event) => {
        event.preventDefault();
        void (sent ? confirm() : send());
      }}
    >
      <p className="member-form__why">
        {t(
          "We use your phone number only to text you a sign-in code and to tell you before your points expire. You can leave and delete it any time.",
        )}
      </p>
      <label>
        {t("Mobile number")}
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          disabled={sent}
          onChange={(event) => setPhone(event.target.value)}
          required
        />
      </label>
      {askConsent ? (
        <label className="member-form__consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />{" "}
          {t("Also text me offers from this restaurant. Optional; you can stop any time.")}
        </label>
      ) : null}
      {sent ? (
        <label>
          {t("Code from the text")}
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>
      ) : null}
      {problem === null ? null : <p role="alert">{problem}</p>}
      <div className="member-form__actions">
        <button type="submit" disabled={busy}>
          {sent ? submitLabel : t("Text me a code")}
        </button>
        {sent ? (
          <button type="button" disabled={busy} onClick={() => void send()}>
            {t("Send another code")}
          </button>
        ) : null}
      </div>
    </form>
  );
}
