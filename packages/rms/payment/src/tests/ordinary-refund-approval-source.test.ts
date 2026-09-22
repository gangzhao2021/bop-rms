import { expect, it } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundApprovalSource } from "../infrastructure/ordinary-refund-approval-source.js";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";
const at = "2026-09-13T12:15:00.000Z";
const request = ordinaryRefundRequestFixture(at);
const scope = {
  tenantReference: request.tenantReference,
  brandReference: request.brandReference,
  storeReference: request.storeReference,
};
function fixture(substitute = false) {
  const tx = {
    query: async (sql: string) => ({
      rows: sql.startsWith("SELECT claim_version")
        ? [{ version: "1", record: encodeOrdinaryRefundRequest(request) }]
        : [],
    }),
  } as unknown as ConsumerTransaction;
  const actors: string[] = [];
  const source = createPostgresOrdinaryRefundApprovalSource({
    scope,
    authorize: async () => true,
    authority: async (transaction, query) => {
      expect(transaction).toBe(tx);
      actors.push(query.actorReference);
      return {
        ...query,
        actorReference: substitute ? id(90 + actors.length) : query.actorReference,
        role: query.permissionCode === "payment.refund.request" ? "Manager" : "Finance",
        active: true,
        allowed: true,
        recentMfaAt: at,
      };
    },
  });
  const input = {
    orderReference: request.orderReference,
    requestReference: request.requestReference,
    approvalReference: id(80),
    approverReference: id(81),
    observedAt: at,
  };
  return { source, tx, actors, input };
}
it("resolves the persisted requester and selected approver in the retained transaction", async () => {
  const f = fixture();
  const result = await f.source(f.tx, f.input);
  expect(f.actors).toEqual([request.actorReference, id(81)]);
  expect(result.approval.requesterReference).toBe(request.actorReference);
  expect(result.approval.approverReference).toBe(id(81));
  expect(result.claimVersion).toBe(1);
});
it("rejects authority adapters substituting otherwise eligible actors", async () => {
  const f = fixture(true);
  await expect(f.source(f.tx, f.input)).rejects.toThrow("ORDINARY_REFUND_APPROVAL_DENIED");
});
it("does not accept a caller-supplied requester or approval digest", async () => {
  const f = fixture();
  await expect(f.source(f.tx, { ...f.input, requesterReference: id(99) })).rejects.toThrow();
  expect(f.actors).toEqual([]);
});
