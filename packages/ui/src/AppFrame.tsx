import type { ReactNode } from "react";
export interface AppFrameProps {
  children: ReactNode;
  description: string;
  navigation?: ReactNode;
  title: string;
}
export function AppFrame({ children, description, navigation, title }: AppFrameProps) {
  return (
    <div className="bop-shell">
      <a className="bop-skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="bop-shell__header">
        <strong aria-label="BOP">BOP</strong>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {navigation ? (
        <nav className="bop-shell__nav" aria-label="Primary">
          {navigation}
        </nav>
      ) : null}
      <main className="bop-shell__main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
