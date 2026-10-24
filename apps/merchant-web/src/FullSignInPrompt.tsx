import { t } from "./i18n/i18n.js";
import { useState } from "react";
import { PIN_ELEVATION_EXPLANATION } from "./StaffPinControls.js";
import { StaffSwitchButton } from "./StaffSession.js";
import { StepUpVerification } from "./StepUpVerification.js";
import { FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import type { StaffSessionClient } from "./staff-session.js";

/**
 * WP-2423: shown in place of a "no permission" message when a sensitive change was refused because
 * the person signed in with a PIN. They confirm it is them with their authenticator app (valid on
 * this PIN sign-in until the time shown) and try again, or sign out and sign in with their account.
 */
export function FullSignInPrompt({
  csrf,
  fetcher,
  sessionClient,
  onVerified,
}: {
  readonly csrf: string;
  /** For the authenticator check (tests). */
  readonly fetcher?: typeof fetch | undefined;
  /** For the sign-out (tests). */
  readonly sessionClient?: StaffSessionClient | undefined;
  readonly onVerified?: ((validUntil: string) => void) | undefined;
}) {
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(null);
  return (
    <section className="full-sign-in-prompt" aria-label={t("Confirm it's you")}>
      <p>{verifiedUntil === null ? FULL_SIGN_IN_REQUIRED_TEXT : t("Verified. Try again now.")}</p>
      <StepUpVerification
        purpose="PinSessionElevation"
        csrf={csrf}
        verifiedUntil={verifiedUntil}
        onVerified={(until) => {
          setVerifiedUntil(until);
          onVerified?.(until);
        }}
        label={t("Verify it's you")}
        hint={false}
        fetcher={fetcher}
        loadServerStatus={false}
        explanation={PIN_ELEVATION_EXPLANATION}
      />
      {verifiedUntil === null ? (
        <StaffSwitchButton
          label={t("Sign out and sign in with your account")}
          {...(sessionClient ? { client: sessionClient } : {})}
        />
      ) : null}
    </section>
  );
}
