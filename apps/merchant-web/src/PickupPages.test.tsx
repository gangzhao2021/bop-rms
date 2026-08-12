import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PickupQueueScreen, PickupStatePanel } from "./PickupPages.js";
import { pickupQueueFixture } from "./pickup.fixtures.js";
import { parsePickupQueueView } from "./pickup.js";
describe("WP-1805 Pickup screens", () => {
  it("renders proof, wait, staging and explicit completion boundary", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen view={parsePickupQueueView(pickupQueueFixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "FUL-PICKUP-QUEUE",
      "ORD-1001",
      "Ready 20 minutes",
      "Overdue",
      "Shelf A",
      "Open proof verification",
      "Explicit handoff confirmation required",
      "one idempotent",
    ])
      expect(html).toContain(value);
  });
  it("locks stale queues and exposes safe command failure", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen
          view={parsePickupQueueView({ ...pickupQueueFixture(), freshnessStatus: "Stale" })}
        />
        <PickupStatePanel state="CommandFailed" />
      </MemoryRouter>,
    );
    expect(html).toContain("Queue stale — read-only");
    expect(html).toContain("No handoff or Fulfillment transition is assumed");
  });
});
