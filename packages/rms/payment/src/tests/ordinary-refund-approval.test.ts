import { assertOrdinaryRefundRequester } from "../application/ordinary-refund-approval.js";
import {
  encodeOrdinaryRefundApproval,
  decodeOrdinaryRefundApproval,
} from "../application/ordinary-refund-approval.js";
import { expect, it } from "vitest";
import { createOrdinaryRefundIndependentApproval as create } from "../application/ordinary-refund-approval.js";
import { evaluateOrdinaryRefundIndependentApproval as evaluate } from "../application/ordinary-refund-approval.js";
const id = (n: number) => "01909982-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T12:15:00.000Z";
const mfa = "2026-09-13T12:00:00.000Z";
function fixture() {
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
  };
  const subject = {
    ...scope,
    requestReference: id(5),
    claimsDigest: "sha256:" + "a".repeat(64),
    allocationDigest: "sha256:" + "b".repeat(64),
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
  };
  return {
    subject,
    observedAt: at,
    approval: {
      approvalReference: id(6),
      subject: { ...subject },
      requesterReference: id(7),
      approverReference: id(8),
      approvedAt: at,
      requesterMfaAt: mfa,
      approverMfaAt: mfa,
    },
    requester: {
      ...scope,
      actorReference: id(7),
      role: "Manager",
      active: true,
      permissionCode: "payment.refund.request",
      allowed: true,
      recentMfaAt: mfa as string | null,
      observedAt: at,
    },
    approver: {
      ...scope,
      actorReference: id(8),
      role: "Finance",
      active: true,
      permissionCode: "payment.refund.approve",
      allowed: true,
      recentMfaAt: mfa as string | null,
      observedAt: at,
    },
  };
}
it("accepts distinct current actors at exact15-minute MFA boundary", () => {
  expect(evaluate(fixture())).toEqual({ status: "ApprovalCurrent", approvalReference: id(6) });
});
it.each(["requester", "approver"] as const)(
  "requires fresh current %s MFA and permission",
  (key) => {
    const f = fixture();
    f[key].recentMfaAt = "2026-09-13T11:59:59.999Z";
    expect(evaluate(f).status).toBe("NeedsReapproval");
    f[key].recentMfaAt = "2026-09-13T12:15:00.001Z";
    expect(evaluate(f).status).toBe("NeedsReapproval");
    f[key].recentMfaAt = null;
    expect(evaluate(f).status).toBe("NeedsReapproval");
    f[key].recentMfaAt = mfa;
    f[key].allowed = false;
    expect(evaluate(f).status).toBe("NeedsReapproval");
    f[key].allowed = true;
    f[key].active = false;
    expect(evaluate(f).status).toBe("NeedsReapproval");
  },
);
it.each(["requesterMfaAt", "approverMfaAt"] as const)("checks historical %s at approval", (key) => {
  const f = fixture();
  f.approval[key] = "2026-09-13T11:59:59.999Z";
  expect(evaluate(f).status).toBe("NeedsReapproval");
});
it.each(["claimsDigest", "allocationDigest"] as const)("invalidates a changed %s", (key) => {
  const f = fixture();
  f.subject[key] = "sha256:" + "c".repeat(64);
  expect(evaluate(f).status).toBe("NeedsReapproval");
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "requestReference",
] as const)("rejects changed approval subject %s", (key) => {
  const f = fixture();
  f.approval.subject[key] = id(99);
  expect(evaluate(f).status).toBe("NeedsReapproval");
});
it("rejects self approval, substituted actor and an ineligible approval role", () => {
  const f = fixture();
  f.approval.approverReference = f.approval.requesterReference;
  expect(evaluate(f).status).toBe("NeedsReapproval");
  const swapped = fixture();
  swapped.approver.actorReference = id(99);
  expect(evaluate(swapped).status).toBe("NeedsReapproval");
  const manager = fixture();
  manager.approver.role = "Manager";
  expect(evaluate(manager).status).toBe("NeedsReapproval");
});
it("invalidates missing approval, old policy and stale authority observation", () => {
  expect(evaluate({ ...fixture(), approval: null }).status).toBe("NeedsReapproval");
  const f = fixture();
  f.approval.subject.policyVersion = "OLD_POLICY";
  expect(evaluate(f).status).toBe("NeedsReapproval");
  const stale = fixture();
  stale.requester.observedAt = mfa;
  expect(evaluate(stale).status).toBe("NeedsReapproval");
});
it("rechecks MFA at dispatch after approval was valid", () => {
  const f = fixture();
  f.observedAt = "2026-09-13T12:15:00.001Z";
  f.requester.observedAt = f.observedAt;
  f.approver.observedAt = f.observedAt;
  expect(evaluate(f).status).toBe("NeedsReapproval");
});

function creationInput() {
  const f = fixture();
  return {
    approvalReference: f.approval.approvalReference,
    subject: f.subject,
    requester: f.requester,
    approver: f.approver,
    observedAt: f.observedAt,
  };
}
it("creates an immutable approval bound to the exact authority and refund subject", () => {
  const input = creationInput();
  const approval = create(input);
  expect(approval).toEqual(fixture().approval);
  input.subject.claimsDigest = "sha256:" + "c".repeat(64);
  expect(approval.subject.claimsDigest).toBe(fixture().subject.claimsDigest);
  expect(Object.isFrozen(approval)).toBe(true);
  expect(Object.isFrozen(approval.subject)).toBe(true);
});
it.each(["requester", "approver"] as const)(
  "refuses creation with missing, expired or revoked %s authority",
  (key) => {
    for (const patch of [
      { recentMfaAt: null },
      { recentMfaAt: "2026-09-13T11:59:59.999Z" },
      { allowed: false },
      { active: false },
      { observedAt: mfa },
      { storeReference: id(99) },
    ]) {
      const input = creationInput();
      Object.assign(input[key], patch);
      expect(() => create(input)).toThrow("ORDINARY_REFUND_APPROVAL_DENIED");
    }
  },
);
it("refuses self approval and caller-supplied historical MFA overrides", () => {
  const input = creationInput();
  input.approver.actorReference = input.requester.actorReference;
  expect(() => create(input)).toThrow("ORDINARY_REFUND_APPROVAL_DENIED");
  expect(() => create({ ...creationInput(), requesterMfaAt: at })).toThrow();
});

it("round trips a canonical durable approval without trusting current authority", () => {
  const approval = create(creationInput());
  expect(decodeOrdinaryRefundApproval(encodeOrdinaryRefundApproval(approval))).toEqual(approval);
  expect(() => decodeOrdinaryRefundApproval("{")).toThrow();
  expect(() => decodeOrdinaryRefundApproval(" ".repeat(8193))).toThrow();
  expect(() => encodeOrdinaryRefundApproval({ ...approval, extra: true })).toThrow();
});
it("refuses durable self approval and historically expired MFA", () => {
  const approval = create(creationInput());
  expect(() =>
    encodeOrdinaryRefundApproval({
      ...approval,
      approverReference: approval.requesterReference,
    }),
  ).toThrow();
  expect(() =>
    encodeOrdinaryRefundApproval({
      ...approval,
      requesterMfaAt: "2026-09-13T11:59:59.999Z",
    }),
  ).toThrow();
});

it("requires a current Manager request capability without imposing non-escalated MFA", () => {
  const f = fixture();
  const expected = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    actorReference: id(7),
  };
  const check = (patch: Record<string, unknown> = {}) =>
    assertOrdinaryRefundRequester({
      expected,
      observedAt: at,
      authority: { ...f.requester, recentMfaAt: null, ...patch },
    });
  expect(() => check()).not.toThrow();
  for (const patch of [
    { role: "Owner" },
    { active: false },
    { allowed: false },
    { permissionCode: "payment.refund.approve" },
    { actorReference: id(99) },
    { storeReference: id(99) },
    { observedAt: mfa },
  ])
    expect(() => check(patch)).toThrow();
});
