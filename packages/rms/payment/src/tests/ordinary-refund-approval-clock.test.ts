import { expect, it } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { assertCurrentOrdinaryRefundApprovalAuthority as check } from "../infrastructure/persistence/ordinary-refund-approval-store.js";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
const at = "2026-09-13T12:15:00.000Z";
const approval = {
  approvalReference: id(1),
  subject: {
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    orderReference: id(5),
    requestReference: id(6),
    claimsDigest: "sha256:" + "a".repeat(64),
    allocationDigest: "sha256:" + "b".repeat(64),
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
  },
  requesterReference: id(7),
  approverReference: id(8),
  approvedAt: at,
  requesterMfaAt: "2026-09-13T12:00:00.000Z",
  approverMfaAt: "2026-09-13T12:00:00.000Z",
};
function fixture(now: unknown, refreshed = false) {
  const tx = { query: async () => ({ rows: [{ now }] }) } as unknown as ConsumerTransaction;
  const authority: Parameters<typeof check>[2] = async (transaction, query) => {
    expect(transaction).toBe(tx);
    expect(query.observedAt).toBe(now instanceof Date ? now.toISOString() : now);
    return {
      ...query,
      active: true,
      allowed: true,
      role: query.permissionCode === "payment.refund.request" ? "Manager" : "Finance",
      recentMfaAt: refreshed ? query.observedAt : approval.requesterMfaAt,
    };
  };
  return { tx, authority };
}
it("uses database time for the exact MFA boundary", async () => {
  const f = fixture(new Date(at));
  await expect(check(f.tx, approval, f.authority)).resolves.toBeUndefined();
});
it("rejects MFA that expired after preparation", async () => {
  const f = fixture("2026-09-13T12:15:00.001Z");
  await expect(check(f.tx, approval, f.authority)).rejects.toThrow();
});
it("accepts refreshed current MFA while preserving historical approval facts", async () => {
  const f = fixture("2026-09-13T12:16:00.000Z", true);
  await expect(check(f.tx, approval, f.authority)).resolves.toBeUndefined();
});
it("rejects a future approval and unavailable database clock", async () => {
  for (const now of ["2026-09-13T12:14:59.999Z", null]) {
    const f = fixture(now);
    await expect(check(f.tx, approval, f.authority)).rejects.toThrow();
  }
});
