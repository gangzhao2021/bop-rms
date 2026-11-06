import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectivityBanner } from "./ConnectivityBanner.js";
import type { ConnectivityController, ConnectivityState } from "./connectivity-controller.js";

function controller(state: ConnectivityState): ConnectivityController {
  return {
    getState: () => state,
    setOnline: () => undefined,
    dismissRestored: () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
  };
}

describe("Customer PWA connectivity banner", () => {
  it("renders no banner while online", () => {
    expect(
      renderToStaticMarkup(<ConnectivityBanner controller={controller({ status: "online" })} />),
    ).toBe("");
  });

  it("makes offline read-only and no-replay behavior explicit", () => {
    const html = renderToStaticMarkup(
      <ConnectivityBanner controller={controller({ status: "offline" })} />,
    );
    expect(html).toContain("You’re offline");
    expect(html).toContain("Ordering and payment are paused until you reconnect");
    expect(html).toContain("Nothing is sent in the background");
    expect(html).toContain('aria-live="polite"');
  });

  it("requires explicit review after connection restoration", () => {
    const html = renderToStaticMarkup(
      <ConnectivityBanner controller={controller({ status: "restored" })} />,
    );
    expect(html).toContain("Connection restored");
    // WP-2423 M17: a confirm sent just before the drop may have gone through; never claim otherwise.
    expect(html).toContain("Check this page before you try again.");
    expect(html).not.toContain("Nothing was sent");
    expect(html).toContain("Dismiss");
  });
});
