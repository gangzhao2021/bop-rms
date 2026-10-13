import { expect, it } from "vitest";
import {
  approvalDerivedReference,
  recentEnough,
  refundMfaRecencyMilliseconds,
} from "./merchant-ordinary-refund-approval.js";

const approval = "0190a7c6-1234-7abc-8def-0123456789ab";
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
it("derives stable, distinct UUIDv7 identities per purpose from the approval reference", () => {
  const purposes = ["approval-audit", "approval-operation", "operation:a", "dispatch:a"];
  const derived = purposes.map((purpose) => approvalDerivedReference(approval, purpose));
  for (const value of derived) {
    expect(value).toMatch(uuidV7);
    expect(value.slice(0, 13)).toBe(approval.slice(0, 13));
  }
  expect(new Set(derived).size).toBe(purposes.length);
  expect(approvalDerivedReference(approval, "operation:a")).toBe(derived[2]);
  expect(approvalDerivedReference("0190a7c6-1234-7abc-8def-0123456789ac", "operation:a")).not.toBe(
    derived[2],
  );
});
it("treats a verification as recent for exactly 15 minutes and never from the future", () => {
  const at = "2026-10-12T15:15:00.000Z";
  expect(refundMfaRecencyMilliseconds).toBe(900_000);
  expect(recentEnough("2026-10-12T15:00:00.000Z", at)).toBe(true);
  expect(recentEnough("2026-10-12T14:59:59.999Z", at)).toBe(false);
  expect(recentEnough("2026-10-12T15:15:00.001Z", at)).toBe(false);
  expect(recentEnough(null, at)).toBe(false);
});
