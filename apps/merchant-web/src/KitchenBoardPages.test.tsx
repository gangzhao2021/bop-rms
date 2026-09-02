import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  KitchenBoardScreen,
  KitchenBoardStatePanel,
  KitchenWorkItemScreen,
} from "./KitchenBoardPages.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { parseKitchenBoardView, parseKitchenWorkItemView } from "./kitchen-board.js";
describe("WP-1804 Kitchen Board screens", () => {
  it("renders station, safety, age and bounded actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenBoardScreen view={parseKitchenBoardView(kitchenBoardFixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "KIT-KITCHEN-QUEUE",
      "Hot line",
      "Mushroom rice bowl",
      "12 minutes",
      "ReviewRequired",
      "Accept",
      "Start / ready by policy",
    ])
      expect(html).toContain(value);
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
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <KitchenWorkItemScreen item={parseKitchenWorkItemView(kitchenItemFixture())} />
        <KitchenBoardStatePanel state="CommandFailed" />
      </MemoryRouter>,
    );
    expect(html).toContain("KIT-WORK-ITEM");
    expect(html).toContain("absent facts are not inferred");
    expect(html).toContain("No Kitchen transition is assumed");
  });
});
