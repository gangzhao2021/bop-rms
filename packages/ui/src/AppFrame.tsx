import { createContext, useContext, type ReactNode } from "react";
import { useUiText } from "./UiText.js";

/**
 * True inside a layout that already renders the page's skip link (one per document); the frame
 * then leaves its own out instead of offering two.
 */
export const SkipLinkProvidedContext = createContext(false);
/**
 * True inside an app's own workspace frame (sidebar, page header). The frame then keeps its title
 * as the page's heading for assistive technology but draws no second top bar (Owner 2026-10-25:
 * "one workspace frame and header everywhere").
 */
export const WorkspaceFrameContext = createContext(false);

export interface AppFrameProps {
  children: ReactNode;
  description: string;
  className?: string;
  headerStatus?: ReactNode;
  navigation?: ReactNode;
  /** Accessible name of the navigation landmark ("Primary" when omitted). */
  navigationLabel?: string;
  /**
   * Draw the navigation inside the top bar, before its status and language switch, instead of as a
   * row of its own, so one bar can hold the title, the links and the switch top-right.
   */
  navigationInHeader?: boolean;
  mobileBrandTitle?: string;
  title: string;
}
export function AppFrame({
  children,
  className,
  description,
  headerStatus,
  mobileBrandTitle,
  navigation,
  navigationInHeader = false,
  navigationLabel,
  title,
}: AppFrameProps) {
  const skipLinkProvided = useContext(SkipLinkProvidedContext);
  const inWorkspace = useContext(WorkspaceFrameContext);
  const text = useUiText();
  const nav = navigation ? (
    <nav className="bop-shell__nav" aria-label={navigationLabel ?? text.primaryNavigation}>
      {navigation}
    </nav>
  ) : null;
  const navInHeader = navigationInHeader && !inWorkspace;
  return (
    <div
      className={`bop-shell${className ? ` ${className}` : ""}`}
      data-mobile-brand-title={mobileBrandTitle ? "true" : undefined}
    >
      {skipLinkProvided ? null : (
        <a className="bop-skip-link" href="#main-content">
          {text.skipToMainContent}
        </a>
      )}
      {inWorkspace ? (
        <header className="bop-shell__header bop-shell__header--in-workspace">
          <h1>{title}</h1>
          {text.headerExtra === undefined ? null : (
            <div className="bop-shell__header-extra">{text.headerExtra}</div>
          )}
        </header>
      ) : null}
      {inWorkspace && headerStatus !== undefined ? (
        <div className="bop-shell__header-status bop-shell__header-status--in-workspace">
          {headerStatus}
        </div>
      ) : null}
      {inWorkspace ? null : (
        <header className="bop-shell__header">
          <strong aria-label="BOP">BOP</strong>
          <h1>{title}</h1>
          {mobileBrandTitle ? (
            <span className="bop-shell__header-mobile-title" aria-hidden="true">
              {mobileBrandTitle}
            </span>
          ) : null}
          <p>{description}</p>
          {navInHeader ? nav : null}
          {headerStatus === undefined ? null : (
            <div className="bop-shell__header-status">{headerStatus}</div>
          )}
          {text.headerExtra === undefined ? null : (
            <div className="bop-shell__header-extra">{text.headerExtra}</div>
          )}
        </header>
      )}
      {navInHeader ? null : nav}
      <main className="bop-shell__main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
