import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createElement } from "react";
import { approvalsBadgeCount, summarizeApprovalsWaiting } from "./approvals-waiting.js";
import { NeedsAttention, initialOverviewState } from "./StoreOverview.js";

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
        createElement(NeedsAttention, { state: initialOverviewState, approvals }),
      ),
    );
  const html = render({ awaiting: 1, approvedNotSent: 0 });
  expect(html).toContain("Refunds waiting for approval");
  expect(html).toContain("1 to approve");
  expect(html).toContain('href="/app/approvals"');
  // Approved but not sent is still waiting for someone, with no approval left to give.
  const notSent = render({ awaiting: 0, approvedNotSent: 1 });
  expect(notSent).toContain("Refunds waiting for approval");
  expect(notSent).toContain("1 approved, not sent yet");
  expect(render({ awaiting: 0, approvedNotSent: 0 })).not.toContain("Refunds waiting for approval");
  expect(render(null)).not.toContain("Refunds waiting for approval");
});

it("WP-2423 M07: the Approvals badge adds staff roles waiting, and only refunds if that read failed", () => {
  const refunds = { awaiting: 1, approvedNotSent: 1 };
  expect(approvalsBadgeCount(refunds, 2)).toBe(4);
  expect(approvalsBadgeCount(refunds, null)).toBe(2);
  // A Store Manager without refund approval: the refund read is refused, roles still count.
  expect(approvalsBadgeCount(null, 1)).toBe(1);
  expect(approvalsBadgeCount(null, null)).toBe(0);
});

it("WP-2423 M07: Home lists staff roles waiting like the badge, and says when they could not be read", () => {
  const render = (staffRoles: number | "Unavailable" | null) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(NeedsAttention, { state: initialOverviewState, approvals: null, staffRoles }),
      ),
    );
  const waiting = render(2);
  expect(waiting).toContain("Roles waiting for approval");
  expect(waiting).toContain("2 to approve");
  expect(waiting).toContain('href="/app/approvals"');
  expect(render(0)).not.toContain("Roles waiting for approval");
  expect(render(null)).not.toContain("Roles waiting for approval");
  // A failed read is never a silent zero.
  const failed = render("Unavailable");
  expect(failed).toContain("This list may be missing something");
  expect(failed).toContain("Staff roles waiting for approval");
  expect(approvalsBadgeCount(null, "Unavailable")).toBe(0);
});
