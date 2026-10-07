import { describe, expect, it } from "vitest";
import {
  canonicalizeRfc8785,
  computePlatformAuditRecordHash,
  parsePlatformAuditInput,
  parsePlatformAuditChainRecord,
  platformAuditChainProfile,
  sha256Hex,
  verifyPlatformAuditChain,
  type AppendPlatformAuditRecordInput,
} from "../index.js";
const id = (n: number) => `018f2000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z";
function input(n = 1): AppendPlatformAuditRecordInput {
  return {
    auditReference: id(n),
    actorReference: id(2),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    actionCode: "PLATFORM_BRAND_TEMPLATE_SAVED",
    targetType: "PlatformBrandTemplate",
    targetReference: id(3),
    operationReference: id(4),
    intentDigest: `sha256:${"a".repeat(64)}`,
    occurredAt: at,
    reasonCode: "ADMIN_CONFIGURATION",
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  };
}
function chain() {
  const first = {
    profile: platformAuditChainProfile,
    sequence: 1,
    previousHash: null,
    recordedAt: at,
    content: input(),
  };
  const record1 = { ...first, recordHash: computePlatformAuditRecordHash(first) };
  const second = { ...first, sequence: 2, previousHash: record1.recordHash, content: input(5) };
  return [record1, { ...second, recordHash: computePlatformAuditRecordHash(second) }];
}
describe("Platform actor purpose Audit contract", () => {
  it("keeps only exact metadata and digests with no Brand or Tenant identity", () => {
    const parsed = parsePlatformAuditInput(input());
    expect(parsed).toEqual(input());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.keys(parsed)).toHaveLength(12);
    for (const extra of ["brandId", "tenantReference", "rawPayload", "sessionCookie"])
      expect(() => parsePlatformAuditInput({ ...input(), [extra]: id(9) })).toThrow();
  });
  it("records absent original resolution against its genuine operation identity", () => {
    const value = {
      ...input(),
      targetType: "PlatformBrandTemplateOperation",
      targetReference: id(4),
      actionCode: "PLATFORM_BRAND_TEMPLATE_ABANDONED",
    };
    expect(parsePlatformAuditInput(value).targetReference).toBe(value.operationReference);
    expect(() => parsePlatformAuditInput({ ...value, targetReference: null })).toThrow();
    expect(() => parsePlatformAuditInput({ ...value, targetReference: id(9) })).toThrow();
  });
  it("rejects invalid identities, policy references, precision and unsafe sequence values", () => {
    for (const patch of [
      { actorReference: "not-an-actor" },
      { intentDigest: "sha256:bad" },
      { occurredAt: "2026-02-30T12:00:00.000Z" },
      { occurredAt: "2026-10-06T12:00:00Z" },
      { retentionPolicyCode: "INVENTED_RETENTION" },
      { retentionPolicyVersion: 2147483648 },
      { purposeCode: "PLATFORM\n" },
    ])
      expect(() => parsePlatformAuditInput({ ...input(), ...patch })).toThrow();
    const value = chain()[0];
    for (const patch of [
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { sequence: 0 },
      { previousHash: "a".repeat(64) },
      { recordedAt: "2026-10-06T11:59:59.000Z" },
    ])
      expect(() => parsePlatformAuditChainRecord({ ...value, ...patch })).toThrow();
  });
  it("rejects getters, hidden fields and sparse arrays without invoking user code", () => {
    let accessed = false;
    const value = { ...input() };
    Object.defineProperty(value, "actorReference", {
      enumerable: true,
      get() {
        accessed = true;
        return id(2);
      },
    });
    expect(() => parsePlatformAuditInput(value)).toThrow();
    expect(accessed).toBe(false);
    const hidden = { ...input() };
    Object.defineProperty(hidden, "purposeCode", { value: hidden.purposeCode, enumerable: false });
    expect(() => parsePlatformAuditInput(hidden)).toThrow();
    expect(verifyPlatformAuditChain(new Array(2))).toBe(false);
    const records = chain();
    Object.defineProperty(records, "0", {
      enumerable: true,
      get() {
        accessed = true;
        return null;
      },
    });
    expect(verifyPlatformAuditChain(records)).toBe(false);
    expect(accessed).toBe(false);
  });
  it("domain separates and canonically hashes the full original content", () => {
    const first = chain()[0];
    if (!first) throw new Error("Missing fixture");
    const { recordHash, ...value } = first;
    expect(recordHash).toBe(sha256Hex(canonicalizeRfc8785(value)));
    expect(
      computePlatformAuditRecordHash({
        ...value,
        content: Object.fromEntries(
          Object.entries(value.content).reverse(),
        ) as unknown as AppendPlatformAuditRecordInput,
      }),
    ).toBe(recordHash);
    expect(
      computePlatformAuditRecordHash({
        ...value,
        content: { ...value.content, intentDigest: `sha256:${"b".repeat(64)}` },
      }),
    ).not.toBe(recordHash);
  });
  it("verifies complete single Actor/purpose chains and detects altered or omitted facts", () => {
    const records = chain();
    expect(verifyPlatformAuditChain(records)).toBe(true);
    expect(verifyPlatformAuditChain(records.slice(1))).toBe(false);
    expect(verifyPlatformAuditChain([])).toBe(false);
    const second = records[1];
    if (!second) throw new Error("Missing fixture");
    expect(
      verifyPlatformAuditChain([
        records[0],
        { ...second, content: { ...second.content, reasonCode: "OTHER_REASON" } },
      ]),
    ).toBe(false);
    for (const patch of [{ actorReference: id(8) }, { purposeCode: "OTHER_PURPOSE" }]) {
      const { recordHash: originalHash, ...changed } = {
        ...second,
        content: { ...second.content, ...patch },
      };
      expect(originalHash).toBe(second.recordHash);
      expect(
        verifyPlatformAuditChain([
          records[0],
          { ...changed, recordHash: computePlatformAuditRecordHash(changed) },
        ]),
      ).toBe(false);
    }
    const original = structuredClone(records[0]);
    const parsed = parsePlatformAuditChainRecord(original);
    if (!original) throw new Error("Missing fixture");
    expect(Reflect.set(original.content, "reasonCode", "OTHER_REASON")).toBe(true);
    expect(parsed.content.reasonCode).toBe("ADMIN_CONFIGURATION");
    expect(Object.isFrozen(parsed.content)).toBe(true);
  });
});
