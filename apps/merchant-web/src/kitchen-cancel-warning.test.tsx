import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KitchenMayHaveStartedNote, kitchenMayHaveStartedText } from "./kitchen-cancel-warning.js";

describe("DEC-KITCHEN-ONE-TAP: taking back a dish nobody marked started", () => {
  const at = Date.parse("2026-11-05T12:00:00.000Z");
  it("warns once the kitchen has had it three minutes, and never before", () => {
    expect(kitchenMayHaveStartedText("2026-11-05T11:57:30.000Z", at)).toBeNull();
    expect(kitchenMayHaveStartedText("2026-11-05T11:57:00.000Z", at)).toBe(
      "The kitchen got this 3 min ago and may already be making it. Ask them first.",
    );
    expect(kitchenMayHaveStartedText("2026-11-05T11:20:00.000Z", at)).toContain("40 min");
  });
  it("says nothing about a round the kitchen has not received", () => {
    expect(kitchenMayHaveStartedText(null, at)).toBeNull();
    expect(kitchenMayHaveStartedText(undefined, at)).toBeNull();
    expect(renderToStaticMarkup(<KitchenMayHaveStartedNote receivedAt={null} />)).toBe("");
  });
  it("warns without blocking: a note beside the action, not a control", () => {
    const html = renderToStaticMarkup(
      <KitchenMayHaveStartedNote receivedAt="2020-01-01T00:00:00.000Z" />,
    );
    expect(html).toContain('role="note"');
    expect(html).not.toContain("button");
  });
});
