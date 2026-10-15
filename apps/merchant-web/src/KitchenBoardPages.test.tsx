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
  groupKitchenItemsByOrder,
  kitchenOrderLabel,
  failedLoadState,
  retryAttempts,
  type LoadState,
} from "./KitchenBoardPages.js";
import { staleRetryDelayMs } from "./stale-read.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { parseKitchenBoardView, parseKitchenWorkItemDetailView } from "./kitchen-board.js";
import { StoreBusinessDayContext } from "./StoreBusinessDay.js";
import { earlierDayTickets, fromEarlierKitchenDay, kitchenWaitText } from "./KitchenEarlierDays.js";
describe("WP-1804 Kitchen Board screens", () => {
  it("WP-2423: says when the board was last checked, not only when its work last changed", () => {
    const view = parseKitchenBoardView(kitchenBoardFixture());
    const checked = new Date(Date.parse(view.projectedAt) + 65 * 60_000).toISOString();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={view} checkedAt={checked} autoRefresh />
      </MemoryRouter>,
    );
    expect(html).toContain("Last checked <time");
    expect(html).toContain("16:17 UTC</time>");
    expect(html).toContain('title="Last change 15:12 UTC"');
    expect(html).not.toContain("Updated · 15:12");
    const stale = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={view}
          checkedAt={checked}
          stale={{ reason: "Unavailable", lastLoadedAt: checked, attempts: 1 }}
        />
      </MemoryRouter>,
    );
    expect(stale).toContain("Data may be out of date · last checked <time");
    expect(stale).toContain("Read-only until reconnected");
  });
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
    // WP-2423 Q2: modifiers are on the card itself; the Order is named by number, not reference.
    expect(html).toContain("<li>Extra mushrooms × 2</li>");
    expect(html).toContain("Order 14 · Table T4");
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
    expect(html).toContain('class="kitchen-board-eyebrow">Order 14 · Table T4</p>');
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
  // WP-2423 Q3: no menu disclosure is said plainly; sourceless cues are not shown as placeholders.
  expect(html).toContain("Allergens not available · check the recipe");
  expect(html).not.toContain("Allergen / exception cues unavailable");
  expect(html).not.toContain("Exception status unavailable");
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

it("WP-2423 Q3: shows the menu's declared allergens on the card, strongest first", () => {
  const view = parseKitchenBoardView({
    ...kitchenBoardFixture(),
    items: [
      {
        ...kitchenItemFixture(),
        allergens: { status: "Declared", contains: ["Milk"], mayContain: ["Sesame"] },
      },
      {
        ...kitchenItemFixture(),
        workItemReference: "01909985-0000-7000-8000-000000000071",
        selectedOptions: [],
        allergens: { status: "Declared", contains: [], mayContain: [] },
      },
    ],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen view={view} onRefresh={() => undefined} />
    </MemoryRouter>,
  );
  expect(html).toContain("<strong>Contains: Milk</strong>");
  expect(html).toContain("<span>May contain: Sesame</span>");
  expect(html).toContain("Modifiers may add allergens");
  expect(html).toContain('aria-label="Contains Milk. May contain Sesame"');
  expect(html).toContain("No menu allergens declared");
  expect(html).not.toMatch(/allergen.free/iu);
});

describe("WP-2423 Q2 kitchen order context", () => {
  it("groups each Order's work under its number, shows the note, and keeps finished work off by default", () => {
    const item = kitchenItemFixture();
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [
        {
          ...item,
          workItemReference: "018f0f58-767a-7f3b-a1d0-000000000501",
          orderReference: "018f0f58-767a-7f3b-a1d0-000000000503",
          orderLabel: { orderNumber: "15", orderType: "Pickup", tableLabel: null },
          customerNote: "Synthetic note: no onions",
          createdAt: "2026-08-12T15:05:00.000Z",
        },
        item,
        {
          ...item,
          workItemReference: "018f0f58-767a-7f3b-a1d0-000000000502",
          displayName: "Miso soup",
        },
        {
          ...item,
          workItemReference: "018f0f58-767a-7f3b-a1d0-000000000504",
          displayName: "Finished tea",
          status: "Completed",
          completedQuantity: 2,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={view} onRefresh={() => undefined} />
      </MemoryRouter>,
    );
    // Oldest Order first, its two items together, then the newer pickup.
    expect(html.indexOf("Order 14 · Table T4")).toBeLessThan(html.indexOf("Order 15 · Pickup"));
    expect(html.indexOf("Miso soup")).toBeLessThan(html.indexOf("Order 15 · Pickup"));
    expect(html).toContain(
      '<p class="kitchen-work-item__note"><span>Note:</span> Synthetic note: no onions</p>',
    );
    expect(html).not.toContain("Finished tea");
    expect(html).toContain('<option value="Active" selected="">Active work</option>');
    expect(groupKitchenItemsByOrder(view.items).map((group) => group.items.length)).toEqual([3, 1]);
    expect(kitchenOrderLabel({ ...item, orderLabel: null } as never)).toBe(
      "Order details unavailable",
    );
  });
});

describe("IDR-0039 kitchen stale read-only mode", () => {
  const view = parseKitchenBoardView({
    ...kitchenBoardFixture(),
    items: [
      {
        ...kitchenItemFixture(),
        execution: {
          orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000433",
          stationReference: "018f0f58-767a-7f3b-a1d0-000000000431",
          ticketVersion: "1",
          workItemVersion: "1",
          acceptedAt: null,
          readyAt: null,
        },
      },
    ],
  });
  const found: LoadState<typeof view> = {
    kind: "Found",
    view,
    loadedAt: "2026-08-12T15:12:30.000Z",
  };
  it("keeps the last tickets on a lost connection and replaces them on a denial", () => {
    for (const reason of ["Offline", "Unavailable"] as const) {
      const stale = failedLoadState(found, reason, 1, true);
      expect(stale).toEqual({
        kind: "Found",
        view,
        loadedAt: found.loadedAt,
        stale: { reason, lastLoadedAt: found.loadedAt, attempts: 1 },
      });
      expect(retryAttempts(stale)).toBe(1);
      // A further failure keeps the same data and counts up for the backoff.
      expect(retryAttempts(failedLoadState(stale, reason, 2, true))).toBe(2);
    }
    for (const reason of ["PermissionDenied", "NotFound"] as const) {
      const replaced = failedLoadState(found, reason, 1, true);
      expect(replaced).toEqual({ kind: reason, attempts: 1 });
      expect(retryAttempts(replaced)).toBeNull();
    }
    // Screens that do not opt in (work item detail) still replace their data.
    expect(failedLoadState(found, "Offline", 1, false)).toEqual({ kind: "Offline", attempts: 1 });
    // A first read that never succeeded keeps retrying too.
    expect(retryAttempts(failedLoadState({ kind: "Loading" }, "Offline", 3, true))).toBe(3);
    expect(retryAttempts(found)).toBeNull();
    expect(retryAttempts({ kind: "Loading" })).toBeNull();
  });
  it("retries with backoff from 5 s up to every 30 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(staleRetryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ]);
  });
  it("shows the last tickets read-only with the time of the last update", () => {
    const live = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={view}
          onAction={() => undefined}
          actionsBlocked={false}
          autoRefresh
        />
      </MemoryRouter>,
    );
    expect(live).toContain("<button>Accept</button>");
    expect(live).not.toContain("Read-only until reconnected");
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={view}
          onAction={() => undefined}
          actionsBlocked={false}
          autoRefresh
          stale={{ reason: "Offline", lastLoadedAt: found.loadedAt, attempts: 1 }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Mushroom rice bowl");
    expect(html).toContain("Read-only until reconnected");
    expect(html).toContain(
      'Offline — showing the last update from <time dateTime="2026-08-12T15:12:30.000Z">15:12 UTC</time>. Actions are paused until the connection returns.',
    );
    expect(html).toContain("Trying again automatically.");
    expect(html).toContain('<button disabled="">Accept</button>');
    expect(html).toContain("Data may be out of date");
    expect(html).not.toContain("Auto-refresh every 10 s");
    expect(html).not.toContain("Board locked — read-only");
    const lost = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={view}
          stale={{ reason: "Unavailable", lastLoadedAt: found.loadedAt, attempts: 2 }}
        />
      </MemoryRouter>,
    );
    expect(lost).toContain("Connection lost — showing the last update from");
  });
});

describe("WP-2423 Q26 kitchen remakes (Handoff Section 26.6)", () => {
  const rework = (overrides: Record<string, unknown> = {}) => ({
    reworkReference: "018f0f58-767a-7f3b-a1d0-000000000501",
    originalWorkItemReference: "018f0f58-767a-7f3b-a1d0-000000000401",
    orderReference: "018f0f58-767a-7f3b-a1d0-000000000403",
    orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000404",
    reasonCode: "DROPPED" as const,
    note: "Slipped off the pass",
    quantity: 1,
    wasteApplies: true,
    status: "Queued" as const,
    version: 1,
    createdAt: "2026-08-12T15:10:00.000Z",
    startedAt: null,
    completedAt: null,
    displayName: "Mushroom rice bowl",
    selectedOptions: [{ displayName: "Extra mushrooms", quantity: 2 }],
    orderLabel: { orderNumber: "14", orderType: "DineIn" as const, tableLabel: "T4" },
    customerNote: null,
    ...overrides,
  });
  const finished = {
    ...kitchenItemFixture(),
    status: "Completed",
    completedQuantity: 2,
    execution: {
      orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000404",
      stationReference: "018f0f58-767a-7f3b-a1d0-000000000405",
      ticketVersion: "5",
      workItemVersion: "4",
      acceptedAt: "2026-08-12T15:01:00.000Z",
      readyAt: "2026-08-12T15:11:00.000Z",
    },
  };
  // Finished but not yet marked ready: still on the active board.
  const awaitingReady = {
    ...finished,
    workItemReference: "018f0f58-767a-7f3b-a1d0-000000000411",
    displayName: "Garden salad",
    execution: { ...finished.execution, readyAt: null },
  };
  const remakes = (canRework: boolean, items = [rework()]) => ({
    items,
    canRework,
    readFailed: false,
    blocked: false,
    onCreate: () => undefined,
    onAdvance: () => undefined,
  });
  const render = (canRework: boolean, items = [rework()]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={parseKitchenBoardView({
            ...kitchenBoardFixture(),
            items: [finished, awaitingReady],
          })}
          remakes={remakes(canRework, items)}
          actionsBlocked={false}
        />
      </MemoryRouter>,
    );
  it("marks open remakes in their own lane with the reason in words", () => {
    const html = render(true);
    expect(html).toContain('aria-label="Remakes"');
    expect(html).toContain("Remake · Dropped");
    expect(html).toContain("Why:</span> Slipped off the pass");
    expect(html).toContain("Order 14 · Table T4");
    expect(html).toContain("Start remake");
    expect(html).not.toContain("DROPPED");
    const back = render(true, [
      rework({ reasonCode: "NOT_READY", status: "In Progress", note: null }),
    ]);
    expect(back).toContain("Back in progress · Marked done too early");
    expect(back).toContain("Remake done");
  });
  it("offers Remake on finished dishes and the recent list only to those who may remake", () => {
    const allowed = render(true);
    expect(allowed).toContain('class="kitchen-remake-button"');
    expect(allowed).toContain("Recently finished · 1");
    expect(allowed).toContain('aria-label="Remake Mushroom rice bowl, Order 14 · Table T4"');
    const denied = render(false);
    expect(denied).not.toContain('class="kitchen-remake-button"');
    expect(denied).not.toContain("Recently finished");
    // Cooks without the remake permission still start and finish remakes.
    expect(denied).toContain("Start remake");
    const none = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={parseKitchenBoardView({ ...kitchenBoardFixture(), items: [finished] })}
        />
      </MemoryRouter>,
    );
    expect(none).not.toContain("Remake");
  });
});

describe("DEC-KITCHEN-STALE-TICKETS earlier business days on the kitchen board", () => {
  const execution = {
    orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000404",
    stationReference: "018f0f58-767a-7f3b-a1d0-000000000405",
    ticketVersion: "3",
    workItemVersion: "2",
    acceptedAt: null,
    readyAt: null,
  };
  const today = { ...kitchenItemFixture(), businessDate: "2026-08-12", execution };
  // The same number 14 from five days earlier, still queued.
  const old = {
    ...kitchenItemFixture(),
    workItemReference: "018f0f58-767a-7f3b-a1d0-000000000421",
    ticketReference: "018f0f58-767a-7f3b-a1d0-000000000422",
    orderReference: "018f0f58-767a-7f3b-a1d0-000000000423",
    displayName: "Old noodle bowl",
    createdAt: "2026-08-07T18:00:00.000Z",
    businessDate: "2026-08-07",
    execution,
  };
  const render = (canClose: boolean, businessDate: string | null = "2026-08-12") =>
    renderToStaticMarkup(
      <StoreBusinessDayContext.Provider
        value={businessDate ? { businessDate, startsAt: null, endsAt: null } : null}
      >
        <MemoryRouter>
          <KitchenBoardScreen
            view={parseKitchenBoardView({
              ...kitchenBoardFixture(),
              items: [today, old],
              canCloseEarlierDayTickets: canClose,
            })}
            earlierDays={{ blocked: false, onClose: () => undefined }}
            onAction={() => undefined}
            actionsBlocked={false}
          />
        </MemoryRouter>
      </StoreBusinessDayContext.Provider>,
    );
  it("keeps an earlier day's open ticket in a collapsed section with its day and age, apart from today's lanes", () => {
    const html = render(true);
    expect(html).toContain('<details class="kitchen-earlier-days">');
    expect(html).not.toContain('<details class="kitchen-earlier-days" open');
    expect(html).toContain("From earlier days — check and close");
    expect(html).toContain("1 ticket");
    expect(html).toContain("From Fri, Aug 7");
    expect(html).toContain("waiting 4 days");
    expect(html).toContain("Close ticket");
    // Today's Order 14 is in the lanes; the old one only in the earlier section.
    const lanes = html.slice(html.indexOf('class="kitchen-board-lanes"'));
    expect(lanes).toContain("Mushroom rice bowl");
    expect(lanes).not.toContain("Old noodle bowl");
    expect(html.indexOf("Old noodle bowl")).toBeLessThan(
      html.indexOf('class="kitchen-board-lanes"'),
    );
    expect(html).toContain("1 work item");
  });
  it("offers the close only to a manager, and shows nothing apart while the business day is unknown", () => {
    const cook = render(false);
    expect(cook).toContain("From earlier days — check and close");
    expect(cook).toContain("Ask a manager to check and close them.");
    expect(cook).not.toContain("Close ticket");
    const unknown = render(true, null);
    expect(unknown).not.toContain("From earlier days");
    expect(unknown).toContain("Old noodle bowl");
  });
  it("groups earlier tickets with their exact version and words waiting time in hours and days", () => {
    const view = parseKitchenBoardView({ ...kitchenBoardFixture(), items: [today, old] });
    expect(fromEarlierKitchenDay(old, "2026-08-12")).toBe(true);
    expect(fromEarlierKitchenDay(today, "2026-08-12")).toBe(false);
    expect(fromEarlierKitchenDay({ businessDate: null }, "2026-08-12")).toBe(false);
    const tickets = earlierDayTickets(view.items, "2026-08-12", kitchenOrderLabel);
    expect(tickets).toEqual([
      expect.objectContaining({
        ticketReference: old.ticketReference,
        businessDate: "2026-08-07",
        ticketVersion: "3",
        orderLabel: "Order 14 · Table T4",
      }),
    ]);
    expect(kitchenWaitText(12)).toBe("12 min");
    expect(kitchenWaitText(125)).toBe("2 h 5 min");
    expect(kitchenWaitText(60 * 24)).toBe("1 day");
    expect(kitchenWaitText(60 * 24 * 5 + 30)).toBe("5 days");
  });
});
