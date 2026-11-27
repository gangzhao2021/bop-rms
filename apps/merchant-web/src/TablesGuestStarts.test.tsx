import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TablesGuestStarts } from "./TablesGuestStarts.js";

const line = (canTurnOff: boolean) =>
  renderToStaticMarkup(
    <TablesGuestStarts
      starts={{ version: 4, canTurnOff }}
      csrf={"a".repeat(43)}
      locked={false}
      reread={async () => null}
      onResult={() => undefined}
    />,
  );

it("DEC-DINING-GUEST-TABLE-START: says guests can start tables, and only whoever may pause sees Turn off", () => {
  expect(line(true)).toContain("Guests can start free tables.");
  expect(line(true)).toContain(">Turn off</button>");
  // Nothing happens on the first tap: that only asks (browser case in dining-guest-started-table).
  expect(line(true)).not.toContain("Only the owner can turn this back on");
  expect(line(false)).toContain("Guests can start free tables.");
  expect(line(false)).not.toContain("<button");
});
