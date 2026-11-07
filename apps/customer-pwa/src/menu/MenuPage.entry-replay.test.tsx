// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, it } from "vitest";
import { MenuBrowsePage, resetEntryReplayForTest } from "./MenuPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.replaceChildren();
  resetEntryReplayForTest();
});

function Entry() {
  return <p data-testid="entry">entry page at {useLocation().pathname}</p>;
}
async function openMenu() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/menu"]}>
        <Routes>
          <Route path="/" element={<Entry />} />
          <Route path="/menu" element={<MenuBrowsePage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

it("WP-2423 live minor 26: a reloaded menu that knows no Store goes once to the entry, which replays the waiting scan", async () => {
  const first = await openMenu();
  // The entry page (it replays this browser's waiting scan: the table-not-open page again).
  expect(first.container.textContent).toBe("entry page at /");
  first.root.unmount();
  // Still no Store after that (no waiting scan): the menu says so, it does not go round.
  const second = await openMenu();
  expect(second.container.textContent).toContain("Scan the location QR code");
  expect(second.container.textContent).toContain("Return to entry");
});
