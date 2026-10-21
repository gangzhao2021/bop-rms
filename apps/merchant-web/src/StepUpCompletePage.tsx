import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import {
  announceStepUpResult,
  parseStepUpResult,
  safeReturnPath,
  type ChannelFactory,
  type StepUpResult,
} from "./step-up-sign-in.js";

/** How long the page waits for `window.close()` before it is known not to be a popup. */
export const STEP_UP_CLOSE_WAIT_MS = 300;

export const stepUpCompleteText: Record<StepUpResult, string> = {
  verified: "You're verified. You can go back to what you were doing.",
  cancelled: "Sign-in was cancelled.",
  failed: "We couldn't confirm it's you.",
};

export interface StepUpCompleteWindow {
  close(): void;
  readonly closed: boolean;
  readonly location: { replace(url: string): void };
}

/**
 * The page's effect, apart from React: tell the page that opened the sign-in window how it went,
 * close this window, and — when it was not a popup (it is still open shortly after) — go back to
 * the page the staff member left. A failed check stays here so its message can be read.
 */
export function finishStepUp(
  result: StepUpResult | null,
  returnTo: string,
  target: StepUpCompleteWindow,
  channel?: ChannelFactory | null,
  schedule: (run: () => void, ms: number) => unknown = setTimeout,
): void {
  if (result === null) return;
  announceStepUpResult(result, channel);
  try {
    target.close();
  } catch {
    // Not a window this page may close; it goes back below.
  }
  if (result === "failed") return;
  schedule(() => {
    if (!target.closed) target.location.replace(returnTo);
  }, STEP_UP_CLOSE_WAIT_MS);
}

/** WP-2423 DEC-COGNITO-STORE-STAFF: where the "confirm it is you" sign-in window ends. */
export function StepUpCompleteView({
  result,
  returnTo,
}: {
  readonly result: StepUpResult | null;
  readonly returnTo: string;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="bop-shell__main staff-switch">
      <header className="staff-switch__header">
        <p className="staff-switch__brand">
          <strong aria-label="BOP">BOP</strong>
        </p>
        <h1>Confirm it is you</h1>
      </header>
      <section className="staff-switch__panel" aria-label="Result">
        {result === null ? (
          <p>This sign-in check has ended.</p>
        ) : (
          <p role={result === "failed" ? "alert" : "status"}>{stepUpCompleteText[result]}</p>
        )}
        <p>
          <Link className="staff-sign-in__link" to={returnTo}>
            Go back
          </Link>
        </p>
      </section>
    </main>
  );
}

export function StepUpCompletePage({ channel }: { readonly channel?: ChannelFactory | null }) {
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  const result = parseStepUpResult(query.get("result"));
  const returnTo = safeReturnPath(query.get("returnTo"));
  useEffect(() => {
    finishStepUp(result, returnTo, window, channel);
    // Once per arrival.
  }, []);
  return <StepUpCompleteView result={result} returnTo={returnTo} />;
}
