import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createElement } from "react";
import { approvalsBadgeCount, summarizeApprovalsWaiting } from "./approvals-waiting.js";
import { NeedsAttention, initialOverviewState } from "./StoreOverview.js";

it("WP-2423 Q35: counts refunds to approve apart from approved ones not sent yet", () => {
  expect(
    summarizeApprovalsWaiting([
      { state: "AwaitingApproval", canApprove: true },
      { state: "Approved", canApprove: false },
      { state: "AwaitingApproval", canApprove: true },
    ]),
  ).toEqual({ awaiting: 2, approvedNotSent: 1, notSent: 0 });
  expect(summarizeApprovalsWaiting([])).toEqual({ awaiting: 0, approvedNotSent: 0, notSent: 0 });
  // WP-2423 M14: a cashier's request that needs no approval waits for someone to send it.
  expect(summarizeApprovalsWaiting([{ state: "NotSent", canApprove: false }]).notSent).toBe(1);
  // A cashier, who can't send, is never told a request waits for them.
  expect(summarizeApprovalsWaiting([{ state: "NotSent", canApprove: false }], false).notSent).toBe(
    0,
  );
});

it("v15 batch 5: a cashier's Home and badge count nothing they can neither approve nor send", () => {
  // The cashier's approvals read lists the store's requests, none of which the cashier can act on.
  const cashier = summarizeApprovalsWaiting(
    [
      { state: "AwaitingApproval", canApprove: false },
      { state: "Approved", canApprove: false },
      { state: "NotSent", canApprove: false },
    ],
    false,
  );
  expect(cashier).toEqual({ awaiting: 0, approvedNotSent: 0, notSent: 0 });
  expect(approvalsBadgeCount(cashier, null)).toBe(0);
  // A manager who sends but can't approve this request (an owner's approval) only sees the send.
  expect(
    summarizeApprovalsWaiting(
      [
        { state: "AwaitingApproval", canApprove: false },
        { state: "Approved", canApprove: false },
      ],
      true,
    ),
  ).toEqual({ awaiting: 0, approvedNotSent: 1, notSent: 0 });
});

it("WP-2423 Q35: the home page says what waits for the approver, and nothing when not read", () => {
  const render = (
    approvals: { awaiting: number; approvedNotSent: number; notSent?: number } | null,
  ) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(NeedsAttention, {
          state: initialOverviewState,
          approvals: approvals === null ? null : { notSent: 0, ...approvals },
        }),
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
  // WP-2423 M14: a cashier asked; a manager is told on Home to send it.
  const asked = render({ awaiting: 0, approvedNotSent: 0, notSent: 1 });
  expect(asked).toContain("Refunds not sent yet");
  expect(asked).toContain("1 asked by staff, waiting for you to send");
  expect(asked).toContain('href="/app/approvals"');
});

it("WP-2423 M07: the Approvals badge adds staff roles waiting, and only refunds if that read failed", () => {
  const refunds = { awaiting: 1, approvedNotSent: 1, notSent: 1 };
  expect(approvalsBadgeCount(refunds, 2)).toBe(5);
  expect(approvalsBadgeCount(refunds, null)).toBe(3);
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
