import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { PlatformLiveGatePage, StoreLiveGatePage } from "./LiveGatePages.js";
import { platformLiveGateFixture, storeLiveGateFixture } from "./live-gate-pages.fixtures.js";
import type { LiveGatePageClient } from "./live-gate-pages.js";
const client: LiveGatePageClient = {
  loadStoreGate: async () => storeLiveGateFixture,
  loadPlatformGates: async () => platformLiveGateFixture,
};
describe("WP-2194 Live Gate pages", () => {
  it("renders canonical loading states without implying evidence approval", () => {
    const store = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/app/organization/stores/018f0000-0000-7000-8000-000000000004/live-gate"]}
      >
        <Routes>
          <Route
            path="/app/organization/stores/:id/live-gate"
            element={<StoreLiveGatePage client={client} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    const platform = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/platform/live-gates"]}>
        <PlatformLiveGatePage client={client} />
      </MemoryRouter>,
    );
    expect(store).toContain("Loading Live Gates");
    expect(platform).toContain("Loading Live Gates");
  });
});
