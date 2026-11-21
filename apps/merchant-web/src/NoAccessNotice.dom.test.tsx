// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { StaffNavigationContext } from "./NoAccessNotice.js";
import { PickupStatePanel } from "./PickupPages.js";
import { OperationalDashboardState } from "./OperationalDashboardPage.js";
import { kitchenOnlyAccessDeniedText, pageAccessDeniedText } from "./access-denied.js";
import type { MerchantNavigationItem } from "./merchant-workspace.js";
import { mount, unmountMounted } from "./dom-test-kit.fixture.js";

afterEach(unmountMounted);

const kitchenDisplay = [
  { screenId: "KIT-KITCHEN-QUEUE", label: "Kitchen", path: "/operations/kitchen" },
] as unknown as readonly MerchantNavigationItem[];

it("batch 38 review: a kitchen display refused the pickup counter or the dashboard is led back to the kitchen", async () => {
  for (const panel of [
    <PickupStatePanel state="PermissionDenied" />,
    <OperationalDashboardState state="PermissionDenied" />,
  ]) {
    const { container } = await mount(
      <MemoryRouter>
        <StaffNavigationContext.Provider value={kitchenDisplay}>
          {panel}
        </StaffNavigationContext.Provider>
      </MemoryRouter>,
    );
    expect(container.textContent).toContain(kitchenOnlyAccessDeniedText);
    expect(container.textContent).not.toContain(pageAccessDeniedText);
    const kitchen = [...container.querySelectorAll("a")].find(
      (link) => link.getAttribute("href") === "/operations/kitchen",
    );
    expect(kitchen?.textContent).toBe("Go to the kitchen");
    await unmountMounted();
  }
});

it("batch 38 review: every whole-page refusal goes through the one shared notice", () => {
  // The kitchen board is the kitchen itself, so "outside kitchen work" would be wrong there.
  const exempt = new Set(["NoAccessNotice.tsx", "KitchenBoardPages.tsx"]);
  const pages = readdirSync(import.meta.dirname).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test.") && !exempt.has(name),
  );
  const bare: string[] = [];
  for (const name of pages) {
    const source = readFileSync(join(import.meta.dirname, name), "utf8");
    if (!source.includes("pageAccessDeniedText")) continue;
    // The text may still sit in a state table, but the page body must be the shared notice.
    if (/<p>\{[^}]*pageAccessDeniedText/u.test(source) || !source.includes("<NoAccessNotice />"))
      bare.push(name);
  }
  expect(bare).toEqual([]);
});
