import { Component, type ErrorInfo, type ReactNode } from "react";
import { useUiText } from "./UiText.js";

/** The page shown when rendering throws: plain words, one way forward, no error internals. */
export function ErrorFallback({ onReload }: { readonly onReload?: (() => void) | undefined }) {
  const reload = onReload ?? (() => globalThis.location?.reload());
  const text = useUiText();
  return (
    <main id="main-content" className="bop-error-page" tabIndex={-1}>
      <h1>{text.errorHeading}</h1>
      <p>{text.errorBody}</p>
      <button type="button" onClick={reload}>
        {text.reload}
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
