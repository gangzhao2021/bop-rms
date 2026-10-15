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
  it("WP-2423: offers claim and exception filters only when the pickups carry those facts", () => {
    const fixture = pickupQueueFixture();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen
          view={parsePickupQueueView({
            ...fixture,
            items: fixture.items.map((item) => ({
              ...item,
              claimStatus: "Unavailable",
              exceptionStatus: "Unavailable",
              allergenCue: "Unavailable",
            })),
          })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Claim<select");
    expect(html).not.toContain("Exception<select");
    expect(html).not.toContain("Unavailable");
    const known = renderToStaticMarkup(
      <MemoryRouter>
        <PickupQueueScreen view={parsePickupQueueView(fixture)} />
      </MemoryRouter>,
    );
    expect(known).toContain("Claim<select");
    expect(known).toContain('<option value="Unclaimed">Not claimed</option>');
    expect(known).toContain("Exception<select");
    expect(known).not.toContain("<option>Unavailable</option>");
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

it("WP-2423 Q26: long waits read in hours or days and earlier days' orders are set apart", async () => {
  const { pickupWaitText, fromEarlierDay } = await import("./PickupPages.js");
  expect([
    pickupWaitText(20),
    pickupWaitText(185),
    pickupWaitText(120),
    pickupWaitText(7766),
  ]).toEqual(["20 min", "3 h 5 min", "2 h", "5 days"]);
  const { StoreBusinessDayContext } = await import("./StoreBusinessDay.js");
  const fixture = pickupQueueFixture();
  const today = { ...fixture.items[0], businessDate: "2026-08-12" };
  const earlier = {
    ...fixture.items[0],
    fulfillmentReference: "018f0f58-767a-7f3b-a1d0-000000000511",
    orderReference: "018f0f58-767a-7f3b-a1d0-000000000512",
    readyAt: "2026-08-07T15:00:00.000Z",
    businessDate: "2026-08-07",
  };
  const parsedEarlier = parsePickupQueueView({ ...fixture, items: [earlier] }).items[0];
  if (!parsedEarlier) throw new Error("fixture");
  expect(fromEarlierDay(parsedEarlier, "2026-08-12")).toBe(true);
  const html = renderToStaticMarkup(
    <StoreBusinessDayContext.Provider
      value={{ businessDate: "2026-08-12", startsAt: null, endsAt: null }}
    >
      <MemoryRouter>
        <PickupQueueScreen view={parsePickupQueueView({ ...fixture, items: [today, earlier] })} />
      </MemoryRouter>
    </StoreBusinessDayContext.Provider>,
  );
  expect(html).toContain("From earlier days — check and close");
  expect(html).toContain("From Fri, Aug 7");
  expect(html).toContain("Ready for 5 days");
  expect(html.indexOf("Ready for 20 min")).toBeLessThan(html.indexOf("From earlier days"));
});
