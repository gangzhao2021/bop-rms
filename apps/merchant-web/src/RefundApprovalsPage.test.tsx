import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { noAccessHeading } from "./access-denied.js";
import type { RefundApprovalEntry } from "./refund-approval-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  ApprovalCard,
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
    cashGivenBackMinor: null,
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

it("v15 batch 8: a counter cash refund is given back from the drawer in whole nickels, on Approvals too", () => {
  const cash: RefundApprovalEntry = {
    orderReference: "01909974-0000-7000-8000-000000000001",
    orderNumber: "35",
    requestReference: "01909974-0000-7000-8000-000000000002",
    requestOperationReference: "01909974-0000-7000-8000-000000000003",
    paymentAttemptReferences: ["01909974-0000-7000-8000-000000000004"],
    paymentIntentReferences: ["01909974-0000-7000-8000-000000000005"],
    paymentMethod: "Cash",
    // The request is $3.67; the drawer gives back $3.65 (the server's whole nickels).
    cashGivenBackMinor: "365",
    currencyCode: "CAD",
    amountMinor: "367",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: [],
    requestedAt: "2026-11-10T12:00:00.000Z",
    requesterName: "Sam",
    requestedByYou: false,
    requesterVerifiedUntil: null,
    state: "NotSent",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: false,
    soleOperatorApproval: false,
  };
  const notSent = (canSend: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <NotSentCard entry={cash} csrf="c" canSend={canSend} onChanged={() => undefined} />
      </MemoryRouter>,
    );
  const card = (entry: RefundApprovalEntry) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <ApprovalCard
          entry={entry}
          csrf="c"
          soleOperator={null}
          viewerVerifiedUntil={null}
          onViewerVerified={() => undefined}
          onChanged={() => undefined}
          fetcher={async () => new Response(null, { status: 503 })}
        />
      </MemoryRouter>,
    );
  const awaiting = {
    ...cash,
    state: "AwaitingApproval" as const,
    canApprove: true,
    escalationReasons: ["MoreThan24Hours" as const],
  };
  const approved = {
    ...awaiting,
    state: "Approved" as const,
    approvalReference: "01909974-0000-7000-8000-000000000006",
    approvedAt: "2026-11-10T12:05:00.000Z",
    approverName: "Lee",
  };
  const manager = notSent(true);
  expect(manager).toContain("waiting for you to give it back in cash");
  expect(manager).toContain(
    "Paid in cash: give back $3.65 from the drawer (the refund of $3.67, in whole nickels), then record it on the payment page.",
  );
  expect(manager).toContain("Recorded, not given back yet.");
  expect(notSent(false)).toContain("a manager or the owner gives back $3.65 from the drawer");
  const asking = card(awaiting);
  expect(asking).toContain("Cash at the counter");
  expect(asking).toContain("Approve giving back $3.65 in cash");
  const done = card(approved);
  expect(done).toContain("Approved — give back $3.65 in cash, then record it");
  expect(done).toContain(
    "Approved. Give back $3.65 in cash from the drawer (the refund of $3.67, in whole nickels), then record it on the payment page.",
  );
  expect(done).toContain("Record the cash given back");
  for (const html of [manager, notSent(false), asking, done]) {
    expect(html).not.toMatch(/card machine|on the machine|slip/u);
    expect(html).not.toMatch(/\bsen[dt]\b/u);
  }
  // A card-machine payment keeps its card-machine words.
  expect(card({ ...approved, paymentMethod: "CardMachine", cashGivenBackMinor: null })).toContain(
    "slip reference",
  );
  setLanguageForTest("zh-Hans");
  expect(notSent(true)).toContain("现金付款：请从钱箱退还现金 $3.65（退款 $3.67，按 5 分取整）");
  expect(card(approved)).toContain("已批准。请从钱箱退还现金 $3.65（退款 $3.67，按 5 分取整）");
  expect(card(awaiting)).toContain("批准退还现金 $3.65");
  setLanguageForTest("en");
  // b12: the requester's check is one sentence in each language, punctuated in that language.
  const verified = {
    ...awaiting,
    requesterName: "Mia (test)",
    requesterVerifiedUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const line = (html: string) =>
    /<p class="refund-approval-card__requester">(.*?)<\/p>/u
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/gu, "") ?? "";
  expect(line(card(verified))).toMatch(
    /^Mia \(test\) has confirmed it is them; approve before [^.]+\.$/u,
  );
  setLanguageForTest("zh-Hans");
  expect(line(card(verified))).toMatch(/^Mia \(test\) 已确认身份，请在 [^：.。]+ 前批准。$/u);
  setLanguageForTest("en");
});
