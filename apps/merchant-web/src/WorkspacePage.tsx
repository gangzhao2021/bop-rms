import type { ReactNode } from "react";
import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import { TopBarStatus } from "./TopBarStatus.js";

/**
 * WP-2423 M1: one page frame for every back-office page inside the workspace layout: a title,
 * the Store or scope under it, a status line and the page's actions in one row. The main
 * landmark carries the shared base styles (`bop-shell__main`) so tables and controls look the
 * same everywhere.
 */
export function WorkspacePage({
  back,
  title,
  meta,
  status,
  statusOnPage = false,
  stamp,
  actions,
  className,
  children,
}: {
  /** The way back from a page opened out of a list, above its title. */
  readonly back?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly status?: ReactNode;
  /**
   * The status is the page's warnings or controls, not its "Updated 01:36" stamp: it stays on the
   * page at every width, on its own line under the title row (batch 64). The tablet top bar holds
   * one short stamp on one line (F38, Figma 58:65); a warning or a button sent there is cut off at
   * the window's edge and lost to staff. Such a page gives its stamp as `stamp`.
   */
  readonly statusOnPage?: boolean;
  /**
   * Batch 64: the page's one "Updated 14:02" stamp (Freshness) when its status line is its own
   * (statusOnPage): in the tablet top bar, else first among the header's actions. The status line
   * then runs under the title across the page, so a long line of warnings never pushes the
   * page's Refresh off the title's row.
   */
  readonly stamp?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={`bop-shell__main workspace-page${className ? ` ${className}` : ""}`}
    >
      {back ? <p className="workspace-page__back">{back}</p> : null}
      <header className="workspace-page__header">
        <div className="workspace-page__title">
          <h1>{title}</h1>
          {meta ? <p className="workspace-page__meta">{meta}</p> : null}
        </div>
        {(status && !statusOnPage) || stamp || actions ? (
          <div className="workspace-page__toolbar">
            {/* Batch 63 (F38): on a tablet the stamp is in the top bar (Figma 58:65). */}
            {status && !statusOnPage ? (
              <TopBarStatus>
                <div className="workspace-page__status">{status}</div>
              </TopBarStatus>
            ) : null}
            {stamp ? (
              <TopBarStatus>
                <div className="workspace-page__status">{stamp}</div>
              </TopBarStatus>
            ) : null}
            {actions ? <div className="workspace-page__actions">{actions}</div> : null}
          </div>
        ) : null}
        {/* Owner 2026-10-26: the language switch ends the title row, top right of the page. */}
        <LanguageSwitch className="workspace-page__language" />
        {status && statusOnPage ? (
          <div className="workspace-page__status workspace-page__status--line">{status}</div>
        ) : null}
      </header>
      {children}
    </main>
  );
}
