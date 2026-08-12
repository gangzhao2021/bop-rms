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
    expect(html).toContain("You are offline");
    expect(html).toContain("Transaction and identity actions are unavailable");
    expect(html).toContain("Nothing will run or replay in the background");
    expect(html).toContain('aria-live="polite"');
  });

  it("requires explicit review after connection restoration", () => {
    const html = renderToStaticMarkup(
      <ConnectivityBanner controller={controller({ status: "restored" })} />,
    );
    expect(html).toContain("Connection restored");
    expect(html).toContain("retry explicitly");
    expect(html).toContain("No action ran automatically");
    expect(html).toContain("Dismiss");
  });
});
