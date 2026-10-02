import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PickupQueueScreen, PickupStatePanel } from "./PickupPages.js";
import { pickupQueueFixture } from "./pickup.fixtures.js";
import { parsePickupQueueView } from "./pickup.js";
describe("WP-1805 Pickup screens", () => {
  it("renders elapsed wait without inventing an overdue threshold", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen view={parsePickupQueueView(pickupQueueFixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "FUL-PICKUP-QUEUE",
      "ORD-1001",
      "Ready 20 minutes · Ready",
      "Waiting",
      "Overdue",
      "Overdue classification is unavailable because this view has no authorized due time.",
      "Shelf A",
      "Open proof verification",
      "Claim and Report exception are unavailable until an authorized source-bound Task or Fulfillment command is defined for this Pickup.",
      "Explicit handoff confirmation required",
      "one idempotent",
    ])
      expect(html).toContain(value);
    expect(html).toContain('aria-describedby="pickup-overdue-availability"');
    expect(html).toContain('id="pickup-overdue-availability"');
  });
  it("shows completed pickups as handed over without waiting or handoff actions", () => {
    const fixture = pickupQueueFixture();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen
          view={parsePickupQueueView({
            ...fixture,
            items: fixture.items.map((item) => ({ ...item, phase: "Completed" })),
          })}
          includeCompleted
        />
      </MemoryRouter>,
    );
    const card = html.slice(html.indexOf("<article"), html.indexOf("</article>"));
    expect(card).toContain("Handed over");
    expect(card).toContain("Completed");
    expect(card).not.toContain("Ready 20 minutes");
    expect(card).not.toContain("Overdue");
    expect(card).not.toContain("Waiting");
    expect(card).not.toContain("Open proof verification");
    expect(card).not.toContain("Explicit handoff confirmation required");
    expect(card).not.toContain("<button");
    expect(html).toContain('id="pickup-overdue-availability"');
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
