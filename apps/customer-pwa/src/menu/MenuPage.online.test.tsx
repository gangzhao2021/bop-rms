// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { MenuBrowsePage } from "./MenuPage.js";
import type { CustomerMenuClient, MenuJourneyContext, MenuLoadResult } from "./types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

const context: MenuJourneyContext = Object.freeze({
  publicStoreReference: "018f7500-0000-7000-8000-000000000001",
  channel: "Pickup",
  locale: "en-CA",
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
});

it("M94: an offline menu opens again by itself when the phone is back online", async () => {
  let calls = 0;
  let result: MenuLoadResult = Object.freeze({ kind: "Offline" });
  const client: CustomerMenuClient = {
    load: async () => {
      calls += 1;
      return result;
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/menu"]}>
        <MenuBrowsePage context={context} client={client} />
      </MemoryRouter>,
    );
  });
  expect(container.textContent).toContain("You’re offline");
  expect(container.textContent).toContain("opens again by itself");
  expect(container.textContent).not.toMatch(/cache/iu);
  expect(calls).toBe(1);
  result = Object.freeze({ kind: "NotFound" });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  expect(calls).toBe(2);
  expect(container.textContent).not.toContain("You’re offline");
  // A menu already shown is not read again on every "online".
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  expect(calls).toBe(2);
  root.unmount();
});
