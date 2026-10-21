import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KitchenBoardPage,
  KitchenBoardScreen,
  kitchenHandoverOffered,
  KitchenBoardStatePanel,
  KitchenDisplayHeaderControls,
  KitchenDisplayNavigation,
  kitchenNavigationFor,
  kitchenUsesWorkspaceFrame,
  kitchenOrderSearchTerm,
  matchesKitchenOrderSearch,
  kitchenBoardSearch,
  earlierDaySearchText,
  kitchenSearchHiddenText,
  kitchenSearchAwaitingText,
  KitchenWorkItemScreen,
  kitchenAgeTier,
  kitchenTicketAge,
  kitchenTicketTierText,
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
import { kitchenClockAt, kitchenClockTickMs, subscribeKitchenClock } from "./kitchen-clock.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import {
  kitchenOrderText,
  parseKitchenBoardView,
  parseKitchenWorkItemDetailView,
} from "./kitchen-board.js";
import { KitchenRemakeLane } from "./KitchenRework.js";
import type { KitchenReworkView } from "./kitchen-rework-client.js";
import { StoreBusinessDayContext } from "./StoreBusinessDay.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
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
      "Order number or table",
      "The number on the ticket or receipt, or the table. Shows only that order&#x27;s work.",
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
      "No kitchen steps for this item on this screen",
      'data-age="warning"',
    ])
      expect(html).toContain(value);
    // WP-2423 Q2: modifiers are on the card itself; the Order is named by number, not reference.
    expect(html).toContain("<li>Extra mushrooms × 2</li>");
    expect(html).toContain("Table T4 · Order 14");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000402");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000403");
    expect(html).not.toContain("Exception: None");
    // WP-2423: the search speaks the staff's language, never identifier vocabulary.
    expect(html).not.toMatch(/uuid|exact reference|reference type/iu);
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
  it("keeps station-unlabeled work visible and hides a meaningless station filter", () => {
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
    expect(html).toContain('aria-label="All kitchen work"');
    expect(html).toContain("All work</h3>");
    expect(html).not.toMatch(/station labels unavailable/iu);
    expect(html).toContain("Mushroom rice bowl");
    expect(html).toContain("Unlabeled rice bowl");
    expect(html).toContain('aria-label="Hot line station"');
    // WP-2423: no reachable stub — a filter the source cannot answer is not offered.
    expect(html).not.toContain('<span class="kitchen-filter-visually-hidden">Station</span>');
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
    expect(html).toContain("Station 1</h3>");
    expect(html).toContain("Station 2</h3>");
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
    expect(html).toContain("Kitchen display paused");
    expect(html).toContain("Use Hand over / sign out, then start the kitchen display again.");
    expect(html).toContain('data-operator="Locked">Kitchen display locked');
    const catchingUp = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={parseKitchenBoardView({ ...kitchenBoardFixture(), freshnessStatus: "Stale" })}
        />
      </MemoryRouter>,
    );
    expect(catchingUp).toContain("Catching up with new orders");
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
    expect(html).toContain('class="kitchen-board-eyebrow">Table T4 · Order 14</p>');
    expect(html).not.toContain("KIT-WORK-ITEM");
    expect(html).not.toContain("Ticket display reference unavailable");
    expect(html).not.toContain("Order display reference unavailable");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000402");
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000403");
    expect(html).toContain("Additional detail</h3>");
    expect(html).toContain("Only recorded milestones are shown.");
    // WP-2423: facts the source does not record are not listed as "Unavailable" rows.
    expect(html).not.toContain("Recipe &amp; handling snapshots");
    expect(html).not.toContain("Timers &amp; dependencies");
    expect(html).not.toContain(">Unavailable<");
    expect(html).toContain("Work item history");
    expect(html).toContain("Work item created");
    expect(html).toContain(
      "Start, progress and completion times are not recorded on this screen yet.",
    );
    expect(html).toContain("Modifiers");
    expect(html).toContain("Extra mushrooms");
    expect(html).toContain("× 2");
    expect(html).toContain('data-operator="Unverified">View only');
    expect(html).toContain("View only on this screen");
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
    expect(html).toContain('<time dateTime="2026-08-12T15:00:00.000Z"');
    expect(html).toContain('<time dateTime="2026-08-12T15:04:00.000Z"');
    expect(html).toContain("Accepted");
    expect(html).toContain('<time dateTime="2026-08-12T15:17:00.000Z"');
    expect(html).toContain("Order item marked ready");
    // WP-2423: without the Store's zone the time is labelled UTC, never the raw machine instant.
    expect(html).toContain(
      '<time dateTime="2026-08-12T15:17:00.000Z" title="2026-08-12T15:17:00.000Z">Aug 12, 2026, 3:17 PM UTC</time>',
    );
    expect(html).not.toContain("unavailable from this projection");
    expect(html.indexOf("Work item created")).toBeLessThan(html.indexOf("Accepted"));
    expect(html.indexOf("Accepted")).toBeLessThan(html.indexOf("Order item marked ready"));
    expect(html).not.toContain("<dd>Unavailable</dd>");
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
  expect(html).toContain("Kitchen display paused");
  expect(html).toContain("sign-in can no longer be confirmed");
  // WP-2423 Q3: no menu disclosure is said plainly; sourceless cues are not shown as placeholders.
  expect(html).toContain("Allergens not available · check the recipe");
  expect(html).not.toContain("Allergen / exception cues unavailable");
  expect(html).not.toContain("Exception status unavailable");
  expect(html).not.toContain("Filters apply only");
  expect(html).not.toContain('<span class="kitchen-filter-visually-hidden">Allergen</span>');
  expect(html).not.toContain('<span class="kitchen-filter-visually-hidden">Exception</span>');
  expect(html).not.toContain("<option>Unavailable</option>");
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
  expect(html).not.toContain('<span class="kitchen-filter-visually-hidden">Allergen</span>');
  expect(html).not.toContain('<span class="kitchen-filter-visually-hidden">Exception</span>');
});

it("does not present permission as proof of an active named operator session", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen
        view={parseKitchenBoardView({ ...kitchenBoardFixture(), operatorStatus: "Unverified" })}
      />
    </MemoryRouter>,
  );
  // WP-2423: a counter/office sign-in sees the board and is told how to start the kitchen display.
  expect(html).toContain('data-operator="Unverified">View only');
  expect(html).toContain("View only on this screen");
  expect(html).toContain("You are signed in for the counter or office");
  expect(html).toContain(">Start kitchen display here</button>");
  expect(html).toContain('disabled=""');
  expect(html).not.toContain("Unverified operator");
  expect(html).not.toContain("KDS");
  expect(html).not.toContain("device lock");
});

describe("WP-2423 kitchen display search and chrome", () => {
  const order = (orderNumber: string, tableLabel: string | null) =>
    parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [
        {
          ...kitchenItemFixture(),
          orderLabel: { orderNumber, orderType: tableLabel ? "DineIn" : "Pickup", tableLabel },
        },
      ],
    }).items[0] as Parameters<typeof matchesKitchenOrderSearch>[0];
  it("finds an order by the number on its ticket or receipt, or by its table", () => {
    const dineIn = order("14", "T4");
    for (const input of ["14", " 14 ", "#14", "Order 14", "order #14", "014", "T4", "table t4"])
      expect(matchesKitchenOrderSearch(dineIn, input), input).toBe(true);
    for (const input of ["1", "4", "140", "T", "Table 14x"])
      expect(matchesKitchenOrderSearch(dineIn, input), input).toBe(false);
    expect(matchesKitchenOrderSearch(order("A-07", null), "a-07")).toBe(true);
    expect(kitchenOrderSearchTerm("   ")).toBeNull();
    expect(matchesKitchenOrderSearch(dineIn, "")).toBe(true);
  });
  it("shows a kitchen display sign-in the kitchen only, and others their navigation", () => {
    const navigation = <a href="/app/approvals">Approvals</a>;
    const kitchenOnly = <KitchenDisplayNavigation current="Kitchen" />;
    expect(kitchenNavigationFor(true, "Named", navigation, kitchenOnly)).toBe(kitchenOnly);
    expect(kitchenNavigationFor(true, "HandoverRequired", navigation, kitchenOnly)).toBe(
      kitchenOnly,
    );
    expect(kitchenNavigationFor(true, "Locked", navigation, kitchenOnly)).toBe(kitchenOnly);
    // Not yet known: nothing rather than flashing the back office at a cook.
    expect(kitchenNavigationFor(true, null, navigation, kitchenOnly)).toBeUndefined();
    expect(kitchenNavigationFor(true, "Unverified", navigation, kitchenOnly)).toBe(navigation);
    expect(kitchenNavigationFor(false, null, navigation, kitchenOnly)).toBe(navigation);
  });
  it("2026-10-21 live check: only a counter or office sign-in reads the Kitchen in the workspace frame", () => {
    const frame = (content: ReactNode) => content;
    expect(kitchenUsesWorkspaceFrame(true, "Unverified", frame)).toBe(true);
    // The kitchen display keeps its own frame; before the board says who it is, no back office.
    for (const operator of ["Named", "HandoverRequired", "Locked", null] as const)
      expect(kitchenUsesWorkspaceFrame(true, operator, frame), String(operator)).toBe(false);
    // The local demo (no sign-in) and an app without the frame keep the kitchen frame.
    expect(kitchenUsesWorkspaceFrame(false, "Unverified", frame)).toBe(false);
    expect(kitchenUsesWorkspaceFrame(true, "Unverified", undefined)).toBe(false);
  });
  it("2026-10-21 live check: puts the view-only board in the workspace frame, without a second header", () => {
    const frame = (content: ReactNode) => (
      <div data-frame="workspace">
        <nav aria-label="Workspace">Grouped navigation</nav>
        {content}
      </div>
    );
    const view = parseKitchenBoardView({ ...kitchenBoardFixture(), operatorStatus: "Unverified" });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={view}
          workspaceFrame={frame}
          headerStatus={<span>Screen kept on</span>}
          soldOutHref="/app/commerce/availability"
        />
      </MemoryRouter>,
    );
    expect(html.startsWith('<div data-frame="workspace">')).toBe(true);
    expect(html).toContain('<main class="bop-shell__main" id="main-content" tabindex="-1">');
    expect(html).toContain("<h1>Kitchen</h1>");
    expect(html).toContain("Screen kept on");
    // No kitchen display header or its own list of links inside the workspace page.
    expect(html).not.toContain("bop-shell__header");
    expect(html).not.toContain("bop-shell__nav");
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).not.toContain(">Kitchen display<");
    expect(html).toContain("Mark an item sold out");
    // The kitchen display itself keeps its own frame.
    const display = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={parseKitchenBoardView(kitchenBoardFixture())} />
      </MemoryRouter>,
    );
    expect(display).toContain("bop-shell__header");
    expect(display).toContain("<h2>Kitchen</h2>");
  });
  it("2026-10-21 live check: frames a work item by who the board says is using it", () => {
    const frame = (content: ReactNode) => <div data-frame="workspace">{content}</div>;
    const detail = (operatorStatus: "Unverified" | "Named") =>
      renderToStaticMarkup(
        <MemoryRouter>
          <KitchenWorkItemScreen
            workspaceFrame={frame}
            view={parseKitchenWorkItemDetailView({
              screenId: "KIT-WORK-ITEM",
              projectionName: "kitchen_work_queue_v1",
              projectionVersion: 1,
              storeLabel: "Synthetic Training Store",
              projectedAt: "2026-08-12T15:18:00.000Z",
              freshnessStatus: "Fresh",
              operatorStatus,
              item: kitchenItemFixture(),
            })}
          />
        </MemoryRouter>,
      );
    const office = detail("Unverified");
    expect(office.startsWith('<div data-frame="workspace">')).toBe(true);
    expect(office).not.toContain("bop-shell__header");
    expect(office).toMatch(/<h1>[^<]+<\/h1>/u);
    const display = detail("Named");
    expect(display).not.toContain('data-frame="workspace"');
    expect(display).toContain("bop-shell__header");
  });
  it("offers the kitchen display marking an item sold out in its own navigation (Q17)", () => {
    const board = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenDisplayNavigation current="Kitchen" soldOutHref="/app/commerce/availability" />
      </MemoryRouter>,
    );
    expect(board).toContain('aria-current="page" href="/operations/kitchen"');
    expect(board).toContain('href="/app/commerce/availability?from=kitchen"');
    expect(board).not.toMatch(/Approvals|Orders|Settlement|Item availability/u);
    const soldOut = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenDisplayNavigation current="SoldOut" soldOutHref="/app/commerce/availability" />
      </MemoryRouter>,
    );
    expect(soldOut).toMatch(/aria-current="page"[^>]*>Mark an item sold out/u);
    expect(soldOut).not.toMatch(/aria-current="page"[^>]*>Kitchen/u);
    // Without the sold-out permission the kitchen display shows the board alone.
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <KitchenDisplayNavigation current="Kitchen" />
        </MemoryRouter>,
      ),
    ).not.toContain("sold out");
  });
  it("renders the handover as a styled header control next to the screen-awake status", () => {
    const html = renderToStaticMarkup(
      <KitchenDisplayHeaderControls
        handoverOffered
        handover="Failed"
        awake="Held"
        onHandover={() => undefined}
      />,
    );
    expect(html).toContain('class="kitchen-display-controls"');
    expect(html).toContain('<button type="button" class="kitchen-handover-button">');
    expect(html).toContain("Hand over / sign out");
    expect(html).toContain("Screen kept on");
    expect(html).toContain('role="alert"');
    const counter = renderToStaticMarkup(
      <KitchenDisplayHeaderControls
        handoverOffered={false}
        handover="Idle"
        awake="Unsupported"
        onHandover={() => undefined}
      />,
    );
    expect(counter).not.toContain("Hand over");
    expect(counter).toContain("set the device to never sleep");
  });
  it("puts the display controls in the board header and marks each card as a focus target", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen
          view={parseKitchenBoardView(kitchenBoardFixture())}
          headerStatus={<span>Display controls</span>}
          navigation={<a href="/operations/kitchen">Kitchen</a>}
        />
      </MemoryRouter>,
    );
    expect(html.indexOf("Display controls")).toBeGreaterThan(html.indexOf("bop-shell__header"));
    expect(html.indexOf("Display controls")).toBeLessThan(html.indexOf("bop-shell__main"));
    expect(html).toMatch(
      /<article class="kitchen-work-item" data-work-item="[^"]+" tabindex="-1"/u,
    );
    expect(html).toContain('<h2 id="kitchen-queue-heading" tabindex="-1">Queue</h2>');
  });
  it("shows kitchen staff no internal codes, identifiers or technical words", () => {
    for (const operatorStatus of ["Named", "Unverified", "HandoverRequired"] as const) {
      const html = renderToStaticMarkup(
        <StoreTimeZoneContext.Provider value="America/Toronto">
          <MemoryRouter>
            <KitchenBoardScreen
              view={parseKitchenBoardView({ ...kitchenBoardFixture(), operatorStatus })}
              headerStatus={
                <KitchenDisplayHeaderControls
                  handoverOffered={operatorStatus !== "Unverified"}
                  handover="Idle"
                  awake="Held"
                  onHandover={() => undefined}
                />
              }
            />
          </MemoryRouter>
        </StoreTimeZoneContext.Provider>,
      );
      expect(findInternalText([staticText(html)]), operatorStatus).toEqual([]);
    }
  });
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
    // Offered once the board has read who is using it, and never to a counter/office sign-in.
    expect(named).not.toContain("Hand over / sign out");
    expect(kitchenHandoverOffered(true, "Named")).toBe(true);
    expect(kitchenHandoverOffered(true, "Locked")).toBe(true);
    expect(kitchenHandoverOffered(true, "Unverified")).toBe(false);
    expect(kitchenHandoverOffered(true, null)).toBe(false);
    expect(kitchenHandoverOffered(false, "Named")).toBe(false);
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
    expect(html.indexOf("Table T4 · Order 14")).toBeLessThan(html.indexOf("Pickup · Order 15"));
    expect(html.indexOf("Miso soup")).toBeLessThan(html.indexOf("Pickup · Order 15"));
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
    cancelledAt: null as string | null,
    cancelReasonCode: null as "GUEST_DECLINED" | "OPENED_BY_MISTAKE" | null,
    displayName: "Mushroom rice bowl",
    selectedOptions: [{ displayName: "Extra mushrooms", quantity: 2 }],
    orderLabel: { orderNumber: "14", orderType: "DineIn" as const, tableLabel: "T4" },
    businessDate: null,
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
    expect(html).toContain("Table T4 · Order 14");
    expect(html).toContain("Start remake");
    expect(html).not.toContain("DROPPED");
    const back = render(true, [
      rework({ reasonCode: "NOT_READY", status: "In Progress", note: null }),
    ]);
    expect(back).toContain("Back in progress · Marked done too early");
    expect(back).toContain("Remake done");
  });
  it("WP-2423 (2026-10-18): offers Cancel remake only with the remake permission and hides cancelled remakes", () => {
    const withCancel = (canRework: boolean, items = [rework()]) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <KitchenBoardScreen
            view={parseKitchenBoardView({
              ...kitchenBoardFixture(),
              items: [finished, awaitingReady],
            })}
            remakes={{ ...remakes(canRework, items), onCancel: () => undefined }}
            actionsBlocked={false}
          />
        </MemoryRouter>,
      );
    expect(withCancel(true)).toContain("Cancel remake");
    expect(withCancel(false)).not.toContain("Cancel remake");
    const cancelled = withCancel(true, [
      rework({
        status: "Cancelled",
        cancelledAt: "2026-08-12T15:12:00.000Z",
        cancelReasonCode: "GUEST_DECLINED",
      }),
    ]);
    expect(cancelled).not.toContain('aria-label="Remakes"');
    expect(cancelled).not.toContain("GUEST_DECLINED");
  });
  it("WP-2423: tickets sharing a number lead with where they go; an earlier day's remake says its day", () => {
    // v15: a pickup remake and a table round both numbered 2 (numbers restart each business day).
    expect(kitchenOrderText({ orderNumber: "2", orderType: "Pickup", tableLabel: null })).toBe(
      "Pickup · Order 2",
    );
    expect(kitchenOrderText({ orderNumber: "2", orderType: "DineIn", tableLabel: "DEMO-02" })).toBe(
      "Table DEMO-02 · Order 2",
    );
    expect(kitchenOrderText({ orderNumber: "2", orderType: "DineIn", tableLabel: null })).toBe(
      "Dine-in · Order 2",
    );
    const lane = (businessDate: string | null) =>
      renderToStaticMarkup(
        <KitchenRemakeLane
          items={[
            rework({
              businessDate,
              orderLabel: { orderNumber: "2", orderType: "Pickup", tableLabel: null },
            }) as KitchenReworkView,
          ]}
          today="2026-08-12"
          readOnly={false}
          onAdvance={() => undefined}
        />,
      );
    expect(lane("2026-08-11")).toMatch(/Pickup · Order 2 · From [^<]+Aug 11/u);
    expect(lane("2026-08-12")).not.toContain("From ");
    expect(lane(null)).not.toContain("From ");
  });
  it("offers Remake on finished dishes and the recent list only to those who may remake", () => {
    const allowed = render(true);
    expect(allowed).toContain('class="kitchen-remake-button"');
    expect(allowed).toContain("Recently finished · 1");
    expect(allowed).toContain('aria-label="Remake Mushroom rice bowl, Table T4 · Order 14"');
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
        orderLabel: "Table T4 · Order 14",
      }),
    ]);
    expect(kitchenWaitText(12)).toBe("12 min");
    expect(kitchenWaitText(125)).toBe("2 h 5 min");
    expect(kitchenWaitText(60 * 24)).toBe("1 day");
    expect(kitchenWaitText(60 * 24 * 5 + 30)).toBe("5 days");
  });
  it("applies one order search to today's lanes, remakes, earlier days and finished work", () => {
    const six = (item: Record<string, unknown>, n: string) => ({
      ...item,
      orderLabel: { orderNumber: n, orderType: "Pickup" as const, tableLabel: null },
    });
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [six(today, "6"), six(old, "6")],
    });
    const remake = (orderNumber: string) => ({
      reworkReference: "018f0f58-767a-7f3b-a1d0-00000000050" + orderNumber,
      originalWorkItemReference: today.workItemReference,
      orderReference: today.orderReference,
      orderItemReference: execution.orderItemReference,
      reasonCode: "DROPPED" as const,
      note: null,
      quantity: 1,
      wasteApplies: true,
      status: "Queued" as const,
      version: 1,
      createdAt: "2026-08-12T15:10:00.000Z",
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelReasonCode: null,
      displayName: "Mushroom rice bowl",
      selectedOptions: [],
      orderLabel: { orderNumber, orderType: "Pickup" as const, tableLabel: null },
      businessDate: null,
      customerNote: null,
    });
    const reworks = [remake("2"), remake("6")];
    const found = kitchenBoardSearch({
      items: view.items,
      reworks,
      today: "2026-08-12",
      search: "6",
    });
    expect(found.todayMatches.map((item) => item.displayName)).toEqual(["Mushroom rice bowl"]);
    expect(found.earlierShown.map((ticket) => ticket.orderLabel)).toEqual(["Pickup · Order 6"]);
    expect(found.reworks.map((rework) => rework.orderLabel?.orderNumber)).toEqual(["6"]);
    const other = kitchenBoardSearch({
      items: view.items,
      reworks,
      today: "2026-08-12",
      search: "2",
    });
    expect(other.todayMatches).toEqual([]);
    expect(other.earlierShown).toEqual([]);
    // Earlier days stay apart from today's lanes whatever the search.
    expect(other.earlier).toHaveLength(1);
    expect(other.reworks.map((rework) => rework.orderLabel?.orderNumber)).toEqual(["2"]);
    const all = kitchenBoardSearch({
      items: view.items,
      reworks,
      today: "2026-08-12",
      search: null,
    });
    expect(all.reworks).toBe(reworks);
    expect(all.earlierShown).toHaveLength(1);
    expect(earlierDaySearchText(1, "6")).toBe(
      "1 ticket from an earlier day has number or table “6”",
    );
    expect(earlierDaySearchText(3, "6")).toBe(
      "3 tickets from earlier days have number or table “6”",
    );
  });

  it("v15: an earlier day's finished or cancelled order never answers for today's paid, not accepted order", () => {
    const label = (n: string) => ({
      orderNumber: n,
      orderType: "Pickup" as const,
      tableLabel: null,
    });
    // Earlier days' order 13 (finished) and order 12 (cancelled) share today's numbers.
    const oldDone = {
      ...old,
      orderLabel: label("13"),
      status: "Completed" as const,
      completedQuantity: 2,
      execution: { ...execution, readyAt: "2026-08-07T18:20:00.000Z" },
    };
    const oldCancelled = {
      ...old,
      workItemReference: "018f0f58-767a-7f3b-a1d0-000000000431",
      orderLabel: label("12"),
      status: "Cancelled" as const,
    };
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [{ ...today, orderLabel: label("14") }, oldDone, oldCancelled],
      awaitingAcceptance: [
        label("13"),
        { orderNumber: "12", orderType: "DineIn", tableLabel: "T4" },
      ],
    });
    expect(view.awaitingAcceptance?.map((entry) => entry.orderNumber)).toEqual(["13", "12"]);
    const search = (term: string) =>
      kitchenBoardSearch({
        items: view.items,
        reworks: [],
        today: "2026-08-12",
        search: term,
        awaitingAcceptance: view.awaitingAcceptance,
      });
    const thirteen = search("13");
    expect(thirteen.todayMatches).toEqual([]);
    expect(thirteen.awaitingMatches.map((entry) => entry.orderNumber)).toEqual(["13"]);
    expect(kitchenSearchAwaitingText(thirteen.awaitingMatches, "13", false)).toBe(
      "Order 13 is not accepted yet — accept it on Orders.",
    );
    const twelve = search("12");
    expect(twelve.todayMatches).toEqual([]);
    expect(kitchenSearchAwaitingText(twelve.awaitingMatches, "12", false)).toBe(
      "Order 12 (table T4) is not accepted yet — accept it on Orders.",
    );
    // A table's earlier round is done and a new round waits.
    expect(kitchenSearchAwaitingText(twelve.awaitingMatches, "12", true)).toBe(
      "Order 12 (table T4) has a new round that is not accepted yet — accept it on Orders.",
    );
    expect(
      kitchenSearchAwaitingText(
        [...thirteen.awaitingMatches, ...thirteen.awaitingMatches],
        "13",
        false,
      ),
    ).toBe("2 orders for “13” are not accepted yet — accept them on Orders.");
    expect(kitchenSearchAwaitingText([], "13", false)).toBeNull();
    // Today's own order is still found; nothing waits for it.
    expect(search("14").todayMatches).toHaveLength(1);
    expect(search("14").awaitingMatches).toEqual([]);
    // An older server (no list) or an unread list: nothing is claimed about acceptance.
    expect(
      kitchenBoardSearch({ items: view.items, reworks: [], today: "2026-08-12", search: "13" })
        .awaitingMatches,
    ).toEqual([]);
    expect(
      parseKitchenBoardView({ ...kitchenBoardFixture(), awaitingAcceptance: null })
        .awaitingAcceptance,
    ).toBeNull();
    expect(() =>
      parseKitchenBoardView({ ...kitchenBoardFixture(), awaitingAcceptance: [null] }),
    ).toThrow("KITCHEN_BOARD_INVALID");
  });

  it("says an order or table is done when all its matching work is finished, not that filters hide it", () => {
    const [base] = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [
        {
          ...kitchenItemFixture(),
          orderLabel: { orderNumber: "9", orderType: "DineIn", tableLabel: "T4" },
        },
      ],
    }).items;
    if (!base) throw new Error("fixture");
    const execution = {
      orderItemReference: "018f0f58-767a-7f3b-a1d0-000000000701",
      stationReference: "018f0f58-767a-7f3b-a1d0-000000000702",
      ticketVersion: "1",
      workItemVersion: "3",
      acceptedAt: "2026-08-12T15:01:00.000Z",
      readyAt: "2026-08-12T15:08:00.000Z",
    };
    const ready = { ...base, status: "Completed" as const, completedQuantity: 2, execution };
    const cancelled = { ...base, status: "Cancelled" as const };
    // Unfinished work hidden by the filters keeps the filters message.
    expect(
      kitchenSearchHiddenText({ matches: [ready, base], search: "9", inRecentlyFinished: false }),
    ).toBe("Order or table “9” has work, but the filters hide it. Clear the filters to see it.");
    // Cooked but not yet marked ready is still unfinished.
    expect(
      kitchenSearchHiddenText({
        matches: [{ ...ready, execution: { ...execution, readyAt: null } }],
        search: "9",
        inRecentlyFinished: false,
      }),
    ).toContain("the filters hide it");
    expect(
      kitchenSearchHiddenText({
        matches: [ready, cancelled],
        search: "9",
        inRecentlyFinished: false,
      }),
    ).toBe("All of order 9 is done.");
    expect(
      kitchenSearchHiddenText({ matches: [ready], search: "Order #9", inRecentlyFinished: true }),
    ).toBe("All of order 9 is done. Its dishes are listed under Recently finished.");
    expect(
      kitchenSearchHiddenText({ matches: [ready], search: "t4", inRecentlyFinished: false }),
    ).toBe("All of table T4 is done.");
    expect(
      kitchenSearchHiddenText({ matches: [cancelled], search: "9", inRecentlyFinished: false }),
    ).toBe("Order 9 has nothing left to make: its items were cancelled.");
    expect(kitchenSearchHiddenText({ matches: [], search: "9", inRecentlyFinished: false })).toBe(
      null,
    );
  });
});

describe("WP-2423 follow-up: kitchen ticket ages follow the clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={parseKitchenBoardView(kitchenBoardFixture())} />
      </MemoryRouter>,
    );
  const ageOf = (html: string) => /data-age="(?:ok|warning|late)">(\d+ min)</u.exec(html)?.[1];
  it("advances a ticket's age as time passes without a new projection", () => {
    // The fixture's ticket was created at 15:00 and the projection is from 15:12.
    vi.useFakeTimers({ now: new Date("2026-08-12T15:12:00.000Z") });
    const ticks: number[] = [];
    const stop = subscribeKitchenClock(() => ticks.push(Date.now()));
    expect(ageOf(render())).toBe("12 min");
    vi.advanceTimersByTime(kitchenClockTickMs - 1);
    expect(ticks).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ticks).toHaveLength(1);
    vi.advanceTimersByTime(10 * kitchenClockTickMs);
    const html = render();
    expect(ageOf(html)).toBe("17 min");
    expect(html).toContain('data-age="late"');
    stop();
    vi.advanceTimersByTime(4 * kitchenClockTickMs);
    expect(ticks).toHaveLength(11);
    // Unused, the clock stops and the board measures from the projection again.
    expect(ageOf(render())).toBe("12 min");
  });
  it("never shows a negative or shrinking age when the device clock runs slow", () => {
    vi.useFakeTimers({ now: new Date("2026-08-12T15:02:00.000Z") });
    const stop = subscribeKitchenClock(() => undefined);
    expect(ageOf(render())).toBe("12 min");
    stop();
    expect(kitchenClockAt("2026-08-12T15:12:00.000Z", Date.parse("2026-08-12T15:02:00.000Z"))).toBe(
      "2026-08-12T15:12:00.000Z",
    );
    expect(kitchenClockAt("2026-08-12T15:12:00.000Z", null, "2026-08-12T15:20:00.000Z")).toBe(
      "2026-08-12T15:20:00.000Z",
    );
  });
});

it("v15 2026-10-16: a board with only finished work and no filter set says nothing is waiting", () => {
  const view = parseKitchenBoardView({
    ...kitchenBoardFixture(),
    items: [{ ...kitchenItemFixture(), status: "Completed", completedQuantity: 2 }],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen view={view} onRefresh={() => undefined} />
    </MemoryRouter>,
  );
  expect(html).toContain("No active work");
  expect(html).toContain("Nothing to make right now.");
  expect(html).not.toContain("Clear the filters");
  const empty = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen
        view={parseKitchenBoardView({ ...kitchenBoardFixture(), items: [] })}
        onRefresh={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(empty).toContain("Nothing to make right now.");
});
it("times a ticket by its longest-waiting unfinished dish and says its tier in words", () => {
  const [item] = parseKitchenBoardView(kitchenBoardFixture()).items;
  if (!item) throw new Error("fixture item missing");
  const newer = { ...item, workItemReference: "018f0f58-767a-7f3b-a1d0-000000000499" };
  const older = { ...item, createdAt: "2026-08-12T14:50:00.000Z" };
  const done = { ...older, status: "Cancelled" as const };
  const at = "2026-08-12T15:12:00.000Z";
  expect(kitchenTicketAge([newer, older], at)).toEqual({ minutes: 22, tier: "late" });
  // Finished dishes do not age the ticket; a ticket with nothing open is done.
  expect(kitchenTicketAge([newer, done], at)).toEqual({ minutes: 12, tier: "warning" });
  expect(kitchenTicketAge([done], at)).toEqual({ minutes: null, tier: "done" });
  expect(kitchenTicketTierText("late")).toBe("Overdue");
  expect(kitchenTicketTierText("warning")).toBe("Running long");
  expect(kitchenTicketTierText("ok")).toBeNull();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <KitchenBoardScreen view={parseKitchenBoardView(kitchenBoardFixture())} />
    </MemoryRouter>,
  );
  expect(html).toContain('class="kitchen-ticket__timer" data-age="warning">12 min</span>');
  expect(html).toContain('<span class="kitchen-ticket__tier">Running long</span>');
});
