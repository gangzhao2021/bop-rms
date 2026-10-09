import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppErrorBoundary,
  AppFrame,
  ErrorFallback,
  SkipLinkProvidedContext,
  StatePanel,
  bopPilotNeutralTokenNames,
} from "./index.js";

describe("shared UI foundation", () => {
  it("passes children through the error boundary and offers a reload on failure", () => {
    expect(
      renderToStaticMarkup(
        <AppErrorBoundary>
          <p>Body</p>
        </AppErrorBoundary>,
      ),
    ).toBe("<p>Body</p>");
    const fallback = renderToStaticMarkup(<ErrorFallback onReload={() => undefined} />);
    expect(fallback).toContain('<main id="main-content" class="bop-error-page"');
    expect(fallback).toContain("Something went wrong");
    expect(fallback).toContain(">Reload</button>");
    expect(fallback).not.toContain("stack");
  });
  it("leaves its skip link out inside a layout that already provides one", () => {
    const html = renderToStaticMarkup(
      <SkipLinkProvidedContext.Provider value={true}>
        <AppFrame title="Store" description="Kitchen display">
          <p>Body</p>
        </AppFrame>
      </SkipLinkProvidedContext.Provider>,
    );
    expect(html).not.toContain("bop-skip-link");
    expect(html).toContain('id="main-content"');
  });
  it("renders landmarks, a skip target, and non-color state text", () => {
    const html = renderToStaticMarkup(
      <AppFrame title="Synthetic shell" description="No business data">
        <StatePanel heading="Offline" tone="offline">
          Read-only placeholder
        </StatePanel>
      </AppFrame>,
    );
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("<main");
    expect(html).toContain("Offline");
    expect(bopPilotNeutralTokenNames).toContain("focus");
  });

  it("names the navigation landmark for its audience", () => {
    const html = renderToStaticMarkup(
      <AppFrame
        title="Synthetic shell"
        description="No business data"
        navigation={<a href="/menu">Menu</a>}
        navigationLabel="Customer journey"
      >
        <p>Body</p>
      </AppFrame>,
    );
    expect(html).toContain('<nav class="bop-shell__nav" aria-label="Customer journey">');
    expect(
      renderToStaticMarkup(
        <AppFrame title="S" description="D" navigation={<a href="/app">Home</a>}>
          <p>Body</p>
        </AppFrame>,
      ),
    ).toContain('aria-label="Primary"');
  });
});
