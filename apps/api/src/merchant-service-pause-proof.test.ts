import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createMerchantServicePauseProof } from "./merchant-service-pause-proof.js";
const ref = (n: number) => "018f8100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-07-29T12:00:00.000Z";
const intent = {
  brandReference: ref(1),
  storeReference: ref(2),
  command: "PauseService",
  operationReference: ref(3),
  configurationReference: ref(4),
  actorReference: ref(5),
  purposeCode: "STORE_SERVICE",
  expectedVersion: 0,
  auditReference: ref(6),
  content: { effectiveUntil: "2026-07-29T13:00:00.000Z", serviceModes: ["Pickup"] },
};
const operation = {
  ...intent,
  intentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(intent)),
  resultingVersion: 1,
  occurredAt: at,
  content: { ...intent.content, closureReference: intent.operationReference, effectiveFrom: at },
};
it("binds reconstructed intent to exact Audit summary and caller authorization", async () => {
  const query = vi.fn(async () => ({ rows: [{ matched: true }] }));
  const proof = createMerchantServicePauseProof({ ...intent, authorize: async () => true });
  expect(await proof({ query }, operation, at)).toBe(true);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("platform_audit.audit_record"), [
    ref(6),
    ref(1),
    ref(2),
    ref(5),
    "STORE_SERVICE_PAUSED",
    "StoreServiceControl",
    ref(3),
    at,
    "MERCHANT_WEB",
    JSON.stringify({
      intentDigest: operation.intentDigest,
      expectedVersion: 0,
      resultingVersion: 1,
    }),
  ]);
});
it.each([
  { ...operation, storeReference: ref(10) },
  { ...operation, resultingVersion: 2 },
  { ...operation, purposeCode: "OTHER" },
  { ...operation, content: { ...operation.content, serviceModes: ["DineIn"] } },
  { ...operation, content: { ...operation.content, effectiveFrom: "2026-07-29T11:00:00.000Z" } },
])("rejects changed scope, version, purpose or content before Audit lookup", async (changed) => {
  const query = vi.fn(async () => ({ rows: [{ matched: true }] }));
  const proof = createMerchantServicePauseProof({ ...intent, authorize: async () => true });
  expect(await proof({ query }, changed, at)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});
it("rejects absent Audit evidence and authorization loss", async () => {
  const query = vi.fn(async () => ({ rows: [{ matched: false }] }));
  const proof = createMerchantServicePauseProof({ ...intent, authorize: async () => true });
  expect(await proof({ query }, operation, at)).toBe(false);
  query.mockResolvedValue({ rows: [{ matched: true }] });
  const denied = createMerchantServicePauseProof({ ...intent, authorize: async () => false });
  query.mockClear();
  expect(await denied({ query }, operation, at)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});
