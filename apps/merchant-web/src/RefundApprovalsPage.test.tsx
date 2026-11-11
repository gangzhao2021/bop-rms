import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { noAccessHeading } from "./access-denied.js";
import type { RefundApprovalEntry } from "./refund-approval-client.js";
import {
  NotSentCard,
  StaffRoleRequestsSection,
  waitingText,
  type StaffRoleRead,
} from "./RefundApprovalsPage.js";

it("Owner 2026-10-25: says how long a refund has waited, in the unit that reads naturally", () => {
  const at = Date.parse("2026-10-25T12:00:00.000Z");
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  expect(waitingText(ago(12), at)).toBe("Waiting 12 min");
  expect(waitingText(ago(5 * 60 + 10), at)).toBe("Waiting 5 h");
  // Ten days with no sign of it was the case found on v15.
  expect(waitingText(ago(10 * 24 * 60 + 30), at)).toBe("Waiting 10 days");
  // A clock slightly behind the server never reads as negative.
  expect(waitingText(new Date(at + 60_000).toISOString(), at)).toBe("Waiting 0 min");
});

describe("WP-2423 M07: staff roles on Approvals for a viewer without refund approval", () => {
  const render = (read: StaffRoleRead, refundsDenied = true) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <StaffRoleRequestsSection
          read={read}
          refundsDenied={refundsDenied}
          onRetry={() => undefined}
        />
      </MemoryRouter>,
    );
  it("says it is still loading, never 'no access'", () => {
    const html = render({ state: "Loading" });
    expect(html).toContain("Checking staff roles waiting for approval");
    expect(html).not.toContain(noAccessHeading);
  });
  it("shows a failed read as could-not-load with a retry, never 'no access'", () => {
    const html = render({ state: "Unavailable" });
    expect(html).toContain("could not be loaded");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/u);
    expect(html).not.toContain(noAccessHeading);
  });
  it("says there is nothing to approve when the read is empty, not a blank page", () => {
    expect(render({ state: "Ready", requests: [] })).toContain("Nothing to approve");
    // With refund approval the refund section says it; nothing is shown twice.
    expect(render({ state: "Ready", requests: [] }, false)).toBe("");
    expect(render({ state: "Loading" }, false)).toBe("");
  });
  it("lists a waiting role with a link to the person's page", () => {
    const html = render({
      state: "Ready",
      requests: [
        {
          actorReference: "0190a5a0-0000-7000-8000-000000000001",
          person: "Mia",
          roleName: "Cashier",
          scope: "Store",
          requestedBy: "You",
          requestedAt: "2026-11-06T12:00:00.000Z",
          action: "ApproveAlone",
        },
      ],
    });
    expect(html).toContain("Staff roles waiting for you");
    expect(html).toContain("/app/organization/users/0190a5a0-0000-7000-8000-000000000001");
  });
});

it("WP-2423 M14: a cashier's request waits for someone who may send it; they send it from Approvals", () => {
  const asked: RefundApprovalEntry = {
    orderReference: "01909974-0000-7000-8000-000000000001",
    orderNumber: "12",
    requestReference: "01909974-0000-7000-8000-000000000002",
    requestOperationReference: "01909974-0000-7000-8000-000000000003",
    paymentAttemptReferences: ["01909974-0000-7000-8000-000000000004"],
    paymentIntentReferences: ["01909974-0000-7000-8000-000000000005"],
    paymentMethod: "Online" as const,
    currencyCode: "CAD" as const,
    amountMinor: "1130",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: [],
    requestedAt: "2026-11-10T12:00:00.000Z",
    requesterName: "Sam",
    requestedByYou: false,
    requesterVerifiedUntil: null,
    state: "NotSent" as const,
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: false,
    soleOperatorApproval: false,
  };
  const render = (canSend: boolean, entry: RefundApprovalEntry = asked) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <NotSentCard entry={entry} csrf="c" canSend={canSend} onChanged={() => undefined} />
      </MemoryRouter>,
    );
  const manager = render(true);
  expect(manager).toContain("Asked by Sam, waiting for you to send");
  expect(manager).toContain("Recorded, not sent yet. The guest has not been refunded.");
  expect(manager).toContain("<button");
  const cashier = render(false);
  expect(cashier).toContain("A manager or the owner sends it.");
  // v15 batch 5: a cashier reading their own request was told it waited "for you to send".
  expect(cashier).not.toContain("waiting for you to send");
  expect(render(false, { ...asked, requestedByYou: true })).toContain(
    "Asked by You, waiting for a manager or the owner to send",
  );
  expect(cashier).not.toContain("<button");
  expect(render(true, { ...asked, paymentMethod: "CardMachine" })).toContain(
    "refund it on the machine, then record it on the payment page",
  );
});
