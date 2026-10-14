import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  pickupOfflineState,
  pickupRefreshIntervalMs,
  PickupQueueScreen,
  PickupStatePanel,
} from "./PickupPages.js";
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
it("IDR-0039: keeps the last pickups on a failed refresh, read-only with no handoff", () => {
  const fixture = pickupQueueFixture();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PickupQueueScreen
        view={parsePickupQueueView({
          ...fixture,
          workstation: {
            deviceReference: "01900000-0000-7000-8000-000000000008",
            pickupLocationReference: "01900000-0000-7000-8000-000000000009",
          },
          items: fixture.items.map((item) => ({ ...item, proofReadiness: "Expired" })),
        })}
        proofContext={{
          csrf: "A".repeat(43),
          storeReference: "01900000-0000-7000-8000-000000000004",
        }}
        stale={{ reason: "Offline", lastLoadedAt: "2026-08-12T15:12:30.000Z", attempts: 1 }}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("ORD-1001");
  expect(html).toContain("Offline — showing the last update from");
  expect(html).toContain("Actions are paused until the connection returns.");
  // The action stays on screen (an unknown result keeps its retry) but cannot be used.
  expect(html).toContain('<button disabled="">Hand over after checking in person</button>');
  expect(html).toContain("Paused until the connection returns.");
});
it("IDR-0039: the browser going offline turns the loaded queue read-only at once", () => {
  const view = parsePickupQueueView(pickupQueueFixture());
  const loadedAt = "2026-08-12T15:12:30.000Z";
  const live = { key: "k", failures: 0, state: { kind: "Found" as const, view, loadedAt } };
  const offline = pickupOfflineState(live);
  expect(offline.failures).toBe(1);
  expect(offline.state).toEqual({
    kind: "Found",
    view,
    loadedAt,
    stale: { reason: "Offline", lastLoadedAt: loadedAt, attempts: 1 },
  });
  // Already stale or nothing loaded: unchanged, the retry backoff keeps counting from reads.
  expect(pickupOfflineState(offline)).toBe(offline);
  const loading = { key: "k", failures: 0, state: { kind: "Loading" as const } };
  expect(pickupOfflineState(loading)).toBe(loading);
  expect(pickupRefreshIntervalMs).toBe(10_000);
});

it("WP-2423 Q26: tells staff to wait when the kitchen is remaking part of the order", () => {
  const fixture = pickupQueueFixture();
  const render = (remakeQuantity: number | undefined, phase = "Ready") =>
    renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen
          view={parsePickupQueueView({
            ...fixture,
            items: fixture.items.map((item) => ({
              ...item,
              phase,
              ...(remakeQuantity === undefined ? {} : { remakeQuantity }),
            })),
          })}
        />
      </MemoryRouter>,
    );
  expect(render(1)).toContain("Kitchen is remaking 1 item");
  expect(render(2)).toContain("Kitchen is remaking 2 items");
  expect(render(undefined)).not.toContain("remaking");
  expect(render(1, "Completed")).not.toContain("remaking");
  expect(() =>
    parsePickupQueueView({
      ...fixture,
      items: fixture.items.map((item) => ({ ...item, remakeQuantity: 0 })),
    }),
  ).toThrow();
});
