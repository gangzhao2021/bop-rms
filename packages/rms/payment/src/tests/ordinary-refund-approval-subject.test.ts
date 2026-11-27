import { expect, it } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundApprovalSubjectSource } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import { ordinaryRefundRequestFixture } from "./ordinary-refund-request.fixture.js";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
const at = "2026-09-13T12:15:00.000Z";
const request = ordinaryRefundRequestFixture(at);
function fixture() {
  const scope = {
    tenantReference: request.tenantReference,
    brandReference: request.brandReference,
    storeReference: request.storeReference,
  };
  const calls: string[] = [];
  const rows = [{ version: "1", record: encodeOrdinaryRefundRequest(request) }];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: sql.startsWith("SELECT claim_version") ? rows : [] };
    },
  } as unknown as ConsumerTransaction;
  const query = {
    orderReference: request.orderReference,
    requestReference: request.requestReference,
    observedAt: at,
  };
  return { scope, calls, rows, tx, query };
}
it("binds the durable request and keeps the digest stable across observation time", async () => {
  const f = fixture();
  const read = createPostgresOrdinaryRefundApprovalSubjectSource({
    scope: f.scope,
    authorize: async () => true,
  });
  const first = await read(f.tx, f.query);
  const later = await read(f.tx, { ...f.query, observedAt: "2026-09-14T12:15:00.000Z" });
  expect(later.subject).toEqual(first.subject);
  expect(first.requesterReference).toBe(request.actorReference);
  expect(first.claimVersion).toBe(1);
  expect(first.subject.allocationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(f.calls[1]).toContain("pg_advisory_xact_lock");
  expect(f.calls[2]).toContain("SELECT claim_version");
});
it("rejects missing request and noncontiguous history", async () => {
  const f = fixture();
  const read = createPostgresOrdinaryRefundApprovalSubjectSource({
    scope: f.scope,
    authorize: async () => true,
  });
  f.rows.splice(0, 1, { version: "2", record: encodeOrdinaryRefundRequest(request) });
  await expect(read(f.tx, f.query)).rejects.toThrow("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
  f.rows.length = 0;
  await expect(read(f.tx, f.query)).rejects.toThrow("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
});
it("rechecks authorization after reading the subject", async () => {
  const f = fixture();
  let checks = 0;
  const read = createPostgresOrdinaryRefundApprovalSubjectSource({
    scope: f.scope,
    authorize: async () => ++checks === 1,
  });
  await expect(read(f.tx, f.query)).rejects.toThrow("ORDINARY_REFUND_PERMISSION_DENIED");
  expect(checks).toBe(2);
});
