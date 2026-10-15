import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import {
  createRefundApprovalClient,
  RefundApprovalClientError,
  StepUpError,
} from "./refund-approval-client.js";
import { describeRefundReason, escalationReasonLabel, formatCad } from "./refund-reasons.js";
import { StepUpVerification } from "./StepUpVerification.js";
import { ApprovalFailureNotice } from "./RefundApprovalsPage.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "c".repeat(43);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const entry = {
  orderReference: id(1),
  orderNumber: "A-0042",
  requestReference: id(2),
  paymentIntentReferences: [id(3)],
  paymentMethod: "Online",
  currencyCode: "CAD",
  amountMinor: "12500",
  reasonCode: "WRONG_ITEM",
  note: null,
  escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
  requestedAt: "2026-10-12T15:00:00.000Z",
  requesterName: "Mia",
  requestedByYou: false,
  requesterVerifiedUntil: "2026-10-12T15:15:00.000Z",
  state: "AwaitingApproval",
  approvalReference: null,
  approvedAt: null,
  approverName: null,
  canApprove: true,
  soleOperatorApproval: false,
};

it("WP-2423 Q5: sends a step-up code once and names each refusal without echoing it", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({
        status: "Verified",
        verifiedAt: "2026-10-12T15:00:00.000Z",
        validUntil: "2026-10-12T15:15:00.000Z",
      }),
    )
    .mockResolvedValueOnce(json({ error: "code_rejected" }, 422))
    .mockResolvedValueOnce(json({ error: "code_already_used" }, 422))
    .mockResolvedValueOnce(json({ error: "too_many_attempts", retryAfterSeconds: 300 }, 429))
    .mockResolvedValueOnce(json({ error: "step_up_not_set_up" }, 503))
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403))
    .mockRejectedValueOnce(new Error("offline"));
  const client = createRefundApprovalClient(fetcher);
  await expect(client.stepUp("RefundApproval", "123456", csrf)).resolves.toEqual({
    verifiedAt: "2026-10-12T15:00:00.000Z",
    validUntil: "2026-10-12T15:15:00.000Z",
  });
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/merchant/identity/step-up");
  expect(call?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    purpose: "RefundApproval",
    code: "123456",
  });
  for (const [code, retry] of [
    ["CodeRejected", null],
    ["CodeAlreadyUsed", null],
    ["TooManyAttempts", 300],
    ["NotSetUp", null],
    ["Denied", null],
    ["Unavailable", null],
  ] as const) {
    const error = await client.stepUp("RefundRequest", "654321", csrf).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepUpError);
    expect(error).toMatchObject({ code, retryAfterSeconds: retry });
    expect(String((error as Error).message)).not.toContain("654321");
  }
  // A malformed code never leaves the browser.
  await expect(client.stepUp("RefundRequest", "12ab", csrf)).rejects.toMatchObject({
    code: "CodeRejected",
  });
  expect(fetcher).toHaveBeenCalledTimes(7);
});

it("WP-2423 Q5: reads the approval list strictly", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({
        observedAt: "2026-10-12T15:01:00.000Z",
        canApprove: true,
        soleOperator: null,
        entries: [entry],
      }),
    )
    .mockResolvedValueOnce(
      json({
        observedAt: "2026-10-12T15:01:00.000Z",
        canApprove: true,
        soleOperator: null,
        entries: [{ ...entry, requesterReference: id(9) }],
      }),
    )
    .mockResolvedValueOnce(
      json({
        observedAt: "2026-10-12T15:01:00.000Z",
        canApprove: true,
        soleOperator: null,
        entries: [{ ...entry, state: "Approved" }],
      }),
    )
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403));
  const client = createRefundApprovalClient(fetcher);
  const view = await client.approvals();
  expect(view.entries[0]).toEqual(entry);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" });
  await expect(client.approvals()).rejects.toMatchObject({ code: "Unavailable" });
  await expect(client.approvals()).rejects.toMatchObject({ code: "Unavailable" });
  await expect(client.approvals()).rejects.toMatchObject({ code: "Denied" });
});

it("WP-2423 Q5: approval outcomes keep the same approval reference for a retry", async () => {
  const command = { orderReference: id(1), requestReference: id(2), approvalReference: id(4) };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("lost"))
    .mockResolvedValueOnce(
      json(
        {
          status: "Approved",
          approvalReference: id(4),
          replayed: true,
          payments: [
            { paymentAttemptReference: id(5), operationReference: id(6), state: "SendRecorded" },
          ],
        },
        202,
      ),
    )
    .mockResolvedValueOnce(json({ error: "needs_reverification", party: "Requester" }, 409))
    .mockResolvedValueOnce(json({ error: "same_person" }, 422))
    .mockResolvedValueOnce(json({ error: "refund_changed" }, 409))
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403))
    .mockResolvedValueOnce(json({ error: "refund_approval_unavailable" }, 503));
  const client = createRefundApprovalClient(fetcher);
  await expect(client.approve(command, csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(client.approve(command, csrf)).resolves.toMatchObject({
    replayed: true,
    payments: [{ state: "SendRecorded" }],
  });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  const reverify = await client.approve(command, csrf).catch((e: unknown) => e);
  expect(reverify).toBeInstanceOf(RefundApprovalClientError);
  expect(reverify).toMatchObject({ code: "NeedsReverification", party: "Requester" });
  for (const code of ["SamePerson", "Changed", "Denied", "OutcomeUnknown"])
    await expect(client.approve(command, csrf)).rejects.toMatchObject({ code });
});

it("WP-2423 Q5: shows reasons and amounts in staff language", () => {
  expect(describeRefundReason("WRONG_ITEM")).toBe("Wrong item");
  expect(describeRefundReason("LEGACY_CODE")).toBe("Other reason");
  expect(escalationReasonLabel.OrderOrdinaryTotalAboveCad100).toContain("more than CAD 100");
  expect(formatCad("12505")).toBe("CAD 125.05");
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(StepUpVerification, {
        purpose: "RefundApproval",
        csrf,
        verifiedUntil: null,
        onVerified: () => undefined,
        label: "Verify to approve",
      }),
    ),
  );
  expect(html).toContain("Verify to approve");
  expect(html).toContain('autoComplete="one-time-code"');
  expect(html).toContain('inputMode="numeric"');
});

it("WP-2423 Q5: declines with a listed reason and names each refusal", async () => {
  const command = {
    orderReference: id(1),
    requestReference: id(2),
    operationReference: id(7),
    reasonCode: "ENTERED_IN_ERROR" as const,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({ status: "Declined", declinedAt: "2026-10-12T15:05:00.000Z", replayed: false }),
    )
    .mockResolvedValueOnce(json({ error: "refund_already_prepared" }, 409))
    .mockResolvedValueOnce(json({ error: "refund_already_declined" }, 409))
    .mockResolvedValueOnce(json({ error: "same_person" }, 422))
    .mockResolvedValueOnce(json({ error: "needs_reverification", party: "Approver" }, 409));
  const client = createRefundApprovalClient(fetcher);
  await expect(client.decline(command, csrf)).resolves.toEqual({
    declinedAt: "2026-10-12T15:05:00.000Z",
    replayed: false,
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/payments/refunds/decline");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(command);
  for (const code of ["AlreadyPrepared", "AlreadyDeclined", "SamePerson", "NeedsReverification"])
    await expect(client.decline(command, csrf)).rejects.toMatchObject({ code });
  await expect(
    client.decline({ ...command, reasonCode: "FREE" as never }, csrf),
  ).rejects.toMatchObject({ code: "Unavailable" });
  const noted = vi.fn<typeof fetch>().mockResolvedValueOnce(
    json({
      observedAt: "2026-10-12T15:01:00.000Z",
      canApprove: true,
      soleOperator: null,
      entries: [{ ...entry, reasonCode: "OTHER", note: "Customer left early" }],
    }),
  );
  expect((await createRefundApprovalClient(noted).approvals()).entries[0]?.note).toBe(
    "Customer left early",
  );
  const misplaced = vi.fn<typeof fetch>().mockResolvedValueOnce(
    json({
      observedAt: "2026-10-12T15:01:00.000Z",
      canApprove: true,
      soleOperator: null,
      entries: [{ ...entry, note: "Only for Other" }],
    }),
  );
  await expect(createRefundApprovalClient(misplaced).approvals()).rejects.toMatchObject({
    code: "Unavailable",
  });
});

it("WP-2423 Q5: reads the server's own verification and names role refusals apart from sessions", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ validUntil: "2026-10-12T15:15:00.000Z" }))
    .mockResolvedValueOnce(json({ validUntil: null }))
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403))
    .mockResolvedValueOnce(json({ error: "refund_role_required" }, 403))
    .mockResolvedValueOnce(json({ error: "requester_not_eligible" }, 409))
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403));
  const client = createRefundApprovalClient(fetcher);
  await expect(client.stepUpStatus()).resolves.toBe("2026-10-12T15:15:00.000Z");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/identity/step-up");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  await expect(client.stepUpStatus()).resolves.toBeNull();
  await expect(client.stepUpStatus()).rejects.toMatchObject({ code: "Denied" });
  const command = { orderReference: id(1), requestReference: id(2), approvalReference: id(4) };
  for (const code of ["NotPermitted", "RequesterNotEligible", "Denied"])
    await expect(client.approve(command, csrf)).rejects.toMatchObject({ code });
});

it("WP-2423: approve and decline refused on a PIN sign-in ask to confirm it is them", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ error: "full_sign_in_required" }, 403))
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403))
    .mockResolvedValueOnce(json({ error: "full_sign_in_required" }, 403))
    .mockResolvedValueOnce(json({ error: "request_denied" }, 403));
  const client = createRefundApprovalClient(fetcher);
  const approval = {
    orderReference: id(1),
    requestReference: id(2),
    approvalReference: id(7),
  };
  await expect(client.approve(approval, csrf)).rejects.toMatchObject({
    code: "FullSignInRequired",
  });
  await expect(client.approve(approval, csrf)).rejects.toMatchObject({ code: "Denied" });
  const decline = {
    orderReference: id(1),
    requestReference: id(2),
    operationReference: id(8),
    reasonCode: "NOT_ELIGIBLE" as const,
  };
  await expect(client.decline(decline, csrf)).rejects.toMatchObject({
    code: "FullSignInRequired",
  });
  await expect(client.decline(decline, csrf)).rejects.toMatchObject({ code: "Denied" });
});

it("WP-2423: an approval refused on a PIN sign-in shows the verification step", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalFailureNotice, { outcome: { kind: "SignIn" }, csrf }),
  );
  expect(html).toContain("You signed in with a PIN");
  expect(html).toContain("Verify it&#x27;s you");
  expect(html).not.toContain("Sign in again");
  const failed = renderToStaticMarkup(
    createElement(ApprovalFailureNotice, {
      outcome: { kind: "Failed", retry: false, message: "Your session has ended." },
      csrf,
    }),
  );
  expect(failed).toContain("Your session has ended.");
  expect(failed).not.toContain("You signed in with a PIN");
});
