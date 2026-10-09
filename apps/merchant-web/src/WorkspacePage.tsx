import type { ReactNode } from "react";

/**
 * WP-2423 M1: one page frame for every back-office page inside the workspace layout: a title,
 * the Store or scope under it, a status line and the page's actions in one row. The main
 * landmark carries the shared base styles (`bop-shell__main`) so tables and controls look the
 * same everywhere.
 */
export function WorkspacePage({
  title,
  meta,
  status,
  actions,
  className,
  children,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly status?: ReactNode;
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
      <header className="workspace-page__header">
        <div className="workspace-page__title">
          <h1>{title}</h1>
          {meta ? <p className="workspace-page__meta">{meta}</p> : null}
        </div>
        {status || actions ? (
          <div className="workspace-page__toolbar">
            {status ? <div className="workspace-page__status">{status}</div> : null}
            {actions ? <div className="workspace-page__actions">{actions}</div> : null}
          </div>
        ) : null}
      </header>
      {children}
    </main>
  );
}
