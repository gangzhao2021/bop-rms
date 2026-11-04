import { t } from "./i18n/i18n.js";
import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { createStaffSessionClient, type SignInEntry } from "./staff-session.js";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: "Staff sign-in". Each staff member signs in with their own
 * account (work email, password and the code from their authenticator app, every time). A kitchen
 * screen starts the kitchen display instead, and a shared store tablet a manager set up switches
 * staff with a PIN. Works without a sign-in; nothing is read here.
 *
 * Operating continuity: signing in needs the network. When it is down, a tablet already signed in
 * keeps its screens; staff sign in once the connection is back (runbook).
 */
export const STAFF_SIGN_IN_PATH = "/operations/sign-in";
export const SIGN_IN_HREF = "/merchant/login?returnTo=/app";
export const KITCHEN_SIGN_IN_HREF = "/merchant/login?returnTo=/operations/kitchen/start";
export const SIGN_IN_FAILED_TEXT = t(
  "We couldn't sign you in. If you were invited, sign in with the email address the invitation was sent to; an invitation expires 7 days after it was sent. If it keeps happening, ask your manager.",
);

/**
 * The sign-in service's own check (it must require the authenticator app) did not pass or could not
 * be read, so no one can sign in with their account for now. Signed-in staff keep working.
 */
export const SIGN_IN_UNAVAILABLE_TEXT = t(
  "Signing in isn't available right now. Staff who are already signed in can keep working, and a shared store tablet still switches staff with a PIN. Try again in a few minutes; if it keeps happening, tell your manager so they can contact BOP support.",
);

export function StaffSignInView({
  failed = false,
  unavailable = false,
  testEntry,
}: {
  readonly failed?: boolean;
  readonly unavailable?: boolean;
  /** The labelled test sign-in, on a pilot without the managed sign-in service. */
  readonly testEntry?: string;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="bop-shell__main staff-switch staff-sign-in">
      <header className="staff-switch__header">
        <p className="staff-switch__brand">
          <strong aria-label="BOP">BOP</strong>
        </p>
        <h1>{t("Staff sign-in")}</h1>
        <LanguageSwitch className="staff-switch__language" />
      </header>
      {failed || unavailable ? (
        <p role="alert" className="staff-switch__message">
          {unavailable ? SIGN_IN_UNAVAILABLE_TEXT : SIGN_IN_FAILED_TEXT}
        </p>
      ) : null}
      <section className="staff-switch__panel">
        <p>{t("Use your work email, your password and the code from your authenticator app.")}</p>
        <a className="staff-switch__action staff-sign-in__primary" href={testEntry ?? SIGN_IN_HREF}>
          {t("Sign in")}
        </a>
        {testEntry ? (
          <p className="staff-session__test-only">
            <strong>{t("TEST-ONLY")}</strong>{" "}
            {t(
              "internal pilot sign-in. A live store signs in with each staff member’s own account.",
            )}
          </p>
        ) : null}
      </section>
      <div className="staff-sign-in__others">
        <section className="staff-sign-in__other" aria-labelledby="staff-sign-in-kitchen">
          <div>
            <h2 id="staff-sign-in-kitchen">{t("Kitchen screen")}</h2>
            <p>{t("Only opens the kitchen, not orders, refunds or settings.")}</p>
          </div>
          <a className="staff-sign-in__link" href={testEntry ?? KITCHEN_SIGN_IN_HREF}>
            {t("Start kitchen display")}
          </a>
        </section>
        <section className="staff-sign-in__other" aria-labelledby="staff-sign-in-tablet">
          <div>
            <h2 id="staff-sign-in-tablet">{t("Shared store tablet")}</h2>
            <p>
              {t(
                "On a shared store tablet a manager has set up, switch to yourself with your PIN.",
              )}
            </p>
          </div>
          <Link className="staff-sign-in__link" to="/operations/switch-staff">
            {t("Switch staff with a PIN")}
          </Link>
        </section>
      </div>
      <footer className="staff-switch__footer">
        <p>
          {t(
            "Forgot your password or lost your phone? Ask the store owner or manager; they can contact BOP support to reset your sign-in.",
          )}
        </p>
      </footer>
    </main>
  );
}

export function StaffSignInPage() {
  const { search } = useLocation();
  const signIn = new URLSearchParams(search).get("signIn");
  // The pilot has no managed sign-in yet: its buttons lead to the labelled test sign-in instead.
  const [entry, setEntry] = useState<SignInEntry | null>(null);
  useEffect(() => {
    createStaffSessionClient()
      .signInEntry()
      .then(setEntry, () => undefined);
  }, []);
  return (
    <StaffSignInView
      failed={signIn === "failed"}
      unavailable={signIn === "unavailable"}
      {...(entry?.testOnly ? { testEntry: entry.path } : {})}
    />
  );
}
