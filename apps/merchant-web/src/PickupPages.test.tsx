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
    for (const value of ["ORD-1001", "Ready for 20 min", "Waiting", "Shelf A", "Updated"])
      expect(html).toContain(value);
    for (const value of [
      "FUL-PICKUP-QUEUE",
      "Overdue",
      "Open proof verification",
      "source-bound",
      "idempotent",
      "Report exception",
      ">Claim</button>",
    ])
      expect(html).not.toContain(value);
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
    expect(card).not.toContain("Ready for 20 min");
    expect(card).not.toContain("Overdue");
    expect(card).not.toContain("Waiting");
    expect(card).not.toContain("<button");
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
    expect(html).toContain("Data may be out of date");
    expect(html).toContain("The handoff was not confirmed");
  });
});

it("WP-2423: offers an in-person handoff when the pickup code expired or was never sent", () => {
  const fixture = pickupQueueFixture();
  const render = (proofReadiness: string) => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen
          view={parsePickupQueueView({
            ...fixture,
            workstation: {
              deviceReference: "01900000-0000-7000-8000-000000000008",
              pickupLocationReference: "01900000-0000-7000-8000-000000000009",
            },
            items: fixture.items.map((item) => ({ ...item, proofReadiness })),
          })}
          proofContext={{
            csrf: "A".repeat(43),
            storeReference: "01900000-0000-7000-8000-000000000004",
          }}
        />
      </MemoryRouter>,
    );
    return html.slice(html.indexOf("<article"), html.indexOf("</article>"));
  };
  expect(render("Expired")).toContain("Hand over after checking in person");
  expect(render("Expired")).toContain("Code expired · check in person");
  expect(render("NotIssued")).toContain("No code sent · check in person");
  expect(render("Ready")).not.toContain("Hand over after checking in person");
});

it("WP-2423: offers closing as not collected only after the one-hour pickup hold", () => {
  const fixture = pickupQueueFixture();
  const render = (readyAt: string) => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen
          view={parsePickupQueueView({
            ...fixture,
            workstation: {
              deviceReference: "01900000-0000-7000-8000-000000000008",
              pickupLocationReference: "01900000-0000-7000-8000-000000000009",
            },
            items: fixture.items.map((item) => ({ ...item, proofReadiness: "Expired", readyAt })),
          })}
          proofContext={{
            csrf: "A".repeat(43),
            storeReference: "01900000-0000-7000-8000-000000000004",
          }}
        />
      </MemoryRouter>,
    );
    return html.slice(html.indexOf("<article"), html.indexOf("</article>"));
  };
  expect(render("2026-08-12T14:00:00.000Z")).toContain("Mark not collected");
  expect(render("2026-08-12T14:00:00.000Z")).toContain("not refunded automatically");
  expect(render("2026-08-12T14:50:00.000Z")).not.toContain("Mark not collected");
});
