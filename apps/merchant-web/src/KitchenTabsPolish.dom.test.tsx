// @vitest-environment jsdom
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { chooseLanguage, setLanguageForTest } from "./i18n/i18n.js";
import { KitchenBoardScreen } from "./KitchenBoardPages.js";
import { placeRecentlyFinishedPanel } from "./KitchenRework.js";
import { parseKitchenBoardView } from "./kitchen-board.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { click, mount, unmountMounted } from "./dom-test-kit.fixture.js";

// WP-2423 batch 43 (v15 batch 42 live check, kitchen-empty-and-recent-polish).

afterEach(() => {
  document.body.innerHTML = "";
  setLanguageForTest("en");
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

const board = (workspaceFrame: boolean) => (
  <MemoryRouter initialEntries={["/operations/kitchen"]}>
    <KitchenBoardScreen
      view={parseKitchenBoardView({
        ...kitchenBoardFixture(),
        // Tea's order 1, accepted and not started.
        items: [kitchenItemFixture()],
      })}
      onRefresh={() => undefined}
      workspaceFrame={workspaceFrame ? (content: ReactNode) => content : undefined}
    />
  </MemoryRouter>
);

function tab(container: HTMLElement, name: RegExp): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>(".order-status-filters button"),
  ].find((button) => name.test(button.textContent ?? ""));
  if (found === undefined) throw new Error(`no tab ${String(name)}`);
  return found;
}

/** The language switch, with the page reload it ends in standing for a fresh mount. */
async function switchLanguage(language: "en" | "zh-Hans") {
  const reload = vi.fn();
  vi.stubGlobal("location", { ...globalThis.location, reload });
  chooseLanguage(language);
  expect(reload).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
  await unmountMounted();
  document.body.innerHTML = "";
}

it("batch 43 (v15 b42 live): switching language keeps the back office's chosen tab", async () => {
  let { container } = await mount(board(true));
  await click(tab(container, /^To make/u));
  expect(tab(container, /^To make/u).getAttribute("aria-pressed")).toBe("true");
  await switchLanguage("zh-Hans");
  ({ container } = await mount(board(true)));
  expect(tab(container, /^待做/u).getAttribute("aria-pressed")).toBe("true");
  expect(tab(container, /^未完成/u).getAttribute("aria-pressed")).toBe("false");
  // Read back once: a later plain reload starts from Open work.
  await unmountMounted();
  document.body.innerHTML = "";
  ({ container } = await mount(board(true)));
  expect(tab(container, /^未完成/u).getAttribute("aria-pressed")).toBe("true");
  // Open work, the default, keeps nothing.
  await switchLanguage("en");
  expect(sessionStorage.length).toBe(0);
});

it("batch 43 (v15 b42 live): switching language keeps the kitchen display's work state", async () => {
  let { container } = await mount(board(false));
  const select = () => {
    const found = [...container.querySelectorAll("select")].find((element) =>
      [...element.options].some((option) => option.value === "In Progress"),
    );
    if (found === undefined) throw new Error("no work-state select");
    return found;
  };
  const { act } = await import("react");
  await act(async () => {
    const element = select();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(element, "In Progress");
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("Nothing being made");
  await switchLanguage("zh-Hans");
  ({ container } = await mount(board(false)));
  expect(select().value).toBe("In Progress");
  expect(container.textContent).toContain("没有正在制作的工作");
  expect(container.textContent).toContain("目前没有正在制作的。");
});

function rect(left: number, width: number, top = 0, height = 44): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top,
    bottom: top + height,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

it("batch 43 (v15 b42 live): Recently finished hangs from its own button, inside the screen", () => {
  const place = (viewport: number, bar: DOMRect, button: DOMRect, panelWidth: number) => {
    document.body.innerHTML = `<div class="kitchen-board-heading__actions"><details class="kitchen-recent-finished" open><summary>Recently finished · 0</summary><p class="kitchen-recent-finished__panel">Nothing finished in the last 2 hours.</p></details></div>`;
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: viewport,
    });
    const actions = document.querySelector<HTMLElement>(".kitchen-board-heading__actions");
    const details = document.querySelector<HTMLDetailsElement>("details");
    const summary = document.querySelector<HTMLElement>("summary");
    const panel = document.querySelector<HTMLElement>("p");
    if (!actions || !details || !summary || !panel) throw new Error("markup");
    actions.getBoundingClientRect = () => bar;
    summary.getBoundingClientRect = () => button;
    panel.getBoundingClientRect = () => rect(0, panelWidth);
    placeRecentlyFinishedPanel(details);
    expect(details.dataset.anchored).toBe("true");
    // The panel's left, across the screen.
    return bar.left + Number.parseFloat(details.style.getPropertyValue("--kitchen-recent-left"));
  };
  // Half Sugar Tea at 1440 en: the button at x 684-846 (the panel had opened at 996-1416).
  expect(place(1440, rect(560, 864), rect(684, 162), 448)).toBe(684);
  // Near the right edge it ends with its button instead of running off the screen.
  expect(place(1024, rect(200, 808), rect(870, 138), 448)).toBe(1008 - 448);
  // Neither fits: kept 16 px inside the screen.
  expect(place(500, rect(0, 500), rect(300, 138), 452)).toBe(16);
  // Closed: nothing is placed.
  document.body.innerHTML = `<details class="kitchen-recent-finished"><summary>x</summary></details>`;
  const closed = document.querySelector<HTMLDetailsElement>("details");
  placeRecentlyFinishedPanel(closed);
  expect(closed?.dataset.anchored).toBeUndefined();
});
