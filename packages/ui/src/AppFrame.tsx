import { createContext, useContext, type ReactNode } from "react";
import { useUiText } from "./UiText.js";

/**
 * True inside a layout that already renders the page's skip link (one per document); the frame
 * then leaves its own out instead of offering two.
 */
export const SkipLinkProvidedContext = createContext(false);

export interface AppFrameProps {
  children: ReactNode;
  description: string;
  className?: string;
  headerStatus?: ReactNode;
  navigation?: ReactNode;
  /** Accessible name of the navigation landmark ("Primary" when omitted). */
  navigationLabel?: string;
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
  navigationLabel,
  title,
}: AppFrameProps) {
  const skipLinkProvided = useContext(SkipLinkProvidedContext);
  const text = useUiText();
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
      <header className="bop-shell__header">
        <strong aria-label="BOP">BOP</strong>
        <h1>{title}</h1>
        {mobileBrandTitle ? (
          <span className="bop-shell__header-mobile-title" aria-hidden="true">
            {mobileBrandTitle}
          </span>
        ) : null}
        <p>{description}</p>
        {headerStatus === undefined ? null : (
          <div className="bop-shell__header-status">{headerStatus}</div>
        )}
        {text.headerExtra === undefined ? null : (
          <div className="bop-shell__header-extra">{text.headerExtra}</div>
        )}
      </header>
      {navigation ? (
        <nav className="bop-shell__nav" aria-label={navigationLabel ?? text.primaryNavigation}>
          {navigation}
        </nav>
      ) : null}
      <main className="bop-shell__main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
