import { t } from "./i18n/i18n.js";
import type { ReactNode } from "react";

/**
 * Owner 2026-10-25: a page opens with one short line; the full explanation is one tap away
 * ("More about this") instead of a paragraph above the work.
 */
export function PageIntro({
  summary,
  aside,
  children,
}: {
  /** The one line shown. */
  readonly summary: ReactNode;
  /** Quiet facts after the line (when the list was read). */
  readonly aside?: ReactNode;
  /** The full explanation, shown on request. */
  readonly children: ReactNode;
}) {
  return (
    <div className="page-intro">
      <p className="page-intro__summary">
        {summary}
        {aside === undefined ? null : <span className="page-intro__aside"> {aside}</span>}
      </p>
      <details className="page-intro__more">
        <summary>{t("More about this")}</summary>
        {children}
      </details>
    </div>
  );
}
