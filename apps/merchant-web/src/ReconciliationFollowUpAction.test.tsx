import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReconciliationFollowUpAction } from "./ReconciliationFollowUpAction.js";
it("requires current owner review before showing mutation controls", () => {
  const html = renderToStaticMarkup(
    <ReconciliationFollowUpAction
      exceptionReference="0190fa82-0000-7000-8000-000000000001"
      csrf={"a".repeat(43)}
      readOnly={false}
    />,
  );
  expect(html).toContain("Review current follow-up");
  expect(html).not.toContain("Acknowledge payment difference");
  expect(html).not.toContain("Assign payment difference");
  expect(html).toContain('aria-live="polite"');
});
it("explains stale read-only state without asserting a completed financial resolution", () => {
  const html = renderToStaticMarkup(
    <ReconciliationFollowUpAction
      exceptionReference="0190fa82-0000-7000-8000-000000000001"
      csrf={"a".repeat(43)}
      readOnly
    />,
  );
  expect(html).toContain("Refresh the workbench before changing follow-up");
  expect(html).not.toContain("Follow-up recorded");
});
