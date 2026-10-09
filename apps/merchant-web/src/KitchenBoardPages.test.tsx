import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  KitchenBoardPage,
  KitchenBoardScreen,
  KitchenBoardStatePanel,
  KitchenWorkItemScreen,
  kitchenAgeTier,
  kitchenLateMinutes,
  kitchenWarningMinutes,
  newQueuedReferences,
  playKitchenChime,
} from "./KitchenBoardPages.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { parseKitchenBoardView, parseKitchenWorkItemDetailView } from "./kitchen-board.js";
describe("WP-1804 Kitchen Board screens", () => {
  it("renders station, safety, age and bounded actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={parseKitchenBoardView(kitchenBoardFixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "Kitchen display",
      "Kitchen",
      "Updated · 15:12 UTC",
      "Queue",
      "Order or ticket reference",
      "Exact reference only. The value stays in this page session and is not added to the URL.",
      "Training Store",
      "Hot line",
      "station",
      "Work state",
      "Allergen",
      "Exception",
      "Clear filters",
      "Mushroom rice bowl",
      "12 min",
      'class="kitchen-work-item__quantity"><dt>Quantity</dt><dd>0 / 2</dd></dl>',
      "Allergen review required",
      "Actions unavailable for this item",
      'data-age="warning"',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain("Extra mushrooms");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000402");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000403");
    expect(html).not.toContain("Exception: None");
    expect(html.indexOf("Mushroom rice bowl")).toBeLessThan(
      html.indexOf('class="kitchen-work-item__state"'),
    );
    expect(html.indexOf('class="kitchen-work-item__state"')).toBeLessThan(
      html.indexOf('class="kitchen-work-item__quantity"'),
    );
  });
  it("groups work items into station lanes without inventing missing queue facts", () => {
    const second = {
      ...kitchenItemFixture(),
      workItemReference: "018f0f58-767a-7f3b-a1d0-000000000411",
      stationLabel: "Cold prep",
      displayName: "Garden salad",
    };
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [kitchenItemFixture(), second],
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={view} />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-label="Hot line station"');
    expect(html).toContain('aria-label="Cold prep station"');
    expect(html).toContain("Garden salad");
    expect(html).not.toContain("SLA");
    expect(html).not.toContain("Priority");
    expect(html).not.toContain("Claim");
    expect(html).not.toContain("Unavailable here");
  });
  it("keeps station-unlabeled work visible and disables a meaningless station filter", () => {
    const unlabeledItem = {
      ...kitchenItemFixture(),
      workItemReference: "018f0f58-767a-7f3b-a1d0-000000000411",
      displayName: "Unlabeled rice bowl",
      stationLabel: null,
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={parseKitchenBoardView({
            ...kitchenBoardFixture(),
            items: [kitchenItemFixture(), unlabeledItem],
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(
      'aria-label="Kitchen work items; station labels unavailable; lane 2 of 2"',
    );
    expect(html).toContain("Station labels unavailable</h3>");
    expect(html).toContain("Mushroom rice bowl");
    expect(html).toContain("Unlabeled rice bowl");
    expect(html).toContain('aria-label="Hot line station"');
    expect(html).toContain(
      '<span class="kitchen-filter-visually-hidden">Station</span><select disabled="">',
    );
    expect(html).toContain('<option value="All" selected="">Unavailable</option>');
    expect(html).not.toContain("Hold/Prioritize");
  });
  it("groups by source station reference without displaying the reference", () => {
    const firstStation = "018f0f58-767a-7f3b-a1d0-000000000431";
    const secondStation = "018f0f58-767a-7f3b-a1d0-000000000432";
    const withStation = (
      stationReference: string,
      workItemReference: string,
      displayName: string,
    ) => ({
      ...kitchenItemFixture(),
      stationLabel: null,
      workItemReference,
      displayName,
      execution: {
        orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000433",
        stationReference,
        ticketVersion: "1",
        workItemVersion: "1",
        acceptedAt: null,
        readyAt: null,
      },
    });
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [
        withStation(firstStation, "018f0f58-767a-7f3b-a1d0-000000000434", "First station item"),
        withStation(
          firstStation,
          "018f0f58-767a-7f3b-a1d0-000000000435",
          "Second same-station item",
        ),
        withStation(secondStation, "018f0f58-767a-7f3b-a1d0-000000000436", "Other station item"),
      ],
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={view} />
      </MemoryRouter>,
    );
    expect(html.match(/class="kitchen-station-lane"/gu)).toHaveLength(2);
    expect(html).toContain("First station item");
    expect(html).toContain("Second same-station item");
    expect(html).toContain("Other station item");
    expect(html).toContain("Station labels unavailable</h3>");
    expect(html).not.toContain(firstStation);
    expect(html).not.toContain(secondStation);
  });
  it("locks stale or unnamed boards", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={parseKitchenBoardView({ ...kitchenBoardFixture(), operatorStatus: "Locked" })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Board locked — read-only");
    expect(html).toContain("named unlocked operator");
  });
  it("renders a privacy-minimized child and safe failure", () => {
    const board = kitchenBoardFixture();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenWorkItemScreen
          view={parseKitchenWorkItemDetailView({
            screenId: "KIT-WORK-ITEM",
            projectionName: "kitchen_work_queue_v1",
            projectionVersion: 1,
            storeLabel: board.storeLabel,
            projectedAt: "2026-08-12T15:18:00.000Z",
            freshnessStatus: "Fresh",
            operatorStatus: "Unverified",
            item: kitchenItemFixture(),
          })}
        />
        <KitchenBoardStatePanel state="CommandFailed" />
      </MemoryRouter>,
    );
    expect(html).toContain('class="kitchen-board-eyebrow">Work item</p>');
    expect(html).not.toContain("KIT-WORK-ITEM");
    expect(html).not.toContain("Ticket display reference unavailable");
    expect(html).not.toContain("Order display reference unavailable");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000402");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000403");
    expect(html).toContain("Additional detail</h3>");
    expect(html).toContain("Only recorded milestones are shown.");
    expect(html).toContain("Recipe &amp; handling snapshots");
    expect(html).toContain("Allergen acknowledgements");
    expect(html).toContain("Timers &amp; dependencies");
    expect(html).toContain("Work item history");
    expect(html).toContain("Work item created");
    expect(html).toContain(
      "Start, progress and completion times are not recorded on this screen yet.",
    );
    expect(html).toContain("Modifiers");
    expect(html).toContain("Extra mushrooms");
    expect(html).toContain("× 2");
    expect(html).toContain("KDS session unverified");
    expect(html).toContain("18 min");
    expect(html).toContain("Take actions from the queue. Your filters are kept when you return.");
    expect(html).toContain("Action not confirmed");
    expect(html).toContain("Nothing is assumed. Refresh before trying again.");
    expect(html).not.toContain("Complete remaining quantity");
    expect(html).not.toContain("Mark ready");
  });
  it("renders only the accepted and ready milestones supplied by the projection", () => {
    const item = {
      ...kitchenItemFixture(),
      status: "Completed" as const,
      completedQuantity: 2,
      execution: {
        orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000421",
        stationReference: "018f0f58-767a-7f3b-a1d0-000000000422",
        ticketVersion: "3",
        workItemVersion: "4",
        acceptedAt: "2026-08-12T15:04:00.000Z",
        readyAt: "2026-08-12T15:17:00.000Z",
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenWorkItemScreen
          view={parseKitchenWorkItemDetailView({
            screenId: "KIT-WORK-ITEM",
            projectionName: "kitchen_work_queue_v1",
            projectionVersion: 1,
            storeLabel: "Synthetic Training Store",
            projectedAt: "2026-08-12T15:18:00.000Z",
            freshnessStatus: "Fresh",
            operatorStatus: "Unverified",
            item,
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-label="Work item milestones"');
    expect(html).toContain('<time dateTime="2026-08-12T15:00:00.000Z">');
    expect(html).toContain('<time dateTime="2026-08-12T15:04:00.000Z">');
    expect(html).toContain("Accepted");
    expect(html).toContain('<time dateTime="2026-08-12T15:17:00.000Z">');
    expect(html).toContain("Order item marked ready");
    expect(html).toContain(
      '<time dateTime="2026-08-12T15:17:00.000Z">2026-08-12T15:17:00.000Z</time>',
    );
    expect(html).not.toContain("unavailable from this projection");
    expect(html.indexOf("Work item created")).toBeLessThan(html.indexOf("Accepted"));
    expect(html.indexOf("Accepted")).toBeLessThan(html.indexOf("Order item marked ready"));
    expect(html).toContain("Timers &amp; dependencies</dt><dd>Unavailable</dd>");
  });
  it("distinguishes a projection-backed empty modifier list", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenWorkItemScreen
          view={parseKitchenWorkItemDetailView({
            screenId: "KIT-WORK-ITEM",
            projectionName: "kitchen_work_queue_v1",
            projectionVersion: 1,
            storeLabel: "Synthetic Training Store",
            projectedAt: "2026-08-12T15:18:00.000Z",
            freshnessStatus: "Fresh",
            operatorStatus: "Unverified",
            item: { ...kitchenItemFixture(), selectedOptions: [] },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("No selected modifiers");
  });
});

it("uses only the authorized navigation supplied by the current workspace", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen
        view={parseKitchenBoardView(kitchenBoardFixture())}
        navigation={
          <a href="/operations/kitchen" aria-current="page">
            Kitchen
          </a>
        }
      />
    </MemoryRouter>,
  );
  expect(html).toContain(
    '<nav class="bop-shell__nav" aria-label="Primary"><a href="/operations/kitchen" aria-current="page">Kitchen</a></nav>',
  );
  expect(html).not.toContain('href="/operations/orders"');
});

it("offers manual refresh and does not claim unavailable operator or safety facts", () => {
  const view = parseKitchenBoardView({
    ...kitchenBoardFixture(),
    operatorStatus: "Unavailable",
    items: [
      { ...kitchenItemFixture(), allergenCue: "Unavailable", exceptionStatus: "Unavailable" },
    ],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen view={view} onRefresh={() => undefined} />
    </MemoryRouter>,
  );
  expect(html).toContain("Board locked — read-only");
  expect(html).toContain("Allergen / exception cues unavailable");
  expect(html).toContain('aria-label="Allergen status unavailable; Exception status unavailable"');
  expect(html).toContain(
    "Filters apply only to fields present for every loaded work item. Allergen and exception filters are unavailable here",
  );
  expect(html).toMatch(
    /<span class="kitchen-filter-visually-hidden">Allergen<\/span><select disabled="">/,
  );
  expect(html).toMatch(
    /<span class="kitchen-filter-visually-hidden">Exception<\/span><select disabled="">/,
  );
  expect(html).toContain(">Refresh</button>");
  expect(html).not.toContain("Refresh from source");
  expect(html).not.toContain("Named operator</dd>");
});

describe("WP-2423 M3 kitchen display", () => {
  it("tiers waiting time and keeps the thresholds explicit", () => {
    expect(kitchenAgeTier(0)).toBe("ok");
    expect(kitchenAgeTier(kitchenWarningMinutes - 1)).toBe("ok");
    expect(kitchenAgeTier(kitchenWarningMinutes)).toBe("warning");
    expect(kitchenAgeTier(kitchenLateMinutes - 1)).toBe("warning");
    expect(kitchenAgeTier(kitchenLateMinutes)).toBe("late");
  });
  it("names only queued work that was not in the previous read", () => {
    const previous = parseKitchenBoardView(kitchenBoardFixture());
    const arrived = {
      ...kitchenItemFixture(),
      workItemReference: "018f0f58-767a-7f3b-a1d0-000000000441",
    };
    const started = {
      ...kitchenItemFixture(),
      workItemReference: "018f0f58-767a-7f3b-a1d0-000000000442",
      status: "In Progress" as const,
    };
    const next = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [kitchenItemFixture(), arrived, started],
    });
    expect(newQueuedReferences(null, next)).toEqual([]);
    expect(newQueuedReferences(previous, next)).toEqual([arrived.workItemReference]);
    expect(newQueuedReferences(next, next)).toEqual([]);
  });
  it("offers the sound toggle, auto-refresh note and plain state labels", () => {
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [{ ...kitchenItemFixture(), status: "In Progress" }],
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={view}
          onRefresh={() => undefined}
          soundOn={false}
          onSoundToggle={() => undefined}
          autoRefresh
        />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Sound off</button>");
    expect(html).toContain("Auto-refresh every 10 s");
    expect(html).toContain('<strong data-status="In Progress">In progress</strong>');
    expect(html).not.toContain("KIT-KITCHEN-QUEUE");
    const on = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={view} soundOn onSoundToggle={() => undefined} />
      </MemoryRouter>,
    );
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain(">Sound on</button>");
    expect(on).not.toContain("Auto-refresh");
  });
  it("plays nothing where audio is unavailable", () => {
    expect(() => playKitchenChime()).not.toThrow();
  });
});

it("drops restored allergen and exception filters when the projection omits those fields", () => {
  const view = parseKitchenBoardView({
    ...kitchenBoardFixture(),
    items: [
      { ...kitchenItemFixture(), allergenCue: "Unavailable", exceptionStatus: "Unavailable" },
    ],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/operations/kitchen",
          state: {
            kitchenQueueScope: {
              station: "All",
              status: "All",
              allergen: "ReviewRequired",
              exception: "Reported",
            },
          },
        },
      ]}
    >
      <KitchenBoardScreen view={view} />
    </MemoryRouter>,
  );
  expect(html).toContain("Mushroom rice bowl");
  expect(html).not.toContain("No matching work");
  expect(html).toMatch(
    /<span class="kitchen-filter-visually-hidden">Allergen<\/span><select disabled=""><option value="All" selected="">Unavailable/,
  );
  expect(html).toMatch(
    /<span class="kitchen-filter-visually-hidden">Exception<\/span><select disabled=""><option value="All" selected="">Unavailable/,
  );
});

it("does not present permission as proof of an active named operator session", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen
        view={parseKitchenBoardView({ ...kitchenBoardFixture(), operatorStatus: "Unverified" })}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("KDS session unverified");
  expect(html).toContain(
    "KDS session or device lock is unverified. Kitchen commands are disabled.",
  );
  expect(html).toContain('disabled=""');
  expect(html).not.toContain("Unverified operator");
});

describe("IDR-0039 named-operator KDS handover", () => {
  it("offers handover only for a current named merchant Session", () => {
    const named = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardPage
          csrf="synthetic-csrf"
          storeReference="store"
          storeLabel="Training Store"
        />
      </MemoryRouter>,
    );
    expect(named).toContain("Hand over / sign out");
    const anonymous = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardPage />
      </MemoryRouter>,
    );
    expect(anonymous).not.toContain("Hand over / sign out");
  });
});
