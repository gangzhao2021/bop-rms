import { Component, type ErrorInfo, type ReactNode } from "react";

/** The page shown when rendering throws: plain words, one way forward, no error internals. */
export function ErrorFallback({ onReload }: { readonly onReload?: (() => void) | undefined }) {
  const reload = onReload ?? (() => globalThis.location?.reload());
  return (
    <main id="main-content" className="bop-error-page" tabIndex={-1}>
      <h1>Something went wrong</h1>
      <p>
        This page could not be shown. Reload to try again. If you were in the middle of something,
        check it after reloading before doing it again.
      </p>
      <button type="button" onClick={reload}>
        Reload
      </button>
    </main>
  );
}

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
  /** Receives the error for the app's own reporting; nothing is logged here. */
  readonly onError?: ((error: Error, info: ErrorInfo) => void) | undefined;
}

/**
 * WP-2423 P4: an application-level boundary so a rendering fault shows a page with a way
 * forward instead of a blank screen.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }
  override render() {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
