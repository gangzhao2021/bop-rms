import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppFrame, StatePanel, bopPilotNeutralTokenNames } from "./index.js";

describe("shared UI foundation", () => {
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
});
