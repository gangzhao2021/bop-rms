import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createElement } from "react";
import { summarizeApprovalsWaiting } from "./approvals-waiting.js";
import { OverviewToday, initialOverviewState } from "./StoreOverview.js";

it("WP-2423 Q35: counts refunds to approve apart from approved ones not sent yet", () => {
  expect(
    summarizeApprovalsWaiting([
      { state: "AwaitingApproval" },
      { state: "Approved" },
      { state: "AwaitingApproval" },
    ]),
  ).toEqual({ awaiting: 2, approvedNotSent: 1 });
  expect(summarizeApprovalsWaiting([])).toEqual({ awaiting: 0, approvedNotSent: 0 });
});

it("WP-2423 Q35: the home page says what waits for the approver, and nothing when not read", () => {
  const render = (approvals: { awaiting: number; approvedNotSent: number } | null) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(OverviewToday, { state: initialOverviewState, approvals }),
      ),
    );
  const html = render({ awaiting: 1, approvedNotSent: 0 });
  expect(html).toContain("Refunds waiting for approval");
  expect(html).toContain("1 to approve");
  expect(html).toContain('href="/app/approvals"');
  expect(render({ awaiting: 0, approvedNotSent: 0 })).toContain("Nothing waiting");
  expect(render(null)).not.toContain("Refunds waiting for approval");
});
