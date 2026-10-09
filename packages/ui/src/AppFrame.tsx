import type { ReactNode } from "react";
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
  navigationLabel = "Primary",
  title,
}: AppFrameProps) {
  return (
    <div
      className={`bop-shell${className ? ` ${className}` : ""}`}
      data-mobile-brand-title={mobileBrandTitle ? "true" : undefined}
    >
      <a className="bop-skip-link" href="#main-content">
        Skip to main content
      </a>
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
      </header>
      {navigation ? (
        <nav className="bop-shell__nav" aria-label={navigationLabel}>
          {navigation}
        </nav>
      ) : null}
      <main className="bop-shell__main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
